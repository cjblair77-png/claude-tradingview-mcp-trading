/**
 * backtest_grinder.js — "The Grinder" — 5-min mean reversion scalping bot
 *
 * Strategy concept:
 *   - High-frequency mean reversion at Bollinger Band extremes
 *   - Tight stops (0.5%), modest TPs (1%) — 2:1 R:R
 *   - High win rate target (55-65%) compensates for tight R:R
 *   - Multi-layer risk controls: daily loss limit, DD throttle, consecutive-loss pause
 *   - 5-min execution, 15-min trend filter
 *
 * Universe: 12 mid/high-vol crypto pairs (NOT BTC/ETH — too quiet for this approach)
 *
 * Sizing: 0.3% risk per trade (Option 1) — small per-trade exposure
 * Max concurrent: 4 positions
 *
 * Run: node backtest_grinder.js
 */

import "dotenv/config";

const MEXC_BASE = "https://futures.mexc.com";
const DAYS      = 180;
const NOW_SEC   = Math.floor(Date.now() / 1000);
const START     = NOW_SEC - DAYS * 86400;
const FEE_PCT   = 0.0004; // 0.02% × 2 (taker round-trip)

// ── Universe — diverse mid/high-vol pairs ──────────────────────────────────
const PAIRS = [
  "SUI_USDT", "AVAX_USDT", "ONDO_USDT",          // mid-caps with good vol
  "ENA_USDT", "TIA_USDT", "WIF_USDT",            // higher-vol mid-caps
  "WLD_USDT", "JUP_USDT", "FILECOIN_USDT",       // mid-cap variety
  "AR_USDT", "AIXBT_USDT", "S_USDT",             // small-cap higher vol
];

// ── Strategy config ────────────────────────────────────────────────────────
const CFG = {
  startBalance:     5000,
  riskPct:          0.003,    // 0.3% per trade
  leverage:         10,        // margin efficiency only
  slPct:            0.005,    // 0.5% SL
  tpPct:            0.010,    // 1.0% TP (2:1 R:R)
  maxHoldBars:      12,       // 1 hour max (12 × 5min)
  maxPositions:     4,
  bbPeriod:         20,
  bbStdDev:         2.5,
  rsiPeriod:        14,
  rsiLong:          30,        // RSI ≤30 for LONG
  rsiShort:         70,        // RSI ≥70 for SHORT
  volMult:          1.2,       // bar vol > 1.2× SMA(20)
  htfTrendBars:     3,         // look back 3×5min = 15min for trend filter
  htfTrendMaxSlope: 0.005,    // 15min change ≤0.5% to allow entry
  // Risk controls
  dailyLossLimit:   0.02,      // -2% halt for the day
  ddThrottle:       0.10,      // 10% DD triggers risk throttle
  ddRiskCut:        0.5,       // halve risk when throttling
  consecLossPause:  5,         // 5 consecutive losses → 4h pause
  consecPauseHours: 4,
};

// ── Helpers ─────────────────────────────────────────────────────────────────
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
  while(cur<endSec){const end=Math.min(cur+chunk,endSec);const batch=await fetchChunk(symbol,intervalStr,cur,end);if(!batch.length){emptyRuns++;if(emptyRuns>=10)break;cur=end+barSecs;await sleep(120);continue;}emptyRuns=0;bars.push(...batch);cur=Math.floor(batch[batch.length-1].t/1000)+barSecs;await sleep(130);}
  const seen=new Set();return bars.filter(b=>{if(seen.has(b.t))return false;seen.add(b.t);return true;}).sort((a,b)=>a.t-b.t);
}

function sma(values, period) {
  return values.map((_,i) => i<period-1 ? null : values.slice(i-period+1,i+1).reduce((a,b)=>a+b,0)/period);
}
function bollingerBands(closes, period, stdDev) {
  const middle = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = middle[i];
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + stdDev * sd;
    lower[i] = mean - stdDev * sd;
  }
  return { middle, upper, lower };
}
function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i-1]; d > 0 ? g += d : l -= d; }
  out[period] = l === 0 ? 100 : 100 - 100 / (1 + g/l);
  for (let i = period+1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) { g = (g*(period-1)+d)/period; l = l*(period-1)/period; }
    else       { g = g*(period-1)/period; l = (l*(period-1)-d)/period; }
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g/l);
  }
  return out;
}

// ── Week key for tracking ──
function weekKey(ts) {
  const d = new Date(ts);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThu = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstThuDayNr = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstThuDayNr + 3);
  const wkNum = 1 + Math.round((target - firstThu) / (7*86400000));
  return `${target.getUTCFullYear()}-W${String(wkNum).padStart(2,"0")}`;
}
function weekStartDate(wk) {
  const [yr, w] = wk.split("-W");
  const jan4 = new Date(Date.UTC(parseInt(yr), 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const w1Mon = new Date(jan4); w1Mon.setUTCDate(jan4.getUTCDate() - jan4Day);
  const monday = new Date(w1Mon); monday.setUTCDate(w1Mon.getUTCDate() + (parseInt(w)-1)*7);
  return monday.toISOString().slice(0,10);
}
function dayKey(ts) { return new Date(ts).toISOString().slice(0,10); }

// ─── The Grinder Simulator ───────────────────────────────────────────────────

function simulate(indicators) {
  let balance = CFG.startBalance, peak = balance, maxDD = 0;
  const positions = [];
  const trades = [];
  const dailyPnL = {};          // dayKey → realized pnl that day
  const consecLosses = { count: 0, pauseUntil: 0 };
  let throttled = false;        // active when DD > ddThrottle
  let totalFees = 0;
  let signalsFired = 0, signalsBlocked = { dailyLoss: 0, consecLoss: 0, maxPos: 0, htfTrend: 0 };

  // Pre-build timestamp maps for fast lookup
  const tsMap = {};
  for (const sym of PAIRS) {
    const ind = indicators[sym]; if (!ind) continue;
    tsMap[sym] = new Map();
    for (let i = 0; i < ind.bars.length; i++) tsMap[sym].set(ind.bars[i].t, i);
  }

  // Union timeline
  const allTs = new Set();
  for (const sym of PAIRS) {
    const ind = indicators[sym]; if (!ind) continue;
    for (const b of ind.bars) if (b.t/1000 >= START) allTs.add(b.t);
  }
  const sortedTs = [...allTs].sort((a,b)=>a-b);

  for (const ts of sortedTs) {
    const dk = dayKey(ts);
    if (!dailyPnL[dk]) dailyPnL[dk] = 0;

    // ── 1. EXITS ──────────────────────────────────────────────────────────
    for (let p = positions.length-1; p >= 0; p--) {
      const pos = positions[p];
      const ind = indicators[pos.sym]; if (!ind) continue;
      const bi = tsMap[pos.sym].get(ts); if (bi === undefined) continue;
      const bar = ind.bars[bi];
      const isL = pos.dir==="LONG"; const barsHeld = bi - pos.entryBarIdx;
      const hitSL = isL ? bar.l<=pos.sl : bar.h>=pos.sl;
      const hitTP = isL ? bar.h>=pos.tp : bar.l<=pos.tp;
      const timeExit = barsHeld >= CFG.maxHoldBars;
      let exitReason = null, exitPrice = null;
      if (hitSL&&hitTP) { exitReason="SL"; exitPrice=pos.sl; }      // conservative
      else if (hitSL)   { exitReason="SL"; exitPrice=pos.sl; }
      else if (hitTP)   { exitReason="TP"; exitPrice=pos.tp; }
      else if (timeExit){ exitReason="TIME"; exitPrice=bar.c; }
      if (exitReason) {
        const grossPnl = ((isL?exitPrice-pos.entry:pos.entry-exitPrice)/pos.entry) * pos.sizeUSD;
        const fee = pos.sizeUSD * FEE_PCT;
        const netPnl = grossPnl - fee;
        balance += netPnl; totalFees += fee;
        dailyPnL[dk] += netPnl;
        if (balance > peak) peak = balance;
        const dd = (peak-balance)/peak * 100; if (dd > maxDD) maxDD = dd;
        // Throttle activation/deactivation
        if (dd >= CFG.ddThrottle*100 && !throttled) throttled = true;
        else if (dd < CFG.ddThrottle*50 && throttled) throttled = false; // re-arm at half threshold (5%)
        // Consecutive losses tracking
        if (netPnl < 0) consecLosses.count++; else consecLosses.count = 0;
        if (consecLosses.count >= CFG.consecLossPause) {
          consecLosses.pauseUntil = ts + CFG.consecPauseHours * 3600 * 1000;
          consecLosses.count = 0;
        }
        trades.push({ sym: pos.sym, dir: pos.dir, gross: grossPnl, fee, net: netPnl, reason: exitReason, exitTs: ts });
        positions.splice(p, 1);
      }
    }

    // ── 2. ENTRY GATES ──────────────────────────────────────────────────────
    if (positions.length >= CFG.maxPositions) { signalsBlocked.maxPos++; continue; }
    // Daily loss limit
    const dayPctLoss = dailyPnL[dk] / balance;
    if (dayPctLoss < -CFG.dailyLossLimit) { signalsBlocked.dailyLoss++; continue; }
    // Consecutive loss pause
    if (ts < consecLosses.pauseUntil) { signalsBlocked.consecLoss++; continue; }

    const effectiveRisk = throttled ? CFG.riskPct * CFG.ddRiskCut : CFG.riskPct;

    // ── 3. ENTRY CHECK ──────────────────────────────────────────────────────
    for (const sym of PAIRS) {
      if (positions.some(p => p.sym === sym)) continue;
      const ind = indicators[sym]; if (!ind) continue;
      const bi = tsMap[sym].get(ts); if (bi === undefined || bi < CFG.bbPeriod + 5) continue;
      const i = bi; // use current bar for entry signal (treat its close as our entry)
      if (!ind.bb.middle[i] || !ind.rsi[i] || !ind.vsma[i]) continue;
      const bar = ind.bars[i];

      // Bollinger Band touch
      const touchedLowerBB = bar.l <= ind.bb.lower[i];
      const touchedUpperBB = bar.h >= ind.bb.upper[i];

      // RSI extreme
      const rsiOversold = ind.rsi[i] <= CFG.rsiLong;
      const rsiOverbought = ind.rsi[i] >= CFG.rsiShort;

      // Volume confirmation
      const volOk = bar.v > ind.vsma[i] * CFG.volMult;
      if (!volOk) continue;

      // 15-min trend filter: don't trade against strong moves
      // Approximation: 5-min × 3 bars = 15-min equivalent
      const trendLookback = CFG.htfTrendBars;
      if (i < trendLookback) continue;
      const trendChange = (ind.bars[i].c - ind.bars[i-trendLookback].c) / ind.bars[i-trendLookback].c;

      let dir = null;
      if (touchedLowerBB && rsiOversold && trendChange > -CFG.htfTrendMaxSlope) dir = "LONG";
      if (touchedUpperBB && rsiOverbought && trendChange < CFG.htfTrendMaxSlope) dir = "SHORT";
      if (!dir) continue;
      signalsFired++;

      // Setup trade
      const entry = bar.c;
      const isL = dir === "LONG";
      const sl = isL ? entry * (1 - CFG.slPct) : entry * (1 + CFG.slPct);
      const tp = isL ? entry * (1 + CFG.tpPct) : entry * (1 - CFG.tpPct);
      const riskUSD = balance * effectiveRisk;
      const slDist = Math.abs(entry - sl);
      const sizeUSD = (riskUSD / slDist) * entry; // Option 1 sizing

      positions.push({ sym, dir, entry, sl, tp, sizeUSD, riskUSD, entryBarIdx: bi });
      if (positions.length >= CFG.maxPositions) break;
    }
  }

  // Force-close any remaining
  for (const pos of positions) {
    const ind = indicators[pos.sym]; if (!ind) continue;
    const lastBar = ind.bars[ind.bars.length-1];
    const isL = pos.dir==="LONG";
    const grossPnl = ((isL?lastBar.c-pos.entry:pos.entry-lastBar.c)/pos.entry) * pos.sizeUSD;
    const fee = pos.sizeUSD * FEE_PCT;
    const netPnl = grossPnl - fee;
    balance += netPnl; totalFees += fee;
    trades.push({ sym: pos.sym, dir: pos.dir, gross: grossPnl, fee, net: netPnl, reason: "OPEN@END", exitTs: lastBar.t });
  }

  const wins = trades.filter(t=>t.net>0);
  const losses = trades.filter(t=>t.net<0);
  const winRate = trades.length ? wins.length/trades.length*100 : 0;
  const grossW = wins.reduce((s,t)=>s+t.gross,0);
  const grossL = Math.abs(losses.reduce((s,t)=>s+t.gross,0));
  const netW = wins.reduce((s,t)=>s+t.net,0);
  const netL = Math.abs(losses.reduce((s,t)=>s+t.net,0));
  const pfGross = grossL > 0 ? grossW/grossL : (wins.length?Infinity:0);
  const pfNet = netL > 0 ? netW/netL : (wins.length?Infinity:0);
  const ret = (balance - CFG.startBalance) / CFG.startBalance * 100;
  const avgWin = wins.length ? netW/wins.length : 0;
  const avgLoss = losses.length ? netL/losses.length : 0;
  const tpCount = trades.filter(t=>t.reason==="TP").length;
  const slCount = trades.filter(t=>t.reason==="SL").length;
  const timeCount = trades.filter(t=>t.reason==="TIME").length;

  return { balance, ret, maxDD, trades, totalFees, signalsFired, signalsBlocked,
           winRate, pfGross, pfNet, avgWin, avgLoss, tpCount, slCount, timeCount };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const startDate = new Date(START*1000).toISOString().slice(0,10);
  const endDate = new Date().toISOString().slice(0,10);

  console.log("╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  THE GRINDER — 5min mean reversion scalping backtest               ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`  Period:    ${startDate} → ${endDate}  (${DAYS} days)`);
  console.log(`  Universe:  ${PAIRS.length} mid/high-vol crypto pairs (excluding BTC/ETH)`);
  console.log(`  Capital:   $${CFG.startBalance.toLocaleString()}`);
  console.log(`  Strategy:  BB(${CFG.bbPeriod}, ${CFG.bbStdDev}σ) + RSI(${CFG.rsiPeriod}) extremes`);
  console.log(`  Risk:      ${(CFG.riskPct*100).toFixed(1)}% per trade | SL ${(CFG.slPct*100).toFixed(1)}% | TP ${(CFG.tpPct*100).toFixed(1)}% | R:R ${(CFG.tpPct/CFG.slPct).toFixed(1)}:1`);
  console.log(`  Hold:      Max ${CFG.maxHoldBars} bars (${CFG.maxHoldBars*5}min) | Max concurrent: ${CFG.maxPositions}`);
  console.log(`  Controls:  Daily loss ${CFG.dailyLossLimit*100}%, DD throttle at ${CFG.ddThrottle*100}%, ${CFG.consecLossPause}-loss pause`);

  console.log(`\n[1/1] Fetching 5min data for ${PAIRS.length} pairs (this takes a few min)…`);
  const data = {};
  let fetched = 0;
  for (const sym of PAIRS) {
    process.stdout.write(`  [${++fetched}/${PAIRS.length}] ${sym}…`);
    data[sym] = await fetchAllBars(sym, "Min5", 5*60, START - 7*86400, NOW_SEC);
    process.stdout.write(`\r  [${fetched}/${PAIRS.length}] ${sym.padEnd(20)} ${String(data[sym].length).padStart(7)} bars ✓\n`);
    await sleep(130);
  }

  console.log("\n  Computing indicators…");
  const ind = {};
  for (const sym of PAIRS) {
    const bars = data[sym]; if (bars.length < 100) { console.log(`  ⚠️  ${sym}: insufficient data (${bars.length} bars)`); continue; }
    const closes = bars.map(b=>b.c), vols=bars.map(b=>b.v);
    ind[sym] = {
      bars, closes, vols,
      bb:   bollingerBands(closes, CFG.bbPeriod, CFG.bbStdDev),
      rsi:  rsi(closes, CFG.rsiPeriod),
      vsma: sma(vols, 20),
    };
  }

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Running simulation…");
  console.log("══════════════════════════════════════════════════════════════");
  const r = simulate(ind);
  console.log(`  Done: $${r.balance.toFixed(0)} | ${r.trades.length} trades fired`);

  // ── Report ──────────────────────────────────────────────────────────────
  console.log("\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  RESULTS                                                            ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`\n  Start:        $${CFG.startBalance.toLocaleString()}`);
  console.log(`  End balance:  $${r.balance.toFixed(0)}`);
  console.log(`  Return:       ${r.ret>=0?'+':''}${r.ret.toFixed(1)}%`);
  console.log(`  Max DD:       ${r.maxDD.toFixed(1)}%`);
  console.log(`  Annualized:   ~${(r.ret*2).toFixed(0)}%`);
  console.log(`  Weekly avg:   ${(r.ret/26).toFixed(2)}%`);

  console.log(`\n  ── Trade stats ──`);
  const wins = r.trades.filter(t=>t.net>0).length;
  const losses = r.trades.filter(t=>t.net<0).length;
  console.log(`  Total trades:   ${r.trades.length}  (W:${wins} / L:${losses})`);
  console.log(`  Win rate:       ${r.winRate.toFixed(1)}%`);
  console.log(`  Avg win:        +$${r.avgWin.toFixed(2)}`);
  console.log(`  Avg loss:       -$${r.avgLoss.toFixed(2)}`);
  console.log(`  Profit factor:  Gross ${r.pfGross===Infinity?'∞':r.pfGross.toFixed(2)}  |  Net (after fees) ${r.pfNet===Infinity?'∞':r.pfNet.toFixed(2)}`);
  console.log(`  Exit breakdown: TP ${r.tpCount} / SL ${r.slCount} / TIME ${r.timeCount}`);
  console.log(`  Total fees:     $${r.totalFees.toFixed(0)}`);

  console.log(`\n  ── Signal flow ──`);
  console.log(`  Signals fired:    ${r.signalsFired}`);
  console.log(`  Blocked - max positions:   ${r.signalsBlocked.maxPos}`);
  console.log(`  Blocked - daily loss halt: ${r.signalsBlocked.dailyLoss}`);
  console.log(`  Blocked - consec loss pause: ${r.signalsBlocked.consecLoss}`);

  // Per-pair P&L
  console.log(`\n  ── Per-pair P&L ──`);
  const byPair = {};
  for (const t of r.trades) { if (!byPair[t.sym]) byPair[t.sym]={pnl:0,trades:0,wins:0}; byPair[t.sym].pnl+=t.net; byPair[t.sym].trades++; if (t.net>0) byPair[t.sym].wins++; }
  const sorted = Object.entries(byPair).sort((a,b)=>b[1].pnl-a[1].pnl);
  for (const [sym, s] of sorted) {
    const wr = s.trades>0 ? (s.wins/s.trades*100).toFixed(0)+'%' : '—';
    const flag = s.pnl>0 ? '✅' : '❌';
    console.log(`     ${flag} ${sym.padEnd(18)} ${(s.pnl>=0?'+':'')}$${s.pnl.toFixed(2).padStart(8)}  ${String(s.trades).padStart(5)} trades, ${wr.padStart(4)} WR`);
  }

  // Weekly breakdown
  console.log(`\n  ── Week-by-week P&L ──`);
  const byWeek = {};
  for (const t of r.trades) { const wk = weekKey(t.exitTs); if (!byWeek[wk]) byWeek[wk] = { net: 0, trades: 0 }; byWeek[wk].net += t.net; byWeek[wk].trades++; }
  const wks = Object.keys(byWeek).sort();
  let cum = 0;
  console.log(`  ${"Week".padEnd(12)} ${"Date".padEnd(12)} ${"Trades".padStart(7)} ${"Net P&L".padStart(11)} ${"Cum.".padStart(11)} ${"%/Wk".padStart(8)}`);
  console.log(`  ${"─".repeat(12)} ${"─".repeat(12)} ${"─".repeat(7)} ${"─".repeat(11)} ${"─".repeat(11)} ${"─".repeat(8)}`);
  for (const wk of wks) {
    const w = byWeek[wk];
    cum += w.net;
    const pctWk = (w.net / CFG.startBalance) * 100;
    console.log(`  ${wk.padEnd(12)} ${weekStartDate(wk).padEnd(12)} ${String(w.trades).padStart(7)} ${((w.net>=0?'+':'')+'$'+w.net.toFixed(0)).padStart(11)} ${((cum>=0?'+':'')+'$'+cum.toFixed(0)).padStart(11)} ${(pctWk.toFixed(1)+'%').padStart(8)}`);
  }
  const wkPnls = wks.map(w => byWeek[w].net);
  const winWks = wkPnls.filter(n=>n>0).length;
  const lossWks = wkPnls.filter(n=>n<0).length;
  console.log(`\n  Weekly win rate: ${winWks}/${wks.length} (${(winWks/wks.length*100).toFixed(0)}%)`);
  console.log(`  Best week:       ${((Math.max(...wkPnls)>=0?'+':'')+'$'+Math.max(...wkPnls).toFixed(0))}`);
  console.log(`  Worst week:      ${((Math.min(...wkPnls)>=0?'+':'')+'$'+Math.min(...wkPnls).toFixed(0))}`);
  console.log(`  Avg per week:    ${((cum/wks.length)>=0?'+':'')}$${(cum/wks.length).toFixed(0)}  (${((cum/wks.length)/CFG.startBalance*100).toFixed(2)}% of start)`);

  // Verdict
  console.log(`\n  📋 VERDICT:`);
  const annualPct = r.ret * (365/DAYS);
  const wkPct = r.ret / (DAYS/7);
  if (r.pfNet > 1.3 && r.maxDD < 15 && wkPct > 1.5) {
    console.log(`     ✅ STRONG — PF ${r.pfNet.toFixed(2)} net, ${wkPct.toFixed(1)}%/wk, ${r.maxDD.toFixed(1)}% DD`);
    console.log(`     Ready to paper test alongside v09 + DT`);
  } else if (r.pfNet > 1.1 && r.maxDD < 20 && wkPct > 0.5) {
    console.log(`     ⚠️  MODERATE — PF ${r.pfNet.toFixed(2)}, ${wkPct.toFixed(1)}%/wk, ${r.maxDD.toFixed(1)}% DD`);
    console.log(`     Marginal — needs param tuning before paper test`);
  } else {
    console.log(`     ❌ WEAK — strategy as-designed doesn't deliver promised performance`);
    console.log(`     PF ${r.pfNet.toFixed(2)}, ${wkPct.toFixed(1)}%/wk — significant rework needed`);
  }

  const mins = ((Date.now()-t0)/60000).toFixed(1);
  console.log(`\n  Backtest time: ${mins} min\n`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
