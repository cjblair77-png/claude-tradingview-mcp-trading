/**
 * backtest_break_bounce.mjs — Break & Bounce strategy — crypto adaptation
 *
 * Original strategy by Carl (YouTube) adapted for 24/7 crypto markets.
 *
 * ── Rules ──────────────────────────────────────────────────────────────────
 *
 * STEP 1 · Previous Day Range (PDH / PDL)
 *   PDH = highest high of all 15m candles in the previous UTC calendar day
 *   PDL = lowest  low  of all 15m candles in the previous UTC calendar day
 *
 * STEP 2 · 15m Breakout Confirmation
 *   Session opens: London 08:00 UTC, NY 13:00 UTC
 *   Within 2.5 hours (10 × 15m bars) of each session open:
 *     → 15m candle CLOSE above PDH = LONG breakout confirmed
 *     → 15m candle CLOSE below PDL = SHORT breakout confirmed
 *   Only one breakout signal per session.
 *
 * STEP 3 · Reversal Entry (retest + candle pattern)
 *   After breakout, wait for price to retest the broken level (PDH or PDL).
 *   Retest = candle low within RETEST_PCT of PDH (for LONG)
 *          or candle high within RETEST_PCT of PDL (for SHORT)
 *
 *   Entry triggers (at candle close):
 *     LONG:  Hammer — lower wick >= WICK_RATIO x body, body in upper half,
 *                      preceded by a red candle
 *     LONG:  Bullish Engulfing — green candle engulfs previous candle fully
 *     SHORT: Inverted Hammer — upper wick >= WICK_RATIO x body, body in lower half,
 *                              preceded by a green candle
 *     SHORT: Bearish Engulfing — red candle engulfs previous candle fully
 *
 *   SL: just below reversal candle low (LONG) / just above high (SHORT)
 *   TP: entry +/- (SL distance x RR)
 *   Time exit: position still open at end of 2.5hr window -> close at market
 *
 * Run: node backtest_break_bounce.mjs [DAYS] [START_BAL] [RR]
 *   eg: node backtest_break_bounce.mjs 365 5000 2
 */

const DAYS      = parseInt(process.argv[2]   || "365");
const START_BAL = parseFloat(process.argv[3] || "5000");
const RR        = parseFloat(process.argv[4] || "2");

const RISK_PCT      = 0.008;
const LEVERAGE      = 3;
const RETEST_PCT    = 0.005;   // within 0.5% of level = retest
const WICK_RATIO    = 1.5;     // lower wick >= 1.5x body for hammer
const SESSION_OPENS = [8, 13]; // London + NY UTC hours
const WINDOW_BARS   = 10;      // 2.5 hrs / 15m

const PAIRS = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT",
  "XRPUSDT", "SUIUSDT", "LTCUSDT", "AVAXUSDT",
  "LINKUSDT", "DOGEUSDT", "ADAUSDT", "DOTUSDT",
];

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchCandles(symbol, days) {
  const needed  = (days + 3) * 96 + 200;
  const batches = Math.ceil(needed / 1000);
  const all     = [];
  let endTime   = Date.now();
  for (let b = 0; b < batches; b++) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=1000&endTime=${endTime}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return null;
      const raw = await res.json();
      if (!Array.isArray(raw) || raw.length === 0) break;
      all.unshift(...raw.map(k => ({
        time:  parseInt(k[0]),
        open:  parseFloat(k[1]),
        high:  parseFloat(k[2]),
        low:   parseFloat(k[3]),
        close: parseFloat(k[4]),
      })));
      endTime = raw[0][0] - 1;
    } catch { return null; }
    if (b < batches - 1) await new Promise(r => setTimeout(r, 200));
  }
  if (!all.length) return null;
  const seen = new Set();
  return all.filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
            .sort((a, b) => a.time - b.time);
}

// ─── Previous Day High/Low ────────────────────────────────────────────────────

function computePDHL(candles) {
  const byDay = {};
  for (const c of candles) {
    const d   = new Date(c.time);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    if (!byDay[key]) byDay[key] = { high: -Infinity, low: Infinity };
    if (c.high > byDay[key].high) byDay[key].high = c.high;
    if (c.low  < byDay[key].low)  byDay[key].low  = c.low;
  }
  return candles.map(c => {
    const d    = new Date(c.time);
    const prev = new Date(d);
    prev.setUTCDate(prev.getUTCDate() - 1);
    const key  = `${prev.getUTCFullYear()}-${prev.getUTCMonth()}-${prev.getUTCDate()}`;
    return byDay[key] ? { pdh: byDay[key].high, pdl: byDay[key].low } : null;
  });
}

// ─── Candle patterns ──────────────────────────────────────────────────────────

function isHammer(c) {
  const body   = Math.abs(c.close - c.open);
  const lowerW = Math.min(c.open, c.close) - c.low;
  const range  = c.high - c.low;
  if (range === 0) return false;
  return lowerW >= WICK_RATIO * Math.max(body, range * 0.01)
      && (c.close - c.low) / range > 0.5;
}

function isInvHammer(c) {
  const body   = Math.abs(c.close - c.open);
  const upperW = c.high - Math.max(c.open, c.close);
  const range  = c.high - c.low;
  if (range === 0) return false;
  return upperW >= WICK_RATIO * Math.max(body, range * 0.01)
      && (c.high - c.close) / range > 0.5;
}

function isBullEng(cur, prev) {
  return cur.close > cur.open && cur.high > prev.high && cur.low < prev.low;
}

function isBearEng(cur, prev) {
  return cur.close < cur.open && cur.high > prev.high && cur.low < prev.low;
}

// ─── Per-pair backtest ────────────────────────────────────────────────────────

function backtestPair(symbol, candles) {
  const pdhl   = computePDHL(candles);
  const cutoff = candles[candles.length - 1].time - DAYS * 86400000;

  let balance = START_BAL, peak = START_BAL, maxDD = 0;
  let openPos = null;
  let session = null;  // { state, dir, pdh, pdl, windowEnd }
  const trades = [];

  for (let i = 1; i < candles.length; i++) {
    const c    = candles[i];
    const prev = candles[i - 1];
    const pd   = pdhl[i];
    if (!pd) continue;

    const h = new Date(c.time).getUTCHours();
    const m = new Date(c.time).getUTCMinutes();

    // New session open
    if (SESSION_OPENS.includes(h) && m === 0 && !openPos) {
      session = { state: 'WATCH', dir: null, pdh: pd.pdh, pdl: pd.pdl, windowEnd: i + WINDOW_BARS };
    }

    if (!session) continue;

    // Window expired
    if (i > session.windowEnd) {
      if (openPos) {
        const isLong  = openPos.dir === 'LONG';
        const movePct = isLong ? (c.close - openPos.entry) / openPos.entry
                               : (openPos.entry - c.close) / openPos.entry;
        const slPct   = Math.abs(openPos.entry - openPos.sl) / openPos.entry;
        const pnl     = slPct > 0 ? (movePct / slPct) * openPos.riskUSD * LEVERAGE : 0;
        balance += pnl; if (balance < 0.01) balance = 0.01;
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak * 100; if (dd > maxDD) maxDD = dd;
        trades.push({ dir: openPos.dir, pnl, exitReason: 'TIME', pattern: openPos.pattern, time: c.time });
        openPos = null;
      }
      session = null;
      continue;
    }

    // Check exits
    if (openPos) {
      const isLong = openPos.dir === 'LONG';
      const hitTP  = isLong ? c.high >= openPos.tp : c.low  <= openPos.tp;
      const hitSL  = isLong ? c.low  <= openPos.sl : c.high >= openPos.sl;
      let exitReason = null, exitPrice = null;
      if      (hitSL && hitTP) { exitReason = 'SL'; exitPrice = openPos.sl; }
      else if (hitSL)          { exitReason = 'SL'; exitPrice = openPos.sl; }
      else if (hitTP)          { exitReason = 'TP'; exitPrice = openPos.tp; }
      if (exitReason) {
        const movePct = isLong ? (exitPrice - openPos.entry) / openPos.entry
                               : (openPos.entry - exitPrice) / openPos.entry;
        const slPct   = Math.abs(openPos.entry - openPos.sl) / openPos.entry;
        const pnl     = slPct > 0 ? (movePct / slPct) * openPos.riskUSD * LEVERAGE : 0;
        balance += pnl; if (balance < 0.01) balance = 0.01;
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak * 100; if (dd > maxDD) maxDD = dd;
        trades.push({ dir: openPos.dir, pnl, exitReason, pattern: openPos.pattern, time: c.time });
        openPos = null; session = null;
        continue;
      }
    }

    if (c.time < cutoff || openPos) continue;

    // WATCH: looking for 15m breakout
    if (session.state === 'WATCH') {
      if      (c.close > session.pdh) { session.state = 'BREAKOUT'; session.dir = 'LONG';  }
      else if (c.close < session.pdl) { session.state = 'BREAKOUT'; session.dir = 'SHORT'; }
      continue;
    }

    // BREAKOUT: looking for retest + reversal candle
    if (session.state === 'BREAKOUT') {
      const level = session.dir === 'LONG' ? session.pdh : session.pdl;
      const lo    = level * (1 - RETEST_PCT);
      const hi    = level * (1 + RETEST_PCT);

      const retestOk = session.dir === 'LONG'
        ? (c.low <= hi && c.low >= lo)
        : (c.high >= lo && c.high <= hi);

      if (!retestOk) continue;

      let pattern = null;
      if (session.dir === 'LONG') {
        if      (isHammer(c) && prev.close < prev.open)  pattern = 'HAMMER';
        else if (isBullEng(c, prev))                      pattern = 'BULL_ENG';
      } else {
        if      (isInvHammer(c) && prev.close > prev.open) pattern = 'INV_HAMMER';
        else if (isBearEng(c, prev))                        pattern = 'BEAR_ENG';
      }
      if (!pattern) continue;

      const entry  = c.close;
      const sl     = session.dir === 'LONG' ? c.low * 0.999 : c.high * 1.001;
      const slDist = Math.abs(entry - sl);
      if (slDist <= 0 || slDist / entry > 0.025) continue;

      const tp      = session.dir === 'LONG' ? entry + slDist * RR : entry - slDist * RR;
      const riskUSD = balance * RISK_PCT;

      openPos = { dir: session.dir, entry, sl, tp, riskUSD, pattern };
    }
  }

  // Stats
  const wins    = trades.filter(t => t.pnl > 0).length;
  const losses  = trades.filter(t => t.pnl <= 0).length;
  const totalPnl = balance - START_BAL;
  const wr       = trades.length ? wins / trades.length * 100 : 0;

  const monthly = {};
  for (const t of trades) {
    const d = new Date(t.time);
    const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
    if (!monthly[k]) monthly[k] = 0;
    monthly[k] += t.pnl;
  }

  const byPattern = {};
  for (const t of trades) {
    if (!byPattern[t.pattern]) byPattern[t.pattern] = { trades: 0, wins: 0, pnl: 0 };
    byPattern[t.pattern].trades++;
    if (t.pnl > 0) byPattern[t.pattern].wins++;
    byPattern[t.pattern].pnl += t.pnl;
  }

  return {
    symbol, trades: trades.length, wins, losses, wr, totalPnl,
    retPct: (totalPnl / START_BAL) * 100, balance, maxDD, monthly, byPattern,
    tpC: trades.filter(t => t.exitReason === 'TP').length,
    slC: trades.filter(t => t.exitReason === 'SL').length,
    timeC: trades.filter(t => t.exitReason === 'TIME').length,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n📊 Break & Bounce — Crypto Backtest`);
  console.log(`   ${DAYS} days  |  $${START_BAL} start  |  ${LEVERAGE}x lev  |  ${(RISK_PCT*100).toFixed(1)}% risk  |  ${RR}:1 R:R`);
  console.log(`   Sessions: London 08:00 + NY 13:00 UTC  |  2.5hr window  |  PDH/PDL previous UTC day\n`);

  const results = [];

  for (const sym of PAIRS) {
    process.stdout.write(`  ${sym.padEnd(12)} fetching...`);
    const candles = await fetchCandles(sym, DAYS);
    if (!candles || candles.length < 300) { process.stdout.write(` no data\n`); continue; }
    const r = backtestPair(sym, candles);
    results.push(r);
    const flag = r.retPct > 0 ? '✅' : '❌';
    process.stdout.write(`\r  ${sym.padEnd(12)} ${flag}  ${String(r.trades).padStart(3)} trades  WR ${r.wr.toFixed(1).padStart(5)}%  ret ${((r.retPct >= 0?'+':'')+r.retPct.toFixed(1)).padStart(7)}%  DD ${r.maxDD.toFixed(1).padStart(5)}%\n`);
  }

  // Combined monthly
  const allMonths    = [...new Set(results.flatMap(r => Object.keys(r.monthly)))].sort();
  const combMonthly  = {};
  for (const r of results) for (const [mo, pnl] of Object.entries(r.monthly)) {
    combMonthly[mo] = (combMonthly[mo] || 0) + pnl;
  }
  const combPattern = {};
  for (const r of results) for (const [pat, s] of Object.entries(r.byPattern)) {
    if (!combPattern[pat]) combPattern[pat] = { trades: 0, wins: 0, pnl: 0 };
    combPattern[pat].trades += s.trades; combPattern[pat].wins += s.wins; combPattern[pat].pnl += s.pnl;
  }
  const combTrades = results.reduce((s, r) => s + r.trades, 0);
  const combWins   = results.reduce((s, r) => s + r.wins, 0);
  const combTP     = results.reduce((s, r) => s + r.tpC, 0);
  const combSL     = results.reduce((s, r) => s + r.slC, 0);
  const combTime   = results.reduce((s, r) => s + r.timeC, 0);

  // Ranked table
  results.sort((a, b) => b.retPct - a.retPct);
  console.log('\n' + '═'.repeat(88));
  console.log('  RANKED RESULTS\n');
  console.log('  ' + 'Pair'.padEnd(12) + 'Trades'.padStart(7) + 'WR%'.padStart(7) + 'Return%'.padStart(9) + 'P&L$'.padStart(9) + 'MaxDD%'.padStart(8) + '  TP  SL TIME');
  console.log('  ' + '─'.repeat(75));
  for (const r of results) {
    const ret = (r.retPct>=0?'+':'')+r.retPct.toFixed(1)+'%';
    const pnl = (r.totalPnl>=0?'+$':'-$')+Math.abs(r.totalPnl).toFixed(0);
    const rec = r.wr>=50 && r.retPct>0 && r.maxDD<40 && r.trades>=10 ? ' ← add' : '';
    console.log(`  ${r.symbol.padEnd(12)}${String(r.trades).padStart(7)}${(r.wr.toFixed(1)+'%').padStart(7)}${ret.padStart(9)}${pnl.padStart(9)}${(r.maxDD.toFixed(1)+'%').padStart(8)}  ${String(r.tpC).padStart(3)} ${String(r.slC).padStart(3)}  ${String(r.timeC).padStart(3)}${rec}`);
  }

  console.log('\n  OVERALL: ' + combTrades + ' trades  |  WR ' + (combWins/combTrades*100).toFixed(1) + '%  |  TP '+combTP+' · SL '+combSL+' · TIME '+combTime);

  // Monthly
  console.log('\n  MONTHLY — all pairs combined\n');
  for (const mo of allMonths.slice(-14)) {
    const v   = combMonthly[mo] || 0;
    const bar = '█'.repeat(Math.min(Math.round(Math.abs(v) / (START_BAL * 0.1)), 25));
    console.log(`  ${mo}  ${((v>=0?'+$':'-$')+Math.abs(v).toFixed(0)).padStart(10)}  ${v>=0?bar:'('+bar+')'}`);
  }

  // Pattern breakdown
  console.log('\n  PATTERN BREAKDOWN\n');
  for (const [pat, s] of Object.entries(combPattern)) {
    const wr  = (s.wins/s.trades*100).toFixed(1);
    const pnl = (s.pnl>=0?'+$':'-$')+Math.abs(s.pnl).toFixed(0);
    console.log(`  ${pat.padEnd(12)}  ${String(s.trades).padStart(4)} trades  WR ${wr}%  P&L ${pnl}`);
  }
  console.log('\n' + '═'.repeat(88) + '\n');
}

main().catch(console.error);
