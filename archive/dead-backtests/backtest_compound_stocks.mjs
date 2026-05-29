/**
 * Compound Backtest — Stocks  |  Fixed $50 vs 5% of Balance
 *
 * Only includes stocks that were PROFITABLE in the prior 5%/15% backtest.
 * Removed: 55 underperforming stocks (MSFT, AMZN, META, JPM, XOM, MA, ORCL, etc.)
 *
 * Long-only — shorts proved negative on stocks (-$9.39 in prior backtest)
 * Signals: ST Bullish Flip (LONG) · BB Recovery Bounce (LONG)
 * SL: 5%  TP: 15%  Min confidence: 65%
 * Data: Yahoo Finance free API · 60 days · 1H candles
 */

import https from 'https';

// ─── Only profitable stocks from prior backtest (44 / 99) ─────────────────────

const STOCKS = [
  // Top tier ($10+ P&L in prior backtest)
  'MU',   'AMD',  'CSCO', 'QCOM', 'PANW', 'LRCX', 'HUM',
  'ARM',  'SNOW', 'ZTS',  'GS',   'LLY',  'MS',   'NOC',

  // Mid tier ($3–$10)
  'DHR',  'ELV',  'BAC',  'AVGO', 'TSLA', 'INTU', 'TMUS',
  'GOOGL','AMGN', 'TXN',  'GE',   'PLD',  'PH',   'MDLZ',
  'BLK',  'ELV',  'AAPL', 'PG',

  // Lower tier (>$0 but <$3)
  'V',    'COST', 'AXP',  'HON',  'LIN',  'UPS',
  'ETN',  'TJX',  'WFC',  'CL',   'UNH',  'CRWD',
];

// Deduplicate (ELV appeared twice above)
const UNIQUE_STOCKS = [...new Set(STOCKS)];

const START_BAL     = 1000;
const FIXED_SIZE    = 50;
const COMPOUND_PCT  = 0.05;
const SL_PCT        = 0.05;
const TP_PCT        = 0.15;
const MIN_CONF      = 65;
const MAX_CONCURRENT = 10;
const DELAY_MS      = 150;   // rate limit between Yahoo Finance requests

// ─── Yahoo Finance fetch ──────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchStockCandles(symbol) {
  return new Promise((resolve, reject) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1h&range=60d&includePrePost=false`;
    const opts = {
      hostname: 'query1.finance.yahoo.com',
      path:     `/v8/finance/chart/${symbol}?interval=1h&range=60d&includePrePost=false`,
      headers:  { 'User-Agent': 'Mozilla/5.0' },
    };
    https.get(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json   = JSON.parse(d);
          const result = json?.chart?.result?.[0];
          if (!result) return reject(new Error(`No data for ${symbol}`));
          const ts  = result.timestamp || [];
          const q   = result.indicators.quote[0];
          const bars = ts.map((t, i) => ({
            time:   t * 1000,
            open:   q.open[i]   ?? null,
            high:   q.high[i]   ?? null,
            low:    q.low[i]    ?? null,
            close:  q.close[i]  ?? null,
            volume: q.volume[i] ?? 0,
          })).filter(c => c.open && c.high && c.low && c.close);
          resolve(bars);
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ─── DST-aware ET offset ─────────────────────────────────────────────────────

function nthSunday(year, month, n) {
  const d = new Date(Date.UTC(year, month, 1));
  d.setUTCDate(1 + ((7 - d.getUTCDay()) % 7) + (n - 1) * 7);
  return d;
}

function etOffsetForTime(ms) {
  const d   = new Date(ms);
  const yr  = d.getUTCFullYear();
  return d >= nthSunday(yr, 2, 2) && d < nthSunday(yr, 10, 1) ? -4 : -5;
}

// Market open time for a given bar (9:30 AM ET in ms)
function marketOpenMs(barMs) {
  const et     = etOffsetForTime(barMs);
  const d      = new Date(barMs);
  const etDate = new Date(d.getTime() + et * 3600000);
  return Date.UTC(
    etDate.getUTCFullYear(), etDate.getUTCMonth(), etDate.getUTCDate(),
    9 - et, 30, 0, 0
  );
}

// ─── VWAP — resets at 9:30 AM ET each day ────────────────────────────────────

function calcVWAPSeries(candles) {
  const r = new Array(candles.length).fill(null);
  let cumTPV = 0, cumVol = 0, currentOpenMs = null;
  for (let i = 0; i < candles.length; i++) {
    const openMs = marketOpenMs(candles[i].time);
    if (openMs !== currentOpenMs) { cumTPV = 0; cumVol = 0; currentOpenMs = openMs; }
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    cumTPV += tp * candles[i].volume;
    cumVol += candles[i].volume;
    r[i] = cumVol === 0 ? null : cumTPV / cumVol;
  }
  return r;
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

// ─── Confidence ───────────────────────────────────────────────────────────────

function calcConfidence(price, ema, vwap, rsi, st, macd, sig, bbSigs, stSigs) {
  const r = rsi ?? 50;
  let L = 0;
  if (st)   { if (st.direction === 1) L += 20; }
  if (ema)  { if (price > ema)        L += 10; }
  if (vwap) { if (price > vwap)       L += 5;  }
  if (macd != null && sig != null) {
    if (macd > 0)   L += 12;
    if (macd > sig) L += 13;
  }
  if      (r < 30) L += 25; else if (r < 40) L += 15; else if (r < 50) L += 5;
  if (stSigs.includes('LONG')) L += 15;
  if (bbSigs.includes('LONG')) L += 10;
  return Math.min(L, 100);
}

// ─── Signal detection (LONG only for stocks) ─────────────────────────────────

function getSignal(i, candles, ema20s, rsi14s, vwaps, sts, macdLine, sigLine, bb1s) {
  const st = sts[i], stP = sts[i-1];
  if (!st || !stP || rsi14s[i] == null || ema20s[i] == null) return null;

  const c   = candles[i].close, cP = candles[i-1].close;
  const bb1 = bb1s[i], bb1P = bb1s[i-1];

  const bbSigs = [], stSigs = [];

  // ST Bullish Flip → LONG
  if (stP.direction === -1 && st.direction === 1) stSigs.push('LONG');
  // BB Recovery → LONG
  if (bb1 && bb1P && cP < bb1P.lower && c > bb1.lower) bbSigs.push('LONG');

  let direction = null;
  if      (stSigs.includes('LONG')) direction = 'LONG';
  else if (bbSigs.includes('LONG')) direction = 'LONG';
  if (!direction) return null;

  const conf = calcConfidence(
    c, ema20s[i], vwaps[i], rsi14s[i], st,
    macdLine[i], sigLine[i], bbSigs, stSigs
  );
  if (conf < MIN_CONF) return null;

  const source = stSigs.includes('LONG') ? 'ST Bullish Flip' : 'BB Recovery';
  return { direction, score: conf, source };
}

// ─── Simulation ───────────────────────────────────────────────────────────────

function createSim(name) {
  return { name, balance: START_BAL, peakBalance: START_BAL, maxDrawdown: 0,
           openPositions: {}, trades: [], equitySnaps: [] };
}

function simEnter(sim, symbol, entryPrice, signal, tradeSize, time) {
  if (sim.openPositions[symbol]) return;
  if (Object.keys(sim.openPositions).length >= MAX_CONCURRENT) return;
  if (sim.balance < tradeSize || tradeSize <= 0) return;

  const sl = entryPrice * (1 - SL_PCT);
  const tp = entryPrice * (1 + TP_PCT);
  sim.balance -= tradeSize;
  sim.openPositions[symbol] = { symbol, direction: 'LONG', entryPrice, size: tradeSize, sl, tp, signal, time };
}

function simUpdate(sim, symbol, bar) {
  const pos = sim.openPositions[symbol];
  if (!pos) return;

  let exitPrice = null, exitReason = null;
  if      (bar.open <= pos.sl) { exitPrice = bar.open; exitReason = 'STOP_LOSS'; }
  else if (bar.open >= pos.tp) { exitPrice = bar.open; exitReason = 'TAKE_PROFIT'; }
  else if (bar.low  <= pos.sl) { exitPrice = pos.sl;   exitReason = 'STOP_LOSS'; }
  else if (bar.high >= pos.tp) { exitPrice = pos.tp;   exitReason = 'TAKE_PROFIT'; }

  if (exitPrice !== null) {
    const pnlPct = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
    const pnlUSD = pnlPct / 100 * pos.size;
    sim.balance += pos.size + pnlUSD;
    if (sim.balance > sim.peakBalance) sim.peakBalance = sim.balance;
    const dd = (sim.peakBalance - sim.balance) / sim.peakBalance * 100;
    if (dd > sim.maxDrawdown) sim.maxDrawdown = dd;
    sim.trades.push({ ...pos, exitPrice, exitReason, pnlPct, pnlUSD });
    delete sim.openPositions[symbol];
  }
}

function simCloseAll(sim, stockData) {
  for (const symbol of Object.keys(sim.openPositions)) {
    const pos  = sim.openPositions[symbol];
    const d    = stockData[symbol];
    if (!d) continue;
    const last   = d.candles[d.candles.length - 1];
    const pnlPct = (last.close - pos.entryPrice) / pos.entryPrice * 100;
    const pnlUSD = pnlPct / 100 * pos.size;
    sim.balance += pos.size + pnlUSD;
    sim.trades.push({ ...pos, exitPrice: last.close, exitReason: 'END_OF_DATA', pnlPct, pnlUSD });
    delete sim.openPositions[symbol];
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n' + '═'.repeat(90));
  console.log('  COMPOUND BACKTEST — STOCKS  |  Fixed $50 vs 5% of Balance');
  console.log(`  ${UNIQUE_STOCKS.length} profitable stocks · 60d · 1H · Long-only · SL ${SL_PCT*100}% / TP ${TP_PCT*100}%`);
  console.log('═'.repeat(90) + '\n');

  // ── Fetch data ────────────────────────────────────────────────────────────
  const stockData = {};
  for (const symbol of UNIQUE_STOCKS) {
    process.stdout.write(`  Fetching ${symbol.padEnd(6)}...`);
    try {
      const candles = await fetchStockCandles(symbol);
      if (candles.length < 30) { console.log(` only ${candles.length} bars — skip`); continue; }
      const closes = candles.map(c => c.close);
      const opens  = candles.map(c => c.open);
      stockData[symbol] = {
        candles,
        ema20s:  calcEMASeries(closes, 20),
        rsi14s:  calcRSISeries(closes, 14),
        vwaps:   calcVWAPSeries(candles),
        sts:     calcSuperTrendSeries(candles, 10, 3),
        macd:    calcMACDSeries(closes, 12, 26, 9),
        bb1s:    calcBBSeries(opens, 4, 4),
      };
      process.stdout.write(` ${candles.length} bars ✓\n`);
    } catch(e) {
      console.log(` ❌ ${e.message}`);
    }
    await delay(DELAY_MS);
  }

  const loaded = Object.keys(stockData);
  console.log(`\n  Loaded: ${loaded.length} / ${UNIQUE_STOCKS.length} stocks\n`);

  // ── Build chronological timeline ──────────────────────────────────────────
  const timeSet = new Set();
  for (const d of Object.values(stockData)) d.candles.forEach(c => timeSet.add(c.time));
  const timeline = [...timeSet].sort((a, b) => a - b);

  for (const [sym, d] of Object.entries(stockData)) {
    d.timeIndex = {};
    d.candles.forEach((c, i) => { d.timeIndex[c.time] = i; });
  }

  // ── Run simulations ───────────────────────────────────────────────────────
  const simFixed    = createSim('Fixed $50');
  const simCompound = createSim('5% Balance');
  let snapMonth = null;

  for (const t of timeline) {
    const dateStr = new Date(t).toISOString().slice(0, 7);
    if (dateStr !== snapMonth) {
      snapMonth = dateStr;
      simFixed.equitySnaps.push({ date: dateStr, balance: simFixed.balance });
      simCompound.equitySnaps.push({ date: dateStr, balance: simCompound.balance });
    }

    for (const [symbol, d] of Object.entries(stockData)) {
      const i = d.timeIndex[t];
      if (i == null || i < 31) continue;
      const bar = d.candles[i];

      simUpdate(simFixed,    symbol, bar);
      simUpdate(simCompound, symbol, bar);

      const sig = getSignal(
        i - 1, d.candles, d.ema20s, d.rsi14s, d.vwaps, d.sts,
        d.macd.macdLine, d.macd.sigLine, d.bb1s
      );

      if (sig && i + 1 < d.candles.length) {
        const entryPrice = d.candles[i].open;
        simEnter(simFixed,    symbol, entryPrice, sig.source, FIXED_SIZE, t);
        simEnter(simCompound, symbol, entryPrice, sig.source, simCompound.balance * COMPOUND_PCT, t);
      }
    }
  }

  simCloseAll(simFixed,    stockData);
  simCloseAll(simCompound, stockData);

  // ── Stats ─────────────────────────────────────────────────────────────────

  function stats(sim) {
    const trades   = sim.trades;
    const wins     = trades.filter(t => t.pnlUSD > 0);
    const losses   = trades.filter(t => t.pnlUSD <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnlUSD, 0);
    const grossWin = wins.reduce((s, t) => s + t.pnlUSD, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUSD, 0));
    const wr  = trades.length ? (wins.length / trades.length * 100).toFixed(1) : '0';
    const pf  = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? '∞' : '0');
    const ret = ((sim.balance - START_BAL) / START_BAL * 100).toFixed(2);
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

  // ── Print ─────────────────────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(90));
  console.log('  RESULTS');
  console.log('═'.repeat(90));

  console.log('\n┌─────────────────────────────┬─────────────────────────┬─────────────────────────┐');
  console.log(`│ Metric                      │ Fixed $${FIXED_SIZE}/trade          │ 5% of Balance           │`);
  console.log('├─────────────────────────────┼─────────────────────────┼─────────────────────────┤');

  const row = (label, a, b, win) => {
    const mark = win ? ' ◀' : '  ';
    console.log(`│ ${label.padEnd(28)}│ ${String(a).padEnd(24)}│ ${String(b).padEnd(23)}${mark}│`);
  };

  const winner = simCompound.balance >= simFixed.balance;
  row('Starting balance',     `$${START_BAL.toFixed(2)}`,               `$${START_BAL.toFixed(2)}`);
  row('Final balance',        `$${simFixed.balance.toFixed(2)}`,        `$${simCompound.balance.toFixed(2)}`,        winner);
  row('Total return',         `${sA.ret >= 0 ? '+' : ''}${sA.ret}%`,   `${sB.ret >= 0 ? '+' : ''}${sB.ret}%`,      winner);
  row('Total P&L',            `${sA.totalPnl >= 0 ? '+' : ''}$${sA.totalPnl.toFixed(2)}`, `${sB.totalPnl >= 0 ? '+' : ''}$${sB.totalPnl.toFixed(2)}`, winner);
  row('Total trades',         sA.trades,                                 sB.trades);
  row('Wins / Losses',        `${sA.wins} / ${sA.losses}`,              `${sB.wins} / ${sB.losses}`);
  row('Win rate',             `${sA.wr}%`,                              `${sB.wr}%`);
  row('Profit factor',        sA.pf,                                     sB.pf);
  row('Max drawdown',         `${simFixed.maxDrawdown.toFixed(2)}%`,    `${simCompound.maxDrawdown.toFixed(2)}%`,    !winner);
  row('Peak balance',         `$${simFixed.peakBalance.toFixed(2)}`,    `$${simCompound.peakBalance.toFixed(2)}`);

  console.log('└─────────────────────────────┴─────────────────────────┴─────────────────────────┘');

  const diff    = simCompound.balance - simFixed.balance;
  const diffPct = (diff / Math.abs(simFixed.balance) * 100).toFixed(2);
  console.log(`\n  💡 Compounding ${diff >= 0 ? 'adds' : 'costs'} ${diff >= 0 ? '+' : ''}$${diff.toFixed(2)} (${diffPct >= 0 ? '+' : ''}${diffPct}%) vs fixed sizing`);

  // ── Equity curve ─────────────────────────────────────────────────────────
  console.log('\n\n══ EQUITY CURVE (month-by-month) ═════════════════════════════════════════════════\n');
  console.log('  Month       Fixed $50     5% Balance    Diff');
  console.log('  ─────────────────────────────────────────────');

  const snA = simFixed.equitySnaps, snB = simCompound.equitySnaps;
  for (let i = 0; i < Math.min(snA.length, snB.length); i++) {
    const a = snA[i].balance, b = snB[i].balance;
    const d = b - a;
    const arrow = i === 0 ? '' : (b > (snB[i-1]?.balance ?? 0) ? ' 📈' : ' 📉');
    console.log(`  ${snA[i].date}  $${a.toFixed(2).padEnd(12)}$${b.toFixed(2).padEnd(12)}${d >= 0 ? '+' : ''}$${d.toFixed(2)}${arrow}`);
  }
  const fdiff = simCompound.balance - simFixed.balance;
  console.log(`  ─────────────────────────────────────────────`);
  console.log(`  FINAL       $${simFixed.balance.toFixed(2).padEnd(12)}$${simCompound.balance.toFixed(2).padEnd(12)}${fdiff >= 0 ? '+' : ''}$${fdiff.toFixed(2)}`);

  // ── Signal breakdown ──────────────────────────────────────────────────────
  console.log('\n\n══ SIGNAL BREAKDOWN ══════════════════════════════════════════════════════════════\n');
  console.log('  Signal'.padEnd(32) + 'Trades'.padEnd(8) + 'Win%'.padEnd(8) + 'Fixed P&L'.padEnd(14) + 'Compound P&L');
  console.log('  ' + '─'.repeat(72));
  const allSigs = new Set([...Object.keys(sA.sigMap), ...Object.keys(sB.sigMap)]);
  for (const sig of allSigs) {
    const a = sA.sigMap[sig] || { count: 0, wins: 0, pnl: 0 };
    const b = sB.sigMap[sig] || { count: 0, wins: 0, pnl: 0 };
    const wr = a.count ? (a.wins / a.count * 100).toFixed(1) : '0';
    const verdict = a.pnl > 0 ? ' ✅' : ' ❌';
    console.log(`  ${sig.padEnd(30)}${String(a.count).padEnd(8)}${`${wr}%`.padEnd(8)}${`${a.pnl >= 0 ? '+' : ''}$${a.pnl.toFixed(2)}`.padEnd(14)}${b.pnl >= 0 ? '+' : ''}$${b.pnl.toFixed(2)}${verdict}`);
  }

  // ── Top 5 stocks ──────────────────────────────────────────────────────────
  const byStock = {};
  for (const t of simFixed.trades) {
    if (!byStock[t.symbol]) byStock[t.symbol] = { trades: 0, wins: 0, pnl: 0 };
    byStock[t.symbol].trades++;
    if (t.pnlUSD > 0) byStock[t.symbol].wins++;
    byStock[t.symbol].pnl += t.pnlUSD;
  }
  const sorted = Object.entries(byStock).sort((a, b) => b[1].pnl - a[1].pnl);
  console.log('\n\n══ TOP 5 STOCKS ══════════════════════════════════════════════════════════════════\n');
  sorted.slice(0, 5).forEach(([sym, d], i) => {
    const wr = d.trades ? (d.wins / d.trades * 100).toFixed(0) : '0';
    console.log(`  #${i+1} ${sym.padEnd(6)} ${d.trades} trades | Win ${wr}% | P&L ${d.pnl >= 0 ? '+' : ''}$${d.pnl.toFixed(2)}`);
  });
  console.log('\n══ BOTTOM 5 STOCKS ═══════════════════════════════════════════════════════════════\n');
  sorted.slice(-5).reverse().forEach(([sym, d], i) => {
    const wr = d.trades ? (d.wins / d.trades * 100).toFixed(0) : '0';
    console.log(`  #${i+1} ${sym.padEnd(6)} ${d.trades} trades | Win ${wr}% | P&L ${d.pnl >= 0 ? '+' : ''}$${d.pnl.toFixed(2)}`);
  });

  // ── Verdict ───────────────────────────────────────────────────────────────
  console.log('\n\n══ VERDICT ═══════════════════════════════════════════════════════════════════════\n');
  console.log(`  Starting balance : $${START_BAL}`);
  console.log(`  Fixed $50/trade  : $${simFixed.balance.toFixed(2)}  (${sA.ret >= 0 ? '+' : ''}${sA.ret}%)`);
  console.log(`  5% compounding   : $${simCompound.balance.toFixed(2)}  (${sB.ret >= 0 ? '+' : ''}${sB.ret}%)`);
  if (diff >= 0) {
    console.log(`\n  ✅ Compounding wins by $${diff.toFixed(2)} — ${diffPct}% more profit`);
    console.log(`     As wins grow your bet sizes grow with them — gains compound faster than losses`);
  } else {
    console.log(`\n  ❌ Fixed sizing wins by $${Math.abs(diff).toFixed(2)}`);
    console.log(`     Drawdowns are shrinking trade sizes too much — strategy needs higher win rate for compounding to help`);
  }
  console.log('\n' + '═'.repeat(90) + '\n');

})().catch(console.error);
