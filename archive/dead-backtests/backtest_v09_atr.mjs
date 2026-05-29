/**
 * backtest_v09_atr.mjs — v09 Dynamic ATR-based Take Profit
 *
 * Tests replacing v09's fixed 23% TP with ATR(14,4H) × multiplier.
 * Fixed SL stays at 6.5%; only TP is dynamic.
 *
 * Variants:
 *   BASELINE   — fixed TP 23%
 *   ATR × 2.0  — TP = ATR(14) × 2.0 / entry
 *   ATR × 3.0  — TP = ATR(14) × 3.0 / entry
 *   ATR × 4.0  — TP = ATR(14) × 4.0 / entry
 *   ATR × 5.0  — TP = ATR(14) × 5.0 / entry
 *
 * Run: node backtest_v09_atr.mjs [DAYS] [START_BAL]
 *      node backtest_v09_atr.mjs 365 5000
 */

import https from 'https';

const DAYS     = parseInt(process.argv[2] || '365');
const CAPITAL  = parseFloat(process.argv[3] || '5000');
const INTERVAL = '4h';
const MAX_POS  = 10;
const RISK_PCT = 0.008;
const SL_PCT   = 0.065;   // fixed SL
const TP_PCT   = 0.23;    // baseline TP (fixed)
const REB_SL   = 0.035;
const REB_TP   = 0.22;

const PAIRS = [
  'KAIAUSDT','SUSDT',   'FILUSDT', 'ARUSDT',    'PLUMEUSDT',
  'FIDAUSDT','GMTUSDT', 'ENAUSDT', 'TIAUSDT',   'TURBOUSDT',
  'WIFUSDT', 'SHIBUSDT','BCHUSDT', 'VETUSDT',   'ONDOUSDT',
  'THETAUSDT','HBARUSDT','RUNEUSDT','IOTAUSDT',  'JUPUSDT',
  'FLUXUSDT','WUSDT',   'CATIUSDT','ZKUSDT',    'KAITOUSDT',
  'WLDUSDT', 'AIXBTUSDT','LAUSDT',  'JASMYUSDT', 'HOMEUSDT',
];

// ─── Fetch ────────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol) {
  const end   = Date.now();
  const start = end - (DAYS + 60) * 24 * 60 * 60 * 1000;
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

// Wilder ATR(14) — standard for 4H crypto charts
function atrSeries(candles, p=14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < 2) return out;
  const trs = [candles[0].high - candles[0].low];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i-1];
    trs.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low  - prev.close)
    ));
  }
  // Wilder smoothing (RMA): seed with SMA(p), then (prev*(p-1)+current)/p
  if (trs.length < p) return out;
  let atr = trs.slice(0, p).reduce((a,b)=>a+b,0) / p;
  out[p-1] = atr;
  for (let i = p; i < candles.length; i++) {
    atr = (atr * (p-1) + trs[i]) / p;
    out[i] = atr;
  }
  return out;
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
  const withTrend = (reg==='bull'&&dir==='LONG') || (reg==='bear'&&dir==='SHORT');
  return withTrend ? base : base * 0.5;
}

// ─── Signals ─────────────────────────────────────────────────────────────────

function getSignals(i, candles, closes, e21, e50, e200, rsi14, mc, vsma) {
  if (i < 31) return null;
  const rNow = rsi14[i], rPrv = rsi14[i-1];
  const vol  = candles[i].volume;
  if (rNow==null||rPrv==null||vsma[i]==null) return null;
  const c   = closes[i];
  const reg = getRegime(i, closes, e21, e50, e200);

  const high30   = Math.max(...closes.slice(i-30, i));
  const breakout = c > high30;
  const trendUp  = e21[i]>e50[i] && e21[i]>e21[i-1] && e21[i-1]>e21[i-3];
  const rsiLong  = rNow>=54 && rNow<=65;
  const volLong  = vol > vsma[i] * 1.5;
  const long     = breakout && trendUp && rsiLong && volLong;

  const wasOB   = [1,2,3,4,5].some(k => rsi14[i-k]!=null && rsi14[i-k]>=65);
  const rsiBrk  = rPrv>=58 && rNow<58;
  const macdBrk = mc.hist[i-1]>=0 && mc.hist[i]<0;
  const volShrt = vol > vsma[i] * 1.2;
  const short   = wasOB && (rsiBrk||macdBrk) && c<e21[i] && rNow>35 && volShrt;

  const wasOversold  = [1,2,3].some(k => rsi14[i-k]!=null && rsi14[i-k]<=20);
  const rsiUp        = rPrv<=30 && rNow>30;
  const notFalling   = c > e21[i]*0.92;
  const longRebound  = wasOversold && rsiUp && reg==='bull' && notFalling && vol>vsma[i]*1.0 && !long;

  const wasOverbought = [1,2,3].some(k => rsi14[i-k]!=null && rsi14[i-k]>=80);
  const rsiDown       = rPrv>=70 && rNow<70;
  const notMelting    = c < e21[i]*1.08;
  const shortRebound  = wasOverbought && rsiDown && reg!=='bull' && notMelting && vol>vsma[i]*1.0 && !short;

  if (!long && !short && !longRebound && !shortRebound) return null;
  let dir = null, type = null;
  if      (long)         { dir='LONG';  type='BREAKOUT'; }
  else if (short)        { dir='SHORT'; type='BREAKDOWN'; }
  else if (longRebound)  { dir='LONG';  type='REBOUND'; }
  else if (shortRebound) { dir='SHORT'; type='REBOUND'; }
  return { dir, type, reg };
}

// ─── Simulation ───────────────────────────────────────────────────────────────
// atrMult: null = use fixed TP, number = use ATR × mult for TP

function runSim(allData, atrMult) {
  let balance = CAPITAL;
  const open  = new Map();
  const trades = [];
  const monthly = {};

  const timeline = [];
  for (const d of allData)
    for (let i = 0; i < d.candles.length; i++)
      timeline.push({ sym: d.symbol, i, time: d.candles[i].time });
  timeline.sort((a,b) => a.time - b.time);

  const cutoff = Date.now() - DAYS * 86400000;
  const entries = timeline.filter(e => e.time >= cutoff);

  for (const { sym, i, time } of entries) {
    const d   = allData.find(x => x.symbol===sym);
    const bar = d.candles[i];
    const ym  = new Date(time).toISOString().slice(0,7);
    if (!monthly[ym]) monthly[ym] = { pnl: 0, trades: 0 };

    // ── Check exits ───────────────────────────────────────────────────────
    if (open.has(sym)) {
      const pos = open.get(sym);
      const { dir, entry, sl, tp, size, slPct, tpPct } = pos;
      let closed=false, won=false, pnlDollar=0;
      if (dir==='LONG') {
        if      (bar.open<=sl) { pnlDollar=-(size*slPct); closed=true; }
        else if (bar.open>=tp) { pnlDollar= (size*tpPct); closed=true; won=true; }
        else if (bar.low <=sl) { pnlDollar=-(size*slPct); closed=true; }
        else if (bar.high>=tp) { pnlDollar= (size*tpPct); closed=true; won=true; }
      } else {
        if      (bar.open>=sl) { pnlDollar=-(size*slPct); closed=true; }
        else if (bar.open<=tp) { pnlDollar= (size*tpPct); closed=true; won=true; }
        else if (bar.high>=sl) { pnlDollar=-(size*slPct); closed=true; }
        else if (bar.low <=tp) { pnlDollar= (size*tpPct); closed=true; won=true; }
      }
      if (closed) {
        balance += pnlDollar;
        trades.push({ sym, dir, won, pnl: pnlDollar, type: pos.type,
                      slPct, tpPct, entry });
        monthly[ym].pnl += pnlDollar;
        monthly[ym].trades++;
        open.delete(sym);
      }
    }

    // ── New signal ────────────────────────────────────────────────────────
    const canFade = !open.has(sym) && open.size < MAX_POS && balance > 10;
    if (canFade && i > 0) {
      const { closes, e21, e50, e200, rsi14, mc, vsma, atr } = d;
      const sig = getSignals(i, d.candles, closes, e21, e50, e200, rsi14, mc, vsma);
      if (sig) {
        const { dir, type, reg } = sig;
        const slPct_  = type==='REBOUND' ? REB_SL : SL_PCT;
        const risk    = riskDollars(balance, reg, dir);

        // TP: fixed or ATR-based
        let tpPct_;
        if (atrMult === null) {
          tpPct_ = type==='REBOUND' ? REB_TP : TP_PCT;
        } else {
          // ATR TP: use signal candle's ATR × multiplier / entry price
          const atrVal = atr[i];
          if (atrVal === null || !d.candles[i+1]) continue;
          const nextOpen = d.candles[i+1].open;
          tpPct_ = (atrVal * atrMult) / nextOpen;
          // Floor/cap for sanity: at least 5%, at most 60%
          tpPct_ = Math.max(0.05, Math.min(0.60, tpPct_));
        }

        const nextBar = d.candles[i+1];
        if (!nextBar) continue;
        const entry = nextBar.open;
        const sl    = dir==='LONG'  ? entry*(1-slPct_) : entry*(1+slPct_);
        const tp    = dir==='LONG'  ? entry*(1+tpPct_) : entry*(1-tpPct_);
        const size  = risk / slPct_;
        open.set(sym, { dir, entry, sl, tp, size, slPct: slPct_, tpPct: tpPct_, type });
      }
    }
  }

  // Close remaining positions
  for (const [sym, pos] of open) {
    const d    = allData.find(x => x.symbol===sym);
    const last = d.candles[d.candles.length-1];
    const { dir, entry, size, slPct, tpPct } = pos;
    const pnl  = dir==='LONG'
      ? (last.close - entry)/entry * size
      : (entry - last.close)/entry * size;
    balance += pnl;
    trades.push({ sym, dir, won: pnl>0, pnl, type: pos.type, slPct, tpPct, entry });
  }

  const wins  = trades.filter(t=>t.won).length;
  const wr    = trades.length ? wins/trades.length*100 : 0;
  const pnl   = balance - CAPITAL;
  const ret   = pnl/CAPITAL*100;
  const gw    = trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
  const gl    = Math.abs(trades.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0));
  const pf    = gl ? gw/gl : Infinity;

  let peak=CAPITAL, dd=0, run=CAPITAL;
  for (const t of trades) {
    run += t.pnl;
    if (run>peak) peak=run;
    const d=(peak-run)/peak*100;
    if (d>dd) dd=d;
  }

  // Average TP% across trades (for ATR variants)
  const avgTp = trades.length ? trades.reduce((s,t)=>s+t.tpPct,0)/trades.length*100 : 0;
  const avgRR = trades.length ? trades.reduce((s,t)=>s+(t.tpPct/t.slPct),0)/trades.length : 0;

  // Signal type breakdown
  const byType = {};
  for (const t of trades) {
    if (!byType[t.type]) byType[t.type] = { trades:0, wins:0, pnl:0 };
    byType[t.type].trades++;
    byType[t.type].wins += t.won?1:0;
    byType[t.type].pnl  += t.pnl;
  }

  return { balance, pnl, ret, trades: trades.length, wins, wr, pf, dd, monthly, byType, avgTp, avgRR };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const bar = '═'.repeat(100);
  console.log(`\n${bar}`);
  console.log(`  v09 DYNAMIC ATR TAKE PROFIT — ${DAYS}d, $${CAPITAL.toLocaleString()}`);
  console.log(`${bar}\n`);

  // Fetch all pairs
  console.log(`Fetching 4H candles for ${PAIRS.length} pairs...`);
  const allData = [];
  for (const sym of PAIRS) {
    process.stdout.write(`  ${sym.padEnd(14)}`);
    try {
      const candles = await fetchKlines(sym);
      if (candles.length < 50) { console.log(`skip (${candles.length} bars)`); continue; }
      const closes = candles.map(c => c.close);
      const vols   = candles.map(c => c.volume);
      allData.push({
        symbol: sym, candles,
        closes,
        e21:   ema(closes, 21),
        e50:   ema(closes, 50),
        e200:  ema(closes, 200),
        rsi14: rsiSeries(closes),
        mc:    macdSeries(closes),
        vsma:  sma(vols, 20),
        atr:   atrSeries(candles, 14),
      });
      console.log(`${candles.length} bars`);
    } catch(e) {
      console.log(`error: ${e.message}`);
    }
    await delay(100);
  }

  console.log(`\nLoaded ${allData.length}/${PAIRS.length} pairs\n`);

  // Run all variants
  const variants = [
    { label: 'BASELINE (fixed 23%)', mult: null   },
    { label: 'ATR × 2.0',            mult: 2.0    },
    { label: 'ATR × 3.0',            mult: 3.0    },
    { label: 'ATR × 4.0',            mult: 4.0    },
    { label: 'ATR × 5.0',            mult: 5.0    },
    { label: 'ATR × 6.0',            mult: 6.0    },
  ];

  const results = [];
  for (const v of variants) {
    process.stdout.write(`  Running ${v.label.padEnd(22)}... `);
    const r = runSim(allData, v.mult);
    results.push({ label: v.label, mult: v.mult, ...r });
    process.stdout.write(`done  ${r.trades} trades  WR ${r.wr.toFixed(1)}%  Ret ${r.ret >= 0 ? '+' : ''}${r.ret.toFixed(1)}%`);
    if (v.mult !== null) process.stdout.write(`  avgTP ${r.avgTp.toFixed(1)}%  avgRR ${r.avgRR.toFixed(2)}x`);
    process.stdout.write('\n');
  }

  // ── Summary table ────────────────────────────────────────────────────────────
  console.log(`\n${bar}`);
  console.log('  COMPARISON TABLE');
  console.log(`${bar}`);
  console.log(`  ${'Variant'.padEnd(24)} ${'Trades'.padStart(7)} ${'WR%'.padStart(6)} ${'PF'.padStart(6)} ${'Return%'.padStart(9)} ${'DD%'.padStart(6)} ${'AvgTP%'.padStart(8)} ${'AvgRR'.padStart(7)}`);
  console.log(`  ${'─'.repeat(80)}`);

  for (const r of results) {
    const sign = r.ret >= 0 ? '+' : '';
    const tp   = r.mult === null ? '23.0' : r.avgTp.toFixed(1);
    const rr   = r.mult === null ? (0.23/0.065).toFixed(2) : r.avgRR.toFixed(2);
    console.log(
      `  ${r.label.padEnd(24)} ${String(r.trades).padStart(7)} ${r.wr.toFixed(1).padStart(6)} ` +
      `${r.pf.toFixed(2).padStart(6)} ${(sign+r.ret.toFixed(1)+'%').padStart(9)} ` +
      `${r.dd.toFixed(1).padStart(6)} ${tp.padStart(8)} ${rr.padStart(7)}`
    );
  }

  // ── Monthly breakdown ────────────────────────────────────────────────────────
  console.log(`\n${bar}`);
  console.log('  MONTHLY P&L BY VARIANT');
  console.log(`${bar}`);

  const allMonths = new Set(results.flatMap(r => Object.keys(r.monthly)));
  const sortedMonths = [...allMonths].sort();

  // Header
  let hdr = `  ${'Month'.padEnd(10)}`;
  for (const r of results) hdr += r.label.slice(0,12).padStart(14);
  console.log(hdr);
  console.log(`  ${'─'.repeat(10 + results.length * 14)}`);

  for (const ym of sortedMonths) {
    let row = `  ${ym.padEnd(10)}`;
    for (const r of results) {
      const pnl = r.monthly[ym]?.pnl ?? 0;
      row += (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(0).padStart(12);
    }
    console.log(row);
  }

  // ── Signal type breakdown ────────────────────────────────────────────────────
  console.log(`\n${bar}`);
  console.log('  SIGNAL TYPE BREAKDOWN (baseline vs best ATR)');
  console.log(`${bar}`);
  const baseline = results[0];
  const bestATR  = results.reduce((a,b) => (b.mult!==null && b.ret > a.ret) ? b : a, results[1]);
  console.log(`  (Best ATR: ${bestATR.label})\n`);
  const types = new Set([...Object.keys(baseline.byType), ...Object.keys(bestATR.byType)]);
  console.log(`  ${'Type'.padEnd(12)} ${'Base trades'.padEnd(13)} ${'Base WR'.padEnd(9)} ${'Base P&L'.padEnd(12)} ${'ATR trades'.padEnd(13)} ${'ATR WR'.padEnd(9)} ${'ATR P&L'}`);
  console.log(`  ${'─'.repeat(80)}`);
  for (const t of types) {
    const b = baseline.byType[t] || { trades:0, wins:0, pnl:0 };
    const a = bestATR.byType[t]  || { trades:0, wins:0, pnl:0 };
    const bwr = b.trades ? (b.wins/b.trades*100).toFixed(0)+'%' : '-';
    const awr = a.trades ? (a.wins/a.trades*100).toFixed(0)+'%' : '-';
    const bpnl = (b.pnl>=0?'+$':'-$')+Math.abs(b.pnl).toFixed(0);
    const apnl = (a.pnl>=0?'+$':'-$')+Math.abs(a.pnl).toFixed(0);
    console.log(`  ${t.padEnd(12)} ${String(b.trades).padEnd(13)} ${bwr.padEnd(9)} ${bpnl.padEnd(12)} ${String(a.trades).padEnd(13)} ${awr.padEnd(9)} ${apnl}`);
  }

  console.log(`\n${bar}\n`);
})();
