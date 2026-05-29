/**
 * backtest_gp_walkforward.js — Golden Pocket walk-forward validation
 *
 * Tests the Golden Pocket strategy on 15 crypto pairs across 4 non-overlapping
 * 3-month windows (12 months total) to identify:
 *   - All-weather pairs (profitable in 4/4 windows) = real edge
 *   - Regime-dependent pairs (profitable in 2-3/4)
 *   - Curve-fit pairs (only profitable recently)
 *   - Pairs to drop entirely
 *
 * Each pair × window simulation is INDEPENDENT (single-pair, full $5000 alloc).
 * This isolates per-pair edge without position-cap interference.
 *
 * Run: node backtest_gp_walkforward.js
 */

import "dotenv/config";

const MEXC_BASE = "https://futures.mexc.com";
const NOW_SEC   = Math.floor(Date.now() / 1000);
const FEE_PCT   = 0.0004;

// 4 non-overlapping 90-day windows
const WINDOWS = [
  { name: "W1 (recent)",    daysAgo: 90,  daysBack: 0   },   // 0-90  days ago
  { name: "W2 (q3 2025-q1)", daysAgo: 180, daysBack: 90  },   // 90-180 days ago
  { name: "W3 (autumn 25)", daysAgo: 270, daysBack: 180 },   // 180-270 days ago
  { name: "W4 (summer 25)", daysAgo: 365, daysBack: 270 },   // 270-365 days ago
];

// 15-pair universe (12 original + 3 new from v09 list)
const PAIRS = [
  "SUI_USDT", "AVAX_USDT", "ONDO_USDT",
  "ENA_USDT", "TIA_USDT", "WIF_USDT",
  "WLD_USDT", "JUP_USDT", "FILECOIN_USDT",
  "AR_USDT", "AIXBT_USDT", "S_USDT",
  // Adding 3 more from v09 top-30
  "BCH_USDT", "KAIA_USDT", "RUNE_USDT",
];

const CFG = {
  startBalance:       5000,
  riskPct:            0.005,
  leverage:           5,
  rrRatio:            1.6,
  maxHoldBars:        192,
  pendingMaxBars:     96,
  maxPositions:       1,      // single-pair: only 1 position at a time
  impulseLookback:    6,
  impulseMinPct:      0.025,
  structureLookback:  20,
  fibEntry:           0.618,
  fibInvalidate:      0.786,
  slBufferPct:        0.005,
  sessionStartH:      13,
  sessionEndH:        18,
  htfEMAfast:         21,
  htfEMAslow:         50,
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
  while(cur<endSec){const end=Math.min(cur+chunk,endSec);const batch=await fetchChunk(symbol,intervalStr,cur,end);if(!batch.length){emptyRuns++;if(emptyRuns>=15)break;cur=end+barSecs;await sleep(120);continue;}emptyRuns=0;bars.push(...batch);cur=Math.floor(batch[batch.length-1].t/1000)+barSecs;await sleep(120);}
  const seen=new Set();return bars.filter(b=>{if(seen.has(b.t))return false;seen.add(b.t);return true;}).sort((a,b)=>a.t-b.t);
}
function ema(values, period) {
  const k = 2/(period+1), out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i]*k + out[i-1]*(1-k));
  return out;
}
function build1HTrend(bars15) {
  const hourly = {};
  for (const b of bars15) {
    const d = new Date(b.t);
    const k = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}`;
    if (!hourly[k]) hourly[k] = { t: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())).getTime(), c: b.c };
    else hourly[k].c = b.c;
  }
  const hours = Object.values(hourly).sort((a,b)=>a.t-b.t);
  const closes = hours.map(h=>h.c);
  const e21 = ema(closes, CFG.htfEMAfast);
  const e50 = ema(closes, CFG.htfEMAslow);
  return hours.map((h,i) => ({ t: h.t, trend: e21[i] != null && e50[i] != null ? (e21[i] > e50[i] ? "UP" : "DOWN") : "NEUTRAL" }));
}
function lookup1HTrend(trendArr, ts) {
  const oneHour = 3600 * 1000;
  let lo = 0, hi = trendArr.length-1, result = "NEUTRAL";
  while (lo <= hi) { const mid = (lo+hi)>>1; if (trendArr[mid].t + oneHour <= ts) { result = trendArr[mid].trend; lo = mid+1; } else hi = mid-1; }
  return result;
}
function inSession(ts) {
  const h = new Date(ts).getUTCHours();
  return h >= CFG.sessionStartH && h < CFG.sessionEndH;
}
function detectImpulse(bars, i) {
  if (i < CFG.impulseLookback + CFG.structureLookback) return null;
  const window = bars.slice(i - CFG.impulseLookback + 1, i + 1);
  const wH = Math.max(...window.map(b=>b.h));
  const wL = Math.min(...window.map(b=>b.l));
  if ((wH - wL) / wL < CFG.impulseMinPct) return null;
  let highIdx = 0, lowIdx = 0; let hv = window[0].h, lv = window[0].l;
  for (let j = 1; j < window.length; j++) { if (window[j].h > hv) { hv = window[j].h; highIdx = j; } if (window[j].l < lv) { lv = window[j].l; lowIdx = j; } }
  const dir = highIdx > lowIdx ? "UP" : "DOWN";
  const priorStart = Math.max(0, i - CFG.impulseLookback - CFG.structureLookback);
  const priorBars = bars.slice(priorStart, i - CFG.impulseLookback + 1);
  if (priorBars.length === 0) return null;
  const priorHigh = Math.max(...priorBars.map(b=>b.h));
  const priorLow  = Math.min(...priorBars.map(b=>b.l));
  if (dir === "UP" && wH <= priorHigh) return null;
  if (dir === "DOWN" && wL >= priorLow) return null;
  return { dir, start: dir === "UP" ? wL : wH, end: dir === "UP" ? wH : wL };
}
function computeFibLevels(impulse) {
  const range = Math.abs(impulse.end - impulse.start);
  let entry, sl, fibInvalid;
  if (impulse.dir === "UP") { entry = impulse.end - range * CFG.fibEntry; sl = impulse.start * (1 - CFG.slBufferPct); fibInvalid = impulse.end - range * CFG.fibInvalidate; }
  else { entry = impulse.end + range * CFG.fibEntry; sl = impulse.start * (1 + CFG.slBufferPct); fibInvalid = impulse.end + range * CFG.fibInvalidate; }
  const slDist = Math.abs(entry - sl);
  const tp = impulse.dir === "UP" ? entry + slDist * CFG.rrRatio : entry - slDist * CFG.rrRatio;
  return { entry, sl, tp, fibInvalid, slDist };
}

// ── Single-pair simulator for a specific window ────────────────────────────

function simulatePairWindow(sym, ind, windowStartMs, windowEndMs) {
  let balance = CFG.startBalance, peak = balance, maxDD = 0;
  let position = null, pending = null;
  const trades = [];

  for (let i = 0; i < ind.bars.length; i++) {
    const bar = ind.bars[i];
    if (bar.t < windowStartMs) continue;
    if (bar.t > windowEndMs) break;

    // ── Exit check
    if (position) {
      if (bar.t > position.fillTs) {
        const isL = position.dir === "LONG"; const barsHeld = i - position.fillBarIdx;
        const hitSL = isL ? bar.l<=position.sl : bar.h>=position.sl;
        const hitTP = isL ? bar.h>=position.tp : bar.l<=position.tp;
        const timeExit = barsHeld >= CFG.maxHoldBars;
        let exitReason = null, exitPrice = null;
        if (hitSL&&hitTP) { exitReason="SL"; exitPrice=position.sl; }
        else if (hitSL)   { exitReason="SL"; exitPrice=position.sl; }
        else if (hitTP)   { exitReason="TP"; exitPrice=position.tp; }
        else if (timeExit){ exitReason="TIME"; exitPrice=bar.c; }
        if (exitReason) {
          const grossPnl = ((isL?exitPrice-position.entry:position.entry-exitPrice)/position.entry) * position.sizeUSD;
          const fee = position.sizeUSD * FEE_PCT;
          const netPnl = grossPnl - fee;
          balance += netPnl;
          if (balance > peak) peak = balance;
          const dd = (peak-balance)/peak*100; if (dd > maxDD) maxDD = dd;
          trades.push({ net: netPnl, gross: grossPnl, reason: exitReason });
          position = null;
        }
      }
    }

    // ── Pending check
    if (pending) {
      if (bar.t > pending.signalTs) {
        const invalidated = pending.dir === "LONG" ? bar.l <= pending.fibInvalid : bar.h >= pending.fibInvalid;
        if (invalidated) { pending = null; }
        else {
          const filled = pending.dir === "LONG" ? bar.l <= pending.entry : bar.h >= pending.entry;
          if (filled) {
            position = { ...pending, fillBarIdx: i, fillTs: bar.t };
            pending = null;
          } else {
            const ageBars = i - pending.signalBarIdx;
            if (ageBars >= CFG.pendingMaxBars) pending = null;
          }
        }
      }
    }

    // ── New entry check
    if (!position && !pending && inSession(bar.t)) {
      const imp = detectImpulse(ind.bars, i);
      if (!imp) continue;
      const htfTrend = lookup1HTrend(ind.trend, bar.t);
      if (imp.dir === "UP"   && htfTrend !== "UP")   continue;
      if (imp.dir === "DOWN" && htfTrend !== "DOWN") continue;
      const fib = computeFibLevels(imp);
      if (fib.slDist <= 0) continue;
      const riskUSD = balance * CFG.riskPct;
      const sizeUSD = (riskUSD / fib.slDist) * fib.entry;
      pending = {
        dir: imp.dir === "UP" ? "LONG" : "SHORT",
        entry: fib.entry, sl: fib.sl, tp: fib.tp,
        fibInvalid: fib.fibInvalid,
        sizeUSD, riskUSD,
        signalBarIdx: i, signalTs: bar.t,
      };
    }
  }

  // Force close at window end
  if (position) {
    const lastBar = ind.bars[ind.bars.length-1];
    const isL = position.dir==="LONG";
    const grossPnl = ((isL?lastBar.c-position.entry:position.entry-lastBar.c)/position.entry) * position.sizeUSD;
    const fee = position.sizeUSD * FEE_PCT;
    const netPnl = grossPnl - fee;
    balance += netPnl;
    trades.push({ net: netPnl, gross: grossPnl, reason: "WINDOW_END" });
  }

  const wins = trades.filter(t=>t.net>0);
  const losses = trades.filter(t=>t.net<0);
  return {
    pnl: balance - CFG.startBalance,
    ret: (balance - CFG.startBalance) / CFG.startBalance * 100,
    trades: trades.length,
    wins: wins.length,
    winRate: trades.length ? wins.length/trades.length*100 : 0,
    maxDD,
  };
}

async function main() {
  const t0 = Date.now();
  console.log("╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  GOLDEN POCKET WALK-FORWARD VALIDATION (12 months, 4 windows)     ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`  Universe: ${PAIRS.length} pairs`);
  console.log(`  Each pair × window runs INDEPENDENTLY (full $${CFG.startBalance} balance)`);
  console.log(`  Windows:`);
  for (const w of WINDOWS) {
    const startDate = new Date((NOW_SEC - w.daysAgo*86400)*1000).toISOString().slice(0,10);
    const endDate   = new Date((NOW_SEC - w.daysBack*86400)*1000).toISOString().slice(0,10);
    console.log(`    ${w.name}: ${startDate} → ${endDate}  (${w.daysAgo-w.daysBack} days)`);
  }

  // Fetch 12+ months of data (1 month warmup for indicators)
  const fetchStart = NOW_SEC - (365 + 30) * 86400;
  console.log(`\n[1/1] Fetching 13 months of 15min data for ${PAIRS.length} pairs (slowest step)…`);
  const data = {};
  let fetched = 0;
  for (const sym of PAIRS) {
    process.stdout.write(`  [${++fetched}/${PAIRS.length}] ${sym}…`);
    data[sym] = await fetchAllBars(sym, "Min15", 15*60, fetchStart, NOW_SEC);
    process.stdout.write(`\r  [${fetched}/${PAIRS.length}] ${sym.padEnd(20)} ${String(data[sym].length).padStart(6)} bars ✓\n`);
    await sleep(100);
  }

  console.log("\n  Computing indicators + 1H trend per pair…");
  const ind = {};
  for (const sym of PAIRS) {
    const bars = data[sym]; if (bars.length < 200) { console.log(`  ⚠️  ${sym}: only ${bars.length} bars — limited windows available`); continue; }
    ind[sym] = { bars, trend: build1HTrend(bars) };
  }

  // ── Run each pair × window
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Running sims (15 pairs × 4 windows = 60 simulations)…");
  console.log("══════════════════════════════════════════════════════════════\n");

  const results = {}; // sym → { W1: {...}, W2: {...}, W3: {...}, W4: {...} }
  for (const sym of PAIRS) {
    results[sym] = {};
    if (!ind[sym]) continue;
    for (const w of WINDOWS) {
      const windowStartMs = (NOW_SEC - w.daysAgo*86400) * 1000;
      const windowEndMs   = (NOW_SEC - w.daysBack*86400) * 1000;
      // Check if we have data in this window
      const firstBar = ind[sym].bars[0];
      if (firstBar.t > windowEndMs) { results[sym][w.name] = { skipped: true, reason: "no data" }; continue; }
      const r = simulatePairWindow(sym, ind[sym], windowStartMs, windowEndMs);
      results[sym][w.name] = r;
    }
  }

  // ── Output matrix ──
  console.log("╔══════════════════════════════════════════════════════════════════════════════════════════════╗");
  console.log("║  PER-PAIR P&L ACROSS 4 WINDOWS                                                                ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════════════════════════╝");
  console.log(`\n  ${"Pair".padEnd(16)} ${"W1 (recent)".padStart(13)} ${"W2".padStart(13)} ${"W3".padStart(13)} ${"W4".padStart(13)} ${"Total".padStart(11)} ${"Wks W".padStart(6)}`);
  console.log(`  ${"─".repeat(16)} ${"─".repeat(13)} ${"─".repeat(13)} ${"─".repeat(13)} ${"─".repeat(13)} ${"─".repeat(11)} ${"─".repeat(6)}`);

  const pairStats = [];
  for (const sym of PAIRS) {
    const r = results[sym] || {};
    let total = 0, wins = 0, validWindows = 0;
    const cells = [];
    for (const w of WINDOWS) {
      const x = r[w.name];
      if (!x || x.skipped) { cells.push("—"); continue; }
      validWindows++;
      total += x.pnl;
      if (x.pnl > 0) wins++;
      const sign = x.pnl >= 0 ? "+" : "";
      cells.push(`${sign}$${x.pnl.toFixed(0)} (${x.trades}t,${x.winRate.toFixed(0)}%)`);
    }
    const consistency = validWindows > 0 ? `${wins}/${validWindows}` : "—";
    console.log(`  ${sym.padEnd(16)} ${cells[0].padStart(13)} ${cells[1].padStart(13)} ${cells[2].padStart(13)} ${cells[3].padStart(13)} ${(total>=0?'+':'')+'$'+total.toFixed(0).padStart(9)} ${consistency.padStart(6)}`);
    pairStats.push({ sym, total, wins, validWindows, consistency });
  }

  // ── Categorization ──
  console.log("\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  PAIR CATEGORIZATION                                                ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");

  const allWeather = pairStats.filter(p => p.validWindows === 4 && p.wins === 4);
  const reliable   = pairStats.filter(p => p.validWindows === 4 && p.wins === 3);
  const regime     = pairStats.filter(p => p.validWindows === 4 && p.wins === 2);
  const curveFit   = pairStats.filter(p => p.validWindows >= 2 && p.wins === 1);
  const broken     = pairStats.filter(p => p.validWindows >= 2 && p.wins === 0);
  const limited    = pairStats.filter(p => p.validWindows < 4 && p.validWindows > 0);

  if (allWeather.length) {
    console.log(`\n  🟢 ALL-WEATHER (4/4 windows profitable) — REAL EDGE:`);
    for (const p of allWeather.sort((a,b)=>b.total-a.total)) console.log(`     ${p.sym.padEnd(16)} Total: ${p.total>=0?'+':''}$${p.total.toFixed(0)}`);
  }
  if (reliable.length) {
    console.log(`\n  🟡 RELIABLE (3/4) — Good edge with some regime sensitivity:`);
    for (const p of reliable.sort((a,b)=>b.total-a.total)) console.log(`     ${p.sym.padEnd(16)} Total: ${p.total>=0?'+':''}$${p.total.toFixed(0)}`);
  }
  if (regime.length) {
    console.log(`\n  🟠 REGIME-DEPENDENT (2/4) — works in some regimes only:`);
    for (const p of regime.sort((a,b)=>b.total-a.total)) console.log(`     ${p.sym.padEnd(16)} Total: ${p.total>=0?'+':''}$${p.total.toFixed(0)}`);
  }
  if (curveFit.length) {
    console.log(`\n  🔴 CURVE-FIT RISK (1/4) — likely lucky single window:`);
    for (const p of curveFit.sort((a,b)=>b.total-a.total)) console.log(`     ${p.sym.padEnd(16)} Total: ${p.total>=0?'+':''}$${p.total.toFixed(0)}`);
  }
  if (broken.length) {
    console.log(`\n  ❌ NEVER WORKS (0/4) — drop entirely:`);
    for (const p of broken.sort((a,b)=>b.total-a.total)) console.log(`     ${p.sym.padEnd(16)} Total: ${p.total>=0?'+':''}$${p.total.toFixed(0)}`);
  }
  if (limited.length) {
    console.log(`\n  ⚠️  LIMITED DATA (<4 windows have data):`);
    for (const p of limited.sort((a,b)=>b.total-a.total)) console.log(`     ${p.sym.padEnd(16)} ${p.consistency} windows, Total: ${p.total>=0?'+':''}$${p.total.toFixed(0)}`);
  }

  // ── Recommendation ──
  console.log("\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  RECOMMENDED TRADING UNIVERSE                                       ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  const keepList = [...allWeather, ...reliable].map(p => p.sym);
  const considerList = regime.map(p => p.sym);
  const dropList = [...curveFit, ...broken].map(p => p.sym);
  console.log(`\n  ✅ Definitely include: ${keepList.length ? keepList.join(', ') : '(none)'}`);
  console.log(`  ⚠️  Consider (regime-dependent): ${considerList.length ? considerList.join(', ') : '(none)'}`);
  console.log(`  ❌ Drop: ${dropList.length ? dropList.join(', ') : '(none)'}`);

  // ── Per-window aggregate (how did the STRATEGY do in each regime) ──
  console.log("\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  STRATEGY PERFORMANCE BY REGIME                                     ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`  ${"Window".padEnd(20)} ${"Pairs +".padStart(8)} ${"Pairs -".padStart(8)} ${"Combined P&L".padStart(14)} ${"Avg PnL/Pair".padStart(14)}`);
  console.log(`  ${"─".repeat(20)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(14)} ${"─".repeat(14)}`);
  for (const w of WINDOWS) {
    let pos = 0, neg = 0, totalPnL = 0, valid = 0;
    for (const sym of PAIRS) {
      const r = results[sym]?.[w.name];
      if (!r || r.skipped) continue;
      valid++; totalPnL += r.pnl;
      if (r.pnl > 0) pos++; else if (r.pnl < 0) neg++;
    }
    const avg = valid > 0 ? totalPnL / valid : 0;
    console.log(`  ${w.name.padEnd(20)} ${String(pos).padStart(8)} ${String(neg).padStart(8)} ${(totalPnL>=0?'+':'')+'$'+totalPnL.toFixed(0).padStart(12)} ${(avg>=0?'+':'')+'$'+avg.toFixed(0).padStart(12)}`);
  }

  const mins = ((Date.now()-t0)/60000).toFixed(1);
  console.log(`\n  Total time: ${mins} min\n`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
