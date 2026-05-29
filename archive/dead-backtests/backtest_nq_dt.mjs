import https from 'https';

function fetch(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

const START_BAL          = 5000;
const DAYS               = 150;
const LEVERAGE           = 5;
const RISK_PCT           = 0.008;    // 0.8% risk per trade
const SL_PCT             = 0.0042;   // 0.42% SL (2x avg RTH 15m bar range)
const TP_PCT             = SL_PCT * 1.3; // 1.3 R:R = 0.546%
const VOL_MULT           = 1.2;
const EMA_S              = 21;
const EMA_L              = 50;
const EMA_TREND_LB       = 4;
const MAX_HOLD           = 12;       // 12 x 1H bars (proxy for 12 x 15m = 3h)
const RTH_START          = 13;       // 13:30 UTC = 9:30am ET
const RTH_END            = 21;       // 21:00 UTC = 5:00pm ET

// ── Fetch NQ 1H data ──────────────────────────────────────────────────────────
console.log(`Fetching NQ=F 1H data (${DAYS} days)...`);
const raw = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/NQ%3DF?interval=1h&range=730d');
const result = raw.chart?.result?.[0];
const ts = result.timestamp;
const q  = result.indicators.quote[0];

let allBars = [];
for (let i = 0; i < ts.length; i++) {
  if (q.open[i] && q.high[i] && q.low[i] && q.close[i] && q.volume[i] > 0) {
    allBars.push({ t: ts[i] * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] });
  }
}

const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;
const bars   = allBars.filter(b => b.t >= cutoff);
console.log(`Using ${bars.length} bars | ${new Date(bars[0].t).toISOString().slice(0,10)} to ${new Date(bars[bars.length-1].t).toISOString().slice(0,10)}`);

// ── Indicators ────────────────────────────────────────────────────────────────
function ema(arr, p) {
  const k = 2 / (p + 1); let e = arr[0];
  return arr.map(v => { e = v * k + e * (1 - k); return e; });
}
const closes = bars.map(b => b.c);
const vols   = bars.map(b => b.v);
const e21    = ema(closes, EMA_S);
const e50    = ema(closes, EMA_L);

function volSma(i, p = 20) {
  if (i < p) return null;
  let s = 0; for (let j = i - p; j < i; j++) s += vols[j]; return s / p;
}

// ── Simulate ──────────────────────────────────────────────────────────────────
let balance  = START_BAL;
let peak     = START_BAL;
let maxDD    = 0;
let inTrade  = false;
let trade    = {};
const trades = [];
const monthly = {};

function monthKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function initMonth(k) {
  if (!monthly[k]) monthly[k] = { trades: 0, wins: 0, pnl: 0, startBal: balance };
}

for (let i = Math.max(EMA_L + 1, 20); i < bars.length; i++) {
  const b    = bars[i];
  const prev = bars[i - 1];
  const h    = new Date(b.t).getUTCHours();
  const inRTH = h >= RTH_START && h < RTH_END;

  // ── Exit check ───────────────────────────────────────────────────────────
  if (inTrade) {
    const held   = i - trade.entryBar;
    const isLong = trade.dir === 'LONG';
    let closed = false, exitPrice = 0, reason = '';

    if (isLong  && b.l <= trade.sl) { exitPrice = trade.sl; reason = 'SL'; closed = true; }
    else if (!isLong && b.h >= trade.sl) { exitPrice = trade.sl; reason = 'SL'; closed = true; }
    else if (isLong  && b.h >= trade.tp) { exitPrice = trade.tp; reason = 'TP'; closed = true; }
    else if (!isLong && b.l <= trade.tp) { exitPrice = trade.tp; reason = 'TP'; closed = true; }
    else if (held >= MAX_HOLD)           { exitPrice = b.c;      reason = 'TIME'; closed = true; }

    if (closed) {
      const rawPct = isLong
        ? (exitPrice - trade.entry) / trade.entry
        : (trade.entry - exitPrice) / trade.entry;
      const pnl = balance * RISK_PCT * LEVERAGE * (rawPct / SL_PCT);
      balance += pnl;
      peak     = Math.max(peak, balance);
      const dd = (peak - balance) / peak * 100;
      maxDD    = Math.max(maxDD, dd);
      const mk = monthKey(b.t);
      initMonth(mk);
      monthly[mk].trades++;
      monthly[mk].pnl += pnl;
      if (pnl > 0) monthly[mk].wins++;
      trades.push({ dir: trade.dir, entry: trade.entry, exit: exitPrice, reason, pnl, pnlPct: rawPct * 100, time: new Date(b.t).toISOString().slice(0, 13) });
      inTrade = false;
    }
  }

  // ── Entry check ──────────────────────────────────────────────────────────
  if (!inTrade && inRTH) {
    const ema50Rising = e50[i] > e50[i - EMA_TREND_LB];
    const ema50Fall   = e50[i] < e50[i - EMA_TREND_LB];
    const vs          = volSma(i);
    const volOk       = vs && b.v > VOL_MULT * vs;

    const longSig  = prev.c < e21[i - 1] && b.c > e21[i] && ema50Rising && volOk;
    const shortSig = prev.c > e21[i - 1] && b.c < e21[i] && ema50Fall   && volOk;

    if (longSig || shortSig) {
      const dir = longSig ? 'LONG' : 'SHORT';
      trade = {
        dir,
        entry:    b.c,
        sl:       longSig ? b.c * (1 - SL_PCT) : b.c * (1 + SL_PCT),
        tp:       longSig ? b.c * (1 + TP_PCT) : b.c * (1 - TP_PCT),
        entryBar: i,
      };
      inTrade = true;
    }
  }
}

// ── Output ────────────────────────────────────────────────────────────────────
const wins   = trades.filter(t => t.pnl > 0).length;
const losses = trades.filter(t => t.pnl <= 0).length;
const wr     = wins / (trades.length || 1) * 100;
const grossW = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
const grossL = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
const pf     = grossW / (grossL || 1);
const ret    = (balance - START_BAL) / START_BAL * 100;
const fmtD   = n => (n >= 0 ? '+' : '') + '$' + Math.abs(n).toFixed(0);

console.log('\n' + '='.repeat(80));
console.log(`  NQ FUTURES — DT STRATEGY BACKTEST  |  ${DAYS} days  |  $${START_BAL.toLocaleString()} start`);
console.log(`  Timeframe: 1H (proxy for 15m)  |  RTH only (13:30-21:00 UTC = 9:30am-5pm ET)`);
console.log(`  SL: ${(SL_PCT*100).toFixed(2)}%  |  TP: ${(TP_PCT*100).toFixed(2)}%  |  R:R 1.3  |  ${LEVERAGE}x leverage  |  0.8% risk/trade`);
console.log('='.repeat(80));

console.log(`\n  Total trades:   ${trades.length}  (${(trades.length / (DAYS/30)).toFixed(1)}/month avg)`);
console.log(`  Win rate:       ${wr.toFixed(1)}%`);
console.log(`  Profit factor:  ${pf.toFixed(2)}`);
console.log(`  Max drawdown:   ${maxDD.toFixed(1)}%`);
console.log(`  Final balance:  $${balance.toFixed(0)}  (${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%)`);
console.log(`  Total P&L:      ${fmtD(balance - START_BAL)}`);
console.log(`  Exit breakdown: TP=${trades.filter(t=>t.reason==='TP').length}  SL=${trades.filter(t=>t.reason==='SL').length}  TIME=${trades.filter(t=>t.reason==='TIME').length}`);

// Monthly breakdown
console.log('\n' + '-'.repeat(80));
console.log('  MONTH-BY-MONTH BREAKDOWN');
console.log('-'.repeat(80));
console.log(`  ${'Month'.padEnd(10)} ${'Tr'.padStart(4)} ${'W'.padStart(4)} ${'WR'.padStart(5)} ${'P&L'.padStart(10)} ${'Month%'.padStart(8)} ${'Balance'.padStart(11)} ${'CumRet%'.padStart(10)}`);
console.log('  ' + '-'.repeat(65));

let runBal = START_BAL;
const months = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
for (const mk of Object.keys(monthly).sort()) {
  const m   = monthly[mk];
  runBal   += m.pnl;
  const wr_ = (m.wins / (m.trades || 1) * 100).toFixed(0) + '%';
  const monPct = (m.pnl / m.startBal * 100);
  const cumRet = (runBal - START_BAL) / START_BAL * 100;
  const [yr, mo] = mk.split('-');
  const label = `${months[+mo]} ${yr}`;
  const pnlStr   = fmtD(m.pnl).padStart(10);
  const monStr   = ((monPct >= 0 ? '+' : '') + monPct.toFixed(1) + '%').padStart(8);
  const balStr   = ('$' + runBal.toFixed(0)).padStart(11);
  const cumStr   = ((cumRet >= 0 ? '+' : '') + cumRet.toFixed(1) + '%').padStart(10);
  console.log(`  ${label.padEnd(10)} ${String(m.trades).padStart(4)} ${String(m.wins).padStart(4)} ${wr_.padStart(5)} ${pnlStr} ${monStr} ${balStr} ${cumStr}`);
}

// Comparison table
console.log('\n' + '-'.repeat(80));
console.log('  NQ vs CRYPTO DT — SIDE BY SIDE');
console.log('-'.repeat(80));
const rows = [
  ['Return (150d)',   `${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%`,        '~+600-700%'],
  ['Win rate',        `${wr.toFixed(1)}%`,                                '55-59%'],
  ['Profit factor',   `${pf.toFixed(2)}`,                                 '1.48-1.60'],
  ['Max drawdown',    `${maxDD.toFixed(1)}%`,                             '33-40%'],
  ['Trades (150d)',   `${trades.length}`,                                  '~220'],
  ['Avg trades/mo',   `${(trades.length/(DAYS/30)).toFixed(1)}`,          '~18'],
  ['SL',              `${(SL_PCT*100).toFixed(2)}%`,                      '0.65%'],
  ['TP',              `${(TP_PCT*100).toFixed(2)}%`,                      '0.85%'],
  ['Session filter',  'RTH (13:30-21 UTC)',                               'London+NY'],
  ['Instrument',      'NQ (index future)',                                 'BTC/XRP/SUI/etc'],
];
console.log(`  ${'Metric'.padEnd(18)} ${'NQ Futures (1H)'.padEnd(22)} Crypto DT (15m)`);
console.log('  ' + '-'.repeat(60));
for (const [m, nq, cr] of rows) {
  console.log(`  ${m.padEnd(18)} ${nq.padEnd(22)} ${cr}`);
}
console.log('\n  NOTE: NQ 1H proxy fires ~4x fewer signals than actual 15m would.');
console.log('  Real 15m NQ backtest would show significantly more trades.');
console.log('  Crypto return advantage is largely due to higher underlying volatility.\n');
