/**
 * bot_market_pulse.js — 6-hourly "what are we looking for / how close are we"
 * report for all 3 strategies. Condition-focused, not P&L-focused.
 *
 * For each strategy it reports:
 *   - What it's looking for (the setup)
 *   - How close we are (nearest pair to a trigger + why blocked if blocked)
 *   - Any active trades / pending orders
 *
 * Run: every 6h via Railway cron (0 *​/6 * * *)
 * Notify: ntfy.sh/hermes-pulse
 */

import "dotenv/config";

const GIST_ID      = process.env.GITHUB_GIST_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const NTFY_TOPIC   = process.env.PULSE_NTFY_TOPIC || "hermes-pulse";
const MEXC_BASE    = "https://contract.mexc.com";

const V09_PAIRS = [
  "KAIA_USDT","S_USDT","FILECOIN_USDT","AR_USDT","PLUME_USDT","FIDA_USDT","GMT_USDT","ENA_USDT","TIA_USDT","TURBO_USDT",
  "WIF_USDT","SHIB_USDT","BCH_USDT","VET_USDT","ONDO_USDT","THETA_USDT","HBAR_USDT","RUNE_USDT","IOTA_USDT","JUP_USDT",
  "FLUX_USDT","W_USDT","CATI_USDT","ZKSYNC_USDT","KAITO_USDT","WLD_USDT","AIXBT_USDT","LA_USDT","JASMY_USDT","HOME_USDT",
];
const DT_PAIRS = ["BTC_USDT","ETH_USDT","SOL_USDT","BNB_USDT","XRP_USDT","SUI_USDT","LTC_USDT","AVAX_USDT"];

// Majors basket for market-breadth compass (4H regime). BTC is the laggard;
// ETH/SOL/XRP are the higher-beta "alt-leaders" that lead risk-on/off moves.
const MAJORS      = ["BTC_USDT","ETH_USDT","SOL_USDT","BNB_USDT","XRP_USDT"];
const ALT_LEADERS = ["ETH_USDT","SOL_USDT","XRP_USDT"];

const V09_LOOKBACK = 15;

// ── Helpers ────────────────────────────────────────────────────────────────
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
async function klines(sym, interval, limit=250){
  const url=`${MEXC_BASE}/api/v1/contract/kline/${sym}?interval=${interval}`;
  try{
    const r=await fetch(url,{signal:AbortSignal.timeout(15000)});
    const j=await r.json();
    if(!j.success||!j.data?.close?.length)return null;
    const d=j.data;
    return d.close.map((_,i)=>({t:d.time[i]*1000,o:+d.open[i],h:+d.high[i],l:+d.low[i],c:+d.close[i],v:+d.vol[i]})).slice(-limit);
  }catch{return null;}
}
function ema(v,p){if(v.length<p)return null;const k=2/(p+1);let e=v.slice(0,p).reduce((a,b)=>a+b,0)/p;for(const x of v.slice(p))e=x*k+e*(1-k);return e;}
function rsiLast(c,p=14){if(c.length<p+1)return null;let g=0,l=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];d>0?g+=d:l-=d;}let r=l===0?100:100-100/(1+g/l);for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];if(d>0){g=(g*(p-1)+d)/p;l=l*(p-1)/p;}else{g=g*(p-1)/p;l=(l*(p-1)-d)/p;}}return l===0?100:100-100/(1+g/l);}
function v09RegimeLast(c){const e21=ema(c,21),e50=ema(c,50),e200=ema(c,200);if(!e200)return"neutral";const x=c[c.length-1];let s=0;if(x>e200)s++;else s--;if(x>e50)s++;else s--;if(x>e21)s++;else s--;if(e21>e50)s++;else s--;if(e50>e200)s++;else s--;return s>=4?"bull":s<=-4?"bear":"neutral";}

async function gistFile(name){
  if(!GIST_ID||!GITHUB_TOKEN)return null;
  try{
    const r=await fetch(`https://api.github.com/gists/${GIST_ID}`,{headers:{Authorization:`token ${GITHUB_TOKEN}`,Accept:"application/vnd.github+json"},signal:AbortSignal.timeout(10000)});
    const d=await r.json();const f=d.files?.[name];return f?JSON.parse(f.content):null;
  }catch{return null;}
}
async function gistAll(){
  if(!GIST_ID||!GITHUB_TOKEN)return {};
  try{
    const r=await fetch(`https://api.github.com/gists/${GIST_ID}`,{headers:{Authorization:`token ${GITHUB_TOKEN}`,Accept:"application/vnd.github+json"},signal:AbortSignal.timeout(10000)});
    const d=await r.json();const out={};for(const k in (d.files||{})){try{out[k]=JSON.parse(d.files[k].content);}catch{}}return out;
  }catch{return {};}
}

async function saveState(state){
  if(!GIST_ID||!GITHUB_TOKEN)return;
  try{
    await fetch(`https://api.github.com/gists/${GIST_ID}`,{method:"PATCH",headers:{Authorization:`token ${GITHUB_TOKEN}`,"Content-Type":"application/json",Accept:"application/vnd.github+json"},body:JSON.stringify({files:{"pulse_state.json":{content:JSON.stringify(state,null,2)}}}),signal:AbortSignal.timeout(10000)});
  }catch(e){console.warn("[state] save failed:",e.message);}
}

function ascii(s){return s.replace(/[^\x20-\x7E]/g,"").trim();}
async function notify(title,body){
  for(let attempt=1;attempt<=3;attempt++){
    try{
      await fetch(`https://ntfy.sh/${NTFY_TOPIC}`,{method:"POST",headers:{"Content-Type":"text/plain",Title:ascii(title),Tags:"satellite"},body,signal:AbortSignal.timeout(8000)});
      console.log("[ntfy] sent");return;
    }catch(e){
      console.warn(`[ntfy] attempt ${attempt} failed:`,e.message);
      if(attempt<3)await sleep(2000);
    }
  }
}
const coin=s=>(s||"").replace("_USDT","");
const pct=n=>(n>=0?"+":"")+n.toFixed(1)+"%";

async function main(){
  console.log(`\n📡 Market Pulse — ${new Date().toISOString()}\n`);
  const hourUTC = new Date().getUTCHours();

  // ── Gist state (accounts + regime) ────────────────────────────────────
  const files = await gistAll();
  const v09acc = files["paper_account_v09.json"];
  const dtacc  = files["paper_daytrading_v01.json"];
  const gpacc  = files["paper_account_golden_pocket.json"];
  const regime = files["regime_state.json"];
  const macroBull = !!(regime?.daily?.ema50_gt_200 || regime?.weekly?.ema10_gt_20);

  // ── Majors breadth compass (4H regime per major) ───────────────────────
  const majorReg = {};
  for(const sym of MAJORS){
    const bars=await klines(sym,"Hour4",250); await sleep(60);
    if(!bars||bars.length<60){ majorReg[sym]="?"; continue; }
    majorReg[sym]=v09RegimeLast(bars.map(b=>b.c));
  }
  const bearCount = MAJORS.filter(s=>majorReg[s]==="bear").length;
  const bullCount = MAJORS.filter(s=>majorReg[s]==="bull").length;
  // Dominant direction + graded label (don't require 5/5 — 4/5 = CONFIRMED)
  let breadthDir="MIXED", aligned=Math.max(bearCount,bullCount);
  if(bearCount>bullCount) breadthDir="BEARISH"; else if(bullCount>bearCount) breadthDir="BULLISH";
  const breadthLabel = aligned>=5?"STRONG":aligned===4?"CONFIRMED":aligned===3?"LEANING":"MIXED";
  // Holdout = the major NOT matching the dominant direction
  const domReg = breadthDir==="BEARISH"?"bear":breadthDir==="BULLISH"?"bull":null;
  const holdouts = domReg ? MAJORS.filter(s=>majorReg[s]!==domReg).map(coin) : [];
  // Alt-leader trio unanimity (more predictive for our alts than BTC)
  const leadBear = ALT_LEADERS.every(s=>majorReg[s]==="bear");
  const leadBull = ALT_LEADERS.every(s=>majorReg[s]==="bull");
  const arrow = r => r==="bear"?"v":r==="bull"?"^":"-";

  // ── Multi-timeframe confluence (30/60/90 min) on the majors basket ──────
  // For each window, the % change of each major; basket = average; count
  // how many majors agree with the basket direction. STRONG confluence =
  // all 3 windows same direction with 4-5/5 majors aligned in each.
  const WINDOWS = [{label:"30m",bars:2},{label:"60m",bars:4},{label:"90m",bars:6}];
  const m15 = {}, m15v = {};
  for(const sym of MAJORS){ const b=await klines(sym,"Min15",60); await sleep(60); if(b&&b.length>10){ m15[sym]=b.map(x=>x.c); m15v[sym]=b.map(x=>x.v); } }
  const mtf = WINDOWS.map(w=>{
    let sum=0, n=0, down=0, up=0;
    for(const sym of MAJORS){
      const c=m15[sym]; if(!c||c.length<=w.bars) continue;
      const chg=(c[c.length-1]/c[c.length-1-w.bars]-1)*100;
      sum+=chg; n++; if(chg<0) down++; else if(chg>0) up++;
    }
    const avg=n?sum/n:0;
    const dir=avg<0?"DOWN":avg>0?"UP":"FLAT";
    const agree=dir==="DOWN"?down:dir==="UP"?up:0;
    return {label:w.label, avg, dir, agree, n};
  });
  const allDown = mtf.every(w=>w.dir==="DOWN");
  const allUp   = mtf.every(w=>w.dir==="UP");
  const minAgree = Math.min(...mtf.map(w=>w.agree));
  let confDir = allDown?"DOWN":allUp?"UP":"MIXED";
  let confTier = "NONE";
  if(confDir!=="MIXED"){
    if(minAgree>=4) confTier="STRONG";       // all 3 windows + 4-5/5 majors each
    else if(minAgree>=3) confTier="BUILDING"; // all 3 windows + 3/5 majors each
    else confTier="WEAK";
  }
  // 30m basket move for fast-move detection
  const fastMovePct = mtf[0]?.avg ?? 0;

  // ── Volume confirmation (proxy: recent vol vs 20-bar avg per major) ─────
  // Candle vol isn't directional, but a move on surging vol = conviction.
  // Combined with confluence direction, that's volume-confirmed.
  let volSurging=0, volRatios=[];
  for(const sym of MAJORS){
    const v=m15v[sym]; if(!v||v.length<22) continue;
    const recent=(v[v.length-1]+v[v.length-2])/2;            // last 30m
    const base=v.slice(-22,-2).reduce((a,b)=>a+b,0)/20;      // prior 20 bars
    if(base>0){ const ratio=recent/base; volRatios.push(ratio); if(ratio>=1.5) volSurging++; }
  }
  const avgVolRatio = volRatios.length ? volRatios.reduce((a,b)=>a+b,0)/volRatios.length : 1;
  const volConfirmed = volSurging>=3;   // majority of majors surging
  // Conviction read: STRONG confluence + volume = high conviction
  const conviction = (confTier==="STRONG" && volConfirmed) ? "HIGH CONVICTION"
                   : (confTier==="STRONG" && !volConfirmed) ? "STRONG but LIGHT VOLUME (watch for exhaustion)"
                   : null;

  // ── Decide run type: full 6h report, or quick alert-on-change ───────────
  const minUTC = new Date().getUTCMinutes();
  const fullReport = (hourUTC % 6 === 0) && minUTC < 30;   // 00/06/12/18 UTC
  const prev = files["pulse_state.json"] || {};
  const confChanged = confTier === "STRONG" && (prev.confTier !== "STRONG" || prev.confDir !== confDir);
  const fastMove = Math.abs(fastMovePct) >= 1.5;           // sharp 30m basket move
  const sendAlert = fullReport || confChanged || fastMove;
  const arrowM = d => d==="DOWN"?"v":d==="UP"?"^":"-";

  // ── Header: MTF confluence + breadth (always built) ─────────────────────
  const H=[];
  H.push(`MARKET PULSE  ${new Date().toUTCString().slice(17,22)} UTC`);
  if(regime) H.push(`BTC $${Math.round(regime.btcPrice).toLocaleString()} | shorts ${macroBull?"OFF (macro bull)":"ON"}`);
  H.push("");
  H.push(`== MTF CONFLUENCE (majors 30/60/90m) ==`);
  H.push(confTier==="NONE" ? `MIXED - timeframes not aligned` : `${confDir} - ${confTier} (min ${minAgree}/5 agree)`);
  for(const w of mtf) H.push(`${w.label}: ${pct(w.avg)} (${w.agree}/${w.n} ${arrowM(w.dir)})`);
  H.push(`Volume: ${volConfirmed?"CONFIRMED":"light"} (${volSurging}/5 surging, ${avgVolRatio.toFixed(1)}x avg)`);
  if(conviction) H.push(`=> ${conviction}`);
  H.push("");
  H.push(`== MAJORS BREADTH (4H) ==`);
  H.push(`${aligned}/5 ${breadthDir} (${breadthLabel})`);
  H.push(MAJORS.map(s=>`${coin(s)} ${arrow(majorReg[s])}`).join("  "));
  if(holdouts.length && holdouts.length<=2) H.push(`Holdout: ${holdouts.join(", ")}`);
  if(leadBear) H.push(`ETH/SOL/XRP unanimous DOWN - alt shorts have tailwind`);
  else if(leadBull) H.push(`ETH/SOL/XRP unanimous UP - alt longs have tailwind`);

  await saveState({confTier, confDir, ts:Date.now()});

  // Silent if nothing meaningful and not a 6h mark
  if(!sendAlert){
    console.log(H.join("\n"));
    console.log("\n(silent — confluence not STRONG, no fast move, not a 6h mark)\n");
    return;
  }

  // Quick confluence/fast-move alert (between 6h reports)
  if(!fullReport){
    const reason = confChanged ? `STRONG ${confDir} confluence — 30/60/90m aligned` : `Fast ${fastMovePct<0?"DROP":"PUMP"} ${pct(fastMovePct)} on majors (30m)`;
    const body = H.join("\n") + `\n\n>> TRIGGER: ${reason}\n>> Watch alt setups in this direction.`;
    console.log(body);
    await notify(`Majors ${confDir} ${confTier}`, body);
    console.log("✅ Alert sent.\n");
    return;
  }

  // ── FULL 6h report: scan v09 + DT + GP ──────────────────────────────────
  let regCounts={bull:0,neutral:0,bear:0};
  let nearLong=null, nearShort=null;
  for(const sym of V09_PAIRS){
    const bars=await klines(sym,"Hour4",250); await sleep(60);
    if(!bars||bars.length<60)continue;
    const c=bars.map(b=>b.c);
    const reg=v09RegimeLast(c); regCounts[reg]=(regCounts[reg]||0)+1;
    const price=c[c.length-1];
    const rsi=rsiLast(c.slice(-50));
    const recent=c.slice(-1-V09_LOOKBACK,-1);
    const highN=Math.max(...recent), lowN=Math.min(...recent);
    const distHigh=(highN-price)/price*100;
    if(reg!=="bear" && distHigh>=0 && (!nearLong||distHigh<nearLong.dist)) nearLong={sym,dist:distHigh,rsi};
    const distLow=(price-lowN)/price*100;
    if(reg==="bear" && distLow>=0 && (!nearShort||distLow<nearShort.dist)) nearShort={sym,dist:distLow,rsi};
  }
  const v09open=(v09acc?.openPositions||[]);

  let dtOversold=0, dtInWindow=[];
  for(const sym of DT_PAIRS){
    const bars=await klines(sym,"Min15",120); await sleep(60);
    if(!bars||bars.length<60)continue;
    const rsi=rsiLast(bars.map(b=>b.c).slice(-50));
    if(rsi<35) dtOversold++;
    else if(rsi>=35&&rsi<=65) dtInWindow.push({sym,rsi});
  }
  const dtSession = !(hourUTC>=1&&hourUTC<8);
  const dtOpen=(dtacc?.positions||[]);
  const gpSession = hourUTC>=13 && hourUTC<18;
  const gpOpen=(gpacc?.positions||[]);
  const gpPending=(gpacc?.pendingPositions||[]);

  const L=[...H, ""];
  L.push(`== v09 (4H, 30 alts) ==`);
  L.push(`Regime: ${regCounts.bull}bull ${regCounts.neutral}neut ${regCounts.bear}bear`);
  if(v09open.length){ for(const p of v09open) L.push(`ACTIVE: ${p.direction} ${coin(p.symbol)} @ $${p.entryPrice} (${p.signal})`); }
  else {
    if(nearShort) L.push(`Closest SHORT: ${coin(nearShort.sym)} ${pct(-nearShort.dist)} to 15-bar low, RSI ${nearShort.rsi?.toFixed(0)}`);
    if(nearLong)  L.push(`Closest LONG: ${coin(nearLong.sym)} ${pct(nearLong.dist)} to breakout, RSI ${nearLong.rsi?.toFixed(0)}`);
    if(!nearShort&&!nearLong) L.push(`No pairs near a trigger`);
  }
  L.push("");
  L.push(`== DT (15m, 8 majors) ==`);
  L.push(`Session: ${dtSession?"ACTIVE":"paused (Asia 01-08 UTC)"}`);
  if(dtOpen.length){ for(const p of dtOpen) L.push(`ACTIVE: ${p.direction} ${coin(p.symbol)} @ $${p.entry}`); }
  else if(dtOversold>=DT_PAIRS.length-1) L.push(`${dtOversold}/${DT_PAIRS.length} oversold (RSI<35) - entries BLOCKED`);
  else if(dtInWindow.length) L.push(`In RSI window: ${dtInWindow.slice(0,3).map(d=>`${coin(d.sym)} ${d.rsi.toFixed(0)}`).join(", ")}`);
  else L.push(`No pairs in entry window`);
  L.push("");
  L.push(`== GP (15m Fib, 7 pairs) ==`);
  L.push(`Session: ${gpSession?"ACTIVE":"closed (opens 13 UTC)"}`);
  if(gpOpen.length) for(const p of gpOpen) L.push(`ACTIVE: ${p.direction} ${coin(p.symbol)} @ $${p.entry}`);
  if(gpPending.length) for(const p of gpPending) L.push(`PENDING: ${p.direction} ${coin(p.symbol)} limit $${p.limitPrice}`);
  if(!gpOpen.length&&!gpPending.length) L.push(`No active orders`);

  const body=L.join("\n");
  console.log(body);
  await notify("Market Pulse (6h report)", body);
  console.log("✅ Full report sent.\n");
}
main().catch(e=>{console.error("FATAL:",e);notify("Market Pulse - ERROR",e.message).catch(()=>{});process.exit(1);});
