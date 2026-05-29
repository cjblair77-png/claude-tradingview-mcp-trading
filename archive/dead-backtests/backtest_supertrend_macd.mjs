/**
 * SuperTrend + MACD Backtest
 * SuperTrend: ATR 10, Multiplier 3
 * MACD: 12, 26, 9
 * 500 x 1H BTCUSDT candles
 */

import https from 'https';

function fetchCandles(symbol = 'BTCUSDT', interval = '1h', limit = 500) {
  return new Promise((resolve, reject) => {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data).map(k => ({
            time:  new Date(k[0]),
            open:  parseFloat(k[1]),
            high:  parseFloat(k[2]),
            low:   parseFloat(k[3]),
            close: parseFloat(k[4]),
            vol:   parseFloat(k[5]),
          })));
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ── Indicators ────────────────────────────────────────────────────────────────

function calcATR(candles, period) {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i-1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
  // Wilder smoothing
  const atr = new Array(candles.length).fill(null);
  let sum = trs.slice(0, period).reduce((a, b) => a + b, 0);
  atr[period - 1] = sum / period;
  for (let i = period; i < candles.length; i++) {
    atr[i] = (atr[i-1] * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function calcSuperTrend(candles, atrPeriod = 10, multiplier = 3) {
  const atr = calcATR(candles, atrPeriod);
  const result = new Array(candles.length).fill(null);
  let prevUpper = null, prevLower = null, prevDir = null;

  for (let i = atrPeriod; i < candles.length; i++) {
    const hl2 = (candles[i].high + candles[i].low) / 2;
    let upper = hl2 + multiplier * atr[i];
    let lower = hl2 - multiplier * atr[i];

    if (prevLower !== null) lower = candles[i].close > prevLower ? Math.max(lower, prevLower) : lower;
    if (prevUpper !== null) upper = candles[i].close < prevUpper ? Math.min(upper, prevUpper) : upper;

    let direction;
    if (prevDir === null) {
      direction = candles[i].close > upper ? 1 : -1;
    } else if (prevDir === -1) {
      direction = candles[i].close > prevUpper ? 1 : -1;
    } else {
      direction = candles[i].close < prevLower ? -1 : 1;
    }

    result[i] = { upper, lower, direction, line: direction === 1 ? lower : upper };
    prevUpper = upper; prevLower = lower; prevDir = direction;
  }
  return result;
}

function calcEMASeries(values, period) {
  const k = 2 / (period + 1);
  const result = new Array(values.length).fill(null);
  let ema = values[0];
  result[0] = ema;
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const fastEMA = calcEMASeries(closes, fast);
  const slowEMA = calcEMASeries(closes, slow);
  const macdLine = closes.map((_, i) =>
    fastEMA[i] !== null && slowEMA[i] !== null ? fastEMA[i] - slowEMA[i] : null
  );
  // Signal line (EMA of MACD)
  const validStart = macdLine.findIndex(v => v !== null);
  const signalLine = new Array(closes.length).fill(null);
  if (validStart >= 0) {
    const k = 2 / (signal + 1);
    let sig = macdLine[validStart];
    signalLine[validStart] = sig;
    for (let i = validStart + 1; i < closes.length; i++) {
      if (macdLine[i] === null) continue;
      sig = macdLine[i] * k + sig * (1 - k);
      signalLine[i] = sig;
    }
  }
  const histogram = closes.map((_, i) =>
    macdLine[i] !== null && signalLine[i] !== null ? macdLine[i] - signalLine[i] : null
  );
  return { macdLine, signalLine, histogram };
}

function calcRSI(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let gains = 0, losses = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = closes[j] - closes[j-1];
      if (diff > 0) gains += diff; else losses -= diff;
    }
    const rs = losses === 0 ? 100 : (gains / period) / (losses / period);
    result[i] = 100 - 100 / (1 + rs);
  }
  return result;
}

// ── Backtest engine ───────────────────────────────────────────────────────────

function backtest(candles, signalFn, label, holdBars = 4) {
  const trades = [];
  let inTrade = null;

  for (let i = 30; i < candles.length - holdBars; i++) {
    if (inTrade) {
      if (i >= inTrade.entryBar + holdBars) {
        const exitPrice = candles[i].close;
        const pnl = inTrade.dir === 'LONG'
          ? (exitPrice - inTrade.entryPrice) / inTrade.entryPrice * 100
          : (inTrade.entryPrice - exitPrice) / inTrade.entryPrice * 100;
        trades.push({ ...inTrade, exitPrice, pnl });
        inTrade = null;
      }
      continue;
    }
    const sig = signalFn(candles, i);
    if (sig) inTrade = { dir: sig, entryPrice: candles[i+1]?.open || candles[i].close, entryBar: i+1 };
  }

  if (!trades.length) return { label, trades: 0, winRate: 0, avgPnl: 0, totalPnl: 0, profitFactor: 0 };
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  return {
    label, trades: trades.length,
    winRate:      (wins.length / trades.length * 100).toFixed(1),
    avgPnl:       (total / trades.length).toFixed(3),
    totalPnl:     total.toFixed(2),
    profitFactor: gl > 0 ? (gp / gl).toFixed(2) : '∞',
    bestTrade:    Math.max(...trades.map(t => t.pnl)).toFixed(2),
    worstTrade:   Math.min(...trades.map(t => t.pnl)).toFixed(2),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  SuperTrend + MACD Backtest — BTCUSDT 1H (500 candles)');
  console.log('  SuperTrend: ATR 10, Multiplier 3');
  console.log('  MACD: 12, 26, 9');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('Fetching 500 x 1H candles from Binance...');
  const candles = await fetchCandles('BTCUSDT', '1h', 500);
  console.log(`  ${candles[0].time.toISOString().slice(0,16)} → ${candles[candles.length-1].time.toISOString().slice(0,16)}\n`);

  const closes = candles.map(c => c.close);
  const st     = calcSuperTrend(candles, 10, 3);
  const macd   = calcMACD(closes, 12, 26, 9);
  const rsi    = calcRSI(closes, 14);
  const rsi3   = calcRSI(closes, 3);

  const { macdLine, signalLine, histogram } = macd;

  const strategies = [

    // 1. SuperTrend direction flip → LONG
    {
      label: 'S1: SuperTrend flips bullish → LONG',
      fn: (c, i) => {
        if (!st[i] || !st[i-1]) return null;
        return st[i-1].direction === -1 && st[i].direction === 1 ? 'LONG' : null;
      }
    },

    // 2. SuperTrend direction flip → SHORT
    {
      label: 'S2: SuperTrend flips bearish → SHORT',
      fn: (c, i) => {
        if (!st[i] || !st[i-1]) return null;
        return st[i-1].direction === 1 && st[i].direction === -1 ? 'SHORT' : null;
      }
    },

    // 3. MACD line crosses above signal → LONG
    {
      label: 'S3: MACD crosses above signal → LONG',
      fn: (c, i) => {
        if (macdLine[i] === null || macdLine[i-1] === null) return null;
        return macdLine[i-1] < signalLine[i-1] && macdLine[i] > signalLine[i] ? 'LONG' : null;
      }
    },

    // 4. MACD line crosses below signal → SHORT
    {
      label: 'S4: MACD crosses below signal → SHORT',
      fn: (c, i) => {
        if (macdLine[i] === null || macdLine[i-1] === null) return null;
        return macdLine[i-1] > signalLine[i-1] && macdLine[i] < signalLine[i] ? 'SHORT' : null;
      }
    },

    // 5. SuperTrend bullish + MACD bullish cross → LONG (combined)
    {
      label: 'S5: SuperTrend bullish + MACD cross up → LONG (combined)',
      fn: (c, i) => {
        if (!st[i] || macdLine[i] === null) return null;
        const stBull = st[i].direction === 1;
        const macdCross = macdLine[i-1] < signalLine[i-1] && macdLine[i] > signalLine[i];
        return stBull && macdCross ? 'LONG' : null;
      }
    },

    // 6. SuperTrend bearish + MACD bearish cross → SHORT (combined)
    {
      label: 'S6: SuperTrend bearish + MACD cross down → SHORT (combined)',
      fn: (c, i) => {
        if (!st[i] || macdLine[i] === null) return null;
        const stBear = st[i].direction === -1;
        const macdCross = macdLine[i-1] > signalLine[i-1] && macdLine[i] < signalLine[i];
        return stBear && macdCross ? 'SHORT' : null;
      }
    },

    // 7. SuperTrend bullish + MACD histogram turning positive → LONG
    {
      label: 'S7: SuperTrend bullish + histogram positive → LONG',
      fn: (c, i) => {
        if (!st[i] || histogram[i] === null) return null;
        return st[i].direction === 1 && histogram[i-1] < 0 && histogram[i] > 0 ? 'LONG' : null;
      }
    },

    // 8. SuperTrend bearish + MACD histogram turning negative → SHORT
    {
      label: 'S8: SuperTrend bearish + histogram negative → SHORT',
      fn: (c, i) => {
        if (!st[i] || histogram[i] === null) return null;
        return st[i].direction === -1 && histogram[i-1] > 0 && histogram[i] < 0 ? 'SHORT' : null;
      }
    },

    // 9. SuperTrend bullish + MACD above zero + RSI(3) < 30 → LONG (triple confirm)
    {
      label: 'S9: SuperTrend bull + MACD>0 + RSI(3)<30 → LONG (triple)',
      fn: (c, i) => {
        if (!st[i] || macdLine[i] === null || rsi3[i] === null) return null;
        return st[i].direction === 1 && macdLine[i] > 0 && rsi3[i] < 30 ? 'LONG' : null;
      }
    },

    // 10. SuperTrend bearish + MACD below zero + RSI(3) > 70 → SHORT (triple confirm)
    {
      label: 'S10: SuperTrend bear + MACD<0 + RSI(3)>70 → SHORT (triple)',
      fn: (c, i) => {
        if (!st[i] || macdLine[i] === null || rsi3[i] === null) return null;
        return st[i].direction === -1 && macdLine[i] < 0 && rsi3[i] > 70 ? 'SHORT' : null;
      }
    },

    // 11. MACD cross + RSI(14) oversold → LONG
    {
      label: 'S11: MACD cross up + RSI(14) < 45 → LONG',
      fn: (c, i) => {
        if (macdLine[i] === null || rsi[i] === null) return null;
        const cross = macdLine[i-1] < signalLine[i-1] && macdLine[i] > signalLine[i];
        return cross && rsi[i] < 45 ? 'LONG' : null;
      }
    },

    // 12. MACD cross + RSI(14) overbought → SHORT
    {
      label: 'S12: MACD cross down + RSI(14) > 55 → SHORT',
      fn: (c, i) => {
        if (macdLine[i] === null || rsi[i] === null) return null;
        const cross = macdLine[i-1] > signalLine[i-1] && macdLine[i] < signalLine[i];
        return cross && rsi[i] > 55 ? 'SHORT' : null;
      }
    },
  ];

  const results = strategies.map(s => backtest(candles, s.fn, s.label, 4));
  results.sort((a, b) => parseFloat(b.profitFactor) - parseFloat(a.profitFactor));

  console.log('Results (4-bar hold, sorted by Profit Factor):\n');
  console.log('─'.repeat(95));
  console.log('Rank'.padEnd(5) + 'Strategy'.padEnd(55) + 'Trades'.padEnd(8) + 'Win%'.padEnd(8) + 'Avg%'.padEnd(8) + 'Total%'.padEnd(9) + 'PF');
  console.log('─'.repeat(95));

  results.forEach((r, i) => {
    const label = r.label.length > 52 ? r.label.slice(0, 52) + '…' : r.label;
    console.log(
      `#${i+1}`.padEnd(5) + label.padEnd(55) +
      String(r.trades).padEnd(8) + `${r.winRate}%`.padEnd(8) +
      `${r.avgPnl}%`.padEnd(8) + `${r.totalPnl}%`.padEnd(9) + r.profitFactor
    );
  });
  console.log('─'.repeat(95));

  const top3 = results.slice(0, 3);
  console.log('\n══ TOP 3 — DETAILED ══════════════════════════════════════════\n');
  top3.forEach((r, i) => {
    console.log(`#${i+1} ${r.label}`);
    console.log(`    Trades: ${r.trades} | Win Rate: ${r.winRate}% | Avg P&L: ${r.avgPnl}% | Total: ${r.totalPnl}%`);
    console.log(`    Profit Factor: ${r.profitFactor} | Best: +${r.bestTrade}% | Worst: ${r.worstTrade}%\n`);
  });

  console.log('══ RECOMMENDATION ════════════════════════════════════════════\n');
  const best = results[0];
  console.log(`Best: ${best.label}`);
  console.log(`PF ${best.profitFactor} | Win rate ${best.winRate}% over ${best.trades} trades.\n`);

})().catch(console.error);
