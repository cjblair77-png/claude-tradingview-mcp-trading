/**
 * CRYPTO v7 — Regime-Aware Bidirectional with Conviction Sizing
 *
 * Lesson from v5/v6:
 *   • The short signal at RSI 35.5% WR / +86% is proven — don't change it
 *   • Regime gates on ENTRIES hurt the short edge (neutral gate blocked early entries)
 *   • Longs fail because RSI ≤35 bounce in a bear market = dead cat bounce
 *   • Fix: tighter long entry (deeper oversold, double confirmation, price > EMA50)
 *   • Fix: regime changes POSITION SIZE, not whether to enter
 *
 * ── LONG SIGNAL (stricter — genuine reversals only) ───────────────────
 *   • RSI was ≤30 (deeply oversold) in last 5 bars  [was ≤35 in v5]
 *   • RSI crosses above 45  [was 42]
 *   • MACD hist also turns positive  [was OR, now AND]
 *   • Price > EMA50  [was > EMA21 — must clear medium-term trend]
 *   • RSI now < 68
 *   • Volume > 1.5× SMA20  [was 1.2×]
 *
 * ── SHORT SIGNAL (unchanged from v5 — proven at 35.5% WR) ────────────
 *   • RSI was ≥65 (overbought) in last 5 bars
 *   • RSI crosses below 58  OR  MACD hist turns negative
 *   • Price < EMA21
 *   • RSI now > 35
 *   • Volume > 1.2× SMA20
 *
 * ── CONVICTION SIZING (regime adjusts risk, not entry) ────────────────
 *   Per-coin regime scored 0-5 (bull conditions):
 *     BULL   (score ≥4): with-trend × 1.0, against-trend × 0.5
 *     NEUTRAL (score 1-3): both × 0.75
 *     BEAR   (score ≤-4): with-trend × 1.0, against-trend × 0.5
 *
 *   Base risk: $100/trade (1% of $10k)
 *   Against-trend: $50/trade (0.5% of $10k)
 *   With-trend full: $100/trade
 *
 *   Position size = risk ÷ SL%  →  $100 ÷ 7% = $1,429 full / $714 half
 *   Win pays:  size × 21%  →  $300 full / $150 half
 *   Loss costs: size × 7%  →  $100 full / $50 half
 *
 * Why this handles bull-run transition:
 *   Bear → neutral: longs at 0.75× sizing, shorts at 0.75×
 *   Neutral → bull: longs scale up to 1.0×, shorts drop to 0.5×
 *   The strategy self-adjusts as each coin's regime score changes.
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

const DAYS      = 200;
const INTERVAL  = '4h';
const CAPITAL   = 10_000;
const CAP       = 30;
const SL_PCT    = 0.07;
const TP_PCT    = 0.21;
const BASE_RISK = CAPITAL * 0.01;   // $100 — full conviction
const HALF_RISK = BASE_RISK * 0.5;  // $50  — against-trend conviction

// Reference from v5
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

/* ── Regime (per coin, per bar) ─────────────────────────────────────────── */
// Returns { regime: 'bull'|'neutral'|'bear', score }
function getRegime(i, closes, e21, e50, e200) {
  if (!e200[i] || !e50[i] || !e21[i]) return { regime: 'neutral', score: 0 };
  const c = closes[i];
  let score = 0;
  if (c      > e200[i]) score++; else score--;
  if (c      > e50[i])  score++; else score--;
  if (c      > e21[i])  score++; else score--;
  if (e21[i] > e50[i])  score++; else score--;
  if (e50[i] > e200[i]) score++; else score--;
  const regime = score >= 4 ? 'bull' : score <= -4 ? 'bear' : 'neutral';
  return { regime, score };
}

// How much to risk based on regime + trade direction
function convictionRisk(regime, direction) {
  if (regime === 'neutral') return BASE_RISK * 0.75;
  const withTrend = (regime === 'bull' && direction === 'LONG') ||
                    (regime === 'bear' && direction === 'SHORT');
  return withTrend ? BASE_RISK : HALF_RISK;
}

/* ── Signals ─────────────────────────────────────────────────────────────── */
function getSignals(i, d) {
  const { candles, closes, e21, e50, rsi14, mc, vsma } = d;
  if (i < 6) return { long: false, short: false };

  const c    = candles[i].close;
  const vol  = candles[i].volume;
  const rNow = rsi14[i];
  const rPrv = rsi14[i-1];
  if (!rNow || !rPrv || !vsma[i]) return { long: false, short: false };

  // ── LONG: deeply oversold → confirmed recovery ────────────────────────
  // Stricter than v5: RSI ≤30, both momentum triggers, price > EMA50, vol 1.5×
  const wasDeepOversold = [1,2,3,4,5].some(k => rsi14[i-k] != null && rsi14[i-k] <= 30);
  const rsiBounce       = rPrv <= 45 && rNow > 45;          // decisive cross above 45
  const macdTurnBull    = mc.hist[i-1] <= 0 && mc.hist[i] > 0;
  const longVolOk       = vol > vsma[i] * 1.5;              // 50% above average
  const long = (
    wasDeepOversold     &&
    rsiBounce           &&    // RSI cross (required)
    macdTurnBull        &&    // MACD also turning (required — both confirmations)
    c > e50[i]          &&    // price cleared medium-term trend
    rNow < 68           &&
    longVolOk
  );

  // ── SHORT: overbought → breakdown (UNCHANGED from v5) ─────────────────
  const wasOverbought = [1,2,3,4,5].some(k => rsi14[i-k] != null && rsi14[i-k] >= 65);
  const rsiBreak      = rPrv >= 58 && rNow < 58;
  const macdTurnBear  = mc.hist[i-1] >= 0 && mc.hist[i] < 0;
  const shortVolOk    = vol > vsma[i] * 1.2;
  const short = (
    wasOverbought       &&
    (rsiBreak || macdTurnBear) &&   // either trigger (same as v5)
    c < e21[i]          &&
    rNow > 35           &&
    shortVolOk
  );

  return { long, short };
}

/* ── Simulation ─────────────────────────────────────────────────────────── */
function runSim(allData) {
  let balance = CAPITAL;
  const open  = new Map();
  const trades = [];
  const bySymbol = {};
  PAIRS.forEach(s => { bySymbol[s] = { trades:0, wins:0, pnl:0, longs:0, shorts:0 }; });

  const regimeCounts  = { bull:0, neutral:0, bear:0 };
  const regimeTrades  = {
    bull:    { long:{t:0,w:0}, short:{t:0,w:0} },
    neutral: { long:{t:0,w:0}, short:{t:0,w:0} },
    bear:    { long:{t:0,w:0}, short:{t:0,w:0} },
  };
  const sizingStats   = { full:0, threequarter:0, half:0 };

  // Build merged timeline
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

    const { regime } = getRegime(i, d.closes, d.e21, d.e50, d.e200);
    regimeCounts[regime]++;

    // ── Exit ──────────────────────────────────────────────────────────
    if (open.has(sym)) {
      const pos = open.get(sym);
      const { direction, entry, sl, tp, size, regime: er } = pos;
      let closed = false, won = false, pnlDollar = 0;

      if (direction === 'LONG') {
        if      (bar.open <= sl) { pnlDollar = -(size * SL_PCT); closed = true; }
        else if (bar.open >= tp) { pnlDollar =   size * TP_PCT;  closed = true; won = true; }
        else if (bar.low  <= sl) { pnlDollar = -(size * SL_PCT); closed = true; }
        else if (bar.high >= tp) { pnlDollar =   size * TP_PCT;  closed = true; won = true; }
      } else {
        if      (bar.open >= sl) { pnlDollar = -(size * SL_PCT); closed = true; }
        else if (bar.open <= tp) { pnlDollar =   size * TP_PCT;  closed = true; won = true; }
        else if (bar.high >= sl) { pnlDollar = -(size * SL_PCT); closed = true; }
        else if (bar.low  <= tp) { pnlDollar =   size * TP_PCT;  closed = true; won = true; }
      }

      if (closed) {
        balance += pnlDollar;
        trades.push({ sym, direction, won, pnl: pnlDollar, regime: er });
        bySymbol[sym].trades++;
        bySymbol[sym].wins   += won ? 1 : 0;
        bySymbol[sym].pnl    += pnlDollar;
        direction === 'LONG' ? bySymbol[sym].longs++ : bySymbol[sym].shorts++;
        monthStats[ym].trades++;
        regimeTrades[er][direction==='LONG'?'long':'short'].t++;
        regimeTrades[er][direction==='LONG'?'long':'short'].w += won ? 1 : 0;
        open.delete(sym);
      }
    }

    // ── Entry ──────────────────────────────────────────────────────────
    if (!open.has(sym) && open.size < CAP && i > 0 && balance > HALF_RISK * 2) {
      const { long, short } = getSignals(i, d);

      let direction = null;
      if (long && !short)  direction = 'LONG';
      if (short && !long)  direction = 'SHORT';
      if (long && short) {
        // Both fire: take the one aligned with regime, else skip
        if (regime === 'bull')  direction = 'LONG';
        else if (regime === 'bear') direction = 'SHORT';
        // neutral + conflict: skip
      }

      if (direction) {
        const nextBar = d.candles[i + 1];
        if (!nextBar) continue;

        const risk  = convictionRisk(regime, direction);
        const size  = risk / SL_PCT;
        if (risk === BASE_RISK)             sizingStats.full++;
        else if (risk === BASE_RISK * 0.75) sizingStats.threequarter++;
        else                                sizingStats.half++;

        const entry = nextBar.open;
        const sl    = direction === 'LONG'  ? entry * (1 - SL_PCT) : entry * (1 + SL_PCT);
        const tp    = direction === 'LONG'  ? entry * (1 + TP_PCT) : entry * (1 - TP_PCT);
        open.set(sym, { direction, entry, sl, tp, size, regime });
      }
    }
  }

  // Close remaining at last bar price
  for (const [sym, pos] of open) {
    const d = allData.find(x => x.symbol === sym);
    const last = d.candles[d.candles.length - 1];
    const { direction, entry, size, regime: er } = pos;
    const pnl = direction === 'LONG'
      ? (last.close - entry) / entry * size
      : (entry - last.close) / entry * size;
    balance += pnl;
    trades.push({ sym, direction, won: pnl > 0, pnl, regime: er });
    bySymbol[sym].trades++;
    bySymbol[sym].wins += pnl > 0 ? 1 : 0;
    bySymbol[sym].pnl  += pnl;
  }

  // Aggregate
  const totalTrades = trades.length;
  const wins        = trades.filter(t => t.won).length;
  const grossWin    = trades.filter(t => t.pnl > 0).reduce((s,t) => s+t.pnl, 0);
  const grossLoss   = Math.abs(trades.filter(t => t.pnl < 0).reduce((s,t) => s+t.pnl, 0));
  const winRate     = totalTrades ? wins/totalTrades*100 : 0;
  const pf          = grossLoss ? grossWin/grossLoss : grossWin > 0 ? Infinity : 0;
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
    regimeCounts, regimeTrades, sizingStats,
  };
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */
const pct    = (n, d=1) => (n>=0?'+':'')+n.toFixed(d)+'%';
const dollar = n        => (n>=0?'+$':'-$')+Math.abs(n).toFixed(2);
const bar88  = '═'.repeat(88);

/* ── Main ───────────────────────────────────────────────────────────────── */
(async () => {
  console.log(`\n${bar88}`);
  console.log(`  CRYPTO v7  |  ${INTERVAL}  |  ${DAYS} days  |  $${CAPITAL.toLocaleString()}  |  Cap ${CAP}`);
  console.log(`  REGIME-ADAPTIVE CONVICTION SIZING`);
  console.log(`  LONG : RSI ≤30 deep oversold + BOTH triggers + price>EMA50 + vol 1.5×`);
  console.log(`  SHORT: RSI ≥65 overbought + EITHER trigger + price<EMA21 + vol 1.2×  (v5 proven)`);
  console.log(`  SIZING: with-trend=$100 risk | neutral=$75 | against-trend=$50`);
  console.log(`  SL ${(SL_PCT*100).toFixed(0)}% / TP ${(TP_PCT*100).toFixed(0)}%  (3:1 R:R)`);
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

  /* ── v5 → v7 comparison ────────────────────────────────────────────── */
  const col = 18;
  const h   = s => String(s).padEnd(col);
  console.log(`\n${bar88}`);
  console.log(`  v5 → v7 COMPARISON`);
  console.log(bar88);
  console.log(`  ${'Metric'.padEnd(28)}${h('v5 Short-Only')}${h('v5 Bidir.')}${h('v7 Bidir.')}`);
  console.log(`${'─'.repeat(82)}`);
  const rows = [
    ['Return (200d)',   V5.shortRet+'%',  V5.comboRet+'%',   pct(r.retPct)                     ],
    ['Win rate',        V5.shortWR+'%',   V5.comboWR+'%',    r.winRate.toFixed(1)+'%'           ],
    ['Long trades',     '-',              '254',             String(r.longTrades.length)         ],
    ['Long WR',         '-',              '19.7%',           r.longWR?.toFixed(1)+'%' ?? '-'    ],
    ['Short trades',    '287',            '184',             String(r.shortTrades.length)        ],
    ['Short WR',        V5.shortWR+'%',   '35.3%',           r.shortWR?.toFixed(1)+'%' ?? '-'   ],
    ['Long P&L',        '-',              '-$6,940',         dollar(r.longPNL)                   ],
    ['Short P&L',       '+$8,624',        '+$5,738',         dollar(r.shortPNL)                  ],
    ['Total P&L',       '+$8,624',        '-$1,202',         dollar(r.pnl)                       ],
    ['Max drawdown',    '29.8%',          '63.8%',           r.maxDD.toFixed(1)+'%'             ],
  ];
  for (const [label, v5s, v5b, v7] of rows) {
    const v7n  = parseFloat(v7);
    const v5bn = parseFloat(v5b);
    const arrow = !isNaN(v7n) && !isNaN(v5bn)
      ? (v7n > v5bn + 0.5 ? ' ✅' : v7n < v5bn - 0.5 ? ' ❌' : ' →')
      : '';
    console.log(`  ${label.padEnd(28)}${h(v5s)}${h(v5b)}${h(v7)}${arrow}`);
  }

  /* ── Main results ───────────────────────────────────────────────────── */
  console.log(`\n\n${bar88}`);
  console.log(`  RESULTS — v7 Regime-Adaptive Bidirectional`);
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
  console.log(`\n  REGIME BREAKDOWN — conviction sizing in action:`);
  console.log(`  ${'Regime'.padEnd(10)}${'Signal bars'.padEnd(14)}${'Long t'.padEnd(10)}${'Long WR'.padEnd(12)}${'Short t'.padEnd(10)}${'Short WR'.padEnd(12)}${'Sizing'}`);
  console.log(`  ${'─'.repeat(80)}`);
  for (const regime of ['bull','neutral','bear']) {
    const rc  = r.regimeCounts[regime];
    const lt  = r.regimeTrades[regime].long;
    const st  = r.regimeTrades[regime].short;
    const lwr = lt.t ? (lt.w/lt.t*100).toFixed(0)+'%' : '-';
    const swr = st.t ? (st.w/st.t*100).toFixed(0)+'%' : '-';
    const icon = regime==='bull'?'🟢':regime==='bear'?'🔴':'🟡';
    const sizing = regime==='bull' ? 'L=$100 S=$50' : regime==='bear' ? 'L=$50 S=$100' : 'L=S=$75';
    console.log(`  ${icon} ${regime.padEnd(8)}${String(rc).padEnd(14)}${String(lt.t+'t').padEnd(10)}${lwr.padEnd(12)}${String(st.t+'t').padEnd(10)}${swr.padEnd(12)}${sizing}`);
  }

  // Sizing stats
  const total = r.sizingStats.full + r.sizingStats.threequarter + r.sizingStats.half;
  if (total > 0) {
    console.log(`\n  CONVICTION SIZING SPLIT:`);
    console.log(`  Full ($100 risk):          ${r.sizingStats.full}t  (${(r.sizingStats.full/total*100).toFixed(0)}%)`);
    console.log(`  Three-quarter ($75 risk):  ${r.sizingStats.threequarter}t  (${(r.sizingStats.threequarter/total*100).toFixed(0)}%)`);
    console.log(`  Half ($50 risk):           ${r.sizingStats.half}t  (${(r.sizingStats.half/total*100).toFixed(0)}%)`);
  }

  // Top/bottom
  const sorted = [...r.symList].sort((a,b) => b.pnl - a.pnl);
  console.log(`\n  TOP 10:`);
  sorted.slice(0,10).forEach((s,i) => {
    const dir = s.longs > s.shorts ? 'L' : s.shorts > s.longs ? 'S' : 'LS';
    console.log(`    #${i+1}  ${s.sym.padEnd(14)}${String(s.trades).padEnd(4)}t  ${String(s.wr.toFixed(0)).padEnd(5)}% win  ${dollar(s.pnl).padEnd(14)}[${dir}]`);
  });
  console.log(`\n  BOTTOM 10:`);
  sorted.slice(-10).reverse().forEach((s,i) => {
    const dir = s.longs > s.shorts ? 'L' : s.shorts > s.longs ? 'S' : 'LS';
    console.log(`    #${i+1}  ${s.sym.padEnd(14)}${String(s.trades).padEnd(4)}t  ${String(s.wr.toFixed(0)).padEnd(5)}% win  ${dollar(s.pnl).padEnd(14)}[${dir}]`);
  });

  /* ── Bull-run readiness ─────────────────────────────────────────────── */
  console.log(`\n\n${bar88}`);
  console.log(`  BULL-RUN READINESS — how the strategy self-adjusts`);
  console.log(bar88);
  console.log(`
  RIGHT NOW (bear market — last 200 days):
    Coins in bear regime   → shorts at full $100 risk, longs at half $50 risk
    Long signals rare      → RSI ≤30 + BOTH triggers + price > EMA50 = real recoveries only
    Short signals common   → proven 35%+ WR, full size

  AS BULL RUN STARTS (coin-by-coin transition):
    BTC recovers first     → EMA21 crosses EMA50 → neutral regime → sizing equalises
    Altcoins follow        → EMA50 crosses EMA200 → bull regime → longs at full size
    Short signals harder   → needs price < EMA200 in bull regime (rare = good)
    Long signals easier    → RSI dip to 30 then bounce is a normal bull pullback

  FULLY IN BULL MARKET:
    Coins in bull regime   → longs at full $100 risk, shorts at half $50 risk
    Short signals rare     → only on deep overbought breakdowns (real tops)
    Long signals common    → every pullback to oversold is a buying opportunity

  NO MANUAL SWITCH NEEDED:
    Each coin transitions independently based on its own EMA structure.
    The strategy naturally flips from short-heavy to long-heavy as the
    market recovers. Neutral regime acts as a smooth buffer.
  `);

  /* ── Final verdict ──────────────────────────────────────────────────── */
  console.log(`\n${bar88}`);
  console.log(`  FINAL VERDICT — v7`);
  console.log(bar88);
  console.log(`  Return (${DAYS}d)  : ${pct(r.retPct)}`);
  console.log(`  Ann. return     : ${pct(r.annRet)}`);
  console.log(`  Win rate        : ${r.winRate.toFixed(1)}%`);
  console.log(`  Profit factor   : ${r.pf.toFixed(2)}`);
  console.log(`  Max drawdown    : ${r.maxDD.toFixed(1)}%`);
  console.log(`  Long trades     : ${r.longTrades.length}t  WR ${r.longWR?.toFixed(1)+'%' ?? '-'}  P&L ${dollar(r.longPNL)}`);
  console.log(`  Short trades    : ${r.shortTrades.length}t  WR ${r.shortWR?.toFixed(1)+'%' ?? '-'}  P&L ${dollar(r.shortPNL)}`);
  console.log(bar88 + '\n');

})().catch(console.error);
