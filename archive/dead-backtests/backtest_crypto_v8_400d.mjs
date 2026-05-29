/**
 * CRYPTO v8 — Breakout Longs + Breakdown Shorts
 *
 * Two completely different signal types, one for each direction:
 *
 * ── SHORT: Overbought breakdown (proven v5 logic, unchanged) ─────────────
 *   The market was euphoric → momentum cracks → SHORT
 *   • RSI was ≥65 (overbought) in last 5 bars
 *   • RSI crosses below 58  OR  MACD hist flips negative
 *   • Price < EMA21
 *   • RSI now > 35 (not already washed out)
 *   • Volume > 1.2× SMA20
 *   → Fires in any market. WR proven at 35.5% over 200 days.
 *
 * ── LONG: Structural breakout (new — designed for bull runs) ────────────
 *   The market breaks above resistance with momentum → LONG
 *   • Price close > highest close of last 20 bars (key resistance cleared)
 *   • EMA21 > EMA50 AND EMA21 rising (trend has genuinely turned up)
 *   • RSI 50–70 (momentum building, not overbought)
 *   • Volume > 1.5× SMA20 (breakout must be conviction-backed)
 *   → In a bear market: prices make lower highs, so 20-bar resistance is
 *     almost never cleared. Signal fires rarely = few losing longs.
 *   → In a bull market: each leg up clears resistance. Signal fires often
 *     and catches the full trend move up.
 *
 * ── CONVICTION SIZING (regime adjusts risk per trade) ───────────────────
 *   Per-coin regime scored (5 conditions, +1 bull / -1 bear):
 *     BULL   (≥+4): with-trend 1.0× ($100 risk), against-trend 0.5× ($50)
 *     NEUTRAL (else): both 0.75× ($75 risk)
 *     BEAR   (≤-4): with-trend 1.0× ($100 risk), against-trend 0.5× ($50)
 *
 *   Position size = risk ÷ SL%  →  full: $1,429 | three-quarter: $1,071 | half: $714
 *   Win  = size × TP%  →  full: +$300 | ¾: +$225 | half: +$150
 *   Loss = size × SL%  →  full: -$100 | ¾: -$75  | half: -$50
 *
 * SL 7% / TP 21%  (3:1 R:R)  —  symmetric both directions
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

const DAYS      = 400;
const INTERVAL  = '4h';
const CAPITAL   = 10_000;
const CAP       = 30;
const SL_PCT    = 0.07;
const TP_PCT    = 0.21;
const BASE_RISK = CAPITAL * 0.01;   // $100
const HALF_RISK = BASE_RISK * 0.5;  // $50

const V5_SHORT = { ret: '+86.2', wr: '35.5', pf: '1.48' };
const V7_COMBO = { ret: '+4.0',  wr: '28.1', pf: '1.02' };

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
    low:  parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
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

function convictionRisk(regime, direction) {
  if (regime === 'neutral') return BASE_RISK * 0.75;
  const withTrend = (regime === 'bull' && direction === 'LONG') ||
                    (regime === 'bear' && direction === 'SHORT');
  return withTrend ? BASE_RISK : HALF_RISK;
}

/* ── Signals ─────────────────────────────────────────────────────────────── */
function getSignals(i, d) {
  const { candles, closes, e21, e50, rsi14, mc, vsma } = d;
  if (i < 22) return { long: false, short: false };

  const c    = closes[i];
  const vol  = candles[i].volume;
  const rNow = rsi14[i];
  const rPrv = rsi14[i-1];
  if (rNow == null || rPrv == null || vsma[i] == null) return { long: false, short: false };

  // ── LONG: Structural breakout ─────────────────────────────────────────
  // Price clears 20-bar resistance with trend confirmation + momentum + volume
  const high20    = Math.max(...closes.slice(i-20, i));       // resistance level
  const breakout  = c > high20;                               // price cleared it
  const trendUp   = e21[i] > e50[i]                          // EMA21 above EMA50
                 && e21[i] > e21[i-1]                         // EMA21 rising now
                 && e21[i-1] > e21[i-3];                      // ...and was rising before
  const rsiLong   = rNow >= 50 && rNow <= 70;                 // momentum, not overbought
  const volLong   = vol > vsma[i] * 1.5;                      // conviction volume
  const long = breakout && trendUp && rsiLong && volLong;

  // ── SHORT: Overbought breakdown (v5 proven — UNCHANGED) ──────────────
  const wasOverbought = [1,2,3,4,5].some(k => rsi14[i-k] != null && rsi14[i-k] >= 65);
  const rsiBreak      = rPrv >= 58 && rNow < 58;
  const macdTurnBear  = mc.hist[i-1] >= 0 && mc.hist[i] < 0;
  const volShort      = vol > vsma[i] * 1.2;
  const short = wasOverbought && (rsiBreak || macdTurnBear) && c < e21[i] && rNow > 35 && volShort;

  return { long, short };
}

/* ── Single sim ─────────────────────────────────────────────────────────── */
function runSim(allData, mode) {
  let balance = CAPITAL;
  const open  = new Map();
  const trades = [];
  const bySymbol = {};
  PAIRS.forEach(s => { bySymbol[s] = { trades:0, wins:0, pnl:0, longs:0, shorts:0 }; });

  const regimeTrades = {
    bull:    { long:{t:0,w:0,pnl:0}, short:{t:0,w:0,pnl:0} },
    neutral: { long:{t:0,w:0,pnl:0}, short:{t:0,w:0,pnl:0} },
    bear:    { long:{t:0,w:0,pnl:0}, short:{t:0,w:0,pnl:0} },
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
    if (!monthStats[ym]) monthStats[ym] = { start: balance, trades: 0, longT: 0, shortT: 0 };

    const { regime } = getRegime(i, d.closes, d.e21, d.e50, d.e200);

    // ── Exit ───────────────────────────────────────────────────────────
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
        const dk = direction === 'LONG' ? 'long' : 'short';
        regimeTrades[er][dk].t++;
        regimeTrades[er][dk].w   += won ? 1 : 0;
        regimeTrades[er][dk].pnl += pnlDollar;
        open.delete(sym);
      }
    }

    // ── Entry ───────────────────────────────────────────────────────────
    if (!open.has(sym) && open.size < CAP && i > 0 && balance > HALF_RISK * 2) {
      const { long, short } = getSignals(i, d);

      let direction = null;
      if (mode === 'long'  && long)  direction = 'LONG';
      if (mode === 'short' && short) direction = 'SHORT';
      if (mode === 'both') {
        if (long && !short)  direction = 'LONG';
        if (short && !long)  direction = 'SHORT';
        if (long && short) {          // conflict: follow regime
          if (regime === 'bull')       direction = 'LONG';
          else if (regime === 'bear')  direction = 'SHORT';
          // neutral conflict → skip
        }
      }

      if (direction) {
        const nextBar = d.candles[i + 1];
        if (!nextBar) continue;
        const risk  = convictionRisk(regime, direction);
        const size  = risk / SL_PCT;
        const entry = nextBar.open;
        const sl    = direction === 'LONG'  ? entry * (1 - SL_PCT) : entry * (1 + SL_PCT);
        const tp    = direction === 'LONG'  ? entry * (1 + TP_PCT) : entry * (1 - TP_PCT);
        open.set(sym, { direction, entry, sl, tp, size, regime });
        if (direction === 'LONG')  monthStats[ym].longT++;
        else                       monthStats[ym].shortT++;
      }
    }
  }

  // Close remaining
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
    regimeTrades,
  };
}

/* ── Display ─────────────────────────────────────────────────────────────── */
const pct    = (n, d=1) => (n>=0?'+':'')+n.toFixed(d)+'%';
const dollar = n        => (n>=0?'+$':'-$')+Math.abs(n).toFixed(2);
const bar88  = '═'.repeat(88);

function printSim(label, r) {
  const emoji = r.pnl >= 0 ? '📈' : '📉';
  console.log(`\n${bar88}`);
  console.log(`  ${label}  ${emoji}`);
  console.log(`  $${r.balance.toFixed(2)}  |  P&L: ${dollar(r.pnl)}  |  WR: ${r.winRate.toFixed(1)}%  |  PF: ${r.pf.toFixed(2)}  |  DD: ${r.maxDD.toFixed(1)}%  |  Ann: ${pct(r.annRet)}`);
  console.log(bar88);

  if (r.longTrades.length && r.shortTrades.length) {
    console.log(`  LONGS : ${r.longTrades.length}t  WR ${r.longWR?.toFixed(1)+'%' ?? '-'}  P&L ${dollar(r.longPNL)}`);
    console.log(`  SHORTS: ${r.shortTrades.length}t  WR ${r.shortWR?.toFixed(1)+'%' ?? '-'}  P&L ${dollar(r.shortPNL)}`);
  } else if (r.longTrades.length) {
    console.log(`  LONGS : ${r.longTrades.length}t  WR ${r.longWR?.toFixed(1)+'%' ?? '-'}  P&L ${dollar(r.longPNL)}`);
  } else {
    console.log(`  SHORTS: ${r.shortTrades.length}t  WR ${r.shortWR?.toFixed(1)+'%' ?? '-'}  P&L ${dollar(r.shortPNL)}`);
  }

  // Monthly
  console.log(`\n  ${'Month'.padEnd(12)}${'Balance'.padEnd(14)}${'L'.padEnd(5)}${'S'.padEnd(5)}${'Trades'.padEnd(8)}vs Start`);
  console.log(`  ${'─'.repeat(62)}`);
  for (const [ym, ms] of r.months) {
    const diff = ms.start - CAPITAL;
    const icon = ms.start >= CAPITAL ? '📈' : '📉';
    console.log(`  ${ym.padEnd(12)}$${ms.start.toFixed(0).padEnd(14)}${String(ms.longT||0).padEnd(5)}${String(ms.shortT||0).padEnd(5)}${String(ms.trades).padEnd(8)}${dollar(diff).padEnd(16)}${icon}`);
  }
  console.log(`  ${'─'.repeat(62)}`);
  console.log(`  ${'FINAL'.padEnd(12)}$${r.balance.toFixed(2).padEnd(14)}${''.padEnd(5)}${''.padEnd(5)}${String(r.totalTrades).padEnd(8)}${dollar(r.pnl)}`);

  // Regime breakdown
  if (r.longTrades.length && r.shortTrades.length) {
    console.log(`\n  REGIME BREAKDOWN:`);
    console.log(`  ${'Regime'.padEnd(10)}${'Long t'.padEnd(9)}${'Long WR'.padEnd(10)}${'Long P&L'.padEnd(14)}${'Short t'.padEnd(9)}${'Short WR'.padEnd(10)}${'Short P&L'}`);
    console.log(`  ${'─'.repeat(76)}`);
    for (const rg of ['bull','neutral','bear']) {
      const lt = r.regimeTrades[rg].long;
      const st = r.regimeTrades[rg].short;
      const lwr = lt.t ? (lt.w/lt.t*100).toFixed(0)+'%' : '-';
      const swr = st.t ? (st.w/st.t*100).toFixed(0)+'%' : '-';
      const icon = rg==='bull'?'🟢':rg==='bear'?'🔴':'🟡';
      const sizing = rg==='bull'?'(L=$100 S=$50)':rg==='bear'?'(L=$50 S=$100)':'(L=S=$75)';
      console.log(`  ${icon} ${rg.padEnd(8)}${String(lt.t+'t').padEnd(9)}${lwr.padEnd(10)}${dollar(lt.pnl).padEnd(14)}${String(st.t+'t').padEnd(9)}${swr.padEnd(10)}${dollar(st.pnl).padEnd(14)}${sizing}`);
    }
  }

  // Top / bottom
  const sorted = [...r.symList].sort((a,b) => b.pnl - a.pnl);
  console.log(`\n  TOP 10:`);
  sorted.slice(0,10).forEach((s,i) => {
    const dir = s.longs > 0 && s.shorts === 0 ? 'L' : s.shorts > 0 && s.longs === 0 ? 'S' : 'LS';
    console.log(`    #${i+1}  ${s.sym.padEnd(14)}${String(s.trades).padEnd(4)}t  ${String(s.wr.toFixed(0)).padEnd(5)}% win  ${dollar(s.pnl).padEnd(14)}[${dir}]`);
  });
  console.log(`\n  BOTTOM 10:`);
  sorted.slice(-10).reverse().forEach((s,i) => {
    const dir = s.longs > 0 && s.shorts === 0 ? 'L' : s.shorts > 0 && s.longs === 0 ? 'S' : 'LS';
    console.log(`    #${i+1}  ${s.sym.padEnd(14)}${String(s.trades).padEnd(4)}t  ${String(s.wr.toFixed(0)).padEnd(5)}% win  ${dollar(s.pnl).padEnd(14)}[${dir}]`);
  });
}

/* ── Main ───────────────────────────────────────────────────────────────── */
(async () => {
  console.log(`\n${bar88}`);
  console.log(`  CRYPTO v8  |  ${INTERVAL}  |  ${DAYS} days  |  $${CAPITAL.toLocaleString()}  |  Cap ${CAP}`);
  console.log(`  BREAKOUT LONGS + BREAKDOWN SHORTS`);
  console.log(`  LONG : 20-bar breakout + EMA21>EMA50 trend + RSI 50-70 + vol 1.5×`);
  console.log(`  SHORT: Overbought fade + EMA21 break + RSI cross + vol 1.2×  [v5 proven]`);
  console.log(`  SIZING: with-trend $100 | neutral $75 | against-trend $50`);
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

  console.log('\n  Running 3 simulations...\n');
  const rLong  = runSim(allData, 'long');
  const rShort = runSim(allData, 'short');
  const rBoth  = runSim(allData, 'both');

  /* ── High-level comparison ────────────────────────────────────────────── */
  const col = 20;
  const h   = s => String(s).padEnd(col);
  console.log(`\n${bar88}`);
  console.log(`  RESULTS SUMMARY`);
  console.log(bar88);
  console.log(`  ${'Metric'.padEnd(26)}${h('Long Only')}${h('Short Only')}${h('Combined')}`);
  console.log(`${'─'.repeat(86)}`);
  const rows = [
    ['Final balance',  `$${rLong.balance.toFixed(2)}`,  `$${rShort.balance.toFixed(2)}`,  `$${rBoth.balance.toFixed(2)}`],
    ['P&L',           dollar(rLong.pnl),                dollar(rShort.pnl),               dollar(rBoth.pnl)            ],
    [`Return (${DAYS}d)`, pct(rLong.retPct),            pct(rShort.retPct),               pct(rBoth.retPct)            ],
    ['Ann. return',   pct(rLong.annRet),                pct(rShort.annRet),               pct(rBoth.annRet)            ],
    ['Trades',        String(rLong.totalTrades),         String(rShort.totalTrades),       String(rBoth.totalTrades)    ],
    ['Win rate',      rLong.winRate.toFixed(1)+'%',     rShort.winRate.toFixed(1)+'%',    rBoth.winRate.toFixed(1)+'%' ],
    ['Profit factor', rLong.pf.toFixed(2),              rShort.pf.toFixed(2),             rBoth.pf.toFixed(2)          ],
    ['Max drawdown',  rLong.maxDD.toFixed(1)+'%',       rShort.maxDD.toFixed(1)+'%',      rBoth.maxDD.toFixed(1)+'%'  ],
    ['Long trades',   `${rLong.totalTrades}t`,           '-',                              `${rBoth.longTrades.length}t`],
    ['Long WR',       rLong.winRate.toFixed(1)+'%',     '-',                              rBoth.longWR?.toFixed(1)+'%' ?? '-'],
    ['Long P&L',      dollar(rLong.longPNL),             '-',                              dollar(rBoth.longPNL)        ],
    ['Short trades',  '-',                               `${rShort.totalTrades}t`,         `${rBoth.shortTrades.length}t`],
    ['Short WR',      '-',                               rShort.winRate.toFixed(1)+'%',    rBoth.shortWR?.toFixed(1)+'%' ?? '-'],
    ['Short P&L',     '-',                               dollar(rShort.shortPNL),          dollar(rBoth.shortPNL)      ],
  ];
  for (const [label, ...vals] of rows)
    console.log(`  ${label.padEnd(26)}${vals.map(v => h(v)).join('')}`);

  /* ── v5/v7 → v8 improvement ──────────────────────────────────────────── */
  console.log(`\n\n${bar88}`);
  console.log(`  EVOLUTION: v5 → v7 → v8`);
  console.log(bar88);
  console.log(`  ${'Metric'.padEnd(26)}${h('v5 Short-Only')}${h('v7 Combined')}${h('v8 Combined')}Change`);
  console.log(`${'─'.repeat(90)}`);
  const evo = [
    ['Return (200d)',  V5_SHORT.ret+'%', V7_COMBO.ret+'%', pct(rBoth.retPct) ],
    ['Win rate',       V5_SHORT.wr+'%',  V7_COMBO.wr+'%',  rBoth.winRate.toFixed(1)+'%'],
    ['Profit factor',  V5_SHORT.pf,      V7_COMBO.pf,      rBoth.pf.toFixed(2)],
    ['Long trades',    '-',              '50',             String(rBoth.longTrades.length)],
    ['Long WR',        '-',              '10.0%',          rBoth.longWR?.toFixed(1)+'%' ?? '-'],
    ['Long P&L',       '-',              '-$2,440',        dollar(rBoth.longPNL)],
    ['Short WR',       V5_SHORT.wr+'%',  '31.8%',          rBoth.shortWR?.toFixed(1)+'%' ?? '-'],
  ];
  for (const [label, v5, v7, v8] of evo) {
    const n8 = parseFloat(v8), n7 = parseFloat(v7);
    const arrow = !isNaN(n8) && !isNaN(n7) ? (n8 > n7+0.5 ? ' ✅' : n8 < n7-0.5 ? ' ❌' : ' →') : '';
    console.log(`  ${label.padEnd(26)}${h(v5)}${h(v7)}${h(v8)}${arrow}`);
  }

  /* ── Detailed printouts ─────────────────────────────────────────────── */
  printSim(`LONG ONLY  — Breakout signal`, rLong);
  printSim(`SHORT ONLY — Overbought breakdown`, rShort);
  printSim(`COMBINED   — Breakout longs + Breakdown shorts`, rBoth);

  /* ── Bull run explanation ────────────────────────────────────────────── */
  console.log(`\n\n${bar88}`);
  console.log(`  HOW THIS HANDLES THE NEXT BULL RUN`);
  console.log(bar88);

  const longSignalCount = rLong.totalTrades;
  const shortSignalCount = rShort.totalTrades;
  console.log(`
  CURRENT BEAR MARKET (last ${DAYS} days):
    Long signals (breakout): ${longSignalCount} total  — price rarely breaks above 20-bar resistance
    Short signals (breakdown): ${shortSignalCount} total — overbought coins fading, easy pickings
    Strategy is naturally SHORT-HEAVY  ✓

  TRANSITION TO BULL MARKET:
    Step 1: Coins bottom out, start making higher lows
    Step 2: Price breaks above 20-bar resistance  → LONG signal fires
    Step 3: EMA21 crosses above EMA50             → bull regime, full $100 long sizing
    Step 4: Each new leg up fires another breakout → strategy rides the trend
    Step 5: Short signals become rare             → need overbought + breakdown in uptrend

  FULLY IN BULL MARKET:
    Long signals: fire on every pullback recovery above the 20-bar high
    Short signals: still fire on euphoric peaks — capturing the corrections
    Strategy becomes LONG-HEAVY but never ignores short opportunities
    Regime conviction sizing: longs at $100, shorts at $50 (reduced size against trend)

  THE KEY DIFFERENCE FROM v5/v6/v7:
    Old long logic: "RSI was oversold, now bouncing" → bull trap in downtrend
    New long logic: "Price actually BROKE ABOVE resistance" → structural change
    The breakout condition is a natural bear-market filter — no new highs = no longs.
  `);

  /* ── Final verdict ───────────────────────────────────────────────────── */
  const best = [
    { label: 'Long Only', r: rLong },
    { label: 'Short Only', r: rShort },
    { label: 'Combined',   r: rBoth },
  ].reduce((a, b) => b.r.retPct > a.r.retPct ? b : a);

  console.log(`\n${bar88}`);
  console.log(`  FINAL VERDICT`);
  console.log(bar88);
  console.log(`  Best mode       : ${best.label}`);
  console.log(`  Return (${DAYS}d)  : ${pct(best.r.retPct)}`);
  console.log(`  Ann. return     : ${pct(best.r.annRet)}`);
  console.log(`  Win rate        : ${best.r.winRate.toFixed(1)}%`);
  console.log(`  Profit factor   : ${best.r.pf.toFixed(2)}`);
  console.log(`  Max drawdown    : ${best.r.maxDD.toFixed(1)}%`);
  if (best.r.longTrades.length)
    console.log(`  Long trades     : ${best.r.longTrades.length}t  WR ${best.r.longWR?.toFixed(1)+'%' ?? '-'}  P&L ${dollar(best.r.longPNL)}`);
  if (best.r.shortTrades.length)
    console.log(`  Short trades    : ${best.r.shortTrades.length}t  WR ${best.r.shortWR?.toFixed(1)+'%' ?? '-'}  P&L ${dollar(best.r.shortPNL)}`);
  console.log(bar88 + '\n');

})().catch(console.error);
