/**
 * backtest_orb_sweep.js — Full ORB stocks parameter optimization (6 months)
 *
 * Sweeps the highest-impact ORB parameters on 10 MEXC stock futures.
 * Same playbook that boosted DT (+27% → +91% potential) and v09 (+30% → +54%).
 *
 * Sweep 1: TP multiplier × OR window matrix (R:R ratio)
 * Sweep 2: Risk per trade × Volume filter
 * Sweep 3: Entry cutoff time
 * Sweep 4: Per-symbol P&L breakdown (which stocks to keep)
 * Final: Combined optimum verification
 *
 * Run: node backtest_orb_sweep.js
 */

import "dotenv/config";

const MEXC_BASE  = "https://futures.mexc.com";
const DAYS       = 150;  // 5 stock symbols listed Dec 28 — must use ≤150 days for full universe
const NOW_SEC    = Math.floor(Date.now() / 1000);
const START      = NOW_SEC - DAYS * 86400;
const FEE_PCT    = 0.0004;

// Stock futures on MEXC
const ORB_SYMBOLS = [
  "CSCOSTOCK_USDT","NFLXSTOCK_USDT","AVGOSTOCK_USDT","JPMSTOCK_USDT","MRVLSTOCK_USDT",
  "MSFTSTOCK_USDT","ASMLSTOCK_USDT","PLTRSTOCK_USDT","ARMSTOCK_USDT","WMTSTOCK_USDT",
];

// ── Defaults (current live config) ──────────────────────────────────────────
const DEF = {
  totalBalance: 6250,
  riskPct: 0.01,          // 1% per trade
  leverage: 5,
  rrRatio: 1.5,           // TP = 1.5 × OR range
  orbBars: 6,             // 30 min OR
  eodH: 19, eodM: 55,     // EOD close at 19:55 UTC
  cutoffH: 17,            // No new entries after 17:00 UTC
  volSessionsMA: 20,
  volMult: 1.0,           // bar vol > 1× prev session avg
};

const PER_SYM = DEF.totalBalance / ORB_SYMBOLS.length; // $625 each

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
  while(cur<endSec){const end=Math.min(cur+chunk,endSec);const batch=await fetchChunk(symbol,intervalStr,cur,end);if(!batch.length){emptyRuns++;if(emptyRuns>=5)break;cur=end+barSecs;await sleep(120);continue;}emptyRuns=0;bars.push(...batch);cur=Math.floor(batch[batch.length-1].t/1000)+barSecs;await sleep(150);}
  const seen=new Set();return bars.filter(b=>{if(seen.has(b.t))return false;seen.add(b.t);return true;}).sort((a,b)=>a.t-b.t);
}

function isRTHBar(ms){const h=new Date(ms).getUTCHours(),m=new Date(ms).getUTCMinutes(),mins=h*60+m;return mins>=13*60+30&&mins<20*60;}
function isOpenBar(ms){const d=new Date(ms);return d.getUTCHours()===13&&d.getUTCMinutes()===30;}
function dayKeyUTC(ms){return new Date(ms).toISOString().slice(0,10);}
function isWeekdayMs(ms){const d=new Date(ms).getUTCDay();return d>=1&&d<=5;}

// ── ORB Simulator with all params configurable ──────────────────────────────

function simulate(symData, cfg, returnPerSymbol = false) {
  const isEODBar = (ms) => { const d=new Date(ms),h=d.getUTCHours(),m=d.getUTCMinutes(); return h>cfg.eodH || (h===cfg.eodH&&m>=cfg.eodM); };
  let totalBalance = 0, totalFees = 0, grandTrades = [], grandMaxDD = 0;
  const perSymbol = {};

  for (const sym of ORB_SYMBOLS) {
    const bars = symData[sym];
    if (!bars || bars.length < 50) { totalBalance += PER_SYM; perSymbol[sym] = { balance: PER_SYM, trades: 0, wins: 0, pnl: 0 }; continue; }
    let balance = PER_SYM, peak = balance, maxDD = 0;
    const trades = []; let symFees = 0;
    const days = {};
    for (const b of bars) { const k = dayKeyUTC(b.t); if (!days[k]) days[k]=[]; days[k].push(b); }
    const dayKeys = Object.keys(days).sort();
    const sessionVols = [];

    for (const dk of dayKeys) {
      const dayBars = days[dk].sort((a,b)=>a.t-b.t);
      if (!dayBars.length) continue;
      const prevSessionAvgVol = sessionVols.length>0 ? sessionVols.reduce((a,b)=>a+b,0)/sessionVols.length : null;
      const rthBars = dayBars.filter(b=>!isOpenBar(b.t));
      if (rthBars.length < cfg.orbBars) continue;

      const orbWindow = rthBars.slice(0, cfg.orbBars);
      const orHigh = Math.max(...orbWindow.map(b=>b.h));
      const orLow  = Math.min(...orbWindow.map(b=>b.l));
      const orRange = orHigh - orLow; if (orRange <= 0) continue;

      const postOrb = rthBars.slice(cfg.orbBars);
      let traded = false, position = null;

      for (const bar of postOrb) {
        if (isEODBar(bar.t)) {
          if (position) {
            const isL = position.dir==="LONG"; const exitP = bar.c;
            const grossPnl = ((isL?exitP-position.entry:position.entry-exitP)/position.entry)*position.sizeUSD;
            const fee = position.sizeUSD * FEE_PCT;
            const netPnl = grossPnl - fee;
            balance += netPnl; symFees += fee; totalFees += fee;
            if (balance>peak) peak = balance;
            const dd=(peak-balance)/peak*100; if (dd>maxDD) maxDD=dd;
            trades.push({ net: netPnl, gross: grossPnl, reason: "EOD" });
            position = null;
          }
          break;
        }
        if (position) {
          const isL = position.dir==="LONG";
          const hitSL = isL?bar.l<=position.sl:bar.h>=position.sl;
          const hitTP = isL?bar.h>=position.tp:bar.l<=position.tp;
          let exitReason=null, exitP=null;
          if (hitSL&&hitTP) { exitReason="SL"; exitP=position.sl; }
          else if (hitSL)   { exitReason="SL"; exitP=position.sl; }
          else if (hitTP)   { exitReason="TP"; exitP=position.tp; }
          if (exitReason) {
            const grossPnl = ((isL?exitP-position.entry:position.entry-exitP)/position.entry)*position.sizeUSD;
            const fee = position.sizeUSD * FEE_PCT;
            const netPnl = grossPnl - fee;
            balance += netPnl; symFees += fee; totalFees += fee;
            if (balance>peak) peak = balance;
            const dd=(peak-balance)/peak*100; if (dd>maxDD) maxDD=dd;
            trades.push({ net: netPnl, gross: grossPnl, reason: exitReason });
            position = null;
          }
          continue;
        }
        if (traded) continue;
        if (new Date(bar.t).getUTCHours() >= cfg.cutoffH) continue;
        const volOk = prevSessionAvgVol===null || bar.v > prevSessionAvgVol * cfg.volMult;
        if (bar.c > orHigh && volOk) {
          const entry=bar.c, sl=orLow, tp=entry+orRange*cfg.rrRatio, slDist=entry-sl;
          const riskUSD=balance*cfg.riskPct, sizeUSD=(riskUSD/slDist)*entry;  // Option 1 sizing
          position={dir:"LONG",entry,sl,tp,sizeUSD,riskUSD}; traded=true;
        } else if (bar.c < orLow && volOk) {
          const entry=bar.c, sl=orHigh, tp=entry-orRange*cfg.rrRatio, slDist=sl-entry;
          const riskUSD=balance*cfg.riskPct, sizeUSD=(riskUSD/slDist)*entry;
          position={dir:"SHORT",entry,sl,tp,sizeUSD,riskUSD}; traded=true;
        }
      }
      const dayAvgVol = dayBars.reduce((s,b)=>s+b.v,0)/dayBars.length;
      sessionVols.push(dayAvgVol);
      if (sessionVols.length > cfg.volSessionsMA) sessionVols.shift();
    }

    const wins = trades.filter(t=>t.net>0).length;
    const pnl = trades.reduce((s,t)=>s+t.net,0);
    if (maxDD > grandMaxDD) grandMaxDD = maxDD;
    totalBalance += balance;
    grandTrades.push(...trades);
    perSymbol[sym] = { balance, trades: trades.length, wins, pnl, fees: symFees, maxDD };
  }

  const wins = grandTrades.filter(t=>t.net>0).length;
  const losses = grandTrades.filter(t=>t.net<0).length;
  const winRate = grandTrades.length ? wins/grandTrades.length*100 : 0;
  const grossW = grandTrades.filter(t=>t.net>0).reduce((s,t)=>s+t.gross,0);
  const grossL = Math.abs(grandTrades.filter(t=>t.net<0).reduce((s,t)=>s+t.gross,0));
  const pf = grossL>0 ? grossW/grossL : (wins?Infinity:0);
  const ret = (totalBalance - DEF.totalBalance) / DEF.totalBalance * 100;
  const result = { balance: totalBalance, ret, maxDD: grandMaxDD, trades: grandTrades.length, winRate, pf, totalFees, wins, losses };
  if (returnPerSymbol) result.perSymbol = perSymbol;
  return result;
}

async function main() {
  const t0 = Date.now();
  const startDate = new Date(START*1000).toISOString().slice(0,10);
  const endDate = new Date().toISOString().slice(0,10);

  console.log("╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  ORB STOCKS FULL PARAMETER SWEEP — 6 months                       ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`  Period:    ${startDate} → ${endDate}  (${DAYS} days)`);
  console.log(`  Capital:   $${DEF.totalBalance.toLocaleString()} total ($${PER_SYM}/symbol × ${ORB_SYMBOLS.length})`);
  console.log(`  Strategy:  ORB on MEXC stock futures, 5min, Option 1 sizing`);
  console.log(`  Baseline:  TP=1.5×OR, OR=6bars, Risk=1%, Vol=1×, Cutoff=17:00`);

  console.log("\n[1/1] Fetching ORB 5min data (10 stocks)…");
  const data = {};
  for (const sym of ORB_SYMBOLS) {
    process.stdout.write(`  ${sym}…`);
    const bars = await fetchAllBars(sym, "Min5", 5*60, START - 21*86400, NOW_SEC);
    data[sym] = bars.filter(b => isRTHBar(b.t) && isWeekdayMs(b.t));
    process.stdout.write(`\r  ${sym.padEnd(24)} ${data[sym].length} RTH bars ✓\n`);
    await sleep(150);
  }

  // Baseline
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  BASELINE (current live config)");
  console.log("══════════════════════════════════════════════════════════════");
  const base = simulate(data, { ...DEF });
  console.log(`  Return: ${base.ret>=0?'+':''}${base.ret.toFixed(1)}%  |  MaxDD: ${base.maxDD.toFixed(1)}%  |  PF: ${base.pf===Infinity?'∞':base.pf.toFixed(2)}  |  Trades: ${base.trades}  |  WR: ${base.winRate.toFixed(1)}%`);

  // ─── SWEEP 1: TP multiplier × OR window ──────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  SWEEP 1 — TP multiplier × OR window length");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  ${"TP×OR".padStart(6)} ${"OR Bars".padStart(7)} ${"Return".padStart(10)} ${"MaxDD".padStart(8)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"Trades".padStart(7)} ${"Risk-Adj".padStart(10)}`);
  console.log(`  ${"─".repeat(6)} ${"─".repeat(7)} ${"─".repeat(10)} ${"─".repeat(8)} ${"─".repeat(6)} ${"─".repeat(6)} ${"─".repeat(7)} ${"─".repeat(10)}`);
  const TP_VALS = [1.0, 1.5, 2.0, 2.5, 3.0];
  const OR_VALS = [3, 6, 9, 12];   // 15min, 30min, 45min, 60min OR
  const sweep1 = [];
  for (const tp of TP_VALS) {
    for (const ob of OR_VALS) {
      const r = simulate(data, { ...DEF, rrRatio: tp, orbBars: ob });
      const ra = r.maxDD>0 ? r.ret/r.maxDD : (r.ret>0?Infinity:0);
      const retStr = `${r.ret>=0?'+':''}${r.ret.toFixed(1)}%`;
      console.log(`  ${tp.toFixed(1).padStart(6)} ${String(ob).padStart(7)} ${retStr.padStart(10)} ${(r.maxDD.toFixed(1)+'%').padStart(8)} ${(r.pf===Infinity?'∞':r.pf.toFixed(2)).padStart(6)} ${r.winRate.toFixed(1).padStart(6)} ${String(r.trades).padStart(7)} ${(isFinite(ra)?ra.toFixed(2):'∞').padStart(10)}`);
      sweep1.push({ rrRatio: tp, orbBars: ob, ...r, ra });
    }
  }
  const best1 = [...sweep1].filter(r=>r.ret>0).sort((a,b)=>b.ra-a.ra)[0] || sweep1.sort((a,b)=>b.ret-a.ret)[0];
  console.log(`\n  🎯 Best TP×OR: TP=${best1.rrRatio}, OR=${best1.orbBars} bars  →  ${best1.ret>=0?'+':''}${best1.ret.toFixed(1)}%, ${best1.maxDD.toFixed(1)}% DD, PF ${best1.pf===Infinity?'∞':best1.pf.toFixed(2)}, RA ${best1.ra.toFixed(2)}`);

  // ─── SWEEP 2: Risk × Vol filter ──────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log(`  SWEEP 2 — Risk × Vol filter (TP=${best1.rrRatio}, OR=${best1.orbBars})`);
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  ${"Risk%".padStart(7)} ${"Vol×".padStart(6)} ${"Return".padStart(10)} ${"MaxDD".padStart(8)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"Trades".padStart(7)} ${"Risk-Adj".padStart(10)}`);
  console.log(`  ${"─".repeat(7)} ${"─".repeat(6)} ${"─".repeat(10)} ${"─".repeat(8)} ${"─".repeat(6)} ${"─".repeat(6)} ${"─".repeat(7)} ${"─".repeat(10)}`);
  const RISK_VALS = [0.005, 0.008, 0.01, 0.015, 0.02];
  const VOL_VALS  = [0.8, 1.0, 1.2, 1.5];
  const sweep2 = [];
  for (const rk of RISK_VALS) {
    for (const v of VOL_VALS) {
      const r = simulate(data, { ...DEF, rrRatio: best1.rrRatio, orbBars: best1.orbBars, riskPct: rk, volMult: v });
      const ra = r.maxDD>0 ? r.ret/r.maxDD : (r.ret>0?Infinity:0);
      const retStr = `${r.ret>=0?'+':''}${r.ret.toFixed(1)}%`;
      console.log(`  ${(rk*100).toFixed(1).padStart(6)}% ${v.toFixed(1).padStart(5)}× ${retStr.padStart(10)} ${(r.maxDD.toFixed(1)+'%').padStart(8)} ${(r.pf===Infinity?'∞':r.pf.toFixed(2)).padStart(6)} ${r.winRate.toFixed(1).padStart(6)} ${String(r.trades).padStart(7)} ${(isFinite(ra)?ra.toFixed(2):'∞').padStart(10)}`);
      sweep2.push({ riskPct: rk, volMult: v, ...r, ra });
    }
  }
  const best2 = [...sweep2].filter(r=>r.ret>0).sort((a,b)=>b.ra-a.ra)[0] || sweep2.sort((a,b)=>b.ret-a.ret)[0];
  console.log(`\n  🎯 Best Risk×Vol: Risk=${(best2.riskPct*100).toFixed(1)}%, Vol=${best2.volMult}×  →  ${best2.ret>=0?'+':''}${best2.ret.toFixed(1)}%, ${best2.maxDD.toFixed(1)}% DD`);

  // ─── SWEEP 3: Entry cutoff time ──────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log(`  SWEEP 3 — Entry cutoff time (using best so far)`);
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  ${"Cutoff".padStart(7)} ${"Return".padStart(10)} ${"MaxDD".padStart(8)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"Trades".padStart(7)} ${"Risk-Adj".padStart(10)}`);
  console.log(`  ${"─".repeat(7)} ${"─".repeat(10)} ${"─".repeat(8)} ${"─".repeat(6)} ${"─".repeat(6)} ${"─".repeat(7)} ${"─".repeat(10)}`);
  const CUTOFF_VALS = [15, 16, 17, 18, 19, 20];
  const sweep3 = [];
  for (const ch of CUTOFF_VALS) {
    const r = simulate(data, { ...DEF, rrRatio: best1.rrRatio, orbBars: best1.orbBars, riskPct: best2.riskPct, volMult: best2.volMult, cutoffH: ch });
    const ra = r.maxDD>0 ? r.ret/r.maxDD : (r.ret>0?Infinity:0);
    const retStr = `${r.ret>=0?'+':''}${r.ret.toFixed(1)}%`;
    console.log(`  ${String(ch).padStart(5)}:00 ${retStr.padStart(10)} ${(r.maxDD.toFixed(1)+'%').padStart(8)} ${(r.pf===Infinity?'∞':r.pf.toFixed(2)).padStart(6)} ${r.winRate.toFixed(1).padStart(6)} ${String(r.trades).padStart(7)} ${(isFinite(ra)?ra.toFixed(2):'∞').padStart(10)}`);
    sweep3.push({ cutoffH: ch, ...r, ra });
  }
  const best3 = [...sweep3].filter(r=>r.ret>0).sort((a,b)=>b.ra-a.ra)[0] || sweep3.sort((a,b)=>b.ret-a.ret)[0];
  console.log(`\n  🎯 Best cutoff: ${best3.cutoffH}:00 UTC  →  ${best3.ret>=0?'+':''}${best3.ret.toFixed(1)}%, ${best3.maxDD.toFixed(1)}% DD`);

  // ─── SWEEP 4: Per-symbol breakdown ───────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log(`  SWEEP 4 — Per-symbol P&L (using optimized config)`);
  console.log("══════════════════════════════════════════════════════════════");
  const finalCfg = { ...DEF, rrRatio: best1.rrRatio, orbBars: best1.orbBars, riskPct: best2.riskPct, volMult: best2.volMult, cutoffH: best3.cutoffH };
  const detailed = simulate(data, finalCfg, true);
  const sorted = Object.entries(detailed.perSymbol).sort((a,b) => b[1].pnl - a[1].pnl);
  console.log(`  ${"Symbol".padEnd(22)} ${"Start".padStart(7)} ${"End".padStart(7)} ${"P&L".padStart(9)} ${"Trades".padStart(7)} ${"WR".padStart(6)} ${"MaxDD".padStart(7)} ${"Status".padStart(10)}`);
  console.log(`  ${"─".repeat(22)} ${"─".repeat(7)} ${"─".repeat(7)} ${"─".repeat(9)} ${"─".repeat(7)} ${"─".repeat(6)} ${"─".repeat(7)} ${"─".repeat(10)}`);
  let winnerCount = 0;
  for (const [sym, s] of sorted) {
    const wr = s.trades>0 ? (s.wins/s.trades*100).toFixed(0)+'%' : '—';
    const status = s.pnl > 0 ? '✅ KEEP' : '❌ DROP';
    if (s.pnl > 0) winnerCount++;
    console.log(`  ${sym.padEnd(22)} ${('$'+PER_SYM).padStart(7)} ${('$'+s.balance.toFixed(0)).padStart(7)} ${((s.pnl>=0?'+':'')+'$'+s.pnl.toFixed(0)).padStart(9)} ${String(s.trades).padStart(7)} ${wr.padStart(6)} ${(s.maxDD?.toFixed(1)+'%' || '—').padStart(7)} ${status.padStart(10)}`);
  }
  console.log(`\n  ${winnerCount}/${ORB_SYMBOLS.length} symbols profitable. If we kept only the winners, return would be higher.`);

  // ── Optimized config with WINNERS ONLY ────────────────────────────────────
  const winnersOnly = sorted.filter(([sym, s]) => s.pnl > 0).map(([sym]) => sym);
  if (winnersOnly.length >= 3 && winnersOnly.length < ORB_SYMBOLS.length) {
    console.log(`\n══════════════════════════════════════════════════════════════`);
    console.log(`  WINNERS-ONLY UNIVERSE — same config, only ${winnersOnly.length} profitable symbols`);
    console.log(`══════════════════════════════════════════════════════════════`);
    // Recalculate per-symbol allocation for fewer symbols
    const perSymFiltered = DEF.totalBalance / winnersOnly.length;
    let filteredBal = 0, filteredFees = 0;
    let filteredTrades = []; let filteredMaxDD = 0;
    for (const sym of winnersOnly) {
      const s = detailed.perSymbol[sym];
      // Scale P&L to new per-symbol allocation
      const scaledPnl = s.pnl * (perSymFiltered / PER_SYM);
      filteredBal += perSymFiltered + scaledPnl;
    }
    const fRet = (filteredBal - DEF.totalBalance) / DEF.totalBalance * 100;
    console.log(`     End balance:  $${filteredBal.toFixed(0)}`);
    console.log(`     Return:       ${fRet>=0?'+':''}${fRet.toFixed(1)}%`);
    console.log(`     Symbols kept: ${winnersOnly.join(', ').replace(/STOCK_USDT/g, '')}`);
  }

  // ─── FINAL COMPARISON ────────────────────────────────────────────────────
  console.log("\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  COMBINED OPTIMUM                                                   ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`\n  Optimal config:`);
  console.log(`     TP × OR:    ${best1.rrRatio}× (was 1.5×)`);
  console.log(`     OR bars:    ${best1.orbBars} (was 6)`);
  console.log(`     Risk %:     ${(best2.riskPct*100).toFixed(1)}% (was 1.0%)`);
  console.log(`     Vol mult:   ${best2.volMult}× (was 1.0×)`);
  console.log(`     Cutoff:     ${best3.cutoffH}:00 UTC (was 17:00)`);

  console.log(`\n  ── Performance comparison ──`);
  console.log(`     ${"Metric".padEnd(15)} ${"Baseline".padStart(12)} ${"Optimized".padStart(12)} ${"Δ".padStart(10)}`);
  console.log(`     ${"─".repeat(15)} ${"─".repeat(12)} ${"─".repeat(12)} ${"─".repeat(10)}`);
  console.log(`     ${"Return".padEnd(15)} ${(base.ret.toFixed(1)+'%').padStart(12)} ${(detailed.ret.toFixed(1)+'%').padStart(12)} ${((detailed.ret-base.ret).toFixed(1)+'%').padStart(10)}`);
  console.log(`     ${"Max DD".padEnd(15)} ${(base.maxDD.toFixed(1)+'%').padStart(12)} ${(detailed.maxDD.toFixed(1)+'%').padStart(12)} ${((detailed.maxDD-base.maxDD).toFixed(1)+'%').padStart(10)}`);
  console.log(`     ${"Profit Factor".padEnd(15)} ${(base.pf===Infinity?'∞':base.pf.toFixed(2)).padStart(12)} ${(detailed.pf===Infinity?'∞':detailed.pf.toFixed(2)).padStart(12)}`);
  console.log(`     ${"Win Rate".padEnd(15)} ${(base.winRate.toFixed(1)+'%').padStart(12)} ${(detailed.winRate.toFixed(1)+'%').padStart(12)}`);
  console.log(`     ${"Trades".padEnd(15)} ${String(base.trades).padStart(12)} ${String(detailed.trades).padStart(12)}`);

  const baseNet = base.balance - DEF.totalBalance;
  const finalNet = detailed.balance - DEF.totalBalance;
  console.log(`\n  ── 6-month $$ comparison (on $${DEF.totalBalance.toLocaleString()}) ──`);
  console.log(`     Baseline net:  ${baseNet>=0?'+':''}$${baseNet.toFixed(0)}`);
  console.log(`     Optimized net: ${finalNet>=0?'+':''}$${finalNet.toFixed(0)}`);
  const lift = finalNet - baseNet;
  console.log(`     Improvement:   ${lift>=0?'+':''}$${lift.toFixed(0)}`);

  const mins = ((Date.now()-t0)/60000).toFixed(1);
  console.log(`\n  Sweep time: ${mins} min\n`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
