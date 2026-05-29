/**
 * CRYPTO v5 — Bidirectional Momentum Reversal Strategy
 *
 * Core idea: read CURRENT momentum on each coin, trade whichever direction
 * it's pointing. No macro regime filter — just react to momentum swings.
 *
 * LONG  signal (mirror of working short):
 *   • RSI was recently ≤35 (oversold) in last 4 bars
 *   • RSI recovery: crosses above 42  OR  MACD hist turns positive
 *   • Price has crossed above EMA21 (momentum confirmed by price action)
 *   • RSI < 65 (not already overbought — don't chase)
 *   • Volume > 20-bar SMA
 *   → SL 7% / TP 21%
 *
 * SHORT signal (proven in v3/v4):
 *   • RSI was recently ≥65 (overbought) in last 4 bars
 *   • RSI fade: crosses below 58  OR  MACD hist turns negative
 *   • Price has crossed below EMA21
 *   • RSI > 35 (not already oversold — don't chase)
 *   • Volume > 20-bar SMA
 *   → SL 7% / TP 21%
 *
 * Symmetric R:R 3:1 on both sides. No BTC filter.
 * Same cap (30), same account ($10k), same 4H / 200-day window.
 */

import https from 'https';

const PAIRS    = [
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
const CAP      = 30;          // max simultaneous open trades
const SL_PCT   = 0.07;        // 7%  stop loss  (both directions)
const TP_PCT   = 0.21;        // 21% take profit (both directions)
const RISK_PER = CAPITAL * 0.01; // $100 risked per trade (1% account risk)

// v4 reference for comparison table
const V4 = { longRet:'-0.26', longWR:'23.7', shortRet:'+2.34', shortWR:'34.1', comboRet:'+1.68', comboWR:'30.2' };

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
  return v.map((_, i) => {
    if (i < p-1) return null;
    return v.slice(i-p+1, i+1).reduce((a,b) => a+b, 0) / p;
  });
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
function macd(closes, f=12, s=26, sig=9) {
  const fast=ema(closes,f), slow=ema(closes,s);
  const ml=closes.map((_,i)=>fast[i]-slow[i]);
  const sl=[ml[0]]; const k=2/(sig+1);
  for (let i=1; i<closes.length; i++) sl.push(ml[i]*k+sl[i-1]*(1-k));
  const hist = ml.map((v,i) => v - sl[i]);
  return { line:ml, signal:sl, hist };
}

/* ── Signal logic ───────────────────────────────────────────────────────── */
function getSignals(i, candles, e21, rsi14, mc, vsma) {
  if (i < 5) return { long: false, short: false };
  const c    = candles[i].close;
  const vol  = candles[i].volume;
  const rNow = rsi14[i];
  const rPrv = rsi14[i-1];
  if (rNow == null || rPrv == null || vsma[i] == null) return { long: false, short: false };

  const volOk = vol > vsma[i];

  // Was price recently oversold / overbought? (last 4 bars including current)
  const wasOversold  = [1,2,3,4].some(k => rsi14[i-k] != null && rsi14[i-k] <= 35);
  const wasOverbought= [1,2,3,4].some(k => rsi14[i-k] != null && rsi14[i-k] >= 65);

  // Momentum shift signals
  const rsiBounce    = rPrv <= 42 && rNow > 42;            // RSI crosses up through 42
  const rsiBreak     = rPrv >= 58 && rNow < 58;            // RSI crosses down through 58
  const macdTurnBull = mc.hist[i-1] <= 0 && mc.hist[i] > 0; // MACD hist flips positive
  const macdTurnBear = mc.hist[i-1] >= 0 && mc.hist[i] < 0; // MACD hist flips negative

  // Price relative to short-term trend (EMA21)
  const priceAboveE21 = c > e21[i];
  const priceBelowE21 = c < e21[i];

  // LONG: oversold → recovery momentum
  const long = (
    wasOversold &&
    (rsiBounce || macdTurnBull) &&
    priceAboveE21 &&
    rNow < 65 &&        // don't enter if already overbought
    volOk
  );

  // SHORT: overbought → breakdown momentum
  const short = (
    wasOverbought &&
    (rsiBreak || macdTurnBear) &&
    priceBelowE21 &&
    rNow > 35 &&        // don't enter if already oversold
    volOk
  );

  return { long, short };
}

/* ── Single simulation ──────────────────────────────────────────────────── */
function runSim(allData, mode /* 'long'|'short'|'both' */) {
  let balance = CAPITAL;
  const open  = new Map();   // symbol → { direction, entry, sl, tp, bar, size }
  const trades = [];
  const bySymbol = {};
  PAIRS.forEach(s => { bySymbol[s] = { trades:0, wins:0, pnl:0 }; });

  // Build merged timeline: every bar from every pair, sorted chronologically
  const timeline = [];
  for (const d of allData) {
    for (let i = 0; i < d.candles.length; i++) {
      timeline.push({ sym: d.symbol, i, time: d.candles[i].time });
    }
  }
  timeline.sort((a, b) => a.time - b.time || a.sym.localeCompare(b.sym));

  const monthStats = {};

  for (const { sym, i, time } of timeline) {
    const d = allData.find(x => x.symbol === sym);
    const bar = d.candles[i];
    const ym  = new Date(time).toISOString().slice(0, 7);
    if (!monthStats[ym]) monthStats[ym] = { start: balance, trades: 0 };

    // Check exits first (on open of each bar)
    if (open.has(sym)) {
      const pos = open.get(sym);
      const { direction, entry, sl, tp, size } = pos;
      let closed = false, won = false, pnlDollar = 0;

      if (direction === 'LONG') {
        if (bar.open <= sl)  { pnlDollar = -size * SL_PCT; closed = true; won = false; }
        else if (bar.open >= tp) { pnlDollar =  size * TP_PCT; closed = true; won = true; }
        else if (bar.low  <= sl) { pnlDollar = -size * SL_PCT; closed = true; won = false; }
        else if (bar.high >= tp) { pnlDollar =  size * TP_PCT; closed = true; won = true; }
      } else {
        if (bar.open >= sl)  { pnlDollar = -size * SL_PCT; closed = true; won = false; }
        else if (bar.open <= tp) { pnlDollar =  size * TP_PCT; closed = true; won = true; }
        else if (bar.high >= sl) { pnlDollar = -size * SL_PCT; closed = true; won = false; }
        else if (bar.low  <= tp) { pnlDollar =  size * TP_PCT; closed = true; won = true; }
      }

      if (closed) {
        balance += pnlDollar;
        trades.push({ sym, direction, won, pnl: pnlDollar });
        bySymbol[sym].trades++;
        bySymbol[sym].wins += won ? 1 : 0;
        bySymbol[sym].pnl  += pnlDollar;
        monthStats[ym].trades++;
        open.delete(sym);
      }
    }

    // Check entry signals
    if (!open.has(sym) && open.size < CAP && i > 0) {
      const { long, short } = getSignals(i, d.candles, d.e21, d.rsi14, d.mc, d.vsma);

      let direction = null;
      if (mode === 'long'  && long)  direction = 'LONG';
      if (mode === 'short' && short) direction = 'SHORT';
      if (mode === 'both') {
        // If both signals fire simultaneously, skip (conflicting momentum)
        if (long && !short) direction = 'LONG';
        if (short && !long) direction = 'SHORT';
      }

      if (direction) {
        const entryPrice = d.candles[i+1]?.open ?? bar.close;
        const size = RISK_PER / SL_PCT;   // position size based on fixed $ risk
        const sl   = direction === 'LONG'
          ? entryPrice * (1 - SL_PCT)
          : entryPrice * (1 + SL_PCT);
        const tp   = direction === 'LONG'
          ? entryPrice * (1 + TP_PCT)
          : entryPrice * (1 - TP_PCT);
        open.set(sym, { direction, entry: entryPrice, sl, tp, size });
      }
    }
  }

  // Close any remaining open positions at last bar price
  for (const [sym, pos] of open) {
    const d = allData.find(x => x.symbol === sym);
    const lastBar = d.candles[d.candles.length - 1];
    const { direction, entry, size } = pos;
    const pnlDollar = direction === 'LONG'
      ? (lastBar.close - entry) / entry * size
      : (entry - lastBar.close) / entry * size;
    balance += pnlDollar;
    trades.push({ sym, direction, won: pnlDollar > 0, pnl: pnlDollar });
    bySymbol[sym].trades++;
    bySymbol[sym].wins += pnlDollar > 0 ? 1 : 0;
    bySymbol[sym].pnl  += pnlDollar;
  }

  const totalTrades = trades.length;
  const wins        = trades.filter(t => t.won).length;
  const grossWin    = trades.filter(t => t.pnl > 0).reduce((s,t) => s+t.pnl, 0);
  const grossLoss   = Math.abs(trades.filter(t => t.pnl < 0).reduce((s,t) => s+t.pnl, 0));
  const winRate     = totalTrades ? (wins/totalTrades*100) : 0;
  const pf          = grossLoss ? (grossWin/grossLoss) : grossWin > 0 ? Infinity : 0;
  const pnl         = balance - CAPITAL;
  const retPct      = pnl / CAPITAL * 100;
  const annRet      = retPct / DAYS * 365;

  // Max drawdown
  let peak = CAPITAL, maxDD = 0, runBal = CAPITAL;
  for (const t of trades) {
    runBal += t.pnl;
    if (runBal > peak) peak = runBal;
    const dd = (peak - runBal) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // Monthly stats
  const months = Object.entries(monthStats).sort(([a],[b]) => a.localeCompare(b));

  // Per-symbol sorted
  const symList = Object.entries(bySymbol)
    .filter(([,v]) => v.trades > 0)
    .map(([sym, v]) => ({ sym, ...v, wr: v.trades ? v.wins/v.trades*100 : 0 }));

  const longTrades  = trades.filter(t => t.direction === 'LONG');
  const shortTrades = trades.filter(t => t.direction === 'SHORT');
  const longWR  = longTrades.length  ? longTrades.filter(t=>t.won).length/longTrades.length*100 : null;
  const shortWR = shortTrades.length ? shortTrades.filter(t=>t.won).length/shortTrades.length*100 : null;
  const longPNL  = longTrades.reduce((s,t)=>s+t.pnl,0);
  const shortPNL = shortTrades.reduce((s,t)=>s+t.pnl,0);

  return {
    balance, pnl, retPct, annRet, totalTrades, wins, winRate, pf, maxDD,
    months, monthStats, symList, longTrades, shortTrades, longWR, shortWR, longPNL, shortPNL,
  };
}

/* ── Display helpers ────────────────────────────────────────────────────── */
function pct(n, decimals=1) {
  return (n >= 0 ? '+' : '') + n.toFixed(decimals) + '%';
}
function dollar(n) {
  return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2);
}

function printSim(label, r, mode) {
  const bar = '═'.repeat(88);
  const pnlStr   = r.pnl >= 0 ? `+$${r.pnl.toFixed(2)}` : `-$${Math.abs(r.pnl).toFixed(2)}`;
  const retStr   = pct(r.retPct);
  const annStr   = pct(r.annRet);
  const ddStr    = r.maxDD.toFixed(1) + '%';

  console.log(`\n${bar}`);
  console.log(`  ${label}`);
  console.log(`  $${r.balance.toFixed(2)}  |  P&L: ${pnlStr}  |  WR: ${r.winRate.toFixed(1)}%  |  PF: ${r.pf.toFixed(2)}  |  DD: ${ddStr}  |  Ann: ${annStr}`);
  console.log(bar);

  // Direction breakdown
  if (r.longTrades.length && r.shortTrades.length) {
    const lwStr = r.longWR  != null ? r.longWR.toFixed(1)+'%'  : '-%';
    const swStr = r.shortWR != null ? r.shortWR.toFixed(1)+'%' : '-%';
    console.log(`  LONGS : ${r.longTrades.length}t  WR ${lwStr}  P&L ${dollar(r.longPNL)}`);
    console.log(`  SHORTS: ${r.shortTrades.length}t  WR ${swStr}  P&L ${dollar(r.shortPNL)}`);
  } else if (r.longTrades.length) {
    console.log(`  LONGS : ${r.longTrades.length}t  WR ${r.longWR?.toFixed(1)+'%' ?? '-%'}`);
  } else {
    console.log(`  SHORTS: ${r.shortTrades.length}t  WR ${r.shortWR?.toFixed(1)+'%' ?? '-%'}`);
  }

  // Monthly table
  console.log(`\n  ${'Month'.padEnd(12)}${'Balance'.padEnd(14)}${'Trades'.padEnd(10)}vs Start`);
  console.log(`${'─'.repeat(60)}`);
  let runBal = CAPITAL;
  for (const [ym, ms] of r.months) {
    const diff = ms.start - CAPITAL;
    const icon = ms.start >= CAPITAL ? '📈' : '📉';
    console.log(`  ${ym.padEnd(12)}$${ms.start.toFixed(2).padEnd(14)}${String(ms.trades).padEnd(10)}${dollar(diff).padEnd(16)}${icon}`);
  }
  console.log(`${'─'.repeat(60)}`);
  console.log(`  ${'FINAL'.padEnd(12)}$${r.balance.toFixed(2).padEnd(14)}${String(r.totalTrades).padEnd(10)}${dollar(r.pnl)}`);

  // Top/bottom 10 symbols
  const sorted = [...r.symList].sort((a,b) => b.pnl - a.pnl);
  console.log(`\n  TOP 10:`);
  sorted.slice(0,10).forEach((s,idx) => {
    const icon = s.pnl >= 0 ? '✅' : '❌';
    console.log(`    #${idx+1}  ${s.sym.padEnd(14)}${String(s.trades).padEnd(4)}t  ${String(s.wr.toFixed(0)).padEnd(5)}% win  ${dollar(s.pnl)}  ${icon}`);
  });
  console.log(`\n  BOTTOM 10:`);
  sorted.slice(-10).reverse().forEach((s,idx) => {
    const icon = s.pnl >= 0 ? '✅' : '❌';
    console.log(`    #${idx+1}  ${s.sym.padEnd(14)}${String(s.trades).padEnd(4)}t  ${String(s.wr.toFixed(0)).padEnd(5)}% win  ${dollar(s.pnl)}  ${icon}`);
  });
}

/* ── Main ───────────────────────────────────────────────────────────────── */
(async () => {
  const bar = '═'.repeat(88);
  console.log(`\n${bar}`);
  console.log(`  CRYPTO v5  |  ${INTERVAL}  |  ${DAYS} days  |  $${CAPITAL.toLocaleString()}  |  Cap ${CAP}`);
  console.log(`  BIDIRECTIONAL MOMENTUM REVERSAL — No regime filter, react to both sides`);
  console.log(`  LONG & SHORT: SL ${SL_PCT*100}% / TP ${TP_PCT*100}%  |  Risk $${RISK_PER}/trade`);
  console.log(bar);

  console.log(`\n  Fetching ${PAIRS.length} pairs (${INTERVAL})...\n`);
  const allData = [];
  for (const symbol of PAIRS) {
    const candles = await fetchCrypto(symbol);
    const closes  = candles.map(c => c.close);
    const vols    = candles.map(c => c.volume);
    const e21     = ema(closes, 21);
    const rsi14   = rsi(closes, 14);
    const mc      = macd(closes);
    const vsma    = sma(vols, 20);
    allData.push({ symbol, candles, e21, rsi14, mc, vsma });
    process.stdout.write(`  ${symbol.padEnd(14)}... ${candles.length} bars ✓\n`);
    await delay(50);
  }

  console.log('\n  Running simulations...\n');

  const rLong  = runSim(allData, 'long');
  const rShort = runSim(allData, 'short');
  const rBoth  = runSim(allData, 'both');

  /* ── Comparison table ─────────────────────────────────────────────────── */
  console.log(`\n\n${bar}`);
  console.log(`  COMPARISON — v5 Bidirectional vs v4`);
  console.log(bar);

  const col = 22;
  const h   = (s) => s.padEnd(col);
  console.log(`  ${'Metric'.padEnd(26)}${h('Long Only')}${h('Short Only')}${h('Bidirectional')}`);
  console.log(`${'─'.repeat(92)}`);

  const rows = [
    ['Final balance',  `$${rLong.balance.toFixed(2)}`,           `$${rShort.balance.toFixed(2)}`,           `$${rBoth.balance.toFixed(2)}`],
    ['Total P&L',      dollar(rLong.pnl),                        dollar(rShort.pnl),                        dollar(rBoth.pnl)],
    [`Return (${DAYS}d)`, pct(rLong.retPct),                     pct(rShort.retPct),                        pct(rBoth.retPct)],
    ['Ann. return',    pct(rLong.annRet),                        pct(rShort.annRet),                        pct(rBoth.annRet)],
    ['Trades',         String(rLong.totalTrades),                 String(rShort.totalTrades),                String(rBoth.totalTrades)],
    ['Win rate',       rLong.winRate.toFixed(1)+'%',              rShort.winRate.toFixed(1)+'%',             rBoth.winRate.toFixed(1)+'%'],
    ['Profit factor',  rLong.pf.toFixed(2),                      rShort.pf.toFixed(2),                      rBoth.pf.toFixed(2)],
    ['Max drawdown',   rLong.maxDD.toFixed(1)+'%',               rShort.maxDD.toFixed(1)+'%',               rBoth.maxDD.toFixed(1)+'%'],
    ['Long WR',        rLong.longWR?.toFixed(1)+'%' ?? '-%',     '-',                                       rBoth.longWR?.toFixed(1)+'%' ?? '-%'],
    ['Short WR',       '-',                                       rShort.shortWR?.toFixed(1)+'%' ?? '-%',   rBoth.shortWR?.toFixed(1)+'%' ?? '-%'],
    ['Long P&L',       dollar(rLong.longPNL),                    '-',                                       dollar(rBoth.longPNL)],
    ['Short P&L',      '-',                                       dollar(rShort.shortPNL),                   dollar(rBoth.shortPNL)],
  ];

  for (const [label, ...vals] of rows) {
    console.log(`  ${label.padEnd(26)}${vals.map(v => h(v)).join('')}`);
  }

  /* ── v4 vs v5 improvement ─────────────────────────────────────────────── */
  console.log(`\n\n${bar}`);
  console.log(`  v4 → v5 IMPROVEMENT (Bidirectional vs BTC-regime-gated)`);
  console.log(bar);
  console.log(`  ${''.padEnd(28)}${'v4'.padEnd(16)}${'v5'.padEnd(16)}Change`);
  console.log(`${'─'.repeat(80)}`);

  const improvements = [
    ['Long return',  V4.longRet+'%',  pct(rLong.retPct),  ],
    ['Long WR',      V4.longWR+'%',   rLong.winRate.toFixed(1)+'%'],
    ['Short return', V4.shortRet+'%', pct(rShort.retPct)  ],
    ['Short WR',     V4.shortWR+'%',  rShort.winRate.toFixed(1)+'%'],
    ['Combo return', V4.comboRet+'%', pct(rBoth.retPct)   ],
    ['Combo WR',     V4.comboWR+'%',  rBoth.winRate.toFixed(1)+'%'],
  ];

  for (const [label, v4val, v5val] of improvements) {
    const v4n = parseFloat(v4val);
    const v5n = parseFloat(v5val);
    const diff = v5n - v4n;
    const arrow = diff > 0.05 ? '✅' : diff < -0.05 ? '❌' : '→';
    const sign  = diff >= 0 ? '+' : '';
    console.log(`  ${label.padEnd(28)}${v4val.padEnd(16)}${v5val.padEnd(16)}${arrow} ${sign}${diff.toFixed(2)}`);
  }

  /* ── Detailed sim printouts ───────────────────────────────────────────── */
  printSim(`LONG ONLY  — Oversold recovery momentum\n  $${rLong.balance.toFixed(2)}  |  P&L: ${dollar(rLong.pnl)}  |  WR: ${rLong.winRate.toFixed(1)}%  |  PF: ${rLong.pf.toFixed(2)}  |  DD: ${rLong.maxDD.toFixed(1)}%  |  Ann: ${pct(rLong.annRet)}`, rLong, 'long');
  printSim(`SHORT ONLY — Overbought breakdown momentum\n  $${rShort.balance.toFixed(2)}  |  P&L: ${dollar(rShort.pnl)}  |  WR: ${rShort.winRate.toFixed(1)}%  |  PF: ${rShort.pf.toFixed(2)}  |  DD: ${rShort.maxDD.toFixed(1)}%  |  Ann: ${pct(rShort.annRet)}`, rShort, 'short');
  printSim(`BIDIRECTIONAL — Both momentum reversals\n  $${rBoth.balance.toFixed(2)}  |  P&L: ${dollar(rBoth.pnl)}  |  WR: ${rBoth.winRate.toFixed(1)}%  |  PF: ${rBoth.pf.toFixed(2)}  |  DD: ${rBoth.maxDD.toFixed(1)}%  |  Ann: ${pct(rBoth.annRet)}`, rBoth, 'both');

  /* ── Signal counts ────────────────────────────────────────────────────── */
  console.log(`\n\n${bar}`);
  console.log(`  SIGNAL BALANCE — How often does each direction fire?`);
  console.log(bar);
  console.log(`  Long  signals → ${rLong.totalTrades} trades (incl. filtered by cap)`);
  console.log(`  Short signals → ${rShort.totalTrades} trades (incl. filtered by cap)`);
  const ratio = rShort.totalTrades / (rLong.totalTrades || 1);
  console.log(`  Ratio: ${ratio.toFixed(1)}x more short signals than long`);
  console.log(`  → This makes sense in a bear market; bidirectional adapts automatically`);

  /* ── Final verdict ────────────────────────────────────────────────────── */
  const results = [
    { label: 'Long Only',      ret: rLong.retPct,  ann: rLong.annRet,  wr: rLong.winRate,  pf: rLong.pf  },
    { label: 'Short Only',     ret: rShort.retPct, ann: rShort.annRet, wr: rShort.winRate, pf: rShort.pf },
    { label: 'Bidirectional',  ret: rBoth.retPct,  ann: rBoth.annRet,  wr: rBoth.winRate,  pf: rBoth.pf  },
  ];
  const best = results.reduce((a,b) => b.ret > a.ret ? b : a);

  console.log(`\n\n${bar}`);
  console.log(`  FINAL VERDICT`);
  console.log(bar);
  console.log(`  Best performer  : ${best.label}`);
  console.log(`  Return (${DAYS}d)  : ${pct(best.ret)}`);
  console.log(`  Ann. return     : ${pct(best.ann)}`);
  console.log(`  Win rate        : ${best.wr.toFixed(1)}%`);
  console.log(`  Profit factor   : ${best.pf.toFixed(2)}`);
  console.log(bar + '\n');

})().catch(console.error);
