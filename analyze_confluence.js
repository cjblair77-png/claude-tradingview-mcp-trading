/**
 * analyze_confluence.js — Did MTF confluence / volume confirmation actually
 * improve trade accuracy? Cross-references closed trades against the
 * confluence_history.json snapshots logged by bot_market_pulse.js.
 *
 * For each closed trade across v09/DT/GP, finds the confluence snapshot
 * nearest its entry time, then buckets trades by whether they fired:
 *   - WITH high-conviction confluence (dir match + HIGH CONVICTION)
 *   - WITH confluence (dir match, any tier)
 *   - during MIXED/no confluence
 *   - AGAINST confluence (counter-trend)
 * and compares win rate + avg P&L per bucket.
 *
 * Run: node analyze_confluence.js   (or via the weekly review task)
 * Optionally pushes a summary to ntfy.sh/hermes-summary.
 */

import "dotenv/config";

const GIST_ID      = process.env.GITHUB_GIST_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const PUSH         = process.argv.includes("--push");
const MATCH_TOL_MS = 45 * 60 * 1000;  // a trade matches a snapshot within 45 min

async function gistAll(){
  const r=await fetch(`https://api.github.com/gists/${GIST_ID}`,{headers:{Authorization:`token ${GITHUB_TOKEN}`,Accept:"application/vnd.github+json"},signal:AbortSignal.timeout(15000)});
  const d=await r.json();const out={};for(const k in (d.files||{})){try{out[k]=JSON.parse(d.files[k].content);}catch{}}return out;
}
const toMs = t => typeof t==="number" ? t : (t ? new Date(t).getTime() : null);

function nearestSnapshot(hist, ms){
  let best=null, bestDiff=Infinity;
  for(const h of hist){ const diff=Math.abs(h.ts-ms); if(diff<bestDiff){bestDiff=diff;best=h;} }
  return bestDiff<=MATCH_TOL_MS ? best : null;
}

function bucketOf(trade, snap){
  if(!snap || snap.confDir==="MIXED" || snap.confTier==="NONE" || snap.confTier==="WEAK") return "mixed";
  const tradeDir = trade.direction==="LONG" ? "UP" : "DOWN";
  if(tradeDir!==snap.confDir) return "counter";
  return snap.conviction==="HIGH CONVICTION" ? "highConv" : "aligned";
}

function stats(trades){
  const n=trades.length;
  if(!n) return {n:0};
  const wins=trades.filter(t=>(t.pnl||0)>0).length;
  const net=trades.reduce((s,t)=>s+(t.pnl||0),0);
  return {n, wr:Math.round(wins/n*100), net:+net.toFixed(2), avg:+(net/n).toFixed(2)};
}

async function main(){
  const files=await gistAll();
  const hist=Array.isArray(files["confluence_history.json"])?files["confluence_history.json"]:[];
  if(hist.length<10){
    const msg=`Confluence efficacy: not enough data yet (${hist.length} snapshots). Need ~1-2 weeks of logging. Check back later.`;
    console.log(msg); if(PUSH) await push("Confluence Efficacy", msg); return;
  }

  // Gather all closed trades, tag strategy + entry ms
  const trades=[];
  for(const [name,key] of [["paper_account_v09.json","v09"],["paper_daytrading_v01.json","DT"],["paper_account_golden_pocket.json","GP"]]){
    const acc=files[name]; if(!acc) continue;
    const list=acc.closedTrades||acc.trades||[];
    for(const t of list){ const ms=toMs(t.entryTime); if(ms) trades.push({...t,_strat:key,_entryMs:ms}); }
  }

  const histStart=Math.min(...hist.map(h=>h.ts));
  const eligible=trades.filter(t=>t._entryMs>=histStart);   // only trades after logging began
  const buckets={highConv:[],aligned:[],mixed:[],counter:[],unmatched:[]};
  for(const t of eligible){
    const snap=nearestSnapshot(hist,t._entryMs);
    if(!snap){ buckets.unmatched.push(t); continue; }
    buckets[bucketOf(t,snap)].push(t);
  }

  const sHigh=stats(buckets.highConv), sAlign=stats(buckets.aligned), sMixed=stats(buckets.mixed), sCounter=stats(buckets.counter);
  const confAll=stats([...buckets.highConv,...buckets.aligned]);
  const nonConf=stats([...buckets.mixed,...buckets.counter]);

  const L=[];
  L.push(`CONFLUENCE EFFICACY  (${hist.length} snapshots, ${eligible.length} trades since logging began)`);
  L.push("");
  L.push(`Bucket            Trades  WR    AvgPnL   NetPnL`);
  const row=(lbl,s)=> `${lbl.padEnd(16)} ${String(s.n||0).padStart(4)}  ${s.n?(s.wr+"%").padStart(4):"  - "}  ${s.n?("$"+s.avg).padStart(7):"   -   "}  ${s.n?("$"+s.net).padStart(7):"   -   "}`;
  L.push(row("HIGH CONVICTION", sHigh));
  L.push(row("Aligned", sAlign));
  L.push(row("Mixed/none", sMixed));
  L.push(row("Counter-conf", sCounter));
  L.push("");
  L.push(`WITH confluence: ${confAll.n} trades, ${confAll.n?confAll.wr+"% WR, $"+confAll.avg+" avg":"-"}`);
  L.push(`WITHOUT (mixed+counter): ${nonConf.n} trades, ${nonConf.n?nonConf.wr+"% WR, $"+nonConf.avg+" avg":"-"}`);
  L.push("");
  // Verdict
  if(confAll.n<8 || nonConf.n<5){
    L.push(`VERDICT: too few trades per bucket for a call. Keep logging.`);
  } else if(confAll.wr>nonConf.wr+8 && confAll.avg>nonConf.avg){
    L.push(`VERDICT: confluence-aligned trades OUTPERFORM (+${confAll.wr-nonConf.wr}pts WR, better avg).`);
    L.push(`-> Worth testing as an entry filter (backtest + walk-forward first).`);
  } else if(confAll.wr<nonConf.wr-8){
    L.push(`VERDICT: confluence-aligned trades UNDERPERFORM. Do NOT wire in.`);
  } else {
    L.push(`VERDICT: no clear edge yet. Keep as a guide; re-check next week.`);
  }
  const body=L.join("\n");
  console.log(body);
  if(PUSH) await push("Confluence Efficacy", body);
}

async function push(title,body){
  try{ await fetch(`https://ntfy.sh/${process.env.SUMMARY_NTFY_TOPIC||"hermes-summary"}`,{method:"POST",headers:{"Content-Type":"text/plain",Title:title.replace(/[^\x20-\x7E]/g,""),Tags:"bar_chart"},body,signal:AbortSignal.timeout(8000)});console.log("\n[ntfy] pushed");}catch(e){console.warn("[ntfy] failed:",e.message);}
}
main().catch(e=>{console.error("FATAL:",e);process.exit(1);});
