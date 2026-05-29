/**
 * Full Strategy Backtest — 1000 x 1H Candles × 50 Coins
 *
 * ALL 4 signals re-enabled — testing on the actual bot timeframe (1H):
 *   P1: SuperTrend bullish flip              → LONG  (was +$13 on daily)
 *   P2: ST bearish + MACD<0 + RSI(14)>70    → SHORT (was -$12 on daily)
 *   P3: BB1 lower < BB2 lower + below BB2   → SHORT (was -$55 on daily)
 *   P4: Price bounces above BB1 lower       → LONG  (was -$6 on daily)
 *   P5: VWAP+EMA20+RSI(14) original         → L/S
 *
 * VWAP resets at midnight UTC (same as live bot)
 * Trade management: $50/trade · 2% SL · 4% TP · 65% min confidence
 * ~41 days of 1H data per coin
 */

import https from 'https';

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

const TRADE_SIZE = 50;
const START_BAL  = 1000;
const SL_PCT     = 0.02;
const TP_PCT     = 0.04;
const MIN_CONF   = 65;

// ── Fetch 1H candles ──────────────────────────────────────────────────────────

function fetchCandles(symbol, limit = 1000) {
  return new Promise((resolve, reject) => {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=${limit}`;
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const raw = JSON.parse(d);
          if (!Array.isArray(raw)) return reject(new Error(`Bad response for ${symbol}: ${d.slice(0,80)}`));
          resolve(raw.map(k => ({
            time:   new Date(k[0]),
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

// ── Indicators ────────────────────────────────────────────────────────────────

function calcEMASeries(values, period) {
  const k = 2 / (period + 1);
  const r = new Array(values.length).fill(null);
  let ema = values[0];
  r[0] = ema;
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    r[i] = ema;
  }
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
    const avgG = g / period;
    const avgL = l / period;
    if (avgL === 0) { r[i] = 100; continue; }
    const rs = avgG / avgL;
    r[i] = 100 - 100 / (1 + rs);
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
  const r = new Array(candles.length).fill(null);
  let pUp = null, pLo = null, pDir = null;
  for (let i = atrPeriod; i < candles.length; i++) {
    const hl2 = (candles[i].high + candles[i].low) / 2;
    let up = hl2 + mult * atr[i];
    let lo = hl2 - mult * atr[i];
    if (pLo !== null) lo = candles[i].close > pLo ? Math.max(lo, pLo) : lo;
    if (pUp !== null) up = candles[i].close < pUp ? Math.min(up, pUp) : up;
    let dir;
    if (pDir === null)      dir = candles[i].close > up ? 1 : -1;
    else if (pDir === -1)   dir = candles[i].close > pUp ? 1 : -1;
    else                    dir = candles[i].close < pLo ? -1 : 1;
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
  const k        = 2 / (signal + 1);
  let s          = macdLine[0];
  sigLine[0]     = s;
  for (let i = 1; i < closes.length; i++) {
    s = macdLine[i] * k + s * (1 - k);
    sigLine[i] = s;
  }
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

// VWAP — resets at midnight UTC each day (mirrors live bot exactly)
function calcVWAPSeries(candles) {
  const r = new Array(candles.length).fill(null);
  let cumTPV = 0, cumVol = 0, currentDay = null;
  for (let i = 0; i < candles.length; i++) {
    const day = candles[i].time.toISOString().slice(0, 10);
    if (day !== currentDay) { cumTPV = 0; cumVol = 0; currentDay = day; }
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    cumTPV += tp * candles[i].volume;
    cumVol += candles[i].volume;
    r[i] = cumVol === 0 ? null : cumTPV / cumVol;
  }
  return r;
}

// ── Confidence scoring (full 5-indicator version with VWAP) ──────────────────

function confidence(price, ema20, vwap, rsi14, st, macd, bbSigs, stSigs) {
  const rsi = rsi14 ?? 50;
  let L = 0, S = 0;

  // Trend (35 pts)
  if (st) { if (st.direction === 1) L += 20; else S += 20; }
  if (ema20 != null) { if (price > ema20) L += 10; else S += 10; }
  if (vwap  != null) { if (price > vwap)  L += 5;  else S += 5;  }

  // MACD (25 pts)
  if (macd) {
    if (macd.macdLine > 0)             L += 12; else S += 12;
    if (macd.macdLine > macd.sigLine)  L += 13; else S += 13;
  }

  // RSI (25 pts)
  if      (rsi < 30) L += 25;
  else if (rsi < 40) L += 15;
  else if (rsi < 50) L += 5;
  if      (rsi > 70) S += 25;
  else if (rsi > 60) S += 15;
  else if (rsi > 50) S += 5;

  // Signal bonus (15 pts)
  if (stSigs.includes('LONG'))  L += 15;
  if (stSigs.includes('SHORT')) S += 15;
  if (bbSigs.includes('LONG'))  L += 10;
  if (bbSigs.includes('SHORT')) S += 10;

  return { long: Math.min(L, 100), short: Math.min(S, 100) };
}

// ── Signal logic — all 4 signals active ──────────────────────────────────────

function getSignal(i, candles, ema20s, rsi14s, vwaps, sts, macdLine, sigLine, bb1s, bb2s) {
  const st   = sts[i],   stP  = sts[i-1];
  const rsi  = rsi14s[i];
  const macd = macdLine[i], sig = sigLine[i];
  const ema  = ema20s[i];
  const vwap = vwaps[i];
  const bb1  = bb1s[i],  bb1P = bb1s[i-1];
  const bb2  = bb2s[i];
  const c    = candles[i].close, cP = candles[i-1].close;

  if (!st || !stP || rsi == null || ema == null) return null;

  const bbSigs = [], stSigs = [];

  // P1: SuperTrend bullish flip → LONG
  if (stP.direction === -1 && st.direction === 1) stSigs.push('LONG');

  // P2: ST bearish + MACD < 0 + RSI(14) > 70 → SHORT
  if (st.direction === -1 && macd < 0 && rsi > 70) stSigs.push('SHORT');

  // P3: BB1 lower < BB2 lower + close below BB2 lower → SHORT
  if (bb1 && bb2 && bb1.lower < bb2.lower && c < bb2.lower) bbSigs.push('SHORT');

  // P4: Price bounces back above BB1 lower (oversold recovery) → LONG
  if (bb1 && bb1P && cP < bb1P.lower && c > bb1.lower) bbSigs.push('LONG');

  // Priority order
  let direction = null;
  if      (stSigs.includes('LONG'))  direction = 'LONG';
  else if (stSigs.includes('SHORT')) direction = 'SHORT';
  else if (bbSigs.includes('SHORT')) direction = 'SHORT';
  else if (bbSigs.includes('LONG'))  direction = 'LONG';
  else {
    // P5: VWAP + EMA20 + RSI original
    const bull = c > ema && (vwap == null || c > vwap) && rsi < 30;
    const bear = c < ema && (vwap == null || c < vwap) && rsi > 70;
    if (bull) direction = 'LONG';
    else if (bear) direction = 'SHORT';
  }

  if (!direction) return null;

  // Confidence gate
  const macdObj = { macdLine: macd, sigLine: sig };
  const conf  = confidence(c, ema, vwap, rsi, st, macdObj, bbSigs, stSigs);
  const score = direction === 'LONG' ? conf.long : conf.short;
  if (score < MIN_CONF) return null;

  let source = 'VWAP+EMA+RSI';
  if      (stSigs.includes('LONG'))  source = 'ST Bullish Flip';
  else if (stSigs.includes('SHORT')) source = 'ST+MACD+RSI Short';
  else if (bbSigs.includes('SHORT')) source = 'BB Breakdown';
  else if (bbSigs.includes('LONG'))  source = 'BB Recovery';

  return { direction, score, source };
}

// ── Backtest engine ───────────────────────────────────────────────────────────

function backtestCoin(candles, symbol) {
  const closes  = candles.map(c => c.close);
  const opens   = candles.map(c => c.open);
  const ema20s  = calcEMASeries(closes, 20);
  const rsi14s  = calcRSISeries(closes, 14);
  const vwaps   = calcVWAPSeries(candles);
  const sts     = calcSuperTrendSeries(candles, 10, 3);
  const { macdLine, sigLine } = calcMACDSeries(closes, 12, 26, 9);
  const bb1s    = calcBBSeries(opens, 4, 4);
  const bb2s    = calcBBSeries(closes, 20, 2);

  const trades  = [];
  let inTrade   = null;
  let balance   = START_BAL;

  for (let i = 30; i < candles.length - 1; i++) {
    // Check open position first
    if (inTrade) {
      const bar    = candles[i];
      const isLong = inTrade.direction === 'LONG';
      let exitPrice = null, exitReason = null;

      if (isLong) {
        if      (bar.open <= inTrade.sl) { exitPrice = bar.open;    exitReason = 'STOP_LOSS'; }
        else if (bar.open >= inTrade.tp) { exitPrice = bar.open;    exitReason = 'TAKE_PROFIT'; }
        else if (bar.low  <= inTrade.sl) { exitPrice = inTrade.sl;  exitReason = 'STOP_LOSS'; }
        else if (bar.high >= inTrade.tp) { exitPrice = inTrade.tp;  exitReason = 'TAKE_PROFIT'; }
      } else {
        if      (bar.open >= inTrade.sl) { exitPrice = bar.open;    exitReason = 'STOP_LOSS'; }
        else if (bar.open <= inTrade.tp) { exitPrice = bar.open;    exitReason = 'TAKE_PROFIT'; }
        else if (bar.high >= inTrade.sl) { exitPrice = inTrade.sl;  exitReason = 'STOP_LOSS'; }
        else if (bar.low  <= inTrade.tp) { exitPrice = inTrade.tp;  exitReason = 'TAKE_PROFIT'; }
      }

      if (exitPrice !== null) {
        const pnlPct = isLong
          ? (exitPrice - inTrade.entryPrice) / inTrade.entryPrice * 100
          : (inTrade.entryPrice - exitPrice) / inTrade.entryPrice * 100;
        const pnlUSD = pnlPct / 100 * TRADE_SIZE;
        balance += TRADE_SIZE + pnlUSD;
        trades.push({ ...inTrade, exitPrice, exitReason, exitDate: bar.time, pnlPct, pnlUSD });
        inTrade = null;
      }
    }

    // Look for new signal if flat
    if (!inTrade) {
      const sig = getSignal(i, candles, ema20s, rsi14s, vwaps, sts, macdLine, sigLine, bb1s, bb2s);
      if (sig && balance >= TRADE_SIZE) {
        const entryPrice = candles[i+1].open;
        const isLong     = sig.direction === 'LONG';
        const sl         = isLong ? entryPrice * (1 - SL_PCT) : entryPrice * (1 + SL_PCT);
        const tp         = isLong ? entryPrice * (1 + TP_PCT) : entryPrice * (1 - TP_PCT);
        balance -= TRADE_SIZE;
        inTrade = { symbol, direction: sig.direction, source: sig.source,
                    confidence: sig.score, entryPrice, entryDate: candles[i+1].time, sl, tp };
      }
    }
  }

  // Close any open position at end of data
  if (inTrade) {
    const last     = candles[candles.length - 1];
    const isLong   = inTrade.direction === 'LONG';
    const pnlPct   = isLong
      ? (last.close - inTrade.entryPrice) / inTrade.entryPrice * 100
      : (inTrade.entryPrice - last.close) / inTrade.entryPrice * 100;
    const pnlUSD = pnlPct / 100 * TRADE_SIZE;
    balance += TRADE_SIZE + pnlUSD;
    trades.push({ ...inTrade, exitPrice: last.close, exitReason: 'END_OF_DATA',
                  exitDate: last.time, pnlPct, pnlUSD });
  }

  const wins      = trades.filter(t => t.pnlUSD > 0);
  const losses    = trades.filter(t => t.pnlUSD <= 0);
  const totalPnl  = trades.reduce((s, t) => s + t.pnlUSD, 0);
  const grossWin  = wins.reduce((s, t) => s + t.pnlUSD, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUSD, 0));

  return {
    symbol,
    trades:       trades.length,
    wins:         wins.length,
    losses:       losses.length,
    winRate:      trades.length ? (wins.length / trades.length * 100).toFixed(1) : '0',
    totalPnlUSD:  parseFloat(totalPnl.toFixed(2)),
    totalPnlPct:  parseFloat((totalPnl / START_BAL * 100).toFixed(2)),
    avgWinUSD:    wins.length   ? parseFloat((grossWin  / wins.length).toFixed(2))   : 0,
    avgLossUSD:   losses.length ? parseFloat((-grossLoss / losses.length).toFixed(2)) : 0,
    profitFactor: grossLoss > 0 ? parseFloat((grossWin / grossLoss).toFixed(2)) : (grossWin > 0 ? '∞' : 0),
    tradeList:    trades,
    signalBreakdown: [...new Set(trades.map(t => t.source))].map(src => {
      const ts = trades.filter(t => t.source === src);
      const ws = ts.filter(t => t.pnlUSD > 0);
      return { source: src, count: ts.length, wins: ws.length,
               pnl: parseFloat(ts.reduce((s, t) => s + t.pnlUSD, 0).toFixed(2)) };
    }),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n' + '═'.repeat(90));
  console.log('  FULL STRATEGY BACKTEST — 1000 x 1H Candles × 50 Coins  (ALL SIGNALS ON)');
  console.log(`  Trade size: $${TRADE_SIZE} | SL: ${SL_PCT*100}% | TP: ${TP_PCT*100}% | Min confidence: ${MIN_CONF}%`);
  console.log(`  Starting balance per coin: $${START_BAL}  |  ~41 days of 1H data`);
  console.log('═'.repeat(90) + '\n');

  const allResults = [];
  let totalTrades = 0, totalWins = 0, totalPnl = 0;

  for (const symbol of COINS) {
    process.stdout.write(`  Fetching ${symbol}...`);
    try {
      const candles = await fetchCandles(symbol, 1000);
      const start   = candles[0].time.toISOString().slice(0,10);
      const end     = candles[candles.length-1].time.toISOString().slice(0,10);
      process.stdout.write(` ${candles.length} candles (${start} → ${end})\n`);
      const r = backtestCoin(candles, symbol);
      allResults.push(r);
      totalTrades += r.trades;
      totalWins   += r.wins;
      totalPnl    += r.totalPnlUSD;
    } catch(e) {
      console.log(` ❌ ${e.message}`);
    }
  }

  // ── Per-coin table ─────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(90));
  console.log(
    'Coin'.padEnd(8) + 'Trades'.padEnd(8) + 'Wins'.padEnd(6) + 'Losses'.padEnd(8) +
    'Win%'.padEnd(8) + 'PF'.padEnd(6) + 'Avg Win'.padEnd(10) + 'Avg Loss'.padEnd(10) +
    'P&L $'.padEnd(10) + 'P&L %'
  );
  console.log('─'.repeat(90));
  for (const r of allResults) {
    const pnl    = `${r.totalPnlUSD >= 0 ? '+' : ''}$${r.totalPnlUSD}`;
    const pnlPct = `${r.totalPnlPct >= 0 ? '+' : ''}${r.totalPnlPct}%`;
    console.log(
      r.symbol.replace('USDT','').padEnd(8) +
      String(r.trades).padEnd(8) +
      String(r.wins).padEnd(6) +
      String(r.losses).padEnd(8) +
      `${r.winRate}%`.padEnd(8) +
      String(r.profitFactor).padEnd(6) +
      `+$${r.avgWinUSD}`.padEnd(10) +
      `$${r.avgLossUSD}`.padEnd(10) +
      pnl.padEnd(10) + pnlPct
    );
  }
  console.log('─'.repeat(90));

  const totalLosses = totalTrades - totalWins;
  const wr = totalTrades ? (totalWins / totalTrades * 100).toFixed(1) : '0';
  console.log(
    'TOTAL'.padEnd(8) + String(totalTrades).padEnd(8) + String(totalWins).padEnd(6) +
    String(totalLosses).padEnd(8) + `${wr}%`.padEnd(62) +
    `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`
  );
  console.log('─'.repeat(90));

  // ── Signal breakdown ───────────────────────────────────────────────────────
  console.log('\n══ SIGNAL BREAKDOWN (all 50 coins combined) ══════════════════════════════════\n');
  const sigMap = {};
  for (const r of allResults) {
    for (const s of r.signalBreakdown) {
      if (!sigMap[s.source]) sigMap[s.source] = { count: 0, wins: 0, pnl: 0 };
      sigMap[s.source].count += s.count;
      sigMap[s.source].wins  += s.wins;
      sigMap[s.source].pnl   += s.pnl;
    }
  }
  console.log('Signal'.padEnd(28) + 'Trades'.padEnd(9) + 'Win%'.padEnd(9) + 'Total P&L');
  console.log('─'.repeat(60));
  for (const [src, d] of Object.entries(sigMap).sort((a,b) => b[1].pnl - a[1].pnl)) {
    const wr2 = d.count ? (d.wins / d.count * 100).toFixed(1) : '0';
    const verdict = d.pnl > 0 ? ' ✅' : ' ❌';
    console.log(src.padEnd(28) + String(d.count).padEnd(9) + `${wr2}%`.padEnd(9) + `${d.pnl >= 0 ? '+' : ''}$${d.pnl.toFixed(2)}${verdict}`);
  }

  // ── Top 5 & Bottom 5 ──────────────────────────────────────────────────────
  const sorted = [...allResults].sort((a, b) => b.totalPnlUSD - a.totalPnlUSD);
  console.log('\n══ TOP 5 PERFORMERS ══════════════════════════════════════════════════════════\n');
  sorted.slice(0, 5).forEach((r, i) => {
    const pnl = `${r.totalPnlUSD >= 0 ? '+' : ''}$${r.totalPnlUSD}`;
    console.log(`  #${i+1} ${r.symbol.replace('USDT','').padEnd(6)} ${r.trades} trades | Win ${r.winRate}% | P&L ${pnl} | PF ${r.profitFactor}`);
    r.signalBreakdown.sort((a,b) => b.pnl - a.pnl).forEach(s => {
      const icon = s.pnl > 0 ? '✅' : '❌';
      console.log(`      ${icon} ${s.source}: ${s.count} trades, ${s.wins} wins, ${s.pnl >= 0 ? '+' : ''}$${s.pnl}`);
    });
  });

  console.log('\n══ BOTTOM 5 PERFORMERS ═══════════════════════════════════════════════════════\n');
  sorted.slice(-5).reverse().forEach((r, i) => {
    const pnl = `${r.totalPnlUSD >= 0 ? '+' : ''}$${r.totalPnlUSD}`;
    console.log(`  #${i+1} ${r.symbol.replace('USDT','').padEnd(6)} ${r.trades} trades | Win ${r.winRate}% | P&L ${pnl} | PF ${r.profitFactor}`);
  });

  // ── Verdict ────────────────────────────────────────────────────────────────
  const avgPerCoin = totalPnl / allResults.length;
  console.log('\n══ VERDICT ═══════════════════════════════════════════════════════════════════\n');
  console.log(`  Total trades across all 50 coins : ${totalTrades}`);
  console.log(`  Overall win rate                 : ${wr}%`);
  console.log(`  Total P&L (all coins, $50/trade) : ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
  console.log(`  Avg P&L per coin                 : ${avgPerCoin >= 0 ? '+' : ''}$${avgPerCoin.toFixed(2)}`);
  console.log(`  Strategy verdict                 : ${totalPnl > 0 ? '✅ PROFITABLE' : '❌ UNPROFITABLE'} over ~41 days (1H)`);
  console.log('\n' + '═'.repeat(90) + '\n');
})().catch(console.error);
