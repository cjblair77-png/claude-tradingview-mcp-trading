/**
 * SL/TP Optimiser — 1H Candles × 50 Coins
 *
 * Fetches candles ONCE, then re-runs the backtest engine across every
 * SL/TP combination so we can find the optimal risk management settings.
 *
 * Signals active: ST Bullish Flip · BB Recovery · ST+MACD+RSI Short
 * BB Breakdown remains OFF (confirmed loser on both timeframes)
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

// ── SL/TP combos to test ──────────────────────────────────────────────────────
const CONFIGS = [
  { label: '1.5% SL / 3.0% TP  (1:2)',   sl: 0.015, tp: 0.030 },
  { label: '1.5% SL / 4.5% TP  (1:3)',   sl: 0.015, tp: 0.045 },
  { label: '1.5% SL / 6.0% TP  (1:4)',   sl: 0.015, tp: 0.060 },
  { label: '2.0% SL / 3.0% TP  (1:1.5)', sl: 0.020, tp: 0.030 },
  { label: '2.0% SL / 4.0% TP  (1:2)  ← current', sl: 0.020, tp: 0.040 },
  { label: '2.0% SL / 6.0% TP  (1:3)',   sl: 0.020, tp: 0.060 },
  { label: '2.0% SL / 8.0% TP  (1:4)',   sl: 0.020, tp: 0.080 },
  { label: '3.0% SL / 6.0% TP  (1:2)',   sl: 0.030, tp: 0.060 },
  { label: '3.0% SL / 9.0% TP  (1:3)',   sl: 0.030, tp: 0.090 },
  { label: '4.0% SL / 8.0% TP  (1:2)',   sl: 0.040, tp: 0.080 },
  { label: '5.0% SL / 10.0% TP (1:2)',   sl: 0.050, tp: 0.100 },
  { label: '5.0% SL / 15.0% TP (1:3)',   sl: 0.050, tp: 0.150 },
];

const TRADE_SIZE = 50;
const START_BAL  = 1000;
const MIN_CONF   = 65;

// ── Fetch ─────────────────────────────────────────────────────────────────────

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
  const r = [values[0]];
  for (let i = 1; i < values.length; i++) r.push(values[i] * k + r[i-1] * (1 - k));
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
    const avgL = l / period;
    r[i] = avgL === 0 ? 100 : 100 - 100 / (1 + (g / period) / avgL);
  }
  return r;
}

function calcATRSeries(candles, period) {
  const trs = candles.map((c, i) => i === 0 ? c.high - c.low :
    Math.max(c.high - c.low, Math.abs(c.high - candles[i-1].close), Math.abs(c.low - candles[i-1].close)));
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
    let up = hl2 + mult * atr[i], lo = hl2 - mult * atr[i];
    if (pLo !== null) lo = candles[i].close > pLo ? Math.max(lo, pLo) : lo;
    if (pUp !== null) up = candles[i].close < pUp ? Math.min(up, pUp) : up;
    let dir = pDir === null ? (candles[i].close > up ? 1 : -1)
            : pDir === -1  ? (candles[i].close > pUp ? 1 : -1)
            :                (candles[i].close < pLo ? -1 : 1);
    r[i] = { upper: up, lower: lo, direction: dir };
    pUp = up; pLo = lo; pDir = dir;
  }
  return r;
}

function calcMACDSeries(closes) {
  const fast = calcEMASeries(closes, 12), slow = calcEMASeries(closes, 26);
  const macd = closes.map((_, i) => fast[i] - slow[i]);
  const k = 2 / 10; let s = macd[0];
  const sig = [s];
  for (let i = 1; i < macd.length; i++) { s = macd[i] * k + s * (1-k); sig.push(s); }
  return { macd, sig };
}

function calcBBSeries(values, length, mult) {
  return values.map((_, i) => {
    if (i < length - 1) return null;
    const sl = values.slice(i - length + 1, i + 1);
    const mean = sl.reduce((s,v) => s+v, 0) / length;
    const std  = Math.sqrt(sl.reduce((s,v) => s+(v-mean)**2, 0) / length);
    return { upper: mean + mult*std, lower: mean - mult*std };
  });
}

function calcVWAPSeries(candles) {
  const r = new Array(candles.length).fill(null);
  let cumTPV = 0, cumVol = 0, day = null;
  for (let i = 0; i < candles.length; i++) {
    const d = candles[i].time.toISOString().slice(0,10);
    if (d !== day) { cumTPV = 0; cumVol = 0; day = d; }
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    cumTPV += tp * candles[i].volume; cumVol += candles[i].volume;
    r[i] = cumVol === 0 ? null : cumTPV / cumVol;
  }
  return r;
}

// ── Pre-compute indicators per coin (done once, reused across all configs) ────

function precompute(candles) {
  const closes = candles.map(c => c.close);
  const opens  = candles.map(c => c.open);
  return {
    candles,
    closes,
    ema20s:  calcEMASeries(closes, 20),
    rsi14s:  calcRSISeries(closes, 14),
    vwaps:   calcVWAPSeries(candles),
    sts:     calcSuperTrendSeries(candles, 10, 3),
    ...calcMACDSeries(closes),           // macd, sig
    bb1s:    calcBBSeries(opens, 4, 4),
    bb2s:    calcBBSeries(closes, 20, 2),
  };
}

// ── Confidence ────────────────────────────────────────────────────────────────

function confidence(price, ema, vwap, rsi, st, macdV, sigV, bbSigs, stSigs) {
  let L = 0, S = 0;
  const r = rsi ?? 50;
  if (st) { if (st.direction===1) L+=20; else S+=20; }
  if (ema  != null) { price>ema  ? L+=10 : S+=10; }
  if (vwap != null) { price>vwap ? L+=5  : S+=5;  }
  if (macdV > 0)  L+=12; else S+=12;
  if (macdV > sigV) L+=13; else S+=13;
  if      (r<30) L+=25; else if (r<40) L+=15; else if (r<50) L+=5;
  if      (r>70) S+=25; else if (r>60) S+=15; else if (r>50) S+=5;
  if (stSigs.includes('LONG'))  L+=15;
  if (stSigs.includes('SHORT')) S+=15;
  if (bbSigs.includes('LONG'))  L+=10;
  if (bbSigs.includes('SHORT')) S+=10;
  return { long: Math.min(L,100), short: Math.min(S,100) };
}

// ── Signal detection ──────────────────────────────────────────────────────────

function getSignal(i, pre) {
  const { candles, ema20s, rsi14s, vwaps, sts, macd, sig, bb1s, bb2s } = pre;
  const st=sts[i], stP=sts[i-1];
  if (!st || !stP || rsi14s[i]==null || ema20s[i]==null) return null;

  const c=candles[i].close, cP=candles[i-1].close;
  const rsi=rsi14s[i], ema=ema20s[i], vwap=vwaps[i];
  const macdV=macd[i], sigV=sig[i];
  const bb1=bb1s[i], bb1P=bb1s[i-1], bb2=bb2s[i];

  const bbSigs=[], stSigs=[];

  // P1: ST Bullish Flip → LONG
  if (stP.direction===-1 && st.direction===1) stSigs.push('LONG');

  // P2: ST bearish + MACD<0 + RSI>70 → SHORT
  if (st.direction===-1 && macdV<0 && rsi>70) stSigs.push('SHORT');

  // P3: BB Breakdown → SHORT  ← DISABLED
  // if (bb1 && bb2 && bb1.lower < bb2.lower && c < bb2.lower) bbSigs.push('SHORT');

  // P4: BB Recovery → LONG
  if (bb1 && bb1P && cP < bb1P.lower && c > bb1.lower) bbSigs.push('LONG');

  let dir = null;
  if      (stSigs.includes('LONG'))  dir='LONG';
  else if (stSigs.includes('SHORT')) dir='SHORT';
  else if (bbSigs.includes('LONG'))  dir='LONG';
  else {
    const bull = c>ema && (vwap==null||c>vwap) && rsi<30;
    const bear = c<ema && (vwap==null||c<vwap) && rsi>70;
    if (bull) dir='LONG'; else if (bear) dir='SHORT';
  }
  if (!dir) return null;

  const conf  = confidence(c, ema, vwap, rsi, st, macdV, sigV, bbSigs, stSigs);
  const score = dir==='LONG' ? conf.long : conf.short;
  if (score < MIN_CONF) return null;

  let source = 'VWAP+EMA+RSI';
  if      (stSigs.includes('LONG'))  source='ST Bullish Flip';
  else if (stSigs.includes('SHORT')) source='ST+MACD+RSI Short';
  else if (bbSigs.includes('LONG'))  source='BB Recovery';

  return { dir, score, source };
}

// ── Backtest engine (reuses pre-computed indicators) ─────────────────────────

function runBacktest(pre, SL_PCT, TP_PCT) {
  const { candles } = pre;
  let inTrade = null, balance = START_BAL;
  let trades = 0, wins = 0, totalPnl = 0;

  for (let i = 30; i < candles.length - 1; i++) {
    if (inTrade) {
      const bar = candles[i], isLong = inTrade.dir==='LONG';
      let exit = null, reason = null;

      if (isLong) {
        if      (bar.open <= inTrade.sl) { exit=bar.open;   reason='SL'; }
        else if (bar.open >= inTrade.tp) { exit=bar.open;   reason='TP'; }
        else if (bar.low  <= inTrade.sl) { exit=inTrade.sl; reason='SL'; }
        else if (bar.high >= inTrade.tp) { exit=inTrade.tp; reason='TP'; }
      } else {
        if      (bar.open >= inTrade.sl) { exit=bar.open;   reason='SL'; }
        else if (bar.open <= inTrade.tp) { exit=bar.open;   reason='TP'; }
        else if (bar.high >= inTrade.sl) { exit=inTrade.sl; reason='SL'; }
        else if (bar.low  <= inTrade.tp) { exit=inTrade.tp; reason='TP'; }
      }

      if (exit !== null) {
        const pnlPct = isLong
          ? (exit - inTrade.entry) / inTrade.entry * 100
          : (inTrade.entry - exit) / inTrade.entry * 100;
        const pnlUSD = pnlPct / 100 * TRADE_SIZE;
        balance += TRADE_SIZE + pnlUSD;
        trades++;
        if (pnlUSD > 0) wins++;
        totalPnl += pnlUSD;
        inTrade = null;
      }
    }

    if (!inTrade) {
      const sig = getSignal(i, pre);
      if (sig && balance >= TRADE_SIZE) {
        const entry = candles[i+1].open, isLong = sig.dir==='LONG';
        balance -= TRADE_SIZE;
        inTrade = {
          dir: sig.dir, entry,
          sl: isLong ? entry*(1-SL_PCT) : entry*(1+SL_PCT),
          tp: isLong ? entry*(1+TP_PCT) : entry*(1-TP_PCT),
        };
      }
    }
  }

  // Close open trade at last bar
  if (inTrade) {
    const last = candles[candles.length-1], isLong = inTrade.dir==='LONG';
    const pnlPct = isLong
      ? (last.close - inTrade.entry) / inTrade.entry * 100
      : (inTrade.entry - last.close) / inTrade.entry * 100;
    const pnlUSD = pnlPct / 100 * TRADE_SIZE;
    balance += TRADE_SIZE + pnlUSD;
    trades++; if (pnlUSD>0) wins++; totalPnl += pnlUSD;
  }

  return { trades, wins, totalPnl: parseFloat(totalPnl.toFixed(2)),
           winRate: trades ? (wins/trades*100).toFixed(1) : '0' };
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n' + '═'.repeat(95));
  console.log('  SL/TP OPTIMISER — 1000 x 1H Candles × 50 Coins');
  console.log('  Signals: ST Bullish Flip · BB Recovery · ST+MACD+RSI Short  |  BB Breakdown: OFF');
  console.log('═'.repeat(95) + '\n');

  // 1. Fetch all candles once
  const allPre = [];
  for (const symbol of COINS) {
    process.stdout.write(`  Fetching ${symbol}...`);
    try {
      const candles = await fetchCandles(symbol, 1000);
      allPre.push(precompute(candles));
      process.stdout.write(` ✓\n`);
    } catch(e) {
      process.stdout.write(` ❌ ${e.message}\n`);
    }
  }

  // 2. Run all configs against cached data
  console.log('\n' + '─'.repeat(95));
  console.log(
    'Config'.padEnd(38) + 'Trades'.padEnd(8) + 'Win%'.padEnd(8) +
    'Total P&L'.padEnd(14) + 'Avg/coin'.padEnd(12) + 'Verdict'
  );
  console.log('─'.repeat(95));

  const results = [];

  for (const cfg of CONFIGS) {
    let totalTrades=0, totalWins=0, totalPnl=0;
    for (const pre of allPre) {
      const r = runBacktest(pre, cfg.sl, cfg.tp);
      totalTrades += r.trades;
      totalWins   += r.wins;
      totalPnl    += r.totalPnl;
    }
    const wr      = totalTrades ? (totalWins/totalTrades*100).toFixed(1) : '0';
    const pnlStr  = `${totalPnl>=0?'+':''}$${totalPnl.toFixed(2)}`;
    const avg     = `${(totalPnl/allPre.length)>=0?'+':''}$${(totalPnl/allPre.length).toFixed(2)}`;
    const verdict = totalPnl > 0 ? '✅ PROFIT' : '❌ LOSS';
    results.push({ cfg, totalTrades, wr, totalPnl, avg: totalPnl/allPre.length, verdict });

    const isCurrent = cfg.label.includes('current');
    const prefix    = isCurrent ? '► ' : '  ';
    console.log(
      (prefix + cfg.label).padEnd(38) +
      String(totalTrades).padEnd(8) +
      `${wr}%`.padEnd(8) +
      pnlStr.padEnd(14) +
      avg.padEnd(12) +
      verdict
    );
  }

  // 3. Best config
  const best = results.sort((a,b) => b.totalPnl - a.totalPnl)[0];
  console.log('─'.repeat(95));
  console.log(`\n  🏆 BEST CONFIG: ${best.cfg.label}`);
  console.log(`     Total P&L: ${best.totalPnl>=0?'+':''}$${best.totalPnl.toFixed(2)} across ${allPre.length} coins`);
  console.log(`     Win rate : ${best.wr}%  |  Trades: ${best.totalTrades}`);
  console.log('\n' + '═'.repeat(95) + '\n');
})().catch(console.error);
