/**
 * Crypto Strategy Comparison — 50 Pairs · 4H · 200 Days
 *
 * 3 strategies tested simultaneously, same data, same SL/TP:
 *
 * Strategy A — EMA Trend Ride
 *   LONG:  price > EMA200 + EMA9 crosses above EMA21 + MACD bullish + RSI 45-72 + vol > avg
 *   SHORT: price < EMA200 + EMA9 crosses below EMA21 + MACD bearish + RSI 28-55 + vol > avg
 *
 * Strategy B — RSI Momentum in Trend
 *   LONG:  price > EMA200, EMA50 > EMA200, RSI crosses above 55, MACD > 0
 *   SHORT: price < EMA200, EMA50 < EMA200, RSI crosses below 45, MACD < 0
 *
 * Strategy C — EMA50 Pullback Bounce
 *   LONG:  price > EMA200, price bounces up through EMA50, MACD bullish, RSI 40-68
 *   SHORT: price < EMA200, price bounces down through EMA50, MACD bearish, RSI 32-60
 *
 * SL: 4%  TP: 12%  (3:1 R:R — need >25% win rate to profit)
 * $50/trade · $10,000 start · Cap 30
 */

import https from 'https';

const CRYPTO = [
  'BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT',
  'DOGEUSDT','LINKUSDT','SUIUSDT','LTCUSDT','AVAXUSDT','HBARUSDT',
  'ADAUSDT','TRXUSDT','TONUSDT','SHIBUSDT','DOTUSDT','BCHUSDT',
  'UNIUSDT','NEARUSDT','APTUSDT','ICPUSDT','ETCUSDT','POLUSDT',
  'VETUSDT','ATOMUSDT','OPUSDT','ARBUSDT','FILUSDT','ALGOUSDT',
  'INJUSDT','BONKUSDT','GRTUSDT','PEPEUSDT','WLDUSDT','AAVEUSDT',
  'TAOUSDT','RENDERUSDT','FETUSDT','STXUSDT','CRVUSDT','THETAUSDT',
  'JASMYUSDT','ONDOUSDT','RUNEUSDT','SANDUSDT','MANAUSDT','ENAUSDT',
  'LDOUSDT','SEIUSDT','TIAUSDT',
];

const START_BAL  = 10000;
const TRADE_SIZE = 50;
const SL_PCT     = 0.04;   // 4%
const TP_PCT     = 0.12;   // 12% — 3:1 R:R
const DAYS       = 200;
const CAP        = 30;
const INTERVAL   = '4h';
const DELAY_MS   = 80;

// ─── Fetch ────────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchCrypto(symbol) {
  const endTime   = Date.now();
  const startTime = endTime - DAYS * 24 * 60 * 60 * 1000;
  const allBars   = [];
  let from = startTime;
  while (from < endTime) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&startTime=${from}&endTime=${endTime}&limit=1000`;
    const page = await new Promise((resolve, reject) => {
      https.get(url, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      }).on('error', reject);
    });
    if (!Array.isArray(page) || !page.length) break;
    allBars.push(...page);
    from = page[page.length - 1][0] + 1;
    if (page.length < 1000) break;
    await delay(DELAY_MS);
  }
  return allBars.map(k => ({
    time: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
    low:  parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function ema(v, p) {
  const k = 2/(p+1), r = [v[0]];
  for (let i = 1; i < v.length; i++) r.push(v[i]*k + r[i-1]*(1-k));
  return r;
}

function rsi(closes, p = 14) {
  const r = new Array(closes.length).fill(null);
  for (let i = p; i < closes.length; i++) {
    let g = 0, l = 0;
    for (let j = i-p+1; j <= i; j++) { const d = closes[j]-closes[j-1]; d>0?g+=d:l-=d; }
    r[i] = l===0 ? 100 : 100 - 100/(1 + (g/p)/(l/p));
  }
  return r;
}

function macd(closes, f=12, s=26, sig=9) {
  const fast = ema(closes,f), slow = ema(closes,s);
  const ml   = closes.map((_,i) => fast[i]-slow[i]);
  const sl   = [ml[0]]; const k = 2/(sig+1);
  for (let i = 1; i < closes.length; i++) sl.push(ml[i]*k + sl[i-1]*(1-k));
  return { line: ml, signal: sl, hist: ml.map((v,i) => v - sl[i]) };
}

function volSMA(candles, p = 20) {
  return candles.map((_,i) => {
    if (i < p-1) return null;
    return candles.slice(i-p+1, i+1).reduce((s,c) => s+c.volume, 0) / p;
  });
}

function atr(candles, p = 14) {
  const trs = candles.map((c,i) => i===0 ? c.high-c.low :
    Math.max(c.high-c.low, Math.abs(c.high-candles[i-1].close), Math.abs(c.low-candles[i-1].close)));
  const r = new Array(candles.length).fill(null);
  r[p-1] = trs.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for (let i = p; i < candles.length; i++) r[i] = (r[i-1]*(p-1)+trs[i])/p;
  return r;
}

// ─── Signals ─────────────────────────────────────────────────────────────────

// A: EMA9/21 crossover in 200EMA regime, MACD confirm, RSI filter, volume
function sigA(i, d) {
  const { candles, e9, e21, e200, mc, rsi14, vsma } = d;
  if (i < 2 || rsi14[i]==null || e200[i]==null || vsma[i]==null) return null;
  const c       = candles[i].close;
  const xUp     = e9[i-1] <= e21[i-1] && e9[i] > e21[i];   // EMA9 crosses above EMA21
  const xDown   = e9[i-1] >= e21[i-1] && e9[i] < e21[i];   // EMA9 crosses below EMA21
  const mBull   = mc.line[i] > mc.signal[i];
  const mBear   = mc.line[i] < mc.signal[i];
  const volOk   = candles[i].volume > vsma[i];
  if (c > e200[i] && xUp   && mBull && rsi14[i]>=45 && rsi14[i]<=72 && volOk)
    return { direction:'LONG',  source:'A: EMA Cross' };
  if (c < e200[i] && xDown && mBear && rsi14[i]>=28 && rsi14[i]<=55 && volOk)
    return { direction:'SHORT', source:'A: EMA Cross' };
  return null;
}

// B: RSI crosses 55/45 in aligned EMA trend, MACD side confirms
function sigB(i, d) {
  const { candles, e50, e200, mc, rsi14 } = d;
  if (i < 2 || rsi14[i]==null || e200[i]==null || e50[i]==null) return null;
  const c         = candles[i].close;
  const bullRegime = c > e200[i] && e50[i] > e200[i];
  const bearRegime = c < e200[i] && e50[i] < e200[i];
  const rsiCUp    = rsi14[i-1] < 55 && rsi14[i] >= 55;
  const rsiCDown  = rsi14[i-1] > 45 && rsi14[i] <= 45;
  if (bullRegime && rsiCUp   && mc.line[i] > 0)
    return { direction:'LONG',  source:'B: RSI Momentum' };
  if (bearRegime && rsiCDown && mc.line[i] < 0)
    return { direction:'SHORT', source:'B: RSI Momentum' };
  return null;
}

// C: Price bounces through EMA50 in 200EMA regime, MACD + RSI confirm
function sigC(i, d) {
  const { candles, e21, e50, e200, mc, rsi14 } = d;
  if (i < 2 || rsi14[i]==null || e200[i]==null || e50[i]==null) return null;
  const c  = candles[i].close,   cP = candles[i-1].close;
  const e5 = e50[i],             e5P = e50[i-1];
  const mBull = mc.line[i] > mc.signal[i];
  const mBear = mc.line[i] < mc.signal[i];
  // Bounce up: was below EMA50, now above, and above EMA21
  const bUp   = cP < e5P && c > e5 && c > e21[i];
  // Bounce down: was above EMA50, now below, and below EMA21
  const bDown = cP > e5P && c < e5 && c < e21[i];
  if (c > e200[i] && bUp   && mBull && rsi14[i]>=40 && rsi14[i]<=68)
    return { direction:'LONG',  source:'C: EMA50 Bounce' };
  if (c < e200[i] && bDown && mBear && rsi14[i]>=32 && rsi14[i]<=60)
    return { direction:'SHORT', source:'C: EMA50 Bounce' };
  return null;
}

// ─── Simulation ───────────────────────────────────────────────────────────────

function mkSim(label) {
  return { label, balance:START_BAL, peak:START_BAL, minBal:START_BAL,
           maxDD:0, openPositions:{}, trades:[], snaps:[], _month:null };
}

function enter(sim, symbol, direction, entryPrice, signal, time) {
  if (sim.openPositions[symbol]) return;
  if (Object.keys(sim.openPositions).length >= CAP) return;
  if (sim.balance < TRADE_SIZE) return;
  const isLong = direction === 'LONG';
  sim.balance -= TRADE_SIZE;
  sim.openPositions[symbol] = {
    symbol, direction, entryPrice, size:TRADE_SIZE, signal, time,
    sl: isLong ? entryPrice*(1-SL_PCT) : entryPrice*(1+SL_PCT),
    tp: isLong ? entryPrice*(1+TP_PCT) : entryPrice*(1-TP_PCT),
  };
}

function tick(sim, symbol, bar) {
  const pos = sim.openPositions[symbol]; if (!pos) return;
  const isLong = pos.direction === 'LONG';
  let exitPrice = null, exitReason = null;
  if (isLong) {
    if      (bar.open <= pos.sl) { exitPrice=bar.open; exitReason='SL'; }
    else if (bar.open >= pos.tp) { exitPrice=bar.open; exitReason='TP'; }
    else if (bar.low  <= pos.sl) { exitPrice=pos.sl;   exitReason='SL'; }
    else if (bar.high >= pos.tp) { exitPrice=pos.tp;   exitReason='TP'; }
  } else {
    if      (bar.open >= pos.sl) { exitPrice=bar.open; exitReason='SL'; }
    else if (bar.open <= pos.tp) { exitPrice=bar.open; exitReason='TP'; }
    else if (bar.high >= pos.sl) { exitPrice=pos.sl;   exitReason='SL'; }
    else if (bar.low  <= pos.tp) { exitPrice=pos.tp;   exitReason='TP'; }
  }
  if (exitPrice !== null) {
    const pnlPct = isLong
      ? (exitPrice-pos.entryPrice)/pos.entryPrice
      : (pos.entryPrice-exitPrice)/pos.entryPrice;
    const pnlUSD = pnlPct * pos.size;
    sim.balance += pos.size + pnlUSD;
    if (sim.balance > sim.peak)   sim.peak   = sim.balance;
    if (sim.balance < sim.minBal) sim.minBal = sim.balance;
    const dd = (sim.peak - sim.balance) / sim.peak * 100;
    if (dd > sim.maxDD) sim.maxDD = dd;
    sim.trades.push({...pos, exitPrice, exitReason, pnlPct:pnlPct*100, pnlUSD});
    delete sim.openPositions[symbol];
  }
}

function closeAll(sim, allData) {
  for (const sym of Object.keys(sim.openPositions)) {
    const pos  = sim.openPositions[sym];
    const last = allData[sym].candles.at(-1);
    const isLong = pos.direction === 'LONG';
    const pnlPct = isLong
      ? (last.close-pos.entryPrice)/pos.entryPrice
      : (pos.entryPrice-last.close)/pos.entryPrice;
    const pnlUSD = pnlPct * pos.size;
    sim.balance += pos.size + pnlUSD;
    sim.trades.push({...pos, exitPrice:last.close, exitReason:'EOD', pnlPct:pnlPct*100, pnlUSD});
    delete sim.openPositions[sym];
  }
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function stats(sim) {
  const trades = sim.trades;
  const wins   = trades.filter(t => t.pnlUSD > 0);
  const losses = trades.filter(t => t.pnlUSD <= 0);
  const pnl    = trades.reduce((s,t) => s+t.pnlUSD, 0);
  const gWin   = wins.reduce((s,t) => s+t.pnlUSD, 0);
  const gLoss  = Math.abs(losses.reduce((s,t) => s+t.pnlUSD, 0));
  const wr     = trades.length ? (wins.length/trades.length*100).toFixed(1) : '0.0';
  const pf     = gLoss > 0 ? (gWin/gLoss).toFixed(2) : gWin > 0 ? '∞' : '0.00';
  const ret    = ((sim.balance - START_BAL) / START_BAL * 100).toFixed(2);
  const ann    = (parseFloat(ret) / DAYS * 365).toFixed(1);
  const expect = trades.length
    ? ((wins.length/trades.length * TP_PCT*100) - (losses.length/trades.length * SL_PCT*100)).toFixed(2)
    : '0.00';

  const bySignal = {};
  const bySym    = {};
  for (const t of trades) {
    if (!bySignal[t.signal]) bySignal[t.signal] = {n:0,w:0,pnl:0};
    bySignal[t.signal].n++; if(t.pnlUSD>0) bySignal[t.signal].w++;
    bySignal[t.signal].pnl += t.pnlUSD;
    if (!bySym[t.symbol]) bySym[t.symbol] = {n:0,w:0,pnl:0};
    bySym[t.symbol].n++; if(t.pnlUSD>0) bySym[t.symbol].w++;
    bySym[t.symbol].pnl += t.pnlUSD;
  }
  const sorted = Object.entries(bySym).sort((a,b) => b[1].pnl - a[1].pnl);

  const longT  = trades.filter(t => t.direction === 'LONG');
  const shortT = trades.filter(t => t.direction === 'SHORT');
  const lPnl   = longT.reduce((s,t) => s+t.pnlUSD, 0);
  const sPnl   = shortT.reduce((s,t) => s+t.pnlUSD, 0);
  const lWr    = longT.length  ? (longT.filter(t=>t.pnlUSD>0).length/longT.length*100).toFixed(1)   : 'N/A';
  const sWr    = shortT.length ? (shortT.filter(t=>t.pnlUSD>0).length/shortT.length*100).toFixed(1) : 'N/A';

  return { trades, wins, losses, pnl, wr, pf, ret, ann, expect,
           bySignal, sorted, longT, shortT, lPnl, sPnl, lWr, sWr };
}

// ─── Print helpers ────────────────────────────────────────────────────────────

const W = 90;
const bar  = () => console.log('═'.repeat(W));
const dash = () => console.log('─'.repeat(W));
const row  = (l, v) => console.log(`  ${String(l).padEnd(28)}${v}`);

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  bar();
  console.log(`  CRYPTO STRATEGY COMPARISON  |  4H  |  ${DAYS} days  |  $${START_BAL.toLocaleString()} start  |  Cap ${CAP}`);
  console.log(`  SL ${SL_PCT*100}%  |  TP ${TP_PCT*100}%  |  3:1 R:R  |  Long + Short`);
  bar();

  // ── Fetch & build indicators ─────────────────────────────────────────────
  console.log('\n  Fetching 50 crypto pairs (4H, 200 days)...\n');
  const allData = {};

  for (const symbol of CRYPTO) {
    process.stdout.write(`  ${symbol.padEnd(14)}...`);
    try {
      const candles = await fetchCrypto(symbol);
      if (candles.length < 210) { console.log(` only ${candles.length} bars — skip`); continue; }
      const closes = candles.map(c => c.close);
      const mc     = macd(closes);
      allData[symbol] = {
        candles,
        e9:   ema(closes, 9),
        e21:  ema(closes, 21),
        e50:  ema(closes, 50),
        e200: ema(closes, 200),
        mc,
        rsi14: rsi(closes, 14),
        vsma:  volSMA(candles, 20),
        atr14: atr(candles, 14),
      };
      console.log(` ${candles.length} bars ✓`);
    } catch(e) { console.log(` ❌ ${e.message}`); }
  }

  const total = Object.keys(allData).length;
  console.log(`\n  Loaded ${total}/50 pairs.\n`);

  // ── Timeline ─────────────────────────────────────────────────────────────
  const timeSet = new Set();
  for (const d of Object.values(allData)) d.candles.forEach(c => timeSet.add(c.time));
  const timeline = [...timeSet].sort((a,b) => a-b);
  for (const d of Object.values(allData)) {
    d.idx = {};
    d.candles.forEach((c,i) => { d.idx[c.time] = i; });
  }

  // ── Run 3 sims ───────────────────────────────────────────────────────────
  console.log(`  Running 3 strategies across ${timeline.length.toLocaleString()} bars...\n`);
  const sims = ['A: EMA Cross', 'B: RSI Momentum', 'C: EMA50 Bounce'].map(mkSim);
  const sigFns = [sigA, sigB, sigC];

  for (const t of timeline) {
    const mo = new Date(t).toISOString().slice(0,7);
    for (const sim of sims) {
      if (sim._month !== mo) {
        sim._month = mo;
        sim.snaps.push({ date:mo, balance:sim.balance,
          open: Object.keys(sim.openPositions).length, trades: sim.trades.length });
      }
    }
    for (const [symbol, d] of Object.entries(allData)) {
      const i = d.idx[t];
      if (i == null || i < 205) continue;       // need 200 bars for EMA200 warmup
      for (let si = 0; si < 3; si++) {
        tick(sims[si], symbol, d.candles[i]);
        const sig = sigFns[si](i-1, d);
        if (sig && i+1 < d.candles.length) enter(sims[si], symbol, sig.direction, d.candles[i].open, sig.source, t);
      }
    }
  }
  for (const sim of sims) closeAll(sim, allData);

  // ── Comparison table ─────────────────────────────────────────────────────
  const st = sims.map(s => stats(s));

  console.log('\n'); bar();
  console.log('  COMPARISON SUMMARY');
  bar();
  console.log(`\n  ${'Metric'.padEnd(26)}${'A: EMA Cross'.padEnd(24)}${'B: RSI Momentum'.padEnd(24)}C: EMA50 Bounce`);
  dash();

  const rows = [
    ['Final balance',      (s,i) => `$${sims[i].balance.toFixed(2)}`],
    ['Total P&L',          (s,i) => `${s.pnl>=0?'+':''}$${s.pnl.toFixed(2)}`],
    [`Return (${DAYS}d)`,  (s,i) => `${s.ret>=0?'+':''}${s.ret}%`],
    ['Ann. return',        (s,i) => `${s.ann>=0?'+':''}${s.ann}%`],
    ['Total trades',       (s,i) => s.trades.length],
    ['Win rate',           (s,i) => `${s.wr}%`],
    ['Profit factor',      (s,i) => s.pf],
    ['Expectancy/trade',   (s,i) => `${s.expect>=0?'+':''}${s.expect}%`],
    ['Max drawdown',       (s,i) => `${sims[i].maxDD.toFixed(2)}%`],
    ['Lowest balance',     (s,i) => `$${sims[i].minBal.toFixed(2)}`],
    ['Long trades/P&L',    (s,i) => `${s.longT.length} / ${s.lPnl>=0?'+':''}$${s.lPnl.toFixed(2)}`],
    ['Short trades/P&L',   (s,i) => `${s.shortT.length} / ${s.sPnl>=0?'+':''}$${s.sPnl.toFixed(2)}`],
    ['Long win%',          (s,i) => `${s.lWr}%`],
    ['Short win%',         (s,i) => `${s.sWr}%`],
  ];

  for (const [label, fn] of rows) {
    const cols = st.map((s,i) => String(fn(s,i)).padEnd(24));
    console.log(`  ${label.padEnd(26)}${cols.join('')}`);
  }

  // ── Per-strategy detail ───────────────────────────────────────────────────
  for (let si = 0; si < 3; si++) {
    const sim = sims[si]; const s = st[si];
    console.log('\n\n'); bar();
    console.log(`  ${sim.label.toUpperCase()}  |  Final: $${sim.balance.toFixed(2)}  |  P&L: ${s.pnl>=0?'+':''}$${s.pnl.toFixed(2)}  |  WR: ${s.wr}%  |  DD: ${sim.maxDD.toFixed(1)}%`);
    bar();

    // Signal breakdown
    console.log(`\n  ${'Signal'.padEnd(24)}${'Trades'.padEnd(8)}${'Win%'.padEnd(8)}P&L`);
    dash();
    for (const [sig,d] of Object.entries(s.bySignal).sort((a,b) => b[1].pnl-a[1].pnl)) {
      const w = d.n ? (d.w/d.n*100).toFixed(1) : '0.0';
      console.log(`  ${sig.padEnd(24)}${String(d.n).padEnd(8)}${`${w}%`.padEnd(8)}${d.pnl>=0?'+':''}$${d.pnl.toFixed(2)}  ${d.pnl>0?'✅':'❌'}`);
    }

    // Equity curve
    console.log(`\n  ${'Month'.padEnd(10)}${'Balance'.padEnd(14)}${'Open'.padEnd(8)}${'Trades'.padEnd(10)}vs Start`);
    dash();
    for (const sn of sim.snaps) {
      const diff = sn.balance - START_BAL;
      const arrow = diff >= 0 ? '📈' : '📉';
      console.log(`  ${sn.date.padEnd(10)}$${sn.balance.toFixed(2).padEnd(13)}${String(sn.open).padEnd(8)}${String(sn.trades).padEnd(10)}${diff>=0?'+':''}$${diff.toFixed(2)}  ${arrow}`);
    }
    dash();
    console.log(`  ${'FINAL'.padEnd(10)}$${sim.balance.toFixed(2).padEnd(13)}${'—'.padEnd(8)}${String(s.trades.length).padEnd(10)}${s.pnl>=0?'+':''}$${s.pnl.toFixed(2)}`);

    // Top 10 / Bottom 10
    console.log(`\n  TOP 10:`);
    s.sorted.slice(0,10).forEach(([sym,d],i) => {
      const w = d.n ? (d.w/d.n*100).toFixed(0) : '0';
      console.log(`    #${String(i+1).padEnd(3)}${sym.padEnd(14)}${String(d.n).padEnd(4)}t  ${String(w).padEnd(5)}% win  ${d.pnl>=0?'+':''}$${d.pnl.toFixed(2)}`);
    });
    console.log(`\n  BOTTOM 10:`);
    s.sorted.slice(-10).reverse().forEach(([sym,d],i) => {
      const w = d.n ? (d.w/d.n*100).toFixed(0) : '0';
      console.log(`    #${String(i+1).padEnd(3)}${sym.padEnd(14)}${String(d.n).padEnd(4)}t  ${String(w).padEnd(5)}% win  ${d.pnl>=0?'+':''}$${d.pnl.toFixed(2)}`);
    });
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  const best   = st.reduce((a,b,i) => parseFloat(a.ret) >= parseFloat(b.ret) ? a : b);
  const bestI  = st.indexOf(best);
  const bestWR = st.reduce((a,b) => parseFloat(a.wr) >= parseFloat(b.wr) ? a : b);
  const wrI    = st.indexOf(bestWR);
  console.log('\n\n'); bar();
  console.log('  VERDICT');
  bar();
  console.log(`\n  Best return      : ${sims[bestI].label}  →  ${best.ret>=0?'+':''}${best.ret}%  (${best.ann>=0?'+':''}${best.ann}% ann.)`);
  console.log(`  Best win rate    : ${sims[wrI].label}  →  ${bestWR.wr}% win rate`);
  console.log(`  Best pf          : ${sims[st.indexOf(st.reduce((a,b) => parseFloat(a.pf)>=parseFloat(b.pf)?a:b))].label}  →  ${st.reduce((a,b) => parseFloat(a.pf)>=parseFloat(b.pf)?a:b).pf}`);
  console.log(`\n  Note: Need >25% win rate for profit at 3:1 R:R.`);
  console.log(`        Need >33% win rate to beat fixed 2:1 R:R alternative.`);
  console.log('\n'); bar();

})().catch(console.error);
