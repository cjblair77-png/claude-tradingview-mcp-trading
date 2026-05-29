/**
 * Dual Bollinger Bands Backtest
 * BB1: Length 4, StdDev 4, Source: Open  (red - extreme volatility bands)
 * BB2: Length 20, StdDev 2, Source: Close (white - standard trend bands)
 *
 * Tests multiple signal strategies on 1H BTCUSDT data (500 candles)
 */

import https from 'https';

// ── Fetch OHLCV from Binance ─────────────────────────────────────────────────
function fetchCandles(symbol = 'BTCUSDT', interval = '1h', limit = 500) {
  return new Promise((resolve, reject) => {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const raw = JSON.parse(data);
          const candles = raw.map(k => ({
            time:  new Date(k[0]),
            open:  parseFloat(k[1]),
            high:  parseFloat(k[2]),
            low:   parseFloat(k[3]),
            close: parseFloat(k[4]),
            vol:   parseFloat(k[5]),
          }));
          resolve(candles);
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ── Bollinger Bands ──────────────────────────────────────────────────────────
function calcBB(values, length, mult) {
  return values.map((_, i) => {
    if (i < length - 1) return null;
    const slice = values.slice(i - length + 1, i + 1);
    const mean  = slice.reduce((s, v) => s + v, 0) / length;
    const variance = slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / length;
    const std   = Math.sqrt(variance);
    return { mid: mean, upper: mean + mult * std, lower: mean - mult * std, std };
  });
}

// ── EMA ──────────────────────────────────────────────────────────────────────
function calcEMA(values, length) {
  const k = 2 / (length + 1);
  const result = new Array(values.length).fill(null);
  let ema = values[0];
  result[0] = ema;
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

// ── Backtest engine ──────────────────────────────────────────────────────────
function backtest(candles, signalFn, label, holdBars = 4) {
  const trades = [];
  let inTrade = null;

  for (let i = 21; i < candles.length - holdBars; i++) {
    if (inTrade) {
      // Simple exit: hold for holdBars candles
      if (i >= inTrade.entryBar + holdBars) {
        const exitPrice = candles[i].close;
        const pnl = inTrade.dir === 'LONG'
          ? (exitPrice - inTrade.entryPrice) / inTrade.entryPrice * 100
          : (inTrade.entryPrice - exitPrice) / inTrade.entryPrice * 100;
        trades.push({ ...inTrade, exitPrice, pnl, exitBar: i });
        inTrade = null;
      }
      continue;
    }

    const sig = signalFn(candles, i);
    if (sig) {
      inTrade = { dir: sig, entryPrice: candles[i + 1].open, entryBar: i + 1, label };
    }
  }

  if (!trades.length) return { label, trades: 0, winRate: 0, avgPnl: 0, totalPnl: 0, profitFactor: 0 };

  const wins  = trades.filter(t => t.pnl > 0);
  const losses= trades.filter(t => t.pnl <= 0);
  const gross_profit = wins.reduce((s, t) => s + t.pnl, 0);
  const gross_loss   = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalPnl     = trades.reduce((s, t) => s + t.pnl, 0);

  return {
    label,
    trades:       trades.length,
    winRate:      (wins.length / trades.length * 100).toFixed(1),
    avgPnl:       (totalPnl / trades.length).toFixed(3),
    totalPnl:     totalPnl.toFixed(2),
    profitFactor: gross_loss > 0 ? (gross_profit / gross_loss).toFixed(2) : '∞',
    bestTrade:    Math.max(...trades.map(t => t.pnl)).toFixed(2),
    worstTrade:   Math.min(...trades.map(t => t.pnl)).toFixed(2),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Dual Bollinger Bands Backtest — BTCUSDT 1H (500 candles)');
  console.log('  BB1: Length 4, StdDev 4, Source Open  (red)');
  console.log('  BB2: Length 20, StdDev 2, Source Close (white)');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('Fetching 500 x 1H candles from Binance...');
  const candles = await fetchCandles('BTCUSDT', '1h', 500);
  console.log(`  Got ${candles.length} candles: ${candles[0].time.toISOString().slice(0,16)} → ${candles[candles.length-1].time.toISOString().slice(0,16)}\n`);

  // Pre-calculate indicators
  const opens  = candles.map(c => c.open);
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);

  const bb1 = calcBB(opens,  4,  4);   // Red:   length 4,  stdDev 4,  source open
  const bb2 = calcBB(closes, 20, 2);   // White: length 20, stdDev 2, source close
  const ema8 = calcEMA(closes, 8);

  // ── Signal definitions ───────────────────────────────────────────────────

  const strategies = [

    // 1. Price closes below BB1 lower → bounce LONG
    {
      label: 'S1: Close below BB1-Lower → LONG (mean reversion)',
      fn: (c, i) => {
        if (!bb1[i]) return null;
        return c[i].close < bb1[i].lower ? 'LONG' : null;
      }
    },

    // 2. Price closes above BB1 upper → short (mean reversion)
    {
      label: 'S2: Close above BB1-Upper → SHORT (mean reversion)',
      fn: (c, i) => {
        if (!bb1[i]) return null;
        return c[i].close > bb1[i].upper ? 'SHORT' : null;
      }
    },

    // 3. Price closes above BB2 upper → LONG breakout
    {
      label: 'S3: Close above BB2-Upper → LONG (breakout)',
      fn: (c, i) => {
        if (!bb2[i]) return null;
        return c[i].close > bb2[i].upper ? 'LONG' : null;
      }
    },

    // 4. Price closes below BB2 lower → SHORT breakout
    {
      label: 'S4: Close below BB2-Lower → SHORT (breakout)',
      fn: (c, i) => {
        if (!bb2[i]) return null;
        return c[i].close < bb2[i].lower ? 'SHORT' : null;
      }
    },

    // 5. BB1 squeeze inside BB2 then close above BB2 mid → LONG
    {
      label: 'S5: BB1 inside BB2 + close above BB2-Mid → LONG (squeeze breakout)',
      fn: (c, i) => {
        if (!bb1[i] || !bb2[i]) return null;
        const squeezed = bb1[i].upper < bb2[i].upper && bb1[i].lower > bb2[i].lower;
        return squeezed && c[i].close > bb2[i].mid ? 'LONG' : null;
      }
    },

    // 6. BB1 squeeze inside BB2 then close below BB2 mid → SHORT
    {
      label: 'S6: BB1 inside BB2 + close below BB2-Mid → SHORT (squeeze breakout)',
      fn: (c, i) => {
        if (!bb1[i] || !bb2[i]) return null;
        const squeezed = bb1[i].upper < bb2[i].upper && bb1[i].lower > bb2[i].lower;
        return squeezed && c[i].close < bb2[i].mid ? 'SHORT' : null;
      }
    },

    // 7. Close between BB2-Mid and BB2-Upper AND above BB1-Mid → LONG trend
    {
      label: 'S7: Close in BB2 upper half + above BB1-Mid → LONG (trend riding)',
      fn: (c, i) => {
        if (!bb1[i] || !bb2[i]) return null;
        return c[i].close > bb2[i].mid && c[i].close < bb2[i].upper && c[i].close > bb1[i].mid
          ? 'LONG' : null;
      }
    },

    // 8. Close between BB2-Mid and BB2-Lower AND below BB1-Mid → SHORT trend
    {
      label: 'S8: Close in BB2 lower half + below BB1-Mid → SHORT (trend riding)',
      fn: (c, i) => {
        if (!bb1[i] || !bb2[i]) return null;
        return c[i].close < bb2[i].mid && c[i].close > bb2[i].lower && c[i].close < bb1[i].mid
          ? 'SHORT' : null;
      }
    },

    // 9. BB1 expands outside BB2 (volatility explosion) + close above BB2-Upper → LONG
    {
      label: 'S9: BB1 expands outside BB2 + close above BB2-Upper → LONG (vol breakout)',
      fn: (c, i) => {
        if (!bb1[i] || !bb2[i]) return null;
        const expanding = bb1[i].upper > bb2[i].upper;
        return expanding && c[i].close > bb2[i].upper ? 'LONG' : null;
      }
    },

    // 10. BB1 expands outside BB2 + close below BB2-Lower → SHORT
    {
      label: 'S10: BB1 expands outside BB2 + close below BB2-Lower → SHORT (vol breakdown)',
      fn: (c, i) => {
        if (!bb1[i] || !bb2[i]) return null;
        const expanding = bb1[i].lower < bb2[i].lower;
        return expanding && c[i].close < bb2[i].lower ? 'SHORT' : null;
      }
    },

    // 11. Price crosses back inside BB1 lower from below → LONG (recovery)
    {
      label: 'S11: Price crosses back above BB1-Lower → LONG (recovery from extreme)',
      fn: (c, i) => {
        if (!bb1[i] || !bb1[i-1]) return null;
        return c[i-1].close < bb1[i-1].lower && c[i].close > bb1[i].lower ? 'LONG' : null;
      }
    },

    // 12. Price crosses back inside BB1 upper from above → SHORT (rejection)
    {
      label: 'S12: Price crosses back below BB1-Upper → SHORT (rejection from extreme)',
      fn: (c, i) => {
        if (!bb1[i] || !bb1[i-1]) return null;
        return c[i-1].close > bb1[i-1].upper && c[i].close < bb1[i].upper ? 'SHORT' : null;
      }
    },

  ];

  // Run all strategies (hold 4 bars = 4 hours)
  const results = strategies.map(s => backtest(candles, s.fn, s.label, 4));

  // Sort by profit factor descending
  results.sort((a, b) => parseFloat(b.profitFactor) - parseFloat(a.profitFactor));

  console.log('Results (4-bar hold, sorted by Profit Factor):\n');
  console.log('─'.repeat(95));
  console.log(
    'Rank'.padEnd(5) +
    'Strategy'.padEnd(55) +
    'Trades'.padEnd(8) +
    'Win%'.padEnd(8) +
    'Avg%'.padEnd(8) +
    'Total%'.padEnd(9) +
    'PF'
  );
  console.log('─'.repeat(95));

  results.forEach((r, i) => {
    const shortLabel = r.label.length > 52 ? r.label.slice(0, 52) + '…' : r.label;
    console.log(
      `#${i+1}`.padEnd(5) +
      shortLabel.padEnd(55) +
      String(r.trades).padEnd(8) +
      `${r.winRate}%`.padEnd(8) +
      `${r.avgPnl}%`.padEnd(8) +
      `${r.totalPnl}%`.padEnd(9) +
      r.profitFactor
    );
  });

  console.log('─'.repeat(95));

  // Detailed breakdown of top 3
  const top3 = results.slice(0, 3);
  console.log('\n══ TOP 3 STRATEGIES — DETAILED ══════════════════════════════════════\n');
  top3.forEach((r, i) => {
    console.log(`#${i+1} ${r.label}`);
    console.log(`    Trades: ${r.trades} | Win Rate: ${r.winRate}% | Avg P&L per trade: ${r.avgPnl}%`);
    console.log(`    Total P&L: ${r.totalPnl}% | Profit Factor: ${r.profitFactor}`);
    console.log(`    Best trade: +${r.bestTrade}% | Worst trade: ${r.worstTrade}%\n`);
  });

  // Summary / recommendation
  const best = results[0];
  console.log('══ RECOMMENDATION ════════════════════════════════════════════════════\n');
  console.log(`Best signal: ${best.label}`);
  console.log(`Profit Factor ${best.profitFactor} means for every $1 lost, you made $${best.profitFactor}.`);
  console.log(`Win rate: ${best.winRate}% over ${best.trades} trades in the last 500 hours.\n`);

})().catch(console.error);
