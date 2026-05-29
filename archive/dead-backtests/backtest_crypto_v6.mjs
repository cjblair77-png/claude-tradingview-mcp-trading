/**
 * CRYPTO v6 — Regime-Adaptive Bidirectional Momentum Strategy
 *
 * Core idea: each coin self-assesses its own market regime every bar.
 * Entry requirements scale with regime so the strategy automatically:
 *   • Bears down on shorts when market is bearish (easy entry)
 *   • Leans into longs when market turns bullish (easy entry)
 *   • Requires strong confirmation to trade AGAINST the current regime
 *
 * ── REGIME DETECTION (per coin, per bar) ──────────────────────────────
 *   Score 5 conditions (+1 bull / -1 bear each):
 *     1. Close > EMA200
 *     2. Close > EMA50
 *     3. Close > EMA21
 *     4. EMA21 > EMA50
 *     5. EMA50 > EMA200
 *   BULL   : score ≥ +4  (4-5 bullish conditions met)
 *   BEAR   : score ≤ -4  (4-5 bearish conditions met)
 *   NEUTRAL: everything else (transitioning / ranging)
 *
 * ── LONG SIGNAL (regime-adaptive) ────────────────────────────────────
 *   Base requirements (all regimes):
 *     • RSI was ≤35 (oversold) within last 5 bars
 *     • RSI crosses above 42  OR  MACD hist flips positive
 *     • RSI now < 65 (don't chase)
 *     • Volume > 1.2× SMA20
 *   Regime-specific price gate:
 *     BULL   → close > EMA21   (easy — just above short-term trend)
 *     NEUTRAL→ close > EMA50   (medium bar — above medium-term trend)
 *     BEAR   → close > EMA200 AND EMA50 > EMA200×0.99  (very high bar)
 *
 * ── SHORT SIGNAL (regime-adaptive) ───────────────────────────────────
 *   Base requirements (all regimes):
 *     • RSI was ≥65 (overbought) within last 5 bars
 *     • RSI crosses below 58  OR  MACD hist flips negative
 *     • RSI now > 35 (don't chase)
 *     • Volume > 1.2× SMA20
 *   Regime-specific price gate:
 *     BEAR   → close < EMA21   (easy — just below short-term trend)
 *     NEUTRAL→ close < EMA50   (medium bar)
 *     BULL   → close < EMA200 AND EMA50 < EMA200×1.01  (very high bar)
 *
 * ── POSITION SIZING ───────────────────────────────────────────────────
 *   Risk per trade: 1% of INITIAL capital ($100)
 *   Position size: $100 ÷ SL% = ~$1,429
 *   Balance guard: skip trade if balance < 2× risk ($200)
 *
 * SL 7% / TP 21% (3:1 R:R) — symmetric both directions
 */

import https from 'https';

const PAIRS = [
  'BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT','DOGEUSDT','LINKUSDT',
  'SUIUSDT','LTCUSDT','AVAXUSDT','HBARUSDT','ADAUSDT','TRXUSDT','TONUSDT',
  'SHIBUSDT','DOTUSDT','BCHUSDT','UNIUSDT','NEARUSDT','APTUSDT','ICPUSDT',
  'ETCUSDT','POLUSDT','VETUSDT','ATOMUSDT','OPUSDT','ARBUSDT','FILUSDT',
  'ALGOUSDT','INJUSDT','BONKUSDT','GRTUSDT','PEPEUSDT','WLDUSDT','AAVEUSDT',
  'TAOUSDT','RENDERUSDT','FETUSDT','STXUSDT','CRVUSDT','THETAUSDT','JASMYUSDT',
  'ONDOUSDT','RUNEUSDT','SANDUSDT','MANAUSDT','ENAUSDT','LDOUSDT','SEIUSDT','TIAUSDT',
];

const DAYS     = 200;
const INTERVAL = '4h';
const CAPITAL  = 10_000;
const CAP      = 30;
const SL_PCT   = 0.07;
const TP_PCT   = 0.21;
const RISK_PER = CAPITAL * 0.01;  // $100 risked per trade

// v5 reference for comparison
const V5 = { shortRet: '+86.2', shortWR: '35.5', comboRet: '-12.0', comboWR: '26.3' };

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ── Fetch ──────────────────────────────────────────────────────────────── */
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
    await delay(80);
  }
  return allBars.map(k => ({
    time: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

/* ── Indicators ─────────────────────────────────────────────────────────── */
function ema(v, p) {
  const k = 2/(p+1), r = [v[0]];
  for (let i = 1; i < v.length; i++) r.push(v[i]*k + r[i-1]*(1-k));
  return r;
}
function sma(v, p) {
  return v.map((_, i) => i < p-1 ? null : v.slice(i-p+1,i+1).reduce((a,b)=>a+b,0)/p);
}
function rsi(closes, p=14) {
  const r = new Array(closes.length).fill(null);
  for (let i = p; i < closes.length; i++) {
    let g=0, l=0;
    for (let j=i-p+1; j<=i; j++) { const d=closes[j]-closes[j-1]; d>0?g+=d:l-=d; }
    r[i] = l===0 ? 100 : 100 - 100/(1+(g/p)/(l/p));
  }
  return r;
}
function macdCalc(closes, f=12, s=26, sig=9) {
  const fast=ema(closes,f), slow=ema(closes,s);
  const ml=closes.map((_,i)=>fast[i]-slow[i]);
  const sl=[ml[0]]; const k=2/(sig+1);
  for (let i=1; i<closes.length; i++) sl.push(ml[i]*k+sl[i-1]*(1-k));
  return { line:ml, signal:sl, hist: ml.map((v,i)=>v-sl[i]) };
}

/* ── Regime ─────────────────────────────────────────────────────────────── */
function getRegime(i, closes, e21, e50, e200) {
  if (e200[i] == null || e50[i] == null || e21[i] == null) return 'neutral';
  const c = closes[i];
  let score = 0;
  if (c     > e200[i]) score++; else score--;
  if (c     > e50[i])  score++; else score--;
  if (c     > e21[i])  score++; else score--;
  if (e21[i] > e50[i]) score++; else score--;
  if (e50[i] > e200[i])score++; else score--;
  if (score >= 4) return 'bull';
  if (score <= -4) return 'bear';
  return 'neutral';
}

/* ── Signals ─────────────────────────────────────────────────────────────── */
function getSignals(i, d) {
  const { candles, closes, e21, e50, e200, rsi14, mc, vsma } = d;
  if (i < 6) return { long: false, short: false, regime: 'neutral' };

  const c      = candles[i].close;
  const vol    = candles[i].volume;
  const rNow   = rsi14[i];
  const rPrv   = rsi14[i-1];
  if (rNow == null || rPrv == null || vsma[i] == null) return { long: false, short: false, regime: 'neutral' };

  const regime = getRegime(i, closes, e21, e50, e200);
  const volOk  = vol > vsma[i] * 1.2;

  // Momentum shift triggers (same for both directions)
  const wasOversold   = [1,2,3,4,5].some(k => rsi14[i-k] != null && rsi14[i-k] <= 35);
  const wasOverbought = [1,2,3,4,5].some(k => rsi14[i-k] != null && rsi14[i-k] >= 65);
  const rsiBounce     = rPrv <= 42 && rNow > 42;
  const rsiBreak      = rPrv >= 58 && rNow < 58;
  const macdTurnBull  = mc.hist[i-1] <= 0 && mc.hist[i] > 0;
  const macdTurnBear  = mc.hist[i-1] >= 0 && mc.hist[i] < 0;

  // Base long conditions
  const longBase = wasOversold && (rsiBounce || macdTurnBull) && rNow < 65 && volOk;

  // Base short conditions
  const shortBase = wasOverbought && (rsiBreak || macdTurnBear) && rNow > 35 && volOk;

  // Regime-specific price gate
  let longGate = false, shortGate = false;
  if (regime === 'bull') {
    longGate  = c > e21[i];                                     // easy
    shortGate = c < e200[i] && e50[i] < e200[i] * 1.01;        // very hard — strong breakdown only
  } else if (regime === 'neutral') {
    longGate  = c > e50[i];                                     // medium
    shortGate = c < e50[i];                                     // medium (symmetric)
  } else { // bear
    longGate  = c > e200[i] && e50[i] > e200[i] * 0.99;        // very hard — strong recovery only
    shortGate = c < e21[i];                                     // easy
  }

  return {
    long:   longBase  && longGate,
    short:  shortBase && shortGate,
    regime,
  };
}

/* ── Simulation ─────────────────────────────────────────────────────────── */
function runSim(allData) {
  let balance = CAPITAL;
  const open  = new Map();
  const trades = [];
  const bySymbol = {};
  PAIRS.forEach(s => { bySymbol[s] = { trades:0, wins:0, pnl:0, longs:0, shorts:0 }; });

  // Regime counters for analytics
  const regimeCounts = { bull: 0, neutral: 0, bear: 0 };
  const regimeTrades = {
    bull:    { long: { t:0, w:0 }, short: { t:0, w:0 } },
    neutral: { long: { t:0, w:0 }, short: { t:0, w:0 } },
    bear:    { long: { t:0, w:0 }, short: { t:0, w:0 } },
  };

  const timeline = [];
  for (const d of allData)
    for (let i = 0; i < d.candles.length; i++)
      timeline.push({ sym: d.symbol, i, time: d.candles[i].time });
  timeline.sort((a, b) => a.time - b.time || a.sym.localeCompare(b.sym));

  const monthStats = {};

  for (const { sym, i, time } of timeline) {
    const d   = allData.find(x => x.symbol === sym);
    const bar = d.candles[i];
    const ym  = new Date(time).toISOString().slice(0, 7);
    if (!monthStats[ym]) monthStats[ym] = { start: balance, trades: 0 };

    // ── Exit check ────────────────────────────────────────────────────
    if (open.has(sym)) {
      const pos = open.get(sym);
      const { direction, entry, sl, tp, size, regime: entryRegime } = pos;
      let closed = false, won = false, pnlDollar = 0;

      if (direction === 'LONG') {
        if      (bar.open <= sl) { pnlDollar = -size * SL_PCT; closed = true; }
        else if (bar.open >= tp) { pnlDollar =  size * TP_PCT; closed = true; won = true; }
        else if (bar.low  <= sl) { pnlDollar = -size * SL_PCT; closed = true; }
        else if (bar.high >= tp) { pnlDollar =  size * TP_PCT; closed = true; won = true; }
      } else {
        if      (bar.open >= sl) { pnlDollar = -size * SL_PCT; closed = true; }
        else if (bar.open <= tp) { pnlDollar =  size * TP_PCT; closed = true; won = true; }
        else if (bar.high >= sl) { pnlDollar = -size * SL_PCT; closed = true; }
        else if (bar.low  <= tp) { pnlDollar =  size * TP_PCT; closed = true; won = true; }
      }

      if (closed) {
        balance += pnlDollar;
        trades.push({ sym, direction, won, pnl: pnlDollar, regime: entryRegime });
        bySymbol[sym].trades++;
        bySymbol[sym].wins += won ? 1 : 0;
        bySymbol[sym].pnl  += pnlDollar;
        direction === 'LONG' ? bySymbol[sym].longs++ : bySymbol[sym].shorts++;
        monthStats[ym].trades++;
        regimeTrades[entryRegime][direction === 'LONG' ? 'long' : 'short'].t++;
        regimeTrades[entryRegime][direction === 'LONG' ? 'long' : 'short'].w += won ? 1 : 0;
        open.delete(sym);
      }
    }

    // ── Entry check ───────────────────────────────────────────────────
    if (!open.has(sym) && open.size < CAP && i > 0 && balance > RISK_PER * 2) {
      const { long, short, regime } = getSignals(i, d);
      regimeCounts[regime]++;

      let direction = null;
      // If both fire simultaneously — only take the one aligned with regime
      if (long && short) {
        if (regime === 'bull') direction = 'LONG';
        else if (regime === 'bear') direction = 'SHORT';
        // neutral + both: skip (conflicting)
      } else if (long)  direction = 'LONG';
      else if (short) direction = 'SHORT';

      if (direction) {
        const nextBar = d.candles[i + 1];
        if (!nextBar) continue;
        const entryPrice = nextBar.open;
        const size       = RISK_PER / SL_PCT;
        const sl = direction === 'LONG'
          ? entryPrice * (1 - SL_PCT)
          : entryPrice * (1 + SL_PCT);
        const tp = direction === 'LONG'
          ? entryPrice * (1 + TP_PCT)
          : entryPrice * (1 - TP_PCT);
        open.set(sym, { direction, entry: entryPrice, sl, tp, size, regime });
      }
    }
  }

  // Close remaining open positions at last bar
  for (const [sym, pos] of open) {
    const d = allData.find(x => x.symbol === sym);
    const lastBar = d.candles[d.candles.length - 1];
    const { direction, entry, size, regime: entryRegime } = pos;
    const pnlDollar = direction === 'LONG'
      ? (lastBar.close - entry) / entry * size
      : (entry - lastBar.close) / entry * size;
    balance += pnlDollar;
    trades.push({ sym, direction, won: pnlDollar > 0, pnl: pnlDollar, regime: entryRegime });
    bySymbol[sym].trades++;
    bySymbol[sym].wins += pnlDollar > 0 ? 1 : 0;
    bySymbol[sym].pnl  += pnlDollar;
  }

  // Aggregate stats
  const totalTrades = trades.length;
  const wins        = trades.filter(t => t.won).length;
  const grossWin    = trades.filter(t => t.pnl > 0).reduce((s,t) => s+t.pnl, 0);
  const grossLoss   = Math.abs(trades.filter(t => t.pnl < 0).reduce((s,t) => s+t.pnl, 0));
  const winRate     = totalTrades ? wins / totalTrades * 100 : 0;
  const pf          = grossLoss ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const pnl         = balance - CAPITAL;
  const retPct      = pnl / CAPITAL * 100;
  const annRet      = retPct / DAYS * 365;

  let peak = CAPITAL, maxDD = 0, runBal = CAPITAL;
  for (const t of trades) {
    runBal += t.pnl;
    if (runBal > peak) peak = runBal;
    const dd = (peak - runBal) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  const longTrades  = trades.filter(t => t.direction === 'LONG');
  const shortTrades = trades.filter(t => t.direction === 'SHORT');
  const longWR      = longTrades.length  ? longTrades.filter(t=>t.won).length/longTrades.length*100  : null;
  const shortWR     = shortTrades.length ? shortTrades.filter(t=>t.won).length/shortTrades.length*100 : null;
  const longPNL     = longTrades.reduce((s,t) => s+t.pnl, 0);
  const shortPNL    = shortTrades.reduce((s,t) => s+t.pnl, 0);

  const symList = Object.entries(bySymbol)
    .filter(([,v]) => v.trades > 0)
    .map(([sym, v]) => ({ sym, ...v, wr: v.trades ? v.wins/v.trades*100 : 0 }));

  const months = Object.entries(monthStats).sort(([a],[b]) => a.localeCompare(b));

  return {
    balance, pnl, retPct, annRet, totalTrades, wins, winRate, pf, maxDD,
    months, symList, longTrades, shortTrades, longWR, shortWR, longPNL, shortPNL,
    regimeCounts, regimeTrades,
  };
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */
const pct = (n, d=1) => (n>=0?'+':'')+n.toFixed(d)+'%';
const dollar = n => (n>=0?'+$':'-$')+Math.abs(n).toFixed(2);
const bar88 = '═'.repeat(88);

function printSim(r) {
  console.log(`\n${bar88}`);
  console.log(`  BIDIRECTIONAL REGIME-ADAPTIVE STRATEGY — v6`);
  console.log(`  $${r.balance.toFixed(2)}  |  P&L: ${dollar(r.pnl)}  |  WR: ${r.winRate.toFixed(1)}%  |  PF: ${r.pf.toFixed(2)}  |  DD: ${r.maxDD.toFixed(1)}%  |  Ann: ${pct(r.annRet)}`);
  console.log(bar88);

  const lwStr = r.longWR  != null ? r.longWR.toFixed(1)+'%'  : '-%';
  const swStr = r.shortWR != null ? r.shortWR.toFixed(1)+'%' : '-%';
  console.log(`  LONGS : ${r.longTrades.length}t  WR ${lwStr}  P&L ${dollar(r.longPNL)}`);
  console.log(`  SHORTS: ${r.shortTrades.length}t  WR ${swStr}  P&L ${dollar(r.shortPNL)}`);

  // Monthly
  console.log(`\n  ${'Month'.padEnd(12)}${'Balance'.padEnd(14)}${'Trades'.padEnd(10)}vs Start`);
  console.log(`${'─'.repeat(60)}`);
  for (const [ym, ms] of r.months) {
    const diff = ms.start - CAPITAL;
    const icon = ms.start >= CAPITAL ? '📈' : '📉';
    console.log(`  ${ym.padEnd(12)}$${ms.start.toFixed(2).padEnd(14)}${String(ms.trades).padEnd(10)}${dollar(diff).padEnd(18)}${icon}`);
  }
  console.log(`${'─'.repeat(60)}`);
  console.log(`  ${'FINAL'.padEnd(12)}$${r.balance.toFixed(2).padEnd(14)}${String(r.totalTrades).padEnd(10)}${dollar(r.pnl)}`);

  // Regime breakdown
  console.log(`\n  REGIME BREAKDOWN (how the strategy adapted):`);
  console.log(`  ${'Regime'.padEnd(10)}${'Signal bars'.padEnd(14)}${'Long trades'.padEnd(16)}${'Long WR'.padEnd(12)}${'Short trades'.padEnd(16)}${'Short WR'}`);
  console.log(`  ${'─'.repeat(78)}`);
  for (const regime of ['bull','neutral','bear']) {
    const rc = r.regimeCounts[regime];
    const lt = r.regimeTrades[regime].long;
    const st = r.regimeTrades[regime].short;
    const lwr = lt.t ? (lt.w/lt.t*100).toFixed(0)+'%' : '-';
    const swr = st.t ? (st.w/st.t*100).toFixed(0)+'%' : '-';
    const icon = regime==='bull'?'🟢':regime==='bear'?'🔴':'🟡';
    console.log(`  ${icon} ${regime.padEnd(8)}${String(rc).padEnd(14)}${String(lt.t+'t').padEnd(16)}${lwr.padEnd(12)}${String(st.t+'t').padEnd(16)}${swr}`);
  }

  // Top/bottom symbols
  const sorted = [...r.symList].sort((a,b) => b.pnl - a.pnl);
  console.log(`\n  TOP 10:`);
  sorted.slice(0,10).forEach((s,i) => {
    const dirTag = s.longs > s.shorts ? 'L' : s.shorts > s.longs ? 'S' : 'LS';
    console.log(`    #${i+1}  ${s.sym.padEnd(14)}${String(s.trades).padEnd(4)}t  ${String(s.wr.toFixed(0)).padEnd(5)}% win  ${dollar(s.pnl).padEnd(14)}[${dirTag}]`);
  });
  console.log(`\n  BOTTOM 10:`);
  sorted.slice(-10).reverse().forEach((s,i) => {
    const dirTag = s.longs > s.shorts ? 'L' : s.shorts > s.longs ? 'S' : 'LS';
    console.log(`    #${i+1}  ${s.sym.padEnd(14)}${String(s.trades).padEnd(4)}t  ${String(s.wr.toFixed(0)).padEnd(5)}% win  ${dollar(s.pnl).padEnd(14)}[${dirTag}]`);
  });
}

/* ── Main ───────────────────────────────────────────────────────────────── */
(async () => {
  console.log(`\n${bar88}`);
  console.log(`  CRYPTO v6  |  ${INTERVAL}  |  ${DAYS} days  |  $${CAPITAL.toLocaleString()}  |  Cap ${CAP}`);
  console.log(`  REGIME-ADAPTIVE BIDIRECTIONAL — Easy with trend, hard against trend`);
  console.log(`  SL ${SL_PCT*100}% / TP ${TP_PCT*100}%  (3:1 R:R)  |  Risk $${RISK_PER}/trade`);
  console.log(bar88);

  console.log(`\n  Fetching ${PAIRS.length} pairs (${INTERVAL})...\n`);

  const allData = [];
  for (const symbol of PAIRS) {
    const candles = await fetchCrypto(symbol);
    const closes  = candles.map(c => c.close);
    const vols    = candles.map(c => c.volume);
    const e21     = ema(closes, 21);
    const e50     = ema(closes, 50);
    const e200    = ema(closes, 200);
    const rsi14   = rsi(closes, 14);
    const mc      = macdCalc(closes);
    const vsma    = sma(vols, 20);
    allData.push({ symbol, candles, closes, e21, e50, e200, rsi14, mc, vsma });
    process.stdout.write(`  ${symbol.padEnd(14)}... ${candles.length} bars ✓\n`);
    await delay(50);
  }

  console.log('\n  Running simulation...\n');
  const r = runSim(allData);

  // ── Summary comparison table ───────────────────────────────────────────
  console.log(`\n${bar88}`);
  console.log(`  v5 → v6 IMPROVEMENT`);
  console.log(bar88);
  const col = 18;
  const h   = s => String(s).padEnd(col);
  console.log(`  ${'Metric'.padEnd(28)}${h('v5 Short-Only')}${h('v5 Bidir.')}${h('v6 Bidir.')}`);
  console.log(`${'─'.repeat(82)}`);
  const rows = [
    ['Return (200d)',   V5.shortRet+'%',  V5.comboRet+'%',  pct(r.retPct)     ],
    ['Win rate',        V5.shortWR+'%',   V5.comboWR+'%',   r.winRate.toFixed(1)+'%'],
    ['Long trades',     '-',              '254',            String(r.longTrades.length)],
    ['Long WR',         '-',              '19.7%',          r.longWR?.toFixed(1)+'%' ?? '-%'],
    ['Short trades',    '287',            '184',            String(r.shortTrades.length)],
    ['Short WR',        V5.shortWR+'%',   '35.3%',          r.shortWR?.toFixed(1)+'%' ?? '-%'],
    ['Long P&L',        '-',              '-$6,940',        dollar(r.longPNL)  ],
    ['Short P&L',       '+$8,624',        '+$5,738',        dollar(r.shortPNL) ],
    ['Total P&L',       '+$8,624',        '-$1,202',        dollar(r.pnl)      ],
  ];
  for (const [label, ...vals] of rows) {
    const change = vals[2];
    const v6n = parseFloat(change);
    const v5bidir = parseFloat(vals[1]);
    const arrow = !isNaN(v6n) && !isNaN(v5bidir)
      ? (v6n > v5bidir + 0.5 ? ' ✅' : v6n < v5bidir - 0.5 ? ' ❌' : ' →')
      : '';
    console.log(`  ${label.padEnd(28)}${vals.map(v => h(v)).join('')}${arrow}`);
  }

  // ── Full sim printout ──────────────────────────────────────────────────
  printSim(r);

  // ── Signal regime analysis ─────────────────────────────────────────────
  console.log(`\n\n${bar88}`);
  console.log(`  HOW THE STRATEGY HANDLES MARKET CHANGES`);
  console.log(bar88);
  console.log(`
  BULL REGIME (price & EMAs all aligned up):
    • LONGS  → LOW bar: just needs close > EMA21 (price barely above short-term trend)
    • SHORTS → HIGH bar: needs close < EMA200 + EMA50 also breaking down (rare)
    → Strategy naturally takes mostly longs during a bull run

  NEUTRAL REGIME (transitioning / ranging):
    • LONGS  → MED bar: needs close > EMA50 (above medium-term trend)
    • SHORTS → MED bar: needs close < EMA50 (symmetric)
    → Strategy takes both directions as confirmation develops

  BEAR REGIME (price & EMAs all aligned down):
    • LONGS  → HIGH bar: needs close > EMA200 + EMA50 recovering (rare — real reversals only)
    • SHORTS → LOW bar: just needs close < EMA21 (easy)
    → Strategy naturally takes mostly shorts during a bear market

  TRANSITION (bear → bull):
    As coins recover, they move bear → neutral → bull regime over time.
    The strategy automatically relaxes long entry and tightens short entry
    without any manual intervention. The next bull run will flip this
    automatically — each coin at its own pace.
  `);

  // Final verdict
  console.log(`\n${bar88}`);
  console.log(`  FINAL VERDICT`);
  console.log(bar88);
  console.log(`  Return (${DAYS}d)  : ${pct(r.retPct)}`);
  console.log(`  Ann. return     : ${pct(r.annRet)}`);
  console.log(`  Win rate        : ${r.winRate.toFixed(1)}%`);
  console.log(`  Profit factor   : ${r.pf.toFixed(2)}`);
  console.log(`  Max drawdown    : ${r.maxDD.toFixed(1)}%`);
  console.log(`  Long trades     : ${r.longTrades.length}  WR ${r.longWR?.toFixed(1)+'%' ?? '-'}`);
  console.log(`  Short trades    : ${r.shortTrades.length}  WR ${r.shortWR?.toFixed(1)+'%' ?? '-'}`);
  console.log(bar88 + '\n');

})().catch(console.error);
