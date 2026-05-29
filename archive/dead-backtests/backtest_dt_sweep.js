/**
 * backtest_dt_sweep.js — DT parameter sweep
 *
 * Tests every combination of R:R × max-hold to find the optimal config.
 * Uses Option 1 sizing + TAKER market orders (the proven baseline).
 *
 * For each combo, reports: return, max DD, PF, win rate, trade count, expectancy/trade.
 * Sorts by return / max DD (risk-adjusted) at the end.
 *
 * Run: node backtest_dt_sweep.js
 */

import "dotenv/config";

const MEXC_BASE  = "https://futures.mexc.com";
const DAYS       = 150;
const NOW_SEC    = Math.floor(Date.now() / 1000);
const START_150  = NOW_SEC - DAYS * 86400;
const TAKER_FEE  = 0.0002; // 0.02% × 2 sides = applied as 0.0004 round trip; modeled as 0.0002 per exit only because we already subtract from gross at fill

// Note: we apply taker fee BOTH on entry and exit (0.0004 total per round-trip).
const FEE_PCT = 0.0004;

// DT config (matches live bot, except R:R and maxHold are swept)
const DT_PAIRS       = ["BTC_USDT", "BNB_USDT", "XRP_USDT", "SUI_USDT", "LTC_USDT", "AVAX_USDT"];
const DT_EMA50_PAIRS = new Set(["BTC_USDT", "SUI_USDT"]);
const DT_STATIC = { startBalance: 8750, riskPct: 0.008, leverage: 5, maxSLPct: 0.012, maxPositions: 6 };

// Sweep params
const RR_VALUES       = [1.3, 1.5, 1.8, 2.0, 2.5, 3.0];
const HOLD_VALUES     = [12, 18, 24, 36];  // 3h, 4.5h, 6h, 9h
const RISK_VALUES     = [0.008];           // keep risk constant for the matrix (test sensitivity at the end)

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchChunk(symbol, intervalStr, startSec, endSec) {
  const url = `${MEXC_BASE}/api/v1/contract/kline/${symbol}?interval=${intervalStr}&start=${startSec}&end=${endSec}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return [];
    const json = await res.json();
    if (!json.data?.time?.length) return [];
    const { time, open, close, high, low, vol } = json.data;
    return time.map((t,i) => ({ t: t*1000, o:+open[i], c:+close[i], h:+high[i], l:+low[i], v:+vol[i] })).sort((a,b)=>a.t-b.t);
  } catch { return []; }
}
async function fetchAllBars(symbol, intervalStr, barSecs, startSec, endSec) {
  const bars=[]; const chunk=1800*barSecs; let cur=startSec, emptyRuns=0;
  while(cur<endSec){const end=Math.min(cur+chunk,endSec);const batch=await fetchChunk(symbol,intervalStr,cur,end);if(!batch.length){emptyRuns++;if(emptyRuns>=5)break;cur=end+barSecs;await sleep(120);continue;}emptyRuns=0;bars.push(...batch);cur=Math.floor(batch[batch.length-1].t/1000)+barSecs;await sleep(180);}
  const seen=new Set();return bars.filter(b=>{if(seen.has(b.t))return false;seen.add(b.t);return true;}).sort((a,b)=>a.t-b.t);
}
function ema(v,p){const k=2/(p+1),o=[v[0]];for(let i=1;i<v.length;i++)o.push(v[i]*k+o[i-1]*(1-k));return o;}
function sma(v,p){return v.map((_,i)=>i<p-1?null:v.slice(i-p+1,i+1).reduce((a,b)=>a+b,0)/p);}
function rsi(c,p=14){const o=new Array(c.length).fill(null);let g=0,l=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];d>0?g+=d:l-=d;}o[p]=l===0?100:100-100/(1+g/l);for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];if(d>0){g=(g*(p-1)+d)/p;l=l*(p-1)/p;}else{g=g*(p-1)/p;l=(l*(p-1)-d)/p;}o[i]=l===0?100:100-100/(1+g/l);}return o;}
function adx(b,p=14){const n=b.length,o=new Array(n).fill(null),tr=[],pdm=[],ndm=[];for(let i=1;i<n;i++){const h=b[i].h,l=b[i].l,pc=b[i-1].c,ph=b[i-1].h,pl=b[i-1].l;tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));const up=h-ph,dn=pl-l;pdm.push(up>dn&&up>0?up:0);ndm.push(dn>up&&dn>0?dn:0);}if(tr.length<p*2)return o;let smTR=tr.slice(0,p).reduce((a,b)=>a+b,0),smP=pdm.slice(0,p).reduce((a,b)=>a+b,0),smN=ndm.slice(0,p).reduce((a,b)=>a+b,0);const dx=[],cDX=()=>{const pp=smTR?100*smP/smTR:0,nn=smTR?100*smN/smTR:0;return(pp+nn)?100*Math.abs(pp-nn)/(pp+nn):0;};dx.push(cDX());for(let i=p;i<tr.length;i++){smTR=smTR-smTR/p+tr[i];smP=smP-smP/p+pdm[i];smN=smN-smN/p+ndm[i];dx.push(cDX());}if(dx.length<p)return o;let v=dx.slice(0,p).reduce((a,b)=>a+b,0)/p;o[2*p-1]=v;for(let j=p;j<dx.length;j++){v=(v*(p-1)+dx[j])/p;o[j+p]=v;}return o;}
function dtSessionBias(bars){const bias=new Array(bars.length).fill(null);let oH=-Infinity,oL=Infinity,bld=false,conf=null,cur=null;for(let j=0;j<bars.length;j++){const h=new Date(bars[j].t).getUTCHours(),m=new Date(bars[j].t).getUTCMinutes();if([1,8,13].includes(h)&&m===0){bld=true;oH=bars[j].h;oL=bars[j].l;conf=null;cur=null;}else if(bld){oH=Math.max(oH,bars[j].h);oL=Math.min(oL,bars[j].l);conf={h:oH,l:oL};bld=false;}if(conf&&cur===null){if(bars[j].c>conf.h)cur="LONG";else if(bars[j].c<conf.l)cur="SHORT";}bias[j]=conf?cur:null;}return bias;}

// ─── Simulator with configurable R:R + max hold ─────────────────────────────

function simulate(indicators, rrRatio, maxHold, riskPct) {
  let balance = DT_STATIC.startBalance, peak = balance, maxDD = 0;
  const positions = []; const trades = []; let totalFees = 0;

  const allTs = new Set();
  for (const sym of DT_PAIRS) { const ind = indicators[sym]; if (!ind) continue; for (const b of ind.bars) if (b.t/1000 >= START_150) allTs.add(b.t); }
  const sortedTs = [...allTs].sort((a,b)=>a-b);

  for (const ts of sortedTs) {
    // Exits
    for (let i = positions.length-1; i >= 0; i--) {
      const pos = positions[i];
      const ind = indicators[pos.sym]; if (!ind) continue;
      const bi = ind.bars.findIndex(b => b.t === ts); if (bi < 0) continue;
      const bar = ind.bars[bi];
      const isL = pos.dir==="LONG"; const barsHeld = bi - pos.entryBarIdx;
      const hitSL = isL ? bar.l<=pos.sl : bar.h>=pos.sl;
      const hitTP = isL ? bar.h>=pos.tp : bar.l<=pos.tp;
      const timeExit = barsHeld >= maxHold;
      let exitReason = null, exitPrice = null;
      if (hitSL&&hitTP) { exitReason="SL"; exitPrice=pos.sl; }
      else if (hitSL)   { exitReason="SL"; exitPrice=pos.sl; }
      else if (hitTP)   { exitReason="TP"; exitPrice=pos.tp; }
      else if (timeExit){ exitReason="TIME"; exitPrice=bar.c; }
      if (exitReason) {
        const grossPnl = ((isL?exitPrice-pos.entry:pos.entry-exitPrice)/pos.entry) * pos.sizeUSD;
        const fee = pos.sizeUSD * FEE_PCT;
        const netPnl = grossPnl - fee;
        balance += netPnl; totalFees += fee;
        if (balance>peak) peak = balance;
        const dd = (peak-balance)/peak*100; if (dd>maxDD) maxDD=dd;
        trades.push({ gross: grossPnl, fee, net: netPnl, reason: exitReason });
        positions.splice(i, 1);
      }
    }

    // Entries
    if (positions.length < DT_STATIC.maxPositions) {
      for (const sym of DT_PAIRS) {
        if (positions.some(p=>p.sym===sym)) continue;
        const ind = indicators[sym]; if (!ind) continue;
        const bi = ind.bars.findIndex(b=>b.t===ts); if (bi < 3) continue;
        const i = bi-1, prev = i-1;
        if (!ind.rsi[i]||!ind.vsma[i]||!ind.adx[i]||ind.adx[i]<20) continue;
        const entryHour = new Date(ind.bars[i].t).getUTCHours();
        if (entryHour>=1&&entryHour<8) continue;
        const bias = ind.bias[i]; if (!bias) continue;
        const c=ind.bars[i], p2=ind.bars[prev];
        const r=ind.rsi[i], volOk=c.v>ind.vsma[i]*1.2;
        const e50Up=ind.e50[i]>ind.e50[i-4], e50Dn=ind.e50[i]<ind.e50[i-4];
        const longRsi=r>=40&&r<65, shortRsi=r>35&&r<=60;
        let sig=null;
        if (bias==="LONG") {
          if (e50Up&&longRsi&&volOk&&p2.c<ind.e21[prev]&&c.c>ind.e21[i]) {
            const swL=Math.min(...ind.bars.slice(Math.max(0,i-3),i+1).map(x=>x.l));
            const risk=c.c-swL;
            if (risk>0 && risk/c.c<DT_STATIC.maxSLPct) sig={dir:"LONG",entry:c.c,sl:swL,tp:c.c+risk*rrRatio};
          }
          if (!sig&&DT_EMA50_PAIRS.has(sym)&&e50Up&&r>=38&&r<62&&volOk&&p2.c<ind.e50[prev]&&c.c>ind.e50[i]) {
            const swL=Math.min(...ind.bars.slice(Math.max(0,i-4),i+1).map(x=>x.l));
            const risk=c.c-swL;
            if (risk>0 && risk/c.c<0.018) sig={dir:"LONG",entry:c.c,sl:swL,tp:c.c+risk*rrRatio};
          }
        }
        if (!sig&&bias==="SHORT") {
          if (e50Dn&&shortRsi&&volOk&&p2.c>ind.e21[prev]&&c.c<ind.e21[i]) {
            const swH=Math.max(...ind.bars.slice(Math.max(0,i-3),i+1).map(x=>x.h));
            const risk=swH-c.c;
            if (risk>0 && risk/c.c<DT_STATIC.maxSLPct) sig={dir:"SHORT",entry:c.c,sl:swH,tp:c.c-risk*rrRatio};
          }
          if (!sig&&DT_EMA50_PAIRS.has(sym)&&e50Dn&&r>38&&r<=62&&volOk&&p2.c>ind.e50[prev]&&c.c<ind.e50[i]) {
            const swH=Math.max(...ind.bars.slice(Math.max(0,i-4),i+1).map(x=>x.h));
            const risk=swH-c.c;
            if (risk>0 && risk/c.c<0.018) sig={dir:"SHORT",entry:c.c,sl:swH,tp:c.c-risk*rrRatio};
          }
        }
        if (!sig) continue;
        const riskUSD = balance * riskPct;
        const slDist  = Math.abs(sig.entry - sig.sl);
        const sizeUSD = (riskUSD / slDist) * sig.entry;  // Option 1 sizing
        positions.push({ sym, dir:sig.dir, entry:sig.entry, sl:sig.sl, tp:sig.tp, sizeUSD, riskUSD, entryBarIdx:bi });
        if (positions.length>=DT_STATIC.maxPositions) break;
      }
    }
  }

  // Close remaining
  for (const pos of positions) {
    const ind = indicators[pos.sym]; if (!ind) continue;
    const lastBar = ind.bars[ind.bars.length-1];
    const isL = pos.dir==="LONG";
    const grossPnl = ((isL?lastBar.c-pos.entry:pos.entry-lastBar.c)/pos.entry) * pos.sizeUSD;
    const fee = pos.sizeUSD * FEE_PCT;
    const netPnl = grossPnl - fee;
    balance += netPnl; totalFees += fee;
    trades.push({ gross: grossPnl, fee, net: netPnl, reason: "OPEN@END" });
  }

  const wins = trades.filter(t=>t.net>0);
  const losses = trades.filter(t=>t.net<0);
  const winRate = trades.length ? wins.length/trades.length*100 : 0;
  const netW = wins.reduce((s,t)=>s+t.net,0);
  const netL = Math.abs(losses.reduce((s,t)=>s+t.net,0));
  const pf = netL>0 ? netW/netL : (wins.length?Infinity:0);
  const ret = (balance - DT_STATIC.startBalance) / DT_STATIC.startBalance * 100;
  const tpCount = trades.filter(t=>t.reason==="TP").length;
  const slCount = trades.filter(t=>t.reason==="SL").length;
  const timeCount = trades.filter(t=>t.reason==="TIME").length;

  return { balance, ret, maxDD, trades: trades.length, winRate, pf, totalFees, tpCount, slCount, timeCount };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log("╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  DT PARAMETER SWEEP — Find optimal R:R × max-hold                 ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`  Fixed:  Option 1 sizing, 0.8% risk, 5x lev (margin only), 6 pairs, ${(FEE_PCT*100).toFixed(2)}% RT fees`);
  console.log(`  Sweep:  R:R = ${RR_VALUES.join(', ')}`);
  console.log(`         Max hold = ${HOLD_VALUES.join(', ')} bars`);
  console.log(`  Total:  ${RR_VALUES.length * HOLD_VALUES.length} configurations`);

  console.log("\n[1/1] Fetching DT 15min data…");
  const dtData = {};
  for (const sym of DT_PAIRS) {
    process.stdout.write(`  ${sym}…`);
    dtData[sym] = await fetchAllBars(sym, "Min15", 15*60, START_150 - 80*15*60, NOW_SEC);
    process.stdout.write(`\r  ${sym.padEnd(20)} ${dtData[sym].length} bars ✓\n`);
    await sleep(150);
  }
  const dtInd = {};
  for (const sym of DT_PAIRS) {
    const bars = dtData[sym]; if (bars.length < 80) continue;
    const closes = bars.map(b=>b.c), vols = bars.map(b=>b.v);
    dtInd[sym] = { bars, closes, vols, e21: ema(closes,21), e50: ema(closes,50), rsi: rsi(closes,14), vsma: sma(vols,20), adx: adx(bars,14), bias: dtSessionBias(bars) };
  }

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Running sweep…");
  console.log("══════════════════════════════════════════════════════════════\n");

  // Run all combinations
  const results = [];
  console.log(`  ${"R:R".padStart(5)} ${"Hold".padStart(5)} ${"Return".padStart(10)} ${"MaxDD".padStart(8)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"Trades".padStart(7)} ${"TP/SL/T".padStart(10)} ${"Risk-Adj".padStart(10)}`);
  console.log(`  ${"─".repeat(5)} ${"─".repeat(5)} ${"─".repeat(10)} ${"─".repeat(8)} ${"─".repeat(6)} ${"─".repeat(6)} ${"─".repeat(7)} ${"─".repeat(10)} ${"─".repeat(10)}`);

  for (const rr of RR_VALUES) {
    for (const hold of HOLD_VALUES) {
      const r = simulate(dtInd, rr, hold, 0.008);
      const riskAdj = r.maxDD > 0 ? r.ret / r.maxDD : (r.ret > 0 ? Infinity : 0);
      const breakdown = `${r.tpCount}/${r.slCount}/${r.timeCount}`;
      const retStr = `${r.ret>=0?'+':''}${r.ret.toFixed(1)}%`;
      const ddStr = `${r.maxDD.toFixed(1)}%`;
      const pfStr = r.pf === Infinity ? '∞' : r.pf.toFixed(2);
      const raStr = isFinite(riskAdj) ? riskAdj.toFixed(2) : '∞';
      console.log(`  ${String(rr).padStart(5)} ${String(hold).padStart(5)} ${retStr.padStart(10)} ${ddStr.padStart(8)} ${pfStr.padStart(6)} ${r.winRate.toFixed(1).padStart(6)} ${String(r.trades).padStart(7)} ${breakdown.padStart(10)} ${raStr.padStart(10)}`);
      results.push({ rr, hold, ...r, riskAdj });
    }
  }

  // ── Find best configurations ────────────────────────────────────────────
  console.log("\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  TOP CONFIGS                                                       ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");

  const byReturn = [...results].sort((a,b) => b.ret - a.ret);
  console.log("\n  📈 Top 3 by Total Return:");
  for (const r of byReturn.slice(0,3)) {
    console.log(`     R:R=${r.rr}, Hold=${r.hold}  →  ${r.ret>=0?'+':''}${r.ret.toFixed(1)}% return, ${r.maxDD.toFixed(1)}% DD, PF ${r.pf===Infinity?'∞':r.pf.toFixed(2)}`);
  }

  const byRiskAdj = [...results].filter(r => r.ret > 0).sort((a,b) => b.riskAdj - a.riskAdj);
  if (byRiskAdj.length > 0) {
    console.log("\n  ⚖️  Top 3 by Risk-Adjusted (Return / Max DD):");
    for (const r of byRiskAdj.slice(0,3)) {
      console.log(`     R:R=${r.rr}, Hold=${r.hold}  →  ${r.ret>=0?'+':''}${r.ret.toFixed(1)}% return, ${r.maxDD.toFixed(1)}% DD, Risk-Adj ${r.riskAdj.toFixed(2)}, PF ${r.pf===Infinity?'∞':r.pf.toFixed(2)}`);
    }
  }

  const byPF = [...results].sort((a,b) => (b.pf===Infinity?9999:b.pf) - (a.pf===Infinity?9999:a.pf));
  console.log("\n  💎 Top 3 by Profit Factor:");
  for (const r of byPF.slice(0,3)) {
    console.log(`     R:R=${r.rr}, Hold=${r.hold}  →  PF ${r.pf===Infinity?'∞':r.pf.toFixed(2)}, ${r.ret>=0?'+':''}${r.ret.toFixed(1)}% return, ${r.maxDD.toFixed(1)}% DD`);
  }

  const baseline = results.find(r => r.rr === 1.3 && r.hold === 12);
  if (baseline) {
    console.log(`\n  📊 Baseline (current live config):  R:R=1.3, Hold=12  →  ${baseline.ret>=0?'+':''}${baseline.ret.toFixed(1)}%, DD ${baseline.maxDD.toFixed(1)}%, PF ${baseline.pf===Infinity?'∞':baseline.pf.toFixed(2)}`);
  }

  const winners = results.filter(r => r.ret > 10);
  console.log(`\n  🎯 Configs with >10% return: ${winners.length} / ${results.length}`);
  const profitable = results.filter(r => r.ret > 0);
  console.log(`     Profitable configs:       ${profitable.length} / ${results.length}`);

  const mins = ((Date.now()-t0)/60000).toFixed(1);
  console.log(`\n  Sweep time: ${mins} min\n`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
