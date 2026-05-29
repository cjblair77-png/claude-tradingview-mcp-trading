/**
 * backtest_v09_leverage.mjs
 *
 * Compares 1.5x vs 2x leverage on the top-30 curated universe.
 * Uses the same signal logic as bot_crypto_v09.js.
 * Reads cached 400-day data from hermes-trading/state/cache.
 *
 * Run: node backtest_v09_leverage.mjs
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

// ─── Config ───────────────────────────────────────────────────────────────────

const STARTING_BALANCE = 1_000;
const PORTFOLIO_USD    = 1_000;   // risk sizing base
const RISK_PCT         = 0.008;   // 0.8% per trade
const MIN_RISK         = 2;       // $2 floor
const MAX_POSITIONS    = 10;
const SL_PCT           = 0.065;   // 6.5%
const TP_PCT           = 0.23;    // 23%
const TRAIL_PCT        = 0.19;    // 19% trail SL
const REBOUND_SL_PCT   = 0.035;
const REBOUND_TP_PCT   = 0.22;
const RSI_OVERSOLD     = 20;
const RSI_OVERBOUGHT   = 80;
const BO_RSI_MIN       = 54;
const BO_RSI_MAX       = 65;
const BO_LOOKBACK      = 30;
const TRAIL_BULL_PCT   = 60;      // activate trailing when >=60% pairs bull
const DAYS             = 365;

const CACHE_DIR = "C:/Users/cjbla/hermes-trading/state/cache";

const PAIRS = [
  ["KAIAUSDT","KAIA"], ["SUSDT","S"],       ["FILUSDT","FIL"],   ["ARUSDT","AR"],
  ["PLUMEUSDT","PLUME"],["FIDAUSDT","FIDA"],["GMTUSDT","GMT"],   ["ENAUSDT","ENA"],
  ["TIAUSDT","TIA"],   ["TURBOUSDT","TURBO"],["WIFUSDT","WIF"],  ["SHIBUSDT","SHIB"],
  ["BCHUSDT","BCH"],   ["VETUSDT","VET"],   ["ONDOUSDT","ONDO"], ["THETAUSDT","THETA"],
  ["HBARUSDT","HBAR"], ["RUNEUSDT","RUNE"], ["IOTAUSDT","IOTA"], ["JUPUSDT","JUP"],
  ["FLUXUSDT","FLUX"], ["WUSDT","W"],       ["CATIUSDT","CATI"], ["ZKUSDT","ZK"],
  ["KAITOUSDT","KAITO"],["WLDUSDT","WLD"],  ["AIXBTUSDT","AIXBT"],["LAUSDT","LA"],
  ["JASMYUSDT","JASMY"],["HOMEUSDT","HOME"],
];

// ─── Indicators ───────────────────────────────────────────────────────────────

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++)
    out.push(values[i] * k + out[i-1] * (1-k));
  return out;
}

function sma(values, period) {
  return values.map((_, i) =>
    i < period - 1 ? null : values.slice(i - period + 1, i + 1).reduce((a,b) => a+b, 0) / period
  );
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let g = 0, l = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j] - closes[j-1];
      d > 0 ? g += d : l -= d;
    }
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + (g/period) / (l/period));
  }
  return out;
}

function macd(closes, f=12, s=26, sig=9) {
  const fast = ema(closes, f), slow = ema(closes, s);
  const line  = closes.map((_, i) => fast[i] - slow[i]);
  const signal = [line[0]];
  const k = 2 / (sig + 1);
  for (let i = 1; i < closes.length; i++) signal.push(line[i]*k + signal[i-1]*(1-k));
  return { line, signal, hist: line.map((v,i) => v - signal[i]) };
}

function calcRegime(i, closes, e21, e50, e200) {
  if (!e200[i] || !e50[i] || !e21[i]) return "neutral";
  const c = closes[i]; let score = 0;
  if (c > e200[i]) score++; else score--;
  if (c > e50[i])  score++; else score--;
  if (c > e21[i])  score++; else score--;
  if (e21[i] > e50[i])  score++; else score--;
  if (e50[i] > e200[i]) score++; else score--;
  return score >= 4 ? "bull" : score <= -4 ? "bear" : "neutral";
}

// ─── Load cached data ─────────────────────────────────────────────────────────

function loadPairData(base) {
  const f = join(CACHE_DIR, `binance_${base}_USDT_4h_400d.json`);
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf8"));
}

// ─── Pre-compute all indicators per pair (run once, not per-bar) ──────────────

function precompute(candles) {
  const closes = candles.map(c => c.close);
  const vols   = candles.map(c => c.volume);
  const e21    = ema(closes, 21);
  const e50    = ema(closes, 50);
  const e200   = ema(closes, 200);
  const rsiV   = rsi(closes, 14);
  const mc     = macd(closes);
  const vsma   = sma(vols, 20);
  return { closes, vols, e21, e50, e200, rsiV, mc, vsma };
}

function evalSignals(pre, candles, i) {
  if (i < 210) return null;
  const { closes, vols, e21, e50, e200, rsiV, mc, vsma } = pre;

  const c    = closes[i];
  const rNow = rsiV[i];
  const rPrv = rsiV[i-1];
  const vol  = vols[i];
  const reg  = calcRegime(i, closes, e21, e50, e200);

  if (rNow == null || rPrv == null || vsma[i] == null) return null;

  // LONG breakout
  const highN    = Math.max(...closes.slice(Math.max(0, i - BO_LOOKBACK), i));
  const breakout = c > highN;
  const trendUp  = e21[i] > e50[i] && e21[i] > e21[i-1] && e21[i-1] > e21[i-3];
  const rsiLong  = rNow >= BO_RSI_MIN && rNow <= BO_RSI_MAX;
  const volLong  = vol > vsma[i] * 1.5;
  const longSig  = breakout && trendUp && rsiLong && volLong;

  // SHORT breakdown
  const wasOB    = [1,2,3,4,5].some(k => rsiV[i-k] != null && rsiV[i-k] >= 65);
  const rsiBrk   = rPrv >= 58 && rNow < 58;
  const macdBrk  = mc.hist[i-1] >= 0 && mc.hist[i] < 0;
  const volShrt  = vol > vsma[i] * 1.2;
  const shortSig = wasOB && (rsiBrk || macdBrk) && c < e21[i] && rNow > 35 && volShrt;

  // LONG rebound
  const wasOS       = [1,2,3].some(k => rsiV[i-k] != null && rsiV[i-k] <= RSI_OVERSOLD);
  const rsiUp       = rPrv <= 30 && rNow > 30;
  const notFalling  = c > e21[i] * 0.92;
  const volReb      = vol > vsma[i] * 1.0;
  const longRebound = wasOS && rsiUp && reg === "bull" && notFalling && volReb && !longSig;

  // SHORT rebound
  const wasOvert    = [1,2,3].some(k => rsiV[i-k] != null && rsiV[i-k] >= RSI_OVERBOUGHT);
  const rsiDown     = rPrv >= 70 && rNow < 70;
  const notMelting  = c < e21[i] * 1.08;
  const shortRebound= wasOvert && rsiDown && reg !== "bull" && notMelting && volReb && !shortSig;

  return { long: longSig, short: shortSig, longRebound, shortRebound, regime: reg, price: c };
}

// ─── Backtest engine ──────────────────────────────────────────────────────────

function runBacktest(allPairCandles, leverage) {
  // Align all pairs to same timeline, trimmed to last DAYS days
  const allTimes = new Set();
  for (const bars of Object.values(allPairCandles))
    bars.forEach(b => allTimes.add(b.time));
  const sortedTimes = [...allTimes].sort((a,b) => a-b);

  // Take last DAYS * 6 bars (4H bars)
  const keepBars = DAYS * 6;
  const timeline = sortedTimes.slice(-keepBars);
  const startTime = timeline[0];

  // Build index map and precompute indicators per pair (once, not per-bar)
  console.log("  Precomputing indicators...");
  const pairIndex = {};
  const pairPre   = {};
  for (const [sym, bars] of Object.entries(allPairCandles)) {
    pairIndex[sym] = new Map(bars.map((b, i) => [b.time, i]));
    pairPre[sym]   = precompute(bars);
  }
  console.log("  Running simulation...\n");

  // State
  let balance    = STARTING_BALANCE;
  let peak       = STARTING_BALANCE;
  let maxDD      = 0;
  const positions    = {};  // sym -> pos
  const closedTrades = [];
  const monthBalMap  = {};  // month -> balance at start of month

  function riskForRegime(reg, dir) {
    const base = Math.max(balance * RISK_PCT, MIN_RISK);
    if (reg === "neutral") return base * 0.75;
    const withTrend = (reg === "bull" && dir === "LONG") || (reg === "bear" && dir === "SHORT");
    return withTrend ? base : base * 0.5;
  }

  // P&L = price_move% * notional * leverage
  // At SL: -slPct * (risk/slPct) * lev = -risk * lev
  // At TP: +tpPct * (risk/slPct) * lev = +risk*(tp/sl) * lev
  function calcPnl(pos, price) {
    const pct = pos.dir === "LONG"
      ? (price - pos.entry) / pos.entry
      : (pos.entry - price) / pos.entry;
    return pct * pos.size * leverage;
  }

  function closePos(sym, price, reason, ts) {
    const pos = positions[sym];
    if (!pos) return;
    const pnl = calcPnl(pos, price);
    balance += pnl;   // only add P&L — no cost basis to return
    const trade = {
      sym, dir: pos.dir, signal: pos.signal,
      entry: pos.entry, exit: price, reason,
      pnl, ts,
    };
    closedTrades.push(trade);
    delete positions[sym];
  }

  // Process timeline bar by bar
  for (let t = 0; t < timeline.length; t++) {
    const barTime = timeline[t];
    const dt = new Date(barTime);
    const month = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,"0")}`;
    if (!(month in monthBalMap)) monthBalMap[month] = balance;

    // Compute signals for all pairs at this bar
    const signals = [];
    let bullCount = 0, totalCount = 0;

    for (const [sym, bars] of Object.entries(allPairCandles)) {
      const idx = pairIndex[sym].get(barTime);
      if (idx == null || idx < 210) continue;
      totalCount++;

      const sig = evalSignals(pairPre[sym], bars, idx);
      if (!sig) continue;
      if (sig.regime === "bull") bullCount++;
      signals.push({ sym, ...sig, price: bars[idx].close });
    }

    const bullPct   = totalCount > 0 ? bullCount / totalCount * 100 : 0;
    const useTrail  = bullPct >= TRAIL_BULL_PCT;

    // Check exits first
    for (const [sym, pos] of Object.entries(positions)) {
      const idx = pairIndex[sym]?.get(barTime);
      if (idx == null) continue;
      const bars = allPairCandles[sym];
      const price = bars[idx].close;
      const isLong = pos.dir === "LONG";

      // Trailing stop update
      if (pos.trailing) {
        if (isLong && price > pos.trailHigh) {
          pos.trailHigh = price;
          pos.sl = price * (1 - TRAIL_PCT);
        } else if (!isLong && price < pos.trailLow) {
          pos.trailLow = price;
          pos.sl = price * (1 + TRAIL_PCT);
        }
      }

      const hitSL = isLong ? price <= pos.sl : price >= pos.sl;
      const hitTP = !pos.trailing && (isLong ? price >= pos.tp : price <= pos.tp);

      if (hitSL) {
        closePos(sym, pos.sl, pos.trailing ? "TRAIL_SL" : "SL", barTime);
      } else if (hitTP) {
        if (pos.noTrail || !useTrail) {
          closePos(sym, pos.tp, "TP", barTime);
        } else {
          pos.trailing = true;
          pos.trailHigh = price;
          pos.trailLow  = price;
          pos.sl = isLong ? price * (1 - TRAIL_PCT) : price * (1 + TRAIL_PCT);
        }
      }
    }

    // Open new positions
    const openCount = Object.keys(positions).length;
    for (const sig of signals) {
      if (openCount >= MAX_POSITIONS) break;
      if (positions[sig.sym]) continue; // already open

      let dir = null, signal = null, slPct = SL_PCT, tpPct = TP_PCT, noTrail = false;

      if (sig.long) { dir = "LONG"; signal = "Breakout"; }
      else if (sig.short) { dir = "SHORT"; signal = "Breakdown"; }
      else if (sig.longRebound) { dir = "LONG"; signal = "Rebound"; slPct = REBOUND_SL_PCT; tpPct = REBOUND_TP_PCT; noTrail = true; }
      else if (sig.shortRebound) { dir = "SHORT"; signal = "Rebound"; slPct = REBOUND_SL_PCT; tpPct = REBOUND_TP_PCT; noTrail = true; }

      if (!dir) continue;

      const riskUSD = riskForRegime(sig.regime, dir);
      // Safety: ensure balance can absorb max loss (risk * leverage)
      if (balance < riskUSD * leverage * 2) continue;

      const entry = sig.price;
      const size  = riskUSD / slPct;   // notional position size
      const sl    = dir === "LONG" ? entry * (1 - slPct) : entry * (1 + slPct);
      const tp    = dir === "LONG" ? entry * (1 + tpPct) : entry * (1 - tpPct);

      // No balance deduction on open — P&L-only accounting (balance updates on close)
      positions[sig.sym] = { dir, signal, entry, size, sl, tp, regime: sig.regime, noTrail,
        trailing: false, trailHigh: entry, trailLow: entry };
    }

    // Update peak / DD
    peak  = Math.max(peak, balance);
    const dd = (peak - balance) / peak * 100;
    maxDD = Math.max(maxDD, dd);
  }

  // Close any remaining open positions at last price
  for (const [sym] of Object.entries(positions)) {
    const bars = allPairCandles[sym];
    closePos(sym, bars[bars.length-1].close, "OPEN_EOT", bars[bars.length-1].time);
  }

  // Build monthly rows using closedTrades
  const monthRows = [];
  const allMonthKeys = [...new Set(closedTrades.map(t => new Date(t.ts).toISOString().slice(0,7)))].sort();
  for (const month of allMonthKeys) {
    const monthTrades = closedTrades.filter(t => new Date(t.ts).toISOString().slice(0,7) === month);
    const wins   = monthTrades.filter(t => t.pnl > 0).length;
    const losses = monthTrades.length - wins;
    const mpnl   = monthTrades.reduce((s, t) => s + t.pnl, 0);
    const startBal = monthBalMap[month] ?? STARTING_BALANCE;
    const endBal   = startBal + mpnl;
    const mpct     = startBal > 0 ? mpnl / startBal * 100 : 0;
    monthRows.push({ month, trades: monthTrades.length, wins, losses, mpnl, mpct, endBal });
  }

  const wins  = closedTrades.filter(t => t.pnl > 0).length;
  const total = closedTrades.length;
  const finalBalance = STARTING_BALANCE + closedTrades.reduce((s, t) => s + t.pnl, 0);

  // Monthly returns for Sharpe
  const monthlyPcts = monthRows.map(r => r.mpct);
  let sharpe = 0;
  if (monthlyPcts.length > 1) {
    const avg = monthlyPcts.reduce((a,b) => a+b, 0) / monthlyPcts.length;
    const std = Math.sqrt(monthlyPcts.map(x => (x-avg)**2).reduce((a,b) => a+b, 0) / (monthlyPcts.length-1));
    sharpe = std > 0 ? (avg / std) * Math.sqrt(12) : 0;
  }

  return { finalBalance, maxDD, sharpe, total, wins, monthRows, closedTrades };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log("Loading cached pair data...");
const allPairCandles = {};
let loaded = 0, skipped = 0;

for (const [sym, base] of PAIRS) {
  const bars = loadPairData(base === "IOTA" ? "IOTA" : base);
  if (bars && bars.length > 200) {
    allPairCandles[sym] = bars;
    loaded++;
  } else {
    console.log(`  ⚠ Skipped ${sym} (no cache)`);
    skipped++;
  }
}

console.log(`  Loaded ${loaded}/30 pairs | Skipped: ${skipped}`);
console.log(`  Running backtest: last ${DAYS} days | $${STARTING_BALANCE.toLocaleString()} start\n`);

const SEP  = "═".repeat(110);
const SEP2 = "─".repeat(110);

// Run both leverages
const r15 = runBacktest(allPairCandles, 1.5);
const r2  = runBacktest(allPairCandles, 2.0);

const p = (s, n, r=false) => { s = String(s); return r ? s.padStart(n) : s.padEnd(n); };
const fmtBal = n => "$" + n.toLocaleString("en-US", {maximumFractionDigits:0});
const fmtPct = n => (n >= 0 ? "+" : "") + n.toFixed(1) + "%";

// ── Summary table ──────────────────────────────────────────────────────────────
console.log(SEP);
console.log("  BACKTEST: Top-30 Universe · Last 365 Days · $1,000 Start");
console.log(SEP);
console.log(`  ${p("Leverage",12)}  ${p("Trades",7,true)}  ${p("Win%",6,true)}  ${p("Return",10,true)}  ${p("Max DD",8,true)}  ${p("Sharpe",8,true)}  ${p("Final $",14,true)}`);
console.log(SEP2);

for (const [lev, r] of [[1.5, r15], [2.0, r2]]) {
  const wr  = r.total > 0 ? (r.wins / r.total * 100).toFixed(0) + "%" : "—";
  const ret = fmtPct((r.finalBalance - STARTING_BALANCE) / STARTING_BALANCE * 100);
  const bal = fmtBal(r.finalBalance);
  console.log(`  ${p(lev+"x",12)}  ${p(r.total,7,true)}  ${p(wr,6,true)}  ${p(ret,10,true)}  ${p(r.maxDD.toFixed(1)+"%",8,true)}  ${p(r.sharpe.toFixed(2),8,true)}  ${p(bal,14,true)}`);
}
console.log(SEP);

// ── Side-by-side monthly ───────────────────────────────────────────────────────
console.log();
console.log(SEP);
console.log("  MONTH-BY-MONTH  |  1.5x vs 2x  |  $1,000 Start");
console.log(SEP);
console.log(`  ${p("Month",10)}  ${p("1.5x Tr",8,true)}  ${p("1.5x %",9,true)}  ${p("1.5x Bal",12,true)}    ${p("2x Tr",7,true)}  ${p("2x %",9,true)}  ${p("2x Bal",12,true)}`);
console.log(SEP2);

const allMonths = [...new Set([...r15.monthRows.map(r=>r.month), ...r2.monthRows.map(r=>r.month)])].sort();
const map15 = Object.fromEntries(r15.monthRows.map(r => [r.month, r]));
const map2  = Object.fromEntries(r2.monthRows.map(r  => [r.month, r]));

for (const month of allMonths) {
  const a = map15[month];
  const b = map2[month];
  const c15 = a ? `${p(a.trades+"tr",8,true)}  ${p(fmtPct(a.mpct),9,true)}  ${p(fmtBal(a.endBal),12,true)}` : `${p("—",8,true)}  ${p("—",9,true)}  ${p("—",12,true)}`;
  const c2  = b ? `${p(b.trades+"tr",7,true)}  ${p(fmtPct(b.mpct),9,true)}  ${p(fmtBal(b.endBal),12,true)}` : `${p("—",7,true)}  ${p("—",9,true)}  ${p("—",12,true)}`;
  const flag = (a && a.mpct < -10) || (b && b.mpct < -10) ? " ⚠️" : "";
  console.log(`  ${p(month,10)}  ${c15}    ${c2}${flag}`);
}
console.log(SEP2);
console.log(`  ${p("FINAL",10)}  ${p("",8,true)}  ${p("",9,true)}  ${p(fmtBal(r15.finalBalance),12,true)}    ${p("",7,true)}  ${p("",9,true)}  ${p(fmtBal(r2.finalBalance),12,true)}`);
console.log(SEP);

// ── Signal breakdown ───────────────────────────────────────────────────────────
console.log();
console.log(SEP);
console.log("  SIGNAL BREAKDOWN (1.5x)");
console.log(SEP);
console.log(`  ${p("Signal",12)}  ${p("Trades",7,true)}  ${p("Wins",6,true)}  ${p("Win%",6,true)}  ${p("Total PnL",13,true)}  ${p("Avg/Trade",12,true)}`);
console.log(SEP2);
const bySig = {};
for (const t of r15.closedTrades) {
  if (!bySig[t.signal]) bySig[t.signal] = [];
  bySig[t.signal].push(t);
}
for (const [sig, trades] of Object.entries(bySig).sort()) {
  const wins = trades.filter(t => t.pnl > 0).length;
  const pnl  = trades.reduce((s, t) => s + t.pnl, 0);
  const wr   = (wins / trades.length * 100).toFixed(0) + "%";
  const avg  = pnl / trades.length;
  console.log(`  ${p(sig,12)}  ${p(trades.length,7,true)}  ${p(wins,6,true)}  ${p(wr,6,true)}  ${p((pnl>=0?"+":"")+pnl.toFixed(2),13,true)}  ${p((avg>=0?"+":"")+avg.toFixed(2),12,true)}`);
}
console.log(SEP);

// ── Worst drawdown months ──────────────────────────────────────────────────────
console.log();
console.log(SEP);
console.log("  WORST 5 MONTHS  (1.5x vs 2x)");
console.log(SEP);
const worst15 = [...r15.monthRows].sort((a,b) => a.mpct - b.mpct).slice(0,5);
const worst2  = [...r2.monthRows].sort((a,b)  => a.mpct - b.mpct).slice(0,5);
console.log(`  ${p("Rank",6)}  ${p("Month (1.5x)",12)}  ${p("Loss%",8,true)}  ${p("Balance",12,true)}    ${p("Month (2x)",12)}  ${p("Loss%",8,true)}  ${p("Balance",12,true)}`);
console.log(SEP2);
for (let i = 0; i < 5; i++) {
  const a = worst15[i] || {};
  const b = worst2[i]  || {};
  const aPct = a.mpct != null ? a.mpct.toFixed(1)+"%" : "—";
  const aBal = a.endBal != null ? fmtBal(a.endBal) : "—";
  const bPct = b.mpct != null ? b.mpct.toFixed(1)+"%" : "—";
  const bBal = b.endBal != null ? fmtBal(b.endBal) : "—";
  console.log(`  ${p((i+1)+".",6)}  ${p(a.month||"—",12)}  ${p(aPct,8,true)}  ${p(aBal,12,true)}    ${p(b.month||"—",12)}  ${p(bPct,8,true)}  ${p(bBal,12,true)}`);
}
console.log(SEP);
console.log();
console.log(`  Note: SL at 6.5% price = capital loss per stop:`);
console.log(`    1.5x → ${(6.5*1.5).toFixed(2)}% capital loss  |  Liquidation at ~66% price drop`);
console.log(`    2.0x → ${(6.5*2.0).toFixed(2)}% capital loss  |  Liquidation at ~50% price drop`);
console.log();
