/**
 * backtest_pivot.mjs — Standalone Pivot Point Strategy
 *
 * Daily classic pivots (PP, R1, R2, S1, S2) calculated from previous UTC day OHLC.
 * Signal detection on 4H candles (same timeframe as v09).
 *
 * LONG signal:
 *   • 4H bar closes above PP for the first time that day
 *   • RSI(14) > 50
 *   • Price > EMA(50)
 *   • MACD histogram > 0
 *   → Enter next bar open
 *   → TP: R1 (dynamic — next resistance)
 *   → SL: S1 (dynamic — next support)
 *
 * SHORT signal (inverse):
 *   • 4H bar closes below PP for the first time that day
 *   • RSI < 50, price < EMA50, MACD hist < 0
 *   → TP: S1, SL: R1
 *
 * Validity checks:
 *   • TP must be beyond entry (else skip)
 *   • SL must be on correct side of entry (else skip)
 *   • Max SL cap: 7% (skip if wider — day too volatile)
 *   • Min SL: 1% (skip if pivots too compressed)
 *
 * Run: node backtest_pivot.mjs [DAYS] [START_BAL]
 */

import https from 'https';

const DAYS    = parseInt(process.argv[2] || '365');
const CAPITAL = parseFloat(process.argv[3] || '5000');
const INTERVAL = '4h';
const MAX_POS  = 10;
const RISK_PCT = 0.008;
const MAX_SL   = 0.07;   // skip trade if SL > 7%
const MIN_SL   = 0.01;   // skip trade if SL < 1% (levels too compressed)

const PAIRS = [
  'KAIAUSDT','SUSDT',    'FILUSDT',  'ARUSDT',    'PLUMEUSDT',
  'FIDAUSDT','GMTUSDT',  'ENAUSDT',  'TIAUSDT',   'TURBOUSDT',
  'WIFUSDT', 'SHIBUSDT', 'BCHUSDT',  'VETUSDT',   'ONDOUSDT',
  'THETAUSDT','HBARUSDT','RUNEUSDT', 'IOTAUSDT',  'JUPUSDT',
  'FLUXUSDT','WUSDT',    'CATIUSDT', 'ZKUSDT',    'KAITOUSDT',
  'WLDUSDT', 'AIXBTUSDT','LAUSDT',   'JASMYUSDT', 'HOMEUSDT',
];

// ─── Fetch ────────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol) {
  const end   = Date.now();
  const start = end - (DAYS + 90) * 86400000;
  const bars  = [];
  let from = start;
  while (from < end) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&startTime=${from}&endTime=${end}&limit=1000`;
    const page = await new Promise((res, rej) => {
      https.get(url, r => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => { try { res(JSON.parse(d)); } catch(e) { rej(e); } });
      }).on('error', rej);
    });
    if (!Array.isArray(page) || !page.length) break;
    bars.push(...page);
    from = page[page.length-1][0] + 1;
    if (page.length < 1000) break;
    await delay(80);
  }
  return bars.map(k => ({
    time:   parseInt(k[0]),
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function ema(v, p) {
  const k = 2/(p+1), r = [v[0]];
  for (let i = 1; i < v.length; i++) r.push(v[i]*k + r[i-1]*(1-k));
  return r;
}
function sma(v, p) {
  return v.map((_, i) => i < p-1 ? null : v.slice(i-p+1,i+1).reduce((a,b)=>a+b,0)/p);
}
function rsiSeries(closes, p=14) {
  const r = new Array(closes.length).fill(null);
  for (let i = p; i < closes.length; i++) {
    let g=0, l=0;
    for (let j=i-p+1; j<=i; j++) { const d=closes[j]-closes[j-1]; d>0?g+=d:l-=d; }
    r[i] = l===0 ? 100 : 100 - 100/(1+(g/p)/(l/p));
  }
  return r;
}
function macdSeries(closes, f=12, s=26, sig=9) {
  const fast=ema(closes,f), slow=ema(closes,s);
  const ml=closes.map((_,i)=>fast[i]-slow[i]);
  const sl=[ml[0]]; const k=2/(sig+1);
  for (let i=1; i<closes.length; i++) sl.push(ml[i]*k+sl[i-1]*(1-k));
  return { hist: ml.map((v,i)=>v-sl[i]) };
}

// ─── Pivots ───────────────────────────────────────────────────────────────────

function calcPivots(H, L, C) {
  const pp = (H + L + C) / 3;
  const r1 = 2 * pp - L;
  const r2 = pp + (H - L);
  const s1 = 2 * pp - H;
  const s2 = pp - (H - L);
  return { pp, r1, r2, s1, s2 };
}

// Group 4H candles by UTC date → get daily OHLC
function buildDailyOHLC(candles) {
  const days = {};
  for (const c of candles) {
    const day = new Date(c.time).toISOString().slice(0, 10);
    if (!days[day]) days[day] = { H: -Infinity, L: Infinity, C: 0, open: c.open };
    days[day].H = Math.max(days[day].H, c.high);
    days[day].L = Math.min(days[day].L, c.low);
    days[day].C = c.close; // last bar's close becomes day's close
  }
  return days;
}

// Get sorted day keys and return previous day's pivots for a given date string
function getPivots(dayStr, dailyOHLC, sortedDays) {
  const idx = sortedDays.indexOf(dayStr);
  if (idx < 1) return null;
  const prev = sortedDays[idx - 1];
  const d = dailyOHLC[prev];
  if (!d || d.H === -Infinity) return null;
  return calcPivots(d.H, d.L, d.C);
}

// ─── Regime ───────────────────────────────────────────────────────────────────

function getRegime(i, closes, e21, e50, e200) {
  if (!e200[i]) return 'neutral';
  const c = closes[i]; let s = 0;
  if (c > e200[i]) s++; else s--;
  if (c > e50[i])  s++; else s--;
  if (c > e21[i])  s++; else s--;
  if (e21[i] > e50[i])  s++; else s--;
  if (e50[i] > e200[i]) s++; else s--;
  return s >= 4 ? 'bull' : s <= -4 ? 'bear' : 'neutral';
}

function riskDollars(balance, reg, dir) {
  const base = Math.max(balance * RISK_PCT, 2);
  if (reg === 'neutral') return base * 0.75;
  const wt = (reg==='bull'&&dir==='LONG')||(reg==='bear'&&dir==='SHORT');
  return wt ? base : base * 0.5;
}

// ─── Simulation ───────────────────────────────────────────────────────────────

function runSim(allData) {
  let balance = CAPITAL;
  const open  = new Map();
  const trades = [];
  const monthly = {};
  let skipped = 0, signals = 0;

  // Track which day we fired a signal for each pair (one signal per pair per day)
  const firedToday = new Map();

  const timeline = [];
  for (const d of allData)
    for (let i = 0; i < d.candles.length; i++)
      timeline.push({ sym: d.symbol, i, time: d.candles[i].time });
  timeline.sort((a,b) => a.time - b.time);

  const cutoff = Date.now() - DAYS * 86400000;

  for (const { sym, i, time } of timeline) {
    if (time < cutoff) continue;
    const d   = allData.find(x => x.symbol===sym);
    const bar = d.candles[i];
    const ym  = new Date(time).toISOString().slice(0,7);
    if (!monthly[ym]) monthly[ym] = { pnl:0, trades:0, longs:0, shorts:0 };

    const dayStr = new Date(time).toISOString().slice(0,10);

    // ── Exit existing position ────────────────────────────────────────────────
    if (open.has(sym)) {
      const pos = open.get(sym);
      const { dir, sl, tp, size, slPct, tpPct } = pos;
      let closed=false, won=false, pnlDollar=0;

      if (dir==='LONG') {
        if      (bar.open<=sl) { pnlDollar=-(size*slPct); closed=true; }
        else if (bar.open>=tp) { pnlDollar=  size*tpPct;  closed=true; won=true; }
        else if (bar.low <=sl) { pnlDollar=-(size*slPct); closed=true; }
        else if (bar.high>=tp) { pnlDollar=  size*tpPct;  closed=true; won=true; }
      } else {
        if      (bar.open>=sl) { pnlDollar=-(size*slPct); closed=true; }
        else if (bar.open<=tp) { pnlDollar=  size*tpPct;  closed=true; won=true; }
        else if (bar.high>=sl) { pnlDollar=-(size*slPct); closed=true; }
        else if (bar.low <=tp) { pnlDollar=  size*tpPct;  closed=true; won=true; }
      }
      if (closed) {
        balance += pnlDollar;
        trades.push({ sym, dir, won, pnl: pnlDollar });
        monthly[ym].pnl += pnlDollar;
        monthly[ym].trades++;
        dir==='LONG' ? monthly[ym].longs++ : monthly[ym].shorts++;
        open.delete(sym);
      }
    }

    // ── Signal detection ─────────────────────────────────────────────────────
    if (open.has(sym) || open.size >= MAX_POS || i < 55 || balance < 10) continue;

    // One pivot signal per pair per day
    const firedKey = `${sym}:${dayStr}`;
    if (firedToday.has(firedKey)) continue;

    const { closes, e21, e50, e200, rsi14, mc } = d;
    const pivots = getPivots(dayStr, d.dailyOHLC, d.sortedDays);
    if (!pivots) continue;

    const { pp, r1, r2, s1, s2 } = pivots;
    const c    = closes[i];
    const rNow = rsi14[i];
    if (rNow == null) continue;
    const reg  = getRegime(i, closes, e21, e50, e200);
    const macdH = mc.hist[i];

    let dir = null;

    // LONG: close crosses above PP
    if (c > pp && closes[i-1] <= pp && rNow > 50 && c > e50[i] && macdH > 0) {
      dir = 'LONG';
    }
    // SHORT: close crosses below PP
    else if (c < pp && closes[i-1] >= pp && rNow < 50 && c < e50[i] && macdH < 0) {
      dir = 'SHORT';
    }

    if (!dir) continue;

    const nextBar = d.candles[i+1];
    if (!nextBar) continue;

    signals++;
    const entry = nextBar.open;

    // Dynamic SL/TP from pivot levels
    let sl, tp;
    if (dir === 'LONG') {
      tp = r1;
      sl = s1;
    } else {
      tp = s1;
      sl = r1;
    }

    // Validity checks
    if (dir === 'LONG'  && (tp <= entry || sl >= entry)) { skipped++; continue; }
    if (dir === 'SHORT' && (tp >= entry || sl <= entry)) { skipped++; continue; }

    const slPct = Math.abs(entry - sl) / entry;
    const tpPct = Math.abs(entry - tp) / entry;

    if (slPct > MAX_SL || slPct < MIN_SL) { skipped++; continue; }

    const risk = riskDollars(balance, reg, dir);
    const size = risk / slPct;

    open.set(sym, { dir, entry, sl, tp, size, slPct, tpPct });
    firedToday.set(firedKey, true);
    dir==='LONG' ? monthly[ym].longs++ : monthly[ym].shorts++;
  }

  // Close remainders at last price
  for (const [sym, pos] of open) {
    const d    = allData.find(x => x.symbol===sym);
    const last = d.candles[d.candles.length-1];
    const { dir, entry, size, slPct, tpPct } = pos;
    const pnl  = dir==='LONG'
      ? (last.close - entry)/entry * size
      : (entry - last.close)/entry * size;
    balance += pnl;
    trades.push({ sym, dir, won: pnl>0, pnl });
  }

  const wins  = trades.filter(t=>t.won).length;
  const wr    = trades.length ? wins/trades.length*100 : 0;
  const pnl   = balance - CAPITAL;
  const ret   = pnl/CAPITAL*100;
  const gw    = trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
  const gl    = Math.abs(trades.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0));
  const pf    = gl ? gw/gl : gw>0 ? Infinity : 0;
  let peak=CAPITAL, dd=0, run=CAPITAL;
  for (const t of trades) {
    run+=t.pnl;
    if (run>peak) peak=run;
    const d2=(peak-run)/peak*100; if (d2>dd) dd=d2;
  }
  const longs  = trades.filter(t=>t.dir==='LONG');
  const shorts = trades.filter(t=>t.dir==='SHORT');
  const lwr    = longs.length  ? longs.filter(t=>t.won).length/longs.length*100  : null;
  const swr    = shorts.length ? shorts.filter(t=>t.won).length/shorts.length*100 : null;
  const lpnl   = longs.reduce((s,t)=>s+t.pnl,0);
  const spnl   = shorts.reduce((s,t)=>s+t.pnl,0);

  return { balance, pnl, ret, trades:trades.length, wins, wr, pf, dd,
           monthly, signals, skipped, longs, shorts, lwr, swr, lpnl, spnl };
}

// ─── Display ─────────────────────────────────────────────────────────────────

const $  = n => (n>=0?'+$':'-$')+Math.abs(n).toFixed(0);
const pc = n => (n>=0?'+':'')+n.toFixed(1)+'%';
const bar72 = '═'.repeat(72);

function printResults(r) {
  const emoji = r.pnl >= 0 ? '📈' : '📉';
  console.log(`\n${bar72}`);
  console.log(`  PIVOT POINT STANDALONE  ${emoji}  ${DAYS}d  |  $${CAPITAL.toLocaleString()} start`);
  console.log(`  PP breakout → TP: R1  SL: S1  |  4H timeframe  |  30 pairs`);
  console.log(bar72);
  console.log(`\n  Final balance : $${r.balance.toFixed(0)}  (${pc(r.ret)})`);
  console.log(`  P&L           : ${$(r.pnl)}`);
  console.log(`  Trades        : ${r.trades}  (signals: ${r.signals}, skipped: ${r.skipped})`);
  console.log(`  Win rate      : ${r.wr.toFixed(1)}%`);
  console.log(`  Profit factor : ${r.pf.toFixed(2)}`);
  console.log(`  Max drawdown  : ${r.dd.toFixed(1)}%`);

  if (r.longs.length) console.log(`  Longs         : ${r.longs.length}t  WR ${r.lwr?.toFixed(1)}%  P&L ${$(r.lpnl)}`);
  if (r.shorts.length) console.log(`  Shorts        : ${r.shorts.length}t  WR ${r.swr?.toFixed(1)}%  P&L ${$(r.spnl)}`);

  console.log(`\n  MONTHLY`);
  console.log(`  ${'Month'.padEnd(10)}${'P&L'.padEnd(12)}${'Trades'.padEnd(9)}${'L/S'}`);
  console.log(`  ${'─'.repeat(42)}`);
  for (const [ym, ms] of Object.entries(r.monthly).sort(([a],[b])=>a.localeCompare(b))) {
    const bar = ms.pnl >= 0
      ? '█'.repeat(Math.min(Math.round(ms.pnl/200),12))
      : ('(')+'░'.repeat(Math.min(Math.round(-ms.pnl/200),12))+')';
    console.log(`  ${ym.padEnd(10)}${$(ms.pnl).padEnd(12)}${String(ms.trades).padEnd(9)}${ms.longs||0}L/${ms.shorts||0}S  ${bar}`);
  }
  console.log(bar72);

  // Compare to v09 and DT
  console.log(`\n  CONTEXT vs EXISTING STRATEGIES (same $5k start, 365d)`);
  console.log(`  ${'Strategy'.padEnd(22)}${'Return'.padEnd(12)}${'WR'.padEnd(10)}${'DD'}`);
  console.log(`  ${'─'.repeat(52)}`);
  console.log(`  ${'v09 (live bot)'.padEnd(22)}${'~+300%+'.padEnd(12)}${'~37%'.padEnd(10)}${'~23%'}`);
  console.log(`  ${'DT (live bot)'.padEnd(22)}${'+821%'.padEnd(12)}${'55.7%'.padEnd(10)}${'33.9%'}`);
  console.log(`  ${'Pivot (this)'.padEnd(22)}${pc(r.ret).padEnd(12)}${(r.wr.toFixed(1)+'%').padEnd(10)}${r.dd.toFixed(1)+'%'}`);
  console.log(bar72+'\n');
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\n${bar72}`);
  console.log(`  PIVOT POINT BACKTEST  |  ${DAYS}d  |  $${CAPITAL.toLocaleString()}  |  ${PAIRS.length} pairs`);
  console.log(`  Signal: PP crossover + RSI>50 + EMA50 + MACD hist`);
  console.log(`  Entry: next bar open  |  TP: R1  |  SL: S1  |  max SL: 7%`);
  console.log(bar72);
  console.log(`\n  Fetching ${PAIRS.length} pairs (4H)...\n`);

  const allData = [];
  for (const symbol of PAIRS) {
    try {
      const candles = await fetchKlines(symbol);
      if (candles.length < 100) { console.log(`  ${symbol.padEnd(14)} ⚠️  insufficient`); continue; }
      const closes   = candles.map(c=>c.close);
      const e21      = ema(closes, 21);
      const e50      = ema(closes, 50);
      const e200     = ema(closes, 200);
      const rsi14    = rsiSeries(closes, 14);
      const mc       = macdSeries(closes);
      const dailyOHLC = buildDailyOHLC(candles);
      const sortedDays = Object.keys(dailyOHLC).sort();
      allData.push({ symbol, candles, closes, e21, e50, e200, rsi14, mc, dailyOHLC, sortedDays });
      process.stdout.write(`  ${symbol.padEnd(14)} ${candles.length} bars ✓\n`);
    } catch(e) {
      console.log(`  ${symbol.padEnd(14)} ❌ ${e.message}`);
    }
    await delay(60);
  }

  const r = runSim(allData);
  printResults(r);
})().catch(console.error);
