/**
 * Compound Backtest — Fixed $50 vs 5% of Balance
 *
 * Runs two simulations on the same trades:
 *   Sim A: Fixed $50 per trade (current bot setting)
 *   Sim B: 5% of current balance per trade (compounding)
 *
 * 50 coins · 1H candles · Shared $1,000 balance · Chronological order
 * SL: 5%  TP: 15%  Min confidence: 65%
 * Signals: ST Bullish Flip (LONG) · BB Recovery (LONG) · ST+MACD+RSI Short
 */

import https from 'https';

// ─── Config ──────────────────────────────────────────────────────────────────

const COINS = [
  'BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT',
  'DOGEUSDT','LINKUSDT','SUIUSDT','LTCUSDT','AVAXUSDT','HBARUSDT',
  'ADAUSDT','TRXUSDT','TONUSDT','SHIBUSDT','DOTUSDT','BCHUSDT',
  'UNIUSDT','NEARUSDT','APTUSDT','ICPUSDT','ETCUSDT','POLUSDT',
  'VETUSDT','ATOMUSDT','OPUSDT','ARBUSDT','FILUSDT','ALGOUSDT',
  'INJUSDT','BONKUSDT','GRTUSDT','PEPEUSDT','WLDUSDT','AAVEUSDT',
  'TAOUSDT','RENDERUSDT','FETUSDT','STXUSDT','CRVUSDT','THETAUSDT',
  'JASMYUSDT','ONDOUSDT','RUNEUSDT','SANDUSDT','MANAUSDT','ENAUSDT',
  'LDOUSDT','SEIUSDT','TIAUSDT'
];

const START_BAL   = 1000;
const FIXED_SIZE  = 50;        // Sim A: always $50
const COMPOUND_PCT = 0.05;     // Sim B: 5% of current balance
const SL_PCT      = 0.05;
const TP_PCT      = 0.15;
const MIN_CONF    = 65;
const MAX_CONCURRENT = 10;     // max simultaneous open positions per sim

// ─── Data Fetch ───────────────────────────────────────────────────────────────

function fetchCandles(symbol, limit = 1000) {
  return new Promise((resolve, reject) => {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=${limit}`;
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const raw = JSON.parse(d);
          if (!Array.isArray(raw)) return reject(new Error(`Bad response: ${d.slice(0,60)}`));
          resolve(raw.map(k => ({
            time:   parseInt(k[0]),
            open:   parseFloat(k[1]),
            high:   parseFloat(k[2]),
            low:    parseFloat(k[3]),
            close:  parseFloat(k[4]),
            volume: parseFloat(k[5]),
          })));
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcEMASeries(values, period) {
  const k = 2 / (period + 1);
  const r = new Array(values.length).fill(null);
  let ema = values[0]; r[0] = ema;
  for (let i = 1; i < values.length; i++) { ema = values[i] * k + ema * (1-k); r[i] = ema; }
  return r;
}

function calcRSISeries(closes, period = 14) {
  const r = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let g = 0, l = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j] - closes[j-1];
      if (d > 0) g += d; else l -= d;
    }
    const ag = g / period, al = l / period;
    r[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return r;
}

function calcATRSeries(candles, period) {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const p = candles[i-1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - p), Math.abs(c.low - p));
  });
  const atr = new Array(candles.length).fill(null);
  atr[period-1] = trs.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < candles.length; i++)
    atr[i] = (atr[i-1] * (period-1) + trs[i]) / period;
  return atr;
}

function calcSuperTrendSeries(candles, atrPeriod = 10, mult = 3) {
  const atr = calcATRSeries(candles, atrPeriod);
  const r   = new Array(candles.length).fill(null);
  let pUp = null, pLo = null, pDir = null;
  for (let i = atrPeriod; i < candles.length; i++) {
    const hl2 = (candles[i].high + candles[i].low) / 2;
    let up = hl2 + mult * atr[i];
    let lo = hl2 - mult * atr[i];
    if (pLo !== null) lo = candles[i].close > pLo ? Math.max(lo, pLo) : lo;
    if (pUp !== null) up = candles[i].close < pUp ? Math.min(up, pUp) : up;
    let dir;
    if   (pDir === null)  dir = candles[i].close > up ? 1 : -1;
    else if (pDir === -1) dir = candles[i].close > pUp ? 1 : -1;
    else                  dir = candles[i].close < pLo ? -1 : 1;
    r[i] = { upper: up, lower: lo, direction: dir, line: dir === 1 ? lo : up };
    pUp = up; pLo = lo; pDir = dir;
  }
  return r;
}

function calcMACDSeries(closes, fast = 12, slow = 26, signal = 9) {
  const fastEMA  = calcEMASeries(closes, fast);
  const slowEMA  = calcEMASeries(closes, slow);
  const macdLine = closes.map((_, i) => fastEMA[i] - slowEMA[i]);
  const sigLine  = new Array(closes.length).fill(null);
  const k = 2 / (signal + 1); let s = macdLine[0]; sigLine[0] = s;
  for (let i = 1; i < closes.length; i++) { s = macdLine[i] * k + s * (1-k); sigLine[i] = s; }
  return { macdLine, sigLine };
}

function calcBBSeries(values, length, mult) {
  return values.map((_, i) => {
    if (i < length - 1) return null;
    const sl   = values.slice(i - length + 1, i + 1);
    const mean = sl.reduce((s, v) => s + v, 0) / length;
    const std  = Math.sqrt(sl.reduce((s, v) => s + (v - mean) ** 2, 0) / length);
    return { mid: mean, upper: mean + mult * std, lower: mean - mult * std };
  });
}

function calcVWAPSeries(candles) {
  const r = new Array(candles.length).fill(null);
  let cumTPV = 0, cumVol = 0, currentDay = null;
  for (let i = 0; i < candles.length; i++) {
    const day = new Date(candles[i].time).toISOString().slice(0, 10);
    if (day !== currentDay) { cumTPV = 0; cumVol = 0; currentDay = day; }
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    cumTPV += tp * candles[i].volume;
    cumVol += candles[i].volume;
    r[i] = cumVol === 0 ? null : cumTPV / cumVol;
  }
  return r;
}

// ─── Confidence ───────────────────────────────────────────────────────────────

function calcConfidence(price, ema, vwap, rsi, st, macd, sigLine, bbSigs, stSigs) {
  const r = rsi ?? 50;
  let L = 0, S = 0;

  if (st)    { if (st.direction === 1) L += 20; else S += 20; }
  if (ema)   { if (price > ema)        L += 10; else S += 10; }
  if (vwap)  { if (price > vwap)       L += 5;  else S += 5;  }

  if (macd != null && sigLine != null) {
    if (macd > 0)       L += 12; else S += 12;
    if (macd > sigLine) L += 13; else S += 13;
  }

  if      (r < 30) L += 25; else if (r < 40) L += 15; else if (r < 50) L += 5;
  if      (r > 70) S += 25; else if (r > 60) S += 15; else if (r > 50) S += 5;

  if (stSigs.includes('LONG'))  L += 15;
  if (stSigs.includes('SHORT')) S += 15;
  if (bbSigs.includes('LONG'))  L += 10;
  if (bbSigs.includes('SHORT')) S += 10;

  return { long: Math.min(L, 100), short: Math.min(S, 100) };
}

// ─── Signal detection ─────────────────────────────────────────────────────────

function getSignal(i, candles, ema20s, rsi14s, vwaps, sts, macdLine, sigLine, bb1s, bb2s) {
  const st = sts[i], stP = sts[i-1];
  if (!st || !stP || rsi14s[i] == null || ema20s[i] == null) return null;

  const c    = candles[i].close, cP = candles[i-1].close;
  const rsi  = rsi14s[i];
  const ema  = ema20s[i];
  const vwap = vwaps[i];
  const macd = macdLine[i], sig = sigLine[i];
  const bb1  = bb1s[i], bb1P = bb1s[i-1];
  const bb2  = bb2s[i];

  const bbSigs = [], stSigs = [];

  // ST Bullish Flip → LONG
  if (stP.direction === -1 && st.direction === 1) stSigs.push('LONG');
  // ST+MACD+RSI Short
  if (st.direction === -1 && macd < 0 && rsi > 70) stSigs.push('SHORT');
  // BB Recovery → LONG (no BB Breakdown — confirmed loser)
  if (bb1 && bb1P && cP < bb1P.lower && c > bb1.lower) bbSigs.push('LONG');

  let direction = null;
  if      (stSigs.includes('LONG'))  direction = 'LONG';
  else if (stSigs.includes('SHORT')) direction = 'SHORT';
  else if (bbSigs.includes('LONG'))  direction = 'LONG';

  if (!direction) return null;

  const conf  = calcConfidence(c, ema, vwap, rsi, st, macd, sig, bbSigs, stSigs);
  const score = direction === 'LONG' ? conf.long : conf.short;
  if (score < MIN_CONF) return null;

  let source = 'VWAP+EMA+RSI';
  if      (stSigs.includes('LONG'))  source = 'ST Bullish Flip';
  else if (stSigs.includes('SHORT')) source = 'ST+MACD+RSI Short';
  else if (bbSigs.includes('LONG'))  source = 'BB Recovery';

  return { direction, score, source };
}

// ─── Simulation engine ────────────────────────────────────────────────────────
// Each sim tracks: balance, openPositions{}, trades[], equityCurve[]

function createSim(name) {
  return {
    name,
    balance:       START_BAL,
    peakBalance:   START_BAL,
    maxDrawdown:   0,
    openPositions: {},   // symbol → position
    trades:        [],
    equitySnaps:   [],   // { time, balance }
  };
}

function simEnter(sim, symbol, direction, entryPrice, signal, tradeSize, time) {
  if (sim.openPositions[symbol]) return;           // already in this symbol
  if (Object.keys(sim.openPositions).length >= MAX_CONCURRENT) return;  // cap
  if (sim.balance < tradeSize) return;             // not enough capital

  const isLong = direction === 'LONG';
  const sl = isLong ? entryPrice * (1 - SL_PCT) : entryPrice * (1 + SL_PCT);
  const tp = isLong ? entryPrice * (1 + TP_PCT) : entryPrice * (1 - TP_PCT);

  sim.balance -= tradeSize;
  sim.openPositions[symbol] = { symbol, direction, entryPrice, size: tradeSize, sl, tp, signal, time };
}

function simUpdate(sim, symbol, bar, time) {
  const pos = sim.openPositions[symbol];
  if (!pos) return;

  const isLong = pos.direction === 'LONG';
  let exitPrice = null, exitReason = null;

  if (isLong) {
    if      (bar.open <= pos.sl) { exitPrice = bar.open; exitReason = 'STOP_LOSS'; }
    else if (bar.open >= pos.tp) { exitPrice = bar.open; exitReason = 'TAKE_PROFIT'; }
    else if (bar.low  <= pos.sl) { exitPrice = pos.sl;   exitReason = 'STOP_LOSS'; }
    else if (bar.high >= pos.tp) { exitPrice = pos.tp;   exitReason = 'TAKE_PROFIT'; }
  } else {
    if      (bar.open >= pos.sl) { exitPrice = bar.open; exitReason = 'STOP_LOSS'; }
    else if (bar.open <= pos.tp) { exitPrice = bar.open; exitReason = 'TAKE_PROFIT'; }
    else if (bar.high >= pos.sl) { exitPrice = pos.sl;   exitReason = 'STOP_LOSS'; }
    else if (bar.low  <= pos.tp) { exitPrice = pos.tp;   exitReason = 'TAKE_PROFIT'; }
  }

  if (exitPrice !== null) {
    const pnlPct = isLong
      ? (exitPrice - pos.entryPrice) / pos.entryPrice * 100
      : (pos.entryPrice - exitPrice) / pos.entryPrice * 100;
    const pnlUSD = pnlPct / 100 * pos.size;

    sim.balance += pos.size + pnlUSD;
    if (sim.balance > sim.peakBalance) sim.peakBalance = sim.balance;
    const dd = (sim.peakBalance - sim.balance) / sim.peakBalance * 100;
    if (dd > sim.maxDrawdown) sim.maxDrawdown = dd;

    sim.trades.push({ ...pos, exitPrice, exitReason, exitTime: time, pnlPct, pnlUSD });
    delete sim.openPositions[symbol];
  }
}

// Force-close all open positions at market price
function simCloseAll(sim, coinData, time) {
  for (const symbol of Object.keys(sim.openPositions)) {
    const pos = sim.openPositions[symbol];
    const d   = coinData[symbol];
    if (!d) continue;
    const last   = d.candles[d.candles.length - 1];
    const isLong = pos.direction === 'LONG';
    const exit   = last.close;
    const pnlPct = isLong
      ? (exit - pos.entryPrice) / pos.entryPrice * 100
      : (pos.entryPrice - exit) / pos.entryPrice * 100;
    const pnlUSD = pnlPct / 100 * pos.size;
    sim.balance += pos.size + pnlUSD;
    sim.trades.push({ ...pos, exitPrice: exit, exitReason: 'END_OF_DATA', exitTime: time, pnlPct, pnlUSD });
    delete sim.openPositions[symbol];
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n' + '═'.repeat(90));
  console.log('  COMPOUND BACKTEST  —  Fixed $50  vs  5% of Balance');
  console.log(`  50 coins · 1H candles · Shared $${START_BAL} balance · Chronological order`);
  console.log(`  SL: ${SL_PCT*100}%  TP: ${TP_PCT*100}%  Min confidence: ${MIN_CONF}%  Max concurrent: ${MAX_CONCURRENT}`);
  console.log('═'.repeat(90) + '\n');

  // ── Step 1: Fetch all candles ─────────────────────────────────────────────
  const coinData = {};
  for (const symbol of COINS) {
    process.stdout.write(`  Fetching ${symbol}...`);
    try {
      const candles = await fetchCandles(symbol, 1000);
      const closes  = candles.map(c => c.close);
      const opens   = candles.map(c => c.open);
      coinData[symbol] = {
        candles,
        ema20s:  calcEMASeries(closes, 20),
        rsi14s:  calcRSISeries(closes, 14),
        vwaps:   calcVWAPSeries(candles),
        sts:     calcSuperTrendSeries(candles, 10, 3),
        macd:    calcMACDSeries(closes, 12, 26, 9),
        bb1s:    calcBBSeries(opens, 4, 4),
        bb2s:    calcBBSeries(closes, 20, 2),
      };
      process.stdout.write(` ${candles.length} bars ✓\n`);
    } catch(e) {
      console.log(` ❌ ${e.message}`);
    }
  }

  // ── Step 2: Build sorted timeline ────────────────────────────────────────
  // All unique timestamps across all coins
  const timeSet = new Set();
  for (const d of Object.values(coinData)) {
    d.candles.forEach(c => timeSet.add(c.time));
  }
  const timeline = [...timeSet].sort((a, b) => a - b);

  // Build bar index maps: symbol → (time → index)
  for (const [sym, d] of Object.entries(coinData)) {
    d.timeIndex = {};
    d.candles.forEach((c, i) => { d.timeIndex[c.time] = i; });
  }

  // ── Step 3: Run both simulations ─────────────────────────────────────────
  const simFixed    = createSim('Fixed $50');
  const simCompound = createSim('5% Balance');

  let snapMonth = null;

  for (const t of timeline) {
    const dateStr = new Date(t).toISOString().slice(0, 7); // YYYY-MM

    // Monthly equity snapshot
    if (dateStr !== snapMonth) {
      snapMonth = dateStr;
      simFixed.equitySnaps.push({ date: dateStr, balance: simFixed.balance });
      simCompound.equitySnaps.push({ date: dateStr, balance: simCompound.balance });
    }

    for (const [symbol, d] of Object.entries(coinData)) {
      const i = d.timeIndex[t];
      if (i == null || i < 31) continue;

      const bar = d.candles[i];

      // 1. Update open positions (check SL/TP)
      simUpdate(simFixed,    symbol, bar, t);
      simUpdate(simCompound, symbol, bar, t);

      // 2. Check for new signal (use bar i-1 as "completed" candle)
      const sig = getSignal(
        i - 1,
        d.candles, d.ema20s, d.rsi14s, d.vwaps, d.sts,
        d.macd.macdLine, d.macd.sigLine, d.bb1s, d.bb2s
      );

      if (sig && i + 1 < d.candles.length) {
        const entryBar   = d.candles[i]; // enter at open of next (current) bar
        const entryPrice = entryBar.open;

        // Sim A: fixed $50
        simEnter(simFixed, symbol, sig.direction, entryPrice, sig.source, FIXED_SIZE, t);

        // Sim B: 5% of current balance
        const compSize = simCompound.balance * COMPOUND_PCT;
        simEnter(simCompound, symbol, sig.direction, entryPrice, sig.source, compSize, t);
      }
    }
  }

  // Force-close remaining open positions
  const lastTime = timeline[timeline.length - 1];
  simCloseAll(simFixed,    coinData, lastTime);
  simCloseAll(simCompound, coinData, lastTime);

  // ── Step 4: Stats ─────────────────────────────────────────────────────────

  function stats(sim) {
    const trades  = sim.trades;
    const wins    = trades.filter(t => t.pnlUSD > 0);
    const losses  = trades.filter(t => t.pnlUSD <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnlUSD, 0);
    const grossWin = wins.reduce((s, t) => s + t.pnlUSD, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUSD, 0));
    const wr = trades.length ? (wins.length / trades.length * 100).toFixed(1) : '0';
    const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? '∞' : '0');
    const ret = ((sim.balance - START_BAL) / START_BAL * 100).toFixed(2);

    // Signal breakdown
    const sigMap = {};
    for (const t of trades) {
      if (!sigMap[t.signal]) sigMap[t.signal] = { count: 0, wins: 0, pnl: 0 };
      sigMap[t.signal].count++;
      if (t.pnlUSD > 0) sigMap[t.signal].wins++;
      sigMap[t.signal].pnl += t.pnlUSD;
    }

    return { trades: trades.length, wins: wins.length, losses: losses.length, wr, pf,
             totalPnl, grossWin, grossLoss, ret, sigMap };
  }

  const sA = stats(simFixed);
  const sB = stats(simCompound);

  // ── Step 5: Print results ─────────────────────────────────────────────────

  console.log('\n\n' + '═'.repeat(90));
  console.log('  RESULTS');
  console.log('═'.repeat(90));

  console.log('\n┌─────────────────────────────┬─────────────────────────┬─────────────────────────┐');
  console.log(`│ Metric                      │ Fixed $${FIXED_SIZE}/trade          │ 5% of Balance           │`);
  console.log('├─────────────────────────────┼─────────────────────────┼─────────────────────────┤');

  const row = (label, a, b, highlight) => {
    const marker = highlight ? ' ◀' : '';
    console.log(`│ ${label.padEnd(28)}│ ${String(a).padEnd(24)}│ ${String(b).padEnd(23)}${marker}│`);
  };

  row('Starting balance',     `$${START_BAL.toFixed(2)}`,            `$${START_BAL.toFixed(2)}`);
  row('Final balance',        `$${simFixed.balance.toFixed(2)}`,     `$${simCompound.balance.toFixed(2)}`,     true);
  row('Total return',         `${sA.ret >= 0 ? '+' : ''}${sA.ret}%`, `${sB.ret >= 0 ? '+' : ''}${sB.ret}%`,  true);
  row('Total P&L',            `${sA.totalPnl >= 0 ? '+' : ''}$${sA.totalPnl.toFixed(2)}`, `${sB.totalPnl >= 0 ? '+' : ''}$${sB.totalPnl.toFixed(2)}`, true);
  row('Total trades',         sA.trades,                              sB.trades);
  row('Wins / Losses',        `${sA.wins} / ${sA.losses}`,           `${sB.wins} / ${sB.losses}`);
  row('Win rate',             `${sA.wr}%`,                           `${sB.wr}%`);
  row('Profit factor',        sA.pf,                                  sB.pf);
  row('Max drawdown',         `${simFixed.maxDrawdown.toFixed(2)}%`,  `${simCompound.maxDrawdown.toFixed(2)}%`);
  row('Peak balance',         `$${simFixed.peakBalance.toFixed(2)}`,  `$${simCompound.peakBalance.toFixed(2)}`);
  row('Avg trade size (est)', `$${FIXED_SIZE}`,                       `$${(START_BAL * COMPOUND_PCT).toFixed(0)} → grows`);

  console.log('└─────────────────────────────┴─────────────────────────┴─────────────────────────┘');

  // Difference
  const diff    = simCompound.balance - simFixed.balance;
  const diffPct = (diff / simFixed.balance * 100).toFixed(2);
  console.log(`\n  💡 Compounding ${diff >= 0 ? 'adds' : 'costs'} ${diff >= 0 ? '+' : ''}$${diff.toFixed(2)} (${diffPct}%) vs fixed sizing`);

  // ── Equity Curve ────────────────────────────────────────────────────────
  console.log('\n\n══ EQUITY CURVE (month-by-month) ═════════════════════════════════════════════════\n');
  console.log('  Month       Fixed $50     5% Balance    Diff');
  console.log('  ─────────────────────────────────────────────');

  const snapsA = simFixed.equitySnaps;
  const snapsB = simCompound.equitySnaps;
  const len    = Math.min(snapsA.length, snapsB.length);

  for (let i = 0; i < len; i++) {
    const a    = snapsA[i].balance;
    const b    = snapsB[i].balance;
    const d    = b - a;
    const aStr = `$${a.toFixed(2)}`.padEnd(14);
    const bStr = `$${b.toFixed(2)}`.padEnd(14);
    const dStr = `${d >= 0 ? '+' : ''}$${d.toFixed(2)}`;
    const bar  = simCompound.equitySnaps[i];
    const arrow = i === 0 ? '' : (b > snapsB[i-1]?.balance ? ' 📈' : ' 📉');
    console.log(`  ${snapsA[i].date}  ${aStr}${bStr}${dStr}${arrow}`);
  }

  // Show final balance
  const finalA = `$${simFixed.balance.toFixed(2)}`.padEnd(14);
  const finalB = `$${simCompound.balance.toFixed(2)}`.padEnd(14);
  const finalD = simCompound.balance - simFixed.balance;
  console.log(`  ─────────────────────────────────────────────`);
  console.log(`  FINAL       ${finalA}${finalB}${finalD >= 0 ? '+' : ''}$${finalD.toFixed(2)}`);

  // ── Signal Breakdown ────────────────────────────────────────────────────
  console.log('\n\n══ SIGNAL BREAKDOWN ══════════════════════════════════════════════════════════════\n');
  console.log('  Signal'.padEnd(32) + 'Trades'.padEnd(8) + 'Win%'.padEnd(8) + 'Fixed P&L'.padEnd(14) + 'Compound P&L');
  console.log('  ' + '─'.repeat(72));

  const allSigs = new Set([...Object.keys(sA.sigMap), ...Object.keys(sB.sigMap)]);
  for (const sig of allSigs) {
    const a = sA.sigMap[sig] || { count: 0, wins: 0, pnl: 0 };
    const b = sB.sigMap[sig] || { count: 0, wins: 0, pnl: 0 };
    const wr = a.count ? (a.wins / a.count * 100).toFixed(1) : '0';
    const aP = `${a.pnl >= 0 ? '+' : ''}$${a.pnl.toFixed(2)}`;
    const bP = `${b.pnl >= 0 ? '+' : ''}$${b.pnl.toFixed(2)}`;
    const verdict = a.pnl > 0 ? ' ✅' : ' ❌';
    console.log(`  ${sig.padEnd(30)}${String(a.count).padEnd(8)}${`${wr}%`.padEnd(8)}${aP.padEnd(14)}${bP}${verdict}`);
  }

  // ── Verdict ─────────────────────────────────────────────────────────────
  console.log('\n\n══ VERDICT ═══════════════════════════════════════════════════════════════════════\n');
  console.log(`  Starting balance : $${START_BAL}`);
  console.log(`  Fixed $50/trade  : $${simFixed.balance.toFixed(2)}  (${sA.ret >= 0 ? '+' : ''}${sA.ret}% return)`);
  console.log(`  5% compounding   : $${simCompound.balance.toFixed(2)}  (${sB.ret >= 0 ? '+' : ''}${sB.ret}% return)`);
  console.log(`\n  ${diff >= 0 ? '✅ Compounding wins' : '❌ Fixed sizing wins'} — ${Math.abs(diff) >= 0 ? '' : ''}$${Math.abs(diff).toFixed(2)} ${diff >= 0 ? 'more' : 'less'} with 5% sizing`);

  if (diff > 0) {
    console.log(`\n  Why compounding helps:`);
    console.log(`    • After each win your next trade size grows → bigger profits`);
    console.log(`    • After each loss your next trade shrinks → smaller losses`);
    console.log(`    • Net effect: wins compound, losses are capped`);
  } else {
    console.log(`\n  Why fixed sizing won this test:`);
    console.log(`    • The drawdowns shrank trade sizes too aggressively`);
    console.log(`    • Recovery is slower when size shrinks after losses`);
    console.log(`    • Consider higher TP or more selective signals first`);
  }

  console.log('\n' + '═'.repeat(90) + '\n');

})().catch(console.error);
