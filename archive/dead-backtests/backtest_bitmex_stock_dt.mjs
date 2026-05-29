import https from 'https';

// ── Config ────────────────────────────────────────────────────────────────────
const SYMBOL    = process.argv[2] || 'SPYUSDT';
const DAYS      = 150;
const START_BAL = 5000;
const LEVERAGE  = 5;
const RISK_PCT  = 0.008;       // 0.8% risk per trade
const SL_PCT    = 0.0042;      // 0.42% SL (calibrated for stock futures 15m)
const TP_PCT    = SL_PCT * 1.3;
const VOL_MULT  = 1.2;
const EMA_S     = 21;
const EMA_L     = 50;
const EMA_LB    = 4;
const MAX_HOLD  = 12;          // 12 × 15m = 3h max hold
// RTH: 13:30–20:00 UTC (NYSE 9:30am–4pm ET)
const RTH_START = 13;
const RTH_END   = 20;

function get(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res([]); } });
    }).on('error', rej);
  });
}

// ── Paginated fetch of all 5m bars ────────────────────────────────────────────
const cutoff = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
console.log(`\nFetching ${SYMBOL} 5m bars from ${cutoff} (${DAYS} days)...`);

let raw5m = [], cursor = cutoff, page = 0;
while (true) {
  const url = `https://www.bitmex.com/api/v1/trade/bucketed?binSize=5m&symbol=${SYMBOL}&count=1000&reverse=false&partial=false&startTime=${cursor}`;
  const chunk = await get(url);
  if (!Array.isArray(chunk) || chunk.length === 0) break;
  // Avoid duplicates — skip first bar on subsequent pages (it equals last bar of prior page)
  const slice = page === 0 ? chunk : chunk.slice(1);
  raw5m = raw5m.concat(slice);
  if (chunk.length < 1000) break;
  // Advance cursor to timestamp of last bar
  cursor = chunk[chunk.length - 1].timestamp;
  page++;
  if (page % 5 === 0) process.stdout.write(`  ${raw5m.length} bars fetched...\r`);
  await new Promise(r => setTimeout(r, 350)); // rate limit
}

// Filter nulls and build clean bars
const bars5m = raw5m
  .filter(b => b.open && b.high && b.low && b.close)
  .map(b => ({
    t: new Date(b.timestamp).getTime(),
    o: b.open, h: b.high, l: b.low, c: b.close,
    v: b.volume || 0,
  }));

console.log(`Fetched ${bars5m.length} raw 5m bars`);

// ── Aggregate 5m → 15m ────────────────────────────────────────────────────────
const bars15m = [];
for (let i = 0; i + 2 < bars5m.length; i += 3) {
  const trio = [bars5m[i], bars5m[i + 1], bars5m[i + 2]];
  bars15m.push({
    t: trio[0].t,
    o: trio[0].o,
    h: Math.max(...trio.map(b => b.h)),
    l: Math.min(...trio.map(b => b.l)),
    c: trio[2].c,
    v: trio.reduce((s, b) => s + b.v, 0),
  });
}
console.log(`Aggregated to ${bars15m.length} 15m bars`);
console.log(`Range: ${new Date(bars15m[0].t).toISOString().slice(0, 10)} → ${new Date(bars15m[bars15m.length - 1].t).toISOString().slice(0, 10)}\n`);

// ── Indicators ────────────────────────────────────────────────────────────────
function calcEma(arr, p) {
  const k = 2 / (p + 1); let e = arr[0];
  return arr.map(v => { e = v * k + e * (1 - k); return e; });
}
const closes = bars15m.map(b => b.c);
const vols   = bars15m.map(b => b.v);
const e21    = calcEma(closes, EMA_S);
const e50    = calcEma(closes, EMA_L);

function volSma(i, p = 20) {
  if (i < p) return null;
  let s = 0; for (let j = i - p; j < i; j++) s += vols[j]; return s / p;
}

// ── Simulate ──────────────────────────────────────────────────────────────────
let balance = START_BAL, peak = START_BAL, maxDD = 0;
let inTrade = false, trade = {};
const trades = [], monthly = {};

function mk(t) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function initM(k) { if (!monthly[k]) monthly[k] = { tr: 0, wins: 0, pnl: 0, bal0: balance }; }

for (let i = Math.max(EMA_L + 1, 20); i < bars15m.length; i++) {
  const b = bars15m[i], prev = bars15m[i - 1];
  const h = new Date(b.t).getUTCHours();
  const inRTH = h >= RTH_START && h < RTH_END;

  // Exit
  if (inTrade) {
    const held = i - trade.bar;
    const isLong = trade.dir === 'LONG';
    let closed = false, ep = 0, why = '';
    if      (isLong  && b.l <= trade.sl) { ep = trade.sl; why = 'SL'; closed = true; }
    else if (!isLong && b.h >= trade.sl) { ep = trade.sl; why = 'SL'; closed = true; }
    else if (isLong  && b.h >= trade.tp) { ep = trade.tp; why = 'TP'; closed = true; }
    else if (!isLong && b.l <= trade.tp) { ep = trade.tp; why = 'TP'; closed = true; }
    else if (held >= MAX_HOLD)            { ep = b.c;     why = 'TIME'; closed = true; }
    if (closed) {
      const rawPct = isLong ? (ep - trade.entry) / trade.entry : (trade.entry - ep) / trade.entry;
      const pnl    = balance * RISK_PCT * LEVERAGE * (rawPct / SL_PCT);
      balance += pnl;
      peak = Math.max(peak, balance);
      maxDD = Math.max(maxDD, (peak - balance) / peak * 100);
      const m = mk(b.t); initM(m);
      monthly[m].tr++; monthly[m].pnl += pnl;
      if (pnl > 0) monthly[m].wins++;
      trades.push({ dir: trade.dir, entry: trade.entry, exit: ep, why, pnl, time: new Date(b.t).toISOString().slice(0, 13) });
      inTrade = false;
    }
  }

  // Entry
  if (!inTrade && inRTH) {
    const rising = e50[i] > e50[i - EMA_LB];
    const falling = e50[i] < e50[i - EMA_LB];
    const vs = volSma(i);
    const volOk = vs && b.v > VOL_MULT * vs;
    const longSig  = prev.c < e21[i - 1] && b.c > e21[i] && rising  && volOk;
    const shortSig = prev.c > e21[i - 1] && b.c < e21[i] && falling && volOk;
    if (longSig || shortSig) {
      const dir = longSig ? 'LONG' : 'SHORT';
      trade = {
        dir, entry: b.c,
        sl: longSig ? b.c * (1 - SL_PCT) : b.c * (1 + SL_PCT),
        tp: longSig ? b.c * (1 + TP_PCT) : b.c * (1 - TP_PCT),
        bar: i,
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
const fmtD   = n => (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(0);

console.log('='.repeat(80));
console.log(`  ${SYMBOL} — DT STRATEGY BACKTEST  |  ${DAYS} days  |  $${START_BAL.toLocaleString()} start`);
console.log(`  Real 15m candles (aggregated from 5m)  |  RTH only (13:30–20:00 UTC)`);
console.log(`  SL: ${(SL_PCT * 100).toFixed(2)}%  |  TP: ${(TP_PCT * 100).toFixed(2)}%  |  R:R 1.3  |  ${LEVERAGE}x leverage  |  0.8% risk/trade`);
console.log('='.repeat(80));
console.log(`\n  Total trades:   ${trades.length}  (${(trades.length / (DAYS / 30)).toFixed(1)}/month avg)`);
console.log(`  Win rate:       ${wr.toFixed(1)}%`);
console.log(`  Profit factor:  ${pf.toFixed(2)}`);
console.log(`  Max drawdown:   ${maxDD.toFixed(1)}%`);
console.log(`  Final balance:  $${balance.toFixed(0)}  (${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%)`);
console.log(`  Total P&L:      ${fmtD(balance - START_BAL)}`);
console.log(`  Exit breakdown: TP=${trades.filter(t => t.why === 'TP').length}  SL=${trades.filter(t => t.why === 'SL').length}  TIME=${trades.filter(t => t.why === 'TIME').length}`);

// Monthly
const MNAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
console.log('\n' + '-'.repeat(80));
console.log('  MONTH-BY-MONTH');
console.log('-'.repeat(80));
console.log(`  ${'Month'.padEnd(10)} ${'Tr'.padStart(4)} ${'W'.padStart(4)} ${'WR'.padStart(5)} ${'P&L'.padStart(10)} ${'Month%'.padStart(8)} ${'Balance'.padStart(11)} ${'CumRet%'.padStart(10)}`);
console.log('  ' + '-'.repeat(65));
let runBal = START_BAL;
for (const key of Object.keys(monthly).sort()) {
  const m = monthly[key];
  runBal += m.pnl;
  const [yr, mo] = key.split('-');
  const label   = `${MNAMES[+mo]} ${yr}`;
  const wr_     = (m.wins / (m.tr || 1) * 100).toFixed(0) + '%';
  const monPct  = (m.pnl / m.bal0 * 100);
  const cumRet  = (runBal - START_BAL) / START_BAL * 100;
  console.log(`  ${label.padEnd(10)} ${String(m.tr).padStart(4)} ${String(m.wins).padStart(4)} ${wr_.padStart(5)} ${fmtD(m.pnl).padStart(10)} ${((monPct >= 0 ? '+' : '') + monPct.toFixed(1) + '%').padStart(8)} ${'$' + runBal.toFixed(0).padStart(10)} ${((cumRet >= 0 ? '+' : '') + cumRet.toFixed(1) + '%').padStart(10)}`);
}

// Comparison
console.log('\n' + '-'.repeat(80));
console.log('  VS CRYPTO DT (15m, same params)');
console.log('-'.repeat(80));
console.log(`  ${'Metric'.padEnd(20)} ${SYMBOL.padEnd(18)} Crypto DT`);
console.log('  ' + '-'.repeat(55));
const rows = [
  ['Return (150d)',  `${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%`,   '~+600-700%'],
  ['Win rate',       `${wr.toFixed(1)}%`,                           '55-59%'],
  ['Profit factor',  `${pf.toFixed(2)}`,                            '1.48-1.60'],
  ['Max drawdown',   `${maxDD.toFixed(1)}%`,                        '33-40%'],
  ['Trades/month',   `${(trades.length / (DAYS / 30)).toFixed(1)}`, '~18'],
  ['Session',        'RTH 9:30am-4pm ET',                           'London+NY'],
];
for (const [label, nq, cr] of rows) {
  console.log(`  ${label.padEnd(20)} ${nq.padEnd(18)} ${cr}`);
}
console.log('');
