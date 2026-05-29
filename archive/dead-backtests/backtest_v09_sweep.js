/**
 * backtest_v09_sweep.js — Full v09 parameter optimization (6 months)
 *
 * Sweeps the highest-impact v09 parameters on 30 isolation-scored alts.
 * Same playbook that took DT from +4.4% to +27.4%.
 *
 * Sweep 1: SL × TP matrix (most impactful — R:R ratio)
 * Sweep 2: Trail % on best SL/TP
 * Sweep 3: Breakout RSI band (currently 54-65)
 * Sweep 4: Lookback bars (currently 30)
 * Sweep 5: Final combined-optimum verification
 *
 * Run: node backtest_v09_sweep.js
 */

import "dotenv/config";

const MEXC_BASE  = "https://futures.mexc.com";
const DAYS       = 180;
const NOW_SEC    = Math.floor(Date.now() / 1000);
const START      = NOW_SEC - DAYS * 86400;
const FEE_PCT    = 0.0004;
const START_BALANCE = 11000;

const V09_PAIRS = [
  "KAIA_USDT","S_USDT","FILECOIN_USDT","AR_USDT","PLUME_USDT","FIDA_USDT","GMT_USDT","ENA_USDT","TIA_USDT","TURBO_USDT",
  "WIF_USDT","SHIB_USDT","BCH_USDT","VET_USDT","ONDO_USDT","THETA_USDT","HBAR_USDT","RUNE_USDT","IOTA_USDT","JUP_USDT",
  "FLUX_USDT","W_USDT","CATI_USDT","ZKSYNC_USDT","KAITO_USDT","WLD_USDT","AIXBT_USDT","LA_USDT","JASMY_USDT","HOME_USDT",
];

// ── Defaults (current live config) ──────────────────────────────────────────
const DEF = {
  riskPct: 0.008, minRisk: 2, leverage: 1.5, maxPositions: 10, warmupDays: 92,
  slPct: 0.065, tpPct: 0.23, trailPct: 0.19, trailBullPct: 60,
  rebSlPct: 0.035, rebTpPct: 0.22,
  brsiMin: 54, brsiMax: 65, lookback: 30,
  volMultBreak: 1.5, volMultShort: 1.2, volMultReb: 1.0,
  rsiOverbought: 80,
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function fetchChunk(symbol, intervalStr, startSec, endSec) {
  const url = `${MEXC_BASE}/api/v1/contract/kline/${symbol}?interval=${intervalStr}&start=${startSec}&end=${endSec}`;
  try { const res = await fetch(url, { signal: AbortSignal.timeout(20000) }); if (!res.ok) return [];
    const json = await res.json(); if (!json.data?.time?.length) return [];
    const { time, open, close, high, low, vol } = json.data;
    return time.map((t,i) => ({ t: t*1000, o:+open[i], c:+close[i], h:+high[i], l:+low[i], v:+vol[i] })).sort((a,b)=>a.t-b.t);
  } catch { return []; }
}
async function fetchAllBars(symbol, intervalStr, barSecs, startSec, endSec) {
  const bars=[]; const chunk=1800*barSecs; let cur=startSec, emptyRuns=0;
  while(cur<endSec){const end=Math.min(cur+chunk,endSec);const batch=await fetchChunk(symbol,intervalStr,cur,end);if(!batch.length){emptyRuns++;if(emptyRuns>=5)break;cur=end+barSecs;await sleep(120);continue;}emptyRuns=0;bars.push(...batch);cur=Math.floor(batch[batch.length-1].t/1000)+barSecs;await sleep(130);}
  const seen=new Set();return bars.filter(b=>{if(seen.has(b.t))return false;seen.add(b.t);return true;}).sort((a,b)=>a.t-b.t);
}
function ema(v,p){const k=2/(p+1),o=[v[0]];for(let i=1;i<v.length;i++)o.push(v[i]*k+o[i-1]*(1-k));return o;}
function sma(v,p){return v.map((_,i)=>i<p-1?null:v.slice(i-p+1,i+1).reduce((a,b)=>a+b,0)/p);}
function rsi(c,p=14){const o=new Array(c.length).fill(null);let g=0,l=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];d>0?g+=d:l-=d;}o[p]=l===0?100:100-100/(1+g/l);for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];if(d>0){g=(g*(p-1)+d)/p;l=l*(p-1)/p;}else{g=g*(p-1)/p;l=(l*(p-1)-d)/p;}o[i]=l===0?100:100-100/(1+g/l);}return o;}
function macd(c,f=12,s=26,sig=9){const fa=ema(c,f),sl=ema(c,s);const line=c.map((_,i)=>fa[i]-sl[i]);const signal=[line[0]];const k=2/(sig+1);for(let i=1;i<c.length;i++)signal.push(line[i]*k+signal[i-1]*(1-k));return{line,signal,hist:line.map((v,i)=>v-signal[i])};}

// ── v09 Simulator with all params configurable ──────────────────────────────

function v09Regime(i,closes,e21,e50,e200){if(!e200[i]||!e50[i]||!e21[i])return"neutral";const c=closes[i];let s=0;if(c>e200[i])s++;else s--;if(c>e50[i])s++;else s--;if(c>e21[i])s++;else s--;if(e21[i]>e50[i])s++;else s--;if(e50[i]>e200[i])s++;else s--;return s>=4?"bull":s<=-4?"bear":"neutral";}
function v09Risk(reg,dir,bal,riskPct,minRisk){const b=Math.max(bal*riskPct,minRisk);if(reg==="neutral")return b*0.75;const w=(reg==="bull"&&dir==="LONG")||(reg==="bear"&&dir==="SHORT");return w?b:b*0.5;}

function simulate(indicators, cfg) {
  let balance = START_BALANCE, peak = balance, maxDD = 0;
  const positions = []; const trades = [];
  const allTs = new Set();
  for (const sym of V09_PAIRS) { const ind = indicators[sym]; if (!ind) continue; for (const b of ind.bars) if (b.t/1000 >= START) allTs.add(b.t); }
  const sortedTs = [...allTs].sort((a,b)=>a-b);

  const tsMap = {};
  for (const sym of V09_PAIRS) { const ind = indicators[sym]; if (!ind) continue; tsMap[sym] = new Map(); for (let i = 0; i < ind.bars.length; i++) tsMap[sym].set(ind.bars[i].t, i); }

  function calcBullPct(ts) {
    let bulls=0,total=0;
    for (const sym of V09_PAIRS) { const ind = indicators[sym]; if (!ind) continue; const bi = tsMap[sym].get(ts); if (bi === undefined) continue; const r = v09Regime(bi, ind.closes, ind.e21, ind.e50, ind.e200); if (r==="bull") bulls++; total++; }
    return total ? (bulls/total)*100 : 0;
  }

  for (const ts of sortedTs) {
    // EXITS
    for (let p = positions.length-1; p >= 0; p--) {
      const pos = positions[p]; const ind = indicators[pos.sym]; if (!ind) continue;
      const bi = tsMap[pos.sym].get(ts); if (bi === undefined) continue;
      const bar = ind.bars[bi]; const isL = pos.dir==="LONG";
      let exitReason=null, exitPrice=null;
      if (pos.trailing) {
        if (isL && bar.h > pos.trailHigh) { pos.trailHigh=bar.h; pos.sl=bar.h*(1-cfg.trailPct); }
        else if (!isL && bar.l < pos.trailLow) { pos.trailLow=bar.l; pos.sl=bar.l*(1+cfg.trailPct); }
        const hitTrail = isL ? bar.l<=pos.sl : bar.h>=pos.sl;
        if (hitTrail) { exitReason="TRAIL_SL"; exitPrice=pos.sl; }
      } else {
        const hitSL = isL ? bar.l<=pos.sl : bar.h>=pos.sl;
        const hitTP = isL ? bar.h>=pos.tp : bar.l<=pos.tp;
        if (hitSL&&hitTP) { exitReason="SL"; exitPrice=pos.sl; }
        else if (hitSL)   { exitReason="SL"; exitPrice=pos.sl; }
        else if (hitTP && pos.noTrail) { exitReason="TP"; exitPrice=pos.tp; }
        else if (hitTP) { pos.trailing=true; pos.trailHigh=isL?pos.tp:Infinity; pos.trailLow=isL?0:pos.tp; pos.sl = isL ? pos.tp*(1-cfg.trailPct) : pos.tp*(1+cfg.trailPct); }
      }
      if (exitReason) {
        const raw = isL ? (exitPrice-pos.entryPrice)/pos.entryPrice*pos.size : (pos.entryPrice-exitPrice)/pos.entryPrice*pos.size;
        const grossPnl = raw;  // Option 1 sizing
        const fee = pos.size * FEE_PCT;
        const netPnl = grossPnl - fee;
        balance += netPnl;
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak * 100; if (dd>maxDD) maxDD=dd;
        trades.push({ net: netPnl, gross: grossPnl, fee, reason: exitReason });
        positions.splice(p, 1);
      }
    }
    // ENTRIES
    if (positions.length < cfg.maxPositions) {
      const bullPct = calcBullPct(ts);
      const trailActive = bullPct >= cfg.trailBullPct;
      for (const sym of V09_PAIRS) {
        if (positions.some(p=>p.sym===sym)) continue;
        const ind = indicators[sym]; if (!ind) continue;
        const bi = tsMap[sym].get(ts); if (bi === undefined || bi < 1) continue;
        const i = bi - 1;
        if (i < 22 || !ind.rsi[i] || !ind.rsi[i-1] || !ind.vsma[i] || !ind.e200[i]) continue;
        const c = ind.closes[i], rNow = ind.rsi[i], rPrv = ind.rsi[i-1], vol = ind.vols[i], reg = v09Regime(i, ind.closes, ind.e21, ind.e50, ind.e200);
        const highN = Math.max(...ind.closes.slice(Math.max(0,i-cfg.lookback),i));
        const trendUp = ind.e21[i]>ind.e50[i] && ind.e21[i]>ind.e21[i-1] && ind.e21[i-1]>ind.e21[i-3];
        const lBreak = c>highN && trendUp && rNow>=cfg.brsiMin && rNow<=cfg.brsiMax && vol>ind.vsma[i]*cfg.volMultBreak;
        const wasOB = [1,2,3,4,5].some(k=>ind.rsi[i-k]!=null&&ind.rsi[i-k]>=65);
        const rsiBrk = rPrv>=58 && rNow<58, macdBrk = ind.macd.hist[i-1]>=0 && ind.macd.hist[i]<0;
        const sBreak = wasOB && (rsiBrk||macdBrk) && c<ind.e21[i] && rNow>35 && vol>ind.vsma[i]*cfg.volMultShort;
        const wasOVB = [1,2,3].some(k=>ind.rsi[i-k]!=null&&ind.rsi[i-k]>=cfg.rsiOverbought);
        const rsiTurnD = rPrv>=70 && rNow<70;
        const sRebound = wasOVB && rsiTurnD && reg!=="bull" && c<ind.e21[i]*1.08 && vol>ind.vsma[i]*cfg.volMultReb && !sBreak;

        if (!lBreak && !sBreak && !sRebound) continue;
        let dir, isRebound;
        if (lBreak)        { dir="LONG";  isRebound=false; }
        else if (sBreak)   { dir="SHORT"; isRebound=false; }
        else               { dir="SHORT"; isRebound=true;  }
        const riskUSD = v09Risk(reg, dir, balance, cfg.riskPct, cfg.minRisk);
        const slPct = isRebound ? cfg.rebSlPct : cfg.slPct;
        const tpPct = isRebound ? cfg.rebTpPct : cfg.tpPct;
        const noTrail = !trailActive || isRebound;
        const entryP = ind.bars[bi].o;
        const size = riskUSD / slPct;
        const isL = dir==="LONG";
        const sl = isL ? entryP*(1-slPct) : entryP*(1+slPct);
        const tp = isL ? entryP*(1+tpPct) : entryP*(1-tpPct);
        positions.push({ sym, dir, entryPrice: entryP, sl, tp, size, riskUSD, trailing: false, noTrail, trailHigh: isL?tp:Infinity, trailLow: isL?0:tp });
        if (positions.length >= cfg.maxPositions) break;
      }
    }
  }
  for (const pos of positions) {
    const ind = indicators[pos.sym]; if (!ind) continue;
    const lastBar = ind.bars[ind.bars.length-1];
    const isL = pos.dir==="LONG";
    const raw = isL ? (lastBar.c-pos.entryPrice)/pos.entryPrice*pos.size : (pos.entryPrice-lastBar.c)/pos.entryPrice*pos.size;
    const grossPnl = raw;
    const fee = pos.size * FEE_PCT;
    const netPnl = grossPnl - fee;
    balance += netPnl;
    trades.push({ net: netPnl, gross: grossPnl, fee });
  }
  const wins = trades.filter(t=>t.net>0); const losses = trades.filter(t=>t.net<0);
  const winRate = trades.length ? wins.length/trades.length*100 : 0;
  const netW = wins.reduce((s,t)=>s+t.net,0); const netL = Math.abs(losses.reduce((s,t)=>s+t.net,0));
  const pf = netL>0 ? netW/netL : (wins.length?Infinity:0);
  const ret = (balance - START_BALANCE) / START_BALANCE * 100;
  return { balance, ret, maxDD, trades: trades.length, winRate, pf };
}

async function main() {
  const t0 = Date.now();
  const startDate = new Date(START*1000).toISOString().slice(0,10);
  const endDate = new Date().toISOString().slice(0,10);

  console.log("╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  v09 FULL PARAMETER SWEEP — 6 months                               ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`  Period:    ${startDate} → ${endDate}  (${DAYS} days)`);
  console.log(`  Capital:   $${START_BALANCE.toLocaleString()}`);
  console.log(`  Strategy:  v09 on 30 isolation-scored alts, 4H, Option 1 sizing`);
  console.log(`  Baseline:  SL=6.5%, TP=23%, Trail=19%, RSI 54-65, Lookback=30 → +30.7% return`);

  console.log("\n[1/1] Fetching v09 4H data (30 pairs)…");
  const data = {};
  const fetchStart = NOW_SEC - (DAYS + DEF.warmupDays) * 86400;
  for (const sym of V09_PAIRS) {
    process.stdout.write(`  ${sym}…`);
    data[sym] = await fetchAllBars(sym, "Hour4", 4*3600, fetchStart, NOW_SEC);
    process.stdout.write(`\r  ${sym.padEnd(20)} ${data[sym].length} bars ✓\n`);
    await sleep(130);
  }
  const ind = {};
  for (const sym of V09_PAIRS) {
    const bars = data[sym]; if (bars.length < 210) continue;
    const closes = bars.map(b=>b.c), vols=bars.map(b=>b.v);
    ind[sym] = { bars, closes, vols, e21: ema(closes,21), e50: ema(closes,50), e200: ema(closes,200), rsi: rsi(closes,14), macd: macd(closes), vsma: sma(vols,20) };
  }

  // Baseline
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  BASELINE (current live config)");
  console.log("══════════════════════════════════════════════════════════════");
  const base = simulate(ind, { ...DEF });
  console.log(`  Return: ${base.ret>=0?'+':''}${base.ret.toFixed(1)}%  |  MaxDD: ${base.maxDD.toFixed(1)}%  |  PF: ${base.pf===Infinity?'∞':base.pf.toFixed(2)}  |  Trades: ${base.trades}  |  WR: ${base.winRate.toFixed(1)}%`);

  // ─── SWEEP 1: SL × TP matrix ──────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  SWEEP 1 — SL × TP matrix (R:R ratio)");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  ${"SL%".padStart(5)} ${"TP%".padStart(5)} ${"R:R".padStart(5)} ${"Return".padStart(10)} ${"MaxDD".padStart(8)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"Trades".padStart(7)} ${"Risk-Adj".padStart(10)}`);
  console.log(`  ${"─".repeat(5)} ${"─".repeat(5)} ${"─".repeat(5)} ${"─".repeat(10)} ${"─".repeat(8)} ${"─".repeat(6)} ${"─".repeat(6)} ${"─".repeat(7)} ${"─".repeat(10)}`);
  const SL_VALS = [0.04, 0.05, 0.065, 0.08, 0.10];
  const TP_VALS = [0.15, 0.20, 0.23, 0.28, 0.35];
  const sweep1 = [];
  for (const sl of SL_VALS) {
    for (const tp of TP_VALS) {
      if (tp <= sl) continue; // skip nonsensical
      const r = simulate(ind, { ...DEF, slPct: sl, tpPct: tp });
      const ra = r.maxDD>0 ? r.ret/r.maxDD : (r.ret>0?Infinity:0);
      const retStr = `${r.ret>=0?'+':''}${r.ret.toFixed(1)}%`;
      console.log(`  ${(sl*100).toFixed(1).padStart(5)} ${(tp*100).toFixed(0).padStart(5)} ${(tp/sl).toFixed(1).padStart(5)} ${retStr.padStart(10)} ${(r.maxDD.toFixed(1)+'%').padStart(8)} ${(r.pf===Infinity?'∞':r.pf.toFixed(2)).padStart(6)} ${r.winRate.toFixed(1).padStart(6)} ${String(r.trades).padStart(7)} ${(isFinite(ra)?ra.toFixed(2):'∞').padStart(10)}`);
      sweep1.push({ sl, tp, ...r, ra });
    }
  }
  const best1 = [...sweep1].filter(r=>r.ret>0).sort((a,b)=>b.ra-a.ra)[0] || sweep1.sort((a,b)=>b.ret-a.ret)[0];
  console.log(`\n  🎯 Best SL/TP: SL=${(best1.sl*100).toFixed(1)}%, TP=${(best1.tp*100).toFixed(0)}%  →  ${best1.ret>=0?'+':''}${best1.ret.toFixed(1)}%, ${best1.maxDD.toFixed(1)}% DD, PF ${best1.pf===Infinity?'∞':best1.pf.toFixed(2)}, RA ${best1.ra.toFixed(2)}`);

  // ─── SWEEP 2: Trail % on best SL/TP ──────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log(`  SWEEP 2 — Trail % (using best SL=${(best1.sl*100).toFixed(1)}%, TP=${(best1.tp*100).toFixed(0)}%)`);
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  ${"Trail%".padStart(7)} ${"Return".padStart(10)} ${"MaxDD".padStart(8)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"Trades".padStart(7)} ${"Risk-Adj".padStart(10)}`);
  console.log(`  ${"─".repeat(7)} ${"─".repeat(10)} ${"─".repeat(8)} ${"─".repeat(6)} ${"─".repeat(6)} ${"─".repeat(7)} ${"─".repeat(10)}`);
  const TRAIL_VALS = [0.10, 0.13, 0.16, 0.19, 0.23, 0.27, 0.32];
  const sweep2 = [];
  for (const tr of TRAIL_VALS) {
    const r = simulate(ind, { ...DEF, slPct: best1.sl, tpPct: best1.tp, trailPct: tr });
    const ra = r.maxDD>0 ? r.ret/r.maxDD : (r.ret>0?Infinity:0);
    const retStr = `${r.ret>=0?'+':''}${r.ret.toFixed(1)}%`;
    console.log(`  ${(tr*100).toFixed(0).padStart(6)}% ${retStr.padStart(10)} ${(r.maxDD.toFixed(1)+'%').padStart(8)} ${(r.pf===Infinity?'∞':r.pf.toFixed(2)).padStart(6)} ${r.winRate.toFixed(1).padStart(6)} ${String(r.trades).padStart(7)} ${(isFinite(ra)?ra.toFixed(2):'∞').padStart(10)}`);
    sweep2.push({ trailPct: tr, ...r, ra });
  }
  const best2 = [...sweep2].filter(r=>r.ret>0).sort((a,b)=>b.ra-a.ra)[0] || sweep2.sort((a,b)=>b.ret-a.ret)[0];
  console.log(`\n  🎯 Best Trail%: ${(best2.trailPct*100).toFixed(0)}%  →  ${best2.ret>=0?'+':''}${best2.ret.toFixed(1)}%, ${best2.maxDD.toFixed(1)}% DD, PF ${best2.pf===Infinity?'∞':best2.pf.toFixed(2)}, RA ${best2.ra.toFixed(2)}`);

  // ─── SWEEP 3: Breakout RSI band ───────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log(`  SWEEP 3 — Breakout RSI band (using best SL/TP/Trail)`);
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  ${"RSI min".padStart(7)} ${"RSI max".padStart(7)} ${"Return".padStart(10)} ${"MaxDD".padStart(8)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"Trades".padStart(7)} ${"Risk-Adj".padStart(10)}`);
  console.log(`  ${"─".repeat(7)} ${"─".repeat(7)} ${"─".repeat(10)} ${"─".repeat(8)} ${"─".repeat(6)} ${"─".repeat(6)} ${"─".repeat(7)} ${"─".repeat(10)}`);
  const sweep3 = [];
  for (const lo of [48, 52, 54, 58]) {
    for (const hi of [62, 65, 70, 75]) {
      if (hi <= lo) continue;
      const r = simulate(ind, { ...DEF, slPct: best1.sl, tpPct: best1.tp, trailPct: best2.trailPct, brsiMin: lo, brsiMax: hi });
      const ra = r.maxDD>0 ? r.ret/r.maxDD : (r.ret>0?Infinity:0);
      const retStr = `${r.ret>=0?'+':''}${r.ret.toFixed(1)}%`;
      console.log(`  ${String(lo).padStart(7)} ${String(hi).padStart(7)} ${retStr.padStart(10)} ${(r.maxDD.toFixed(1)+'%').padStart(8)} ${(r.pf===Infinity?'∞':r.pf.toFixed(2)).padStart(6)} ${r.winRate.toFixed(1).padStart(6)} ${String(r.trades).padStart(7)} ${(isFinite(ra)?ra.toFixed(2):'∞').padStart(10)}`);
      sweep3.push({ brsiMin: lo, brsiMax: hi, ...r, ra });
    }
  }
  const best3 = [...sweep3].filter(r=>r.ret>0).sort((a,b)=>b.ra-a.ra)[0] || sweep3.sort((a,b)=>b.ret-a.ret)[0];
  console.log(`\n  🎯 Best RSI band: ${best3.brsiMin}-${best3.brsiMax}  →  ${best3.ret>=0?'+':''}${best3.ret.toFixed(1)}%, ${best3.maxDD.toFixed(1)}% DD`);

  // ─── SWEEP 4: Lookback ────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log(`  SWEEP 4 — Breakout lookback bars`);
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  ${"Lookback".padStart(8)} ${"Return".padStart(10)} ${"MaxDD".padStart(8)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"Trades".padStart(7)} ${"Risk-Adj".padStart(10)}`);
  console.log(`  ${"─".repeat(8)} ${"─".repeat(10)} ${"─".repeat(8)} ${"─".repeat(6)} ${"─".repeat(6)} ${"─".repeat(7)} ${"─".repeat(10)}`);
  const sweep4 = [];
  for (const lb of [15, 20, 25, 30, 40, 50, 70]) {
    const r = simulate(ind, { ...DEF, slPct: best1.sl, tpPct: best1.tp, trailPct: best2.trailPct, brsiMin: best3.brsiMin, brsiMax: best3.brsiMax, lookback: lb });
    const ra = r.maxDD>0 ? r.ret/r.maxDD : (r.ret>0?Infinity:0);
    const retStr = `${r.ret>=0?'+':''}${r.ret.toFixed(1)}%`;
    console.log(`  ${String(lb).padStart(8)} ${retStr.padStart(10)} ${(r.maxDD.toFixed(1)+'%').padStart(8)} ${(r.pf===Infinity?'∞':r.pf.toFixed(2)).padStart(6)} ${r.winRate.toFixed(1).padStart(6)} ${String(r.trades).padStart(7)} ${(isFinite(ra)?ra.toFixed(2):'∞').padStart(10)}`);
    sweep4.push({ lookback: lb, ...r, ra });
  }
  const best4 = [...sweep4].filter(r=>r.ret>0).sort((a,b)=>b.ra-a.ra)[0] || sweep4.sort((a,b)=>b.ret-a.ret)[0];
  console.log(`\n  🎯 Best Lookback: ${best4.lookback} bars  →  ${best4.ret>=0?'+':''}${best4.ret.toFixed(1)}%, ${best4.maxDD.toFixed(1)}% DD`);

  // ─── FINAL OPTIMUM ────────────────────────────────────────────────────────
  console.log("\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  COMBINED OPTIMUM                                                   ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  const final = simulate(ind, { ...DEF, slPct: best1.sl, tpPct: best1.tp, trailPct: best2.trailPct, brsiMin: best3.brsiMin, brsiMax: best3.brsiMax, lookback: best4.lookback });
  console.log(`\n  Optimal config:`);
  console.log(`     SL:         ${(best1.sl*100).toFixed(1)}%   (was 6.5%)`);
  console.log(`     TP:         ${(best1.tp*100).toFixed(0)}%   (was 23%)`);
  console.log(`     R:R:        ${(best1.tp/best1.sl).toFixed(1)}:1`);
  console.log(`     Trail:      ${(best2.trailPct*100).toFixed(0)}%   (was 19%)`);
  console.log(`     RSI band:   ${best3.brsiMin}-${best3.brsiMax}   (was 54-65)`);
  console.log(`     Lookback:   ${best4.lookback} bars   (was 30)`);

  console.log(`\n  ── Performance comparison ──`);
  console.log(`     ${"Metric".padEnd(15)} ${"Baseline".padStart(12)} ${"Optimized".padStart(12)} ${"Δ".padStart(10)}`);
  console.log(`     ${"─".repeat(15)} ${"─".repeat(12)} ${"─".repeat(12)} ${"─".repeat(10)}`);
  console.log(`     ${"Return".padEnd(15)} ${(base.ret.toFixed(1)+'%').padStart(12)} ${(final.ret.toFixed(1)+'%').padStart(12)} ${((final.ret-base.ret).toFixed(1)+'%').padStart(10)}`);
  console.log(`     ${"Max DD".padEnd(15)} ${(base.maxDD.toFixed(1)+'%').padStart(12)} ${(final.maxDD.toFixed(1)+'%').padStart(12)} ${((final.maxDD-base.maxDD).toFixed(1)+'%').padStart(10)}`);
  console.log(`     ${"Profit Factor".padEnd(15)} ${(base.pf===Infinity?'∞':base.pf.toFixed(2)).padStart(12)} ${(final.pf===Infinity?'∞':final.pf.toFixed(2)).padStart(12)}`);
  console.log(`     ${"Win Rate".padEnd(15)} ${(base.winRate.toFixed(1)+'%').padStart(12)} ${(final.winRate.toFixed(1)+'%').padStart(12)}`);
  console.log(`     ${"Trades".padEnd(15)} ${String(base.trades).padStart(12)} ${String(final.trades).padStart(12)}`);

  const baseNet = (base.balance - START_BALANCE);
  const finalNet = (final.balance - START_BALANCE);
  const lift = finalNet - baseNet;
  console.log(`\n  ── 6-month $$ comparison (on $${START_BALANCE.toLocaleString()}) ──`);
  console.log(`     Baseline net:  ${baseNet>=0?'+':''}$${baseNet.toFixed(0)}`);
  console.log(`     Optimized net: ${finalNet>=0?'+':''}$${finalNet.toFixed(0)}`);
  console.log(`     Improvement:   ${lift>=0?'+':''}$${lift.toFixed(0)}  (${lift>=0?'+':''}${((lift/Math.abs(baseNet||1))*100).toFixed(0)}%)`);

  const mins = ((Date.now()-t0)/60000).toFixed(1);
  console.log(`\n  Sweep time: ${mins} min\n`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
