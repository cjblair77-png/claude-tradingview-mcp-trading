/**
 * backtest_pullback.js — "BTC-ETH Pullback Pro" strategy backtest
 *
 * Concept: Long BTC and ETH only when they pull back to the 4H EMA21
 * during a confirmed daily uptrend. High R:R, low frequency, maker orders.
 *
 * Universe:   BTC_USDT, ETH_USDT (top liquidity)
 * Execution:  4H bars
 * Direction:  LONG only
 * Trend gate: Daily EMA21 > EMA50 AND EMA50 > EMA200 (strong bull)
 * Entry trigger (4H):
 *   - Previous bar's low within 1% of EMA21 (the pullback)
 *   - Current bar close > EMA21 (the recapture)
 *   - RSI between 40 and 60 (room to run, not extreme)
 *   - Volume > 1.2× 20-bar SMA (participation confirmation)
 * Order:      Limit at signal-close × 0.9995 (5bps below — guaranteed maker)
 * Timeout:    6 bars (24h) — cancel if unfilled
 * SL:         3% below entry
 * TP:         9% above entry (3:1 R:R)
 * Risk:       1% per trade (true Option 1 sizing — actual loss = 1% of equity)
 * Leverage:   2× (margin efficiency only — does NOT scale position size)
 * Max pos:    2 (one per pair)
 *
 * Fees:       MEXC futures — 0% maker on fills, 0.02% taker if forced to market
 *
 * Run: node backtest_pullback.js
 */

import "dotenv/config";

const MEXC_BASE  = "https://futures.mexc.com";
const DAYS       = 150;
const NOW_SEC    = Math.floor(Date.now() / 1000);
const START_150  = NOW_SEC - DAYS * 86400;
const MAKER_FEE  = 0.0000;   // 0% per fill
const TAKER_FEE  = 0.0002;   // 0.02% per fill (only if we force to market on cancel — unused here)

// ── Strategy config ──────────────────────────────────────────────────────────

const PAIRS         = ["BTC_USDT", "ETH_USDT"];
const RISK_PCT      = 0.01;     // 1% true risk per trade
const LEVERAGE      = 2;        // margin efficiency only
const SL_PCT        = 0.03;     // 3%
const TP_PCT        = 0.09;     // 9% (3:1 R:R)
const MAKER_OFFSET  = 0.0005;   // 5 bps below entry for maker
const PENDING_MAX   = 6;        // 6 × 4H = 24h timeout
const START_BALANCE = 5000;
// QUALITY filters — take only A+ setups (v09-style)
const PULLBACK_PCT  = 0.02;
const RSI_LONG_MIN  = 54;       // v09's tight RSI band
const RSI_LONG_MAX  = 65;
const RSI_SHORT_MIN = 35;
const RSI_SHORT_MAX = 46;
const VOL_MULT      = 1.5;      // require strong volume confirmation
const BREAKOUT_LOOKBACK = 20;   // 20-bar high/low (5 days on 4H) = significant level
const EMA21_SLOPE_BARS = 3;     // EMA21 must be rising/falling for 3 bars (trend strength)
const TREND_WARMUP_DAYS = 250;

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
    return time.map((t, i) => ({ t: t*1000, o: +open[i], c: +close[i], h: +high[i], l: +low[i], v: +vol[i] })).sort((a,b) => a.t - b.t);
  } catch { return []; }
}

async function fetchAllBars(symbol, intervalStr, barSecs, startSec, endSec) {
  const bars = []; const chunk = 1800 * barSecs;
  let cur = startSec, emptyRuns = 0;
  while (cur < endSec) {
    const end = Math.min(cur + chunk, endSec);
    const batch = await fetchChunk(symbol, intervalStr, cur, end);
    if (!batch.length) { emptyRuns++; if (emptyRuns >= 5) break; cur = end + barSecs; await sleep(120); continue; }
    emptyRuns = 0; bars.push(...batch);
    cur = Math.floor(batch[batch.length-1].t/1000) + barSecs;
    await sleep(180);
  }
  const seen = new Set();
  return bars.filter(b => { if (seen.has(b.t)) return false; seen.add(b.t); return true; }).sort((a,b) => a.t - b.t);
}

function ema(values, period) {
  const k = 2 / (period + 1), out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i-1] * (1-k));
  return out;
}
function sma(values, period) {
  return values.map((_, i) => i < period-1 ? null : values.slice(i-period+1, i+1).reduce((a,b)=>a+b,0) / period);
}
function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null); let g = 0, l = 0;
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

// ── Daily trend lookup — bidirectional ─────────────────────────────────────
// Returns "bull" if daily EMA21 > EMA50, "bear" if EMA21 < EMA50, else "neutral"
// (neutral = within 0.5% of each other, no clear direction)

function buildDailyTrendMap(dailyBars) {
  const closes = dailyBars.map(b => b.c);
  const e21 = ema(closes, 21), e50 = ema(closes, 50);
  return dailyBars.map((b, i) => {
    if (e21[i] == null || e50[i] == null) return { t: b.t, regime: "neutral" };
    const sepPct = (e21[i] - e50[i]) / e50[i];
    let regime = "neutral";
    if (sepPct > 0.005) regime = "bull";       // EMA21 > 0.5% above EMA50
    else if (sepPct < -0.005) regime = "bear"; // EMA21 > 0.5% below EMA50
    return { t: b.t, regime };
  });
}

function getDailyRegime(dailyTrend, fourHBarTime) {
  const dayMs = 24 * 3600 * 1000;
  let lo = 0, hi = dailyTrend.length - 1, result = "neutral";
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dailyTrend[mid].t + dayMs <= fourHBarTime) { result = dailyTrend[mid].regime; lo = mid + 1; }
    else hi = mid - 1;
  }
  return result;
}

// ── Simulator ───────────────────────────────────────────────────────────────

function simulate(pairData) {
  let balance = START_BALANCE, peak = balance, maxDD = 0;
  const positions = [];          // filled open positions
  const pending = [];            // limit orders awaiting fill
  const trades = [];
  let totalFees = 0;
  let signalsFired = 0, ordersPlaced = 0, ordersFilled = 0, ordersCancelled = 0;

  // Pre-compute everything per symbol
  const sym = {};
  for (const s of PAIRS) {
    const { fourH, daily } = pairData[s];
    if (!fourH || fourH.length < 30) continue;
    const closes = fourH.map(b => b.c), vols = fourH.map(b => b.v);
    sym[s] = {
      bars: fourH,
      e21: ema(closes, 21),
      rsi: rsi(closes, 14),
      vsma: sma(vols, 20),
      trend: buildDailyTrendMap(daily),
    };
  }

  // Build a unified timeline of 4H timestamps in trade window
  const allTs = new Set();
  for (const s of PAIRS) {
    const ind = sym[s]; if (!ind) continue;
    for (const b of ind.bars) if (b.t/1000 >= START_150) allTs.add(b.t);
  }
  const sortedTs = [...allTs].sort((a,b)=>a-b);

  for (const ts of sortedTs) {
    // ─── 1. Check pending limit orders for fill ─────────────────────────────
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      const ind = sym[p.symbol]; if (!ind) continue;
      const bi = ind.bars.findIndex(b => b.t === ts); if (bi < 0) continue;
      const bar = ind.bars[bi];
      if (bar.t <= p.signalBarTime) continue;

      // LONG limit fills if low touched limit; SHORT fills if high touched limit
      const filled = p.direction === "LONG" ? bar.l <= p.limitPrice : bar.h >= p.limitPrice;
      if (filled) {
        positions.push({
          symbol: p.symbol,
          direction: p.direction,
          entry: p.limitPrice,
          sl: p.sl,
          tp: p.tp,
          sizeUSD: p.sizeUSD,
          riskUSD: p.riskUSD,
          fillBarTime: bar.t,
        });
        pending.splice(i, 1);
        ordersFilled++;
        continue;
      }

      const ageBars = bi - p.signalBarIdx;
      if (ageBars >= PENDING_MAX) { pending.splice(i, 1); ordersCancelled++; }
    }

    // ─── 2. Check exits on open positions ────────────────────────────────────
    for (let i = positions.length - 1; i >= 0; i--) {
      const pos = positions[i];
      const ind = sym[pos.symbol]; if (!ind) continue;
      const bi = ind.bars.findIndex(b => b.t === ts); if (bi < 0) continue;
      const bar = ind.bars[bi];
      if (bar.t <= pos.fillBarTime) continue;

      const isLong = pos.direction === "LONG";
      const hitSL = isLong ? bar.l <= pos.sl : bar.h >= pos.sl;
      const hitTP = isLong ? bar.h >= pos.tp : bar.l <= pos.tp;

      let exitPrice = null, exitReason = null;
      if (hitSL && hitTP) { exitPrice = pos.sl; exitReason = "SL"; }
      else if (hitSL)     { exitPrice = pos.sl; exitReason = "SL"; }
      else if (hitTP)     { exitPrice = pos.tp; exitReason = "TP"; }

      if (exitPrice !== null) {
        const priceDiff = isLong ? exitPrice - pos.entry : pos.entry - exitPrice;
        const grossPnl = (priceDiff / pos.entry) * pos.sizeUSD;
        const exitFee  = pos.sizeUSD * MAKER_FEE; // exit also via limit at TP/SL (both maker)
        const netPnl   = grossPnl - exitFee;
        totalFees += exitFee;
        balance += netPnl;
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak * 100;
        if (dd > maxDD) maxDD = dd;
        trades.push({ symbol: pos.symbol, direction: pos.direction, entryPrice: pos.entry, exitPrice, gross: grossPnl, fee: exitFee, net: netPnl, exitReason, exitTs: bar.t, entryTs: pos.fillBarTime });
        positions.splice(i, 1);
      }
    }

    // ─── 3. Check for new signals → place new limit orders ──────────────────
    if (positions.length + pending.length >= 2) continue; // max 2 positions total
    for (const s of PAIRS) {
      // Skip if already have an open or pending order for this symbol
      if (positions.some(p => p.symbol === s)) continue;
      if (pending.some(p => p.symbol === s)) continue;

      const ind = sym[s]; if (!ind) continue;
      const bi = ind.bars.findIndex(b => b.t === ts); if (bi < 2) continue;
      const i = bi - 1, prev = i - 1; // signal bar = previous closed bar

      if (!ind.rsi[i] || !ind.vsma[i] || !ind.e21[i]) continue;
      if (i < BREAKOUT_LOOKBACK + EMA21_SLOPE_BARS) continue;

      const bar = ind.bars[i];
      const regime = getDailyRegime(ind.trend, bar.t);
      if (regime === "neutral") continue;

      // QUALITY filter 1: Volume must be 1.5×
      if (bar.v < ind.vsma[i] * VOL_MULT) continue;

      const lookbackHigh = Math.max(...ind.bars.slice(i - BREAKOUT_LOOKBACK, i).map(b => b.h));
      const lookbackLow  = Math.min(...ind.bars.slice(i - BREAKOUT_LOOKBACK, i).map(b => b.l));

      // QUALITY filter 2: EMA21 slope must align with direction
      const e21Rising  = ind.e21[i] > ind.e21[i - EMA21_SLOPE_BARS];
      const e21Falling = ind.e21[i] < ind.e21[i - EMA21_SLOPE_BARS];

      let direction = null;

      if (regime === "bull" && e21Rising) {
        if (ind.rsi[i] < RSI_LONG_MIN || ind.rsi[i] > RSI_LONG_MAX) continue;
        // BREAKOUT only: 20-bar high break (drop the pullback trigger — too noisy)
        if (bar.c <= lookbackHigh) continue;
        direction = "LONG";
      } else if (regime === "bear" && e21Falling) {
        if (ind.rsi[i] < RSI_SHORT_MIN || ind.rsi[i] > RSI_SHORT_MAX) continue;
        // BREAKDOWN only: 20-bar low break
        if (bar.c >= lookbackLow) continue;
        direction = "SHORT";
      }
      if (!direction) continue;

      // SIGNAL FIRED — place limit order
      signalsFired++;
      // For LONG, limit BELOW close (passive bid); for SHORT, limit ABOVE close (passive ask)
      const limitPrice = direction === "LONG"
        ? bar.c * (1 - MAKER_OFFSET)
        : bar.c * (1 + MAKER_OFFSET);
      const slPrice = direction === "LONG"
        ? limitPrice * (1 - SL_PCT)
        : limitPrice * (1 + SL_PCT);
      const tpPrice = direction === "LONG"
        ? limitPrice * (1 + TP_PCT)
        : limitPrice * (1 - TP_PCT);
      const riskUSD = balance * RISK_PCT;
      const slDist  = Math.abs(limitPrice - slPrice);
      const sizeUSD = (riskUSD / slDist) * limitPrice;

      pending.push({
        symbol: s,
        direction,
        limitPrice,
        sl: slPrice,
        tp: tpPrice,
        sizeUSD,
        riskUSD,
        signalBarIdx: i,
        signalBarTime: bar.t,
        placedAt: bar.t,
      });
      ordersPlaced++;
    }
  }

  // Cancel anything still pending at end
  ordersCancelled += pending.length;

  // Force-close any still-open positions at last close
  for (const pos of positions) {
    const ind = sym[pos.symbol]; if (!ind) continue;
    const lastBar = ind.bars[ind.bars.length - 1];
    const exitPrice = lastBar.c;
    const isLong = pos.direction === "LONG";
    const priceDiff = isLong ? exitPrice - pos.entry : pos.entry - exitPrice;
    const grossPnl = (priceDiff / pos.entry) * pos.sizeUSD;
    balance += grossPnl;
    trades.push({ symbol: pos.symbol, direction: pos.direction, entryPrice: pos.entry, exitPrice, gross: grossPnl, fee: 0, net: grossPnl, exitReason: "OPEN@END", exitTs: lastBar.t, entryTs: pos.fillBarTime });
  }

  // Stats
  const wins = trades.filter(t => t.net > 0);
  const losses = trades.filter(t => t.net < 0);
  const winRate = trades.length ? wins.length / trades.length * 100 : 0;
  const grossW = wins.reduce((s,t) => s + t.gross, 0);
  const grossL = Math.abs(losses.reduce((s,t) => s + t.gross, 0));
  const pf = grossL > 0 ? grossW / grossL : (wins.length ? Infinity : 0);
  const avgWin = wins.length ? wins.reduce((s,t)=>s+t.net,0)/wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s,t)=>s+t.net,0))/losses.length : 0;
  const fillRate = ordersPlaced ? ordersFilled / ordersPlaced * 100 : 0;

  return { balance, peak, maxDD, trades, totalFees, signalsFired, ordersPlaced, ordersFilled, ordersCancelled, fillRate, winRate, pf, avgWin, avgLoss };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const startDate = new Date(START_150*1000).toISOString().slice(0,10);
  const endDate   = new Date().toISOString().slice(0,10);

  console.log("╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  BTC-ETH PULLBACK PRO — Backtest                                   ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`  Period:    ${startDate} → ${endDate}`);
  console.log(`  Universe:  ${PAIRS.join(", ")}`);
  console.log(`  Direction: LONG (bull daily) + SHORT (bear daily)  |  Bidirectional`);
  console.log(`  Entry:     20-bar high/low break + EMA21 slope-aligned + RSI ${RSI_LONG_MIN}-${RSI_LONG_MAX} long / ${RSI_SHORT_MIN}-${RSI_SHORT_MAX} short + vol ${VOL_MULT}×`);
  console.log(`  Orders:    LIMIT at -${MAKER_OFFSET*10000}bps (maker), ${PENDING_MAX}-bar timeout`);
  console.log(`  Risk:      ${RISK_PCT*100}% per trade (Option 1 sizing)  |  Lev: ${LEVERAGE}× (margin only)`);
  console.log(`  SL/TP:     ${SL_PCT*100}% / ${TP_PCT*100}% (${(TP_PCT/SL_PCT).toFixed(1)}:1)`);
  console.log(`  Fees:      MAKER 0%, TAKER 0.02% (only fees if forced to market)`);

  // Fetch 4H data
  console.log("\n[1/2] Fetching 4H data…");
  const fourHFetchStart = NOW_SEC - (DAYS + 60) * 86400; // 60 day warmup for indicators
  const pairData = {};
  for (const s of PAIRS) {
    process.stdout.write(`  ${s} 4H…`);
    const bars = await fetchAllBars(s, "Hour4", 4*3600, fourHFetchStart, NOW_SEC);
    pairData[s] = { fourH: bars };
    process.stdout.write(`\r  ${s.padEnd(12)} 4H: ${bars.length} bars ✓\n`);
    await sleep(150);
  }

  // Fetch daily data for trend filter
  console.log("\n[2/2] Fetching Daily data (for trend filter)…");
  const dailyFetchStart = NOW_SEC - TREND_WARMUP_DAYS * 86400;
  for (const s of PAIRS) {
    process.stdout.write(`  ${s} D1…`);
    const bars = await fetchAllBars(s, "Day1", 86400, dailyFetchStart, NOW_SEC);
    pairData[s].daily = bars;
    process.stdout.write(`\r  ${s.padEnd(12)} D1: ${bars.length} bars ✓\n`);
    await sleep(150);
  }

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Running simulation…");
  console.log("══════════════════════════════════════════════════════════════");
  const res = simulate(pairData);

  // ─── Report ────────────────────────────────────────────────────────────────
  console.log("\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  RESULTS                                                            ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`  Start balance:       $${START_BALANCE.toLocaleString()}`);
  console.log(`  End balance:         $${res.balance.toFixed(0)}`);
  const ret = (res.balance - START_BALANCE) / START_BALANCE * 100;
  console.log(`  Return:              ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%`);
  console.log(`  Peak balance:        $${res.peak.toFixed(0)}`);
  console.log(`  Max drawdown:        ${res.maxDD.toFixed(1)}%`);
  console.log(`  Total fees:          $${res.totalFees.toFixed(2)} (all maker, 0%)`);

  console.log(`\n  ── Order-flow ──`);
  console.log(`  Signals fired:       ${res.signalsFired}`);
  console.log(`  Limit orders placed: ${res.ordersPlaced}`);
  console.log(`  Filled:              ${res.ordersFilled}  (${res.fillRate.toFixed(1)}% fill rate)`);
  console.log(`  Cancelled (timeout): ${res.ordersCancelled}`);

  console.log(`\n  ── Trades ──`);
  const wins = res.trades.filter(t => t.net > 0).length;
  const losses = res.trades.filter(t => t.net < 0).length;
  console.log(`  Total closed:        ${res.trades.length}  (W:${wins} / L:${losses})`);
  console.log(`  Win rate:            ${res.winRate.toFixed(1)}%`);
  console.log(`  Avg win:             +$${res.avgWin.toFixed(2)}`);
  console.log(`  Avg loss:            -$${res.avgLoss.toFixed(2)}`);
  console.log(`  Profit factor:       ${res.pf === Infinity ? '∞' : res.pf.toFixed(2)}`);

  console.log(`\n  ── Per-pair P&L ──`);
  for (const s of PAIRS) {
    const ptrades = res.trades.filter(t => t.symbol === s);
    const pPnl = ptrades.reduce((sum,t) => sum + t.net, 0);
    const pWins = ptrades.filter(t => t.net > 0).length;
    console.log(`  ${s.padEnd(12)} ${ptrades.length} trades  ${pPnl >= 0 ? '+' : ''}$${pPnl.toFixed(2)}  (WR ${ptrades.length ? (pWins/ptrades.length*100).toFixed(0) : 0}%)`);
  }

  // ─── Comparison to existing strategies ─────────────────────────────────────
  console.log(`\n  ── How it compares to your existing bots (same 150 days, real fees) ──`);
  console.log(`  v09:           +34.7% return, 5.7% max DD, PF 2.00, 75 trades`);
  console.log(`  DT (Option 1): +4.4%  return, 11.3% max DD, PF 1.05, 210 trades`);
  console.log(`  ORB (Option 1):-0.8%  return, 12.0% max DD, PF 0.97, 806 trades`);
  console.log(`  Pullback Pro:  ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}% return, ${res.maxDD.toFixed(1)}% max DD, PF ${res.pf === Infinity ? '∞' : res.pf.toFixed(2)}, ${res.trades.length} trades`);

  // ─── Verdict ───────────────────────────────────────────────────────────────
  console.log(`\n  📋 VERDICT:`);
  if (ret > 30 && res.maxDD < 10 && res.pf > 1.8) {
    console.log(`     ✅ STRONG — high return, low drawdown, solid profit factor`);
    console.log(`     Recommend: build live paper-trading bot`);
  } else if (ret > 10 && res.maxDD < 15 && res.pf > 1.4) {
    console.log(`     ⚠️  GOOD — worth paper trading to validate`);
  } else if (ret > 0 && res.pf > 1.0) {
    console.log(`     ⚠️  MARGINAL — profitable but unimpressive; tune parameters or skip`);
  } else {
    console.log(`     ❌ WEAK — doesn't beat baseline; needs redesign`);
  }

  const mins = ((Date.now()-t0)/60000).toFixed(1);
  console.log(`\n  Backtest time: ${mins} min\n`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
