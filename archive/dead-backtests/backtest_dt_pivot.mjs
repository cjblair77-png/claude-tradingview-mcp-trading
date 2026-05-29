/**
 * backtest_dt_pivot.mjs — DT Strategy + Pivot Point Confluence Filter
 *
 * Runs the existing DT strategy side-by-side with and without a pivot filter.
 * The pivot filter adds one extra condition to every DT entry:
 *   • The EMA21 level (the dynamic S/R being recaptured) must be within ±0.4%
 *     of a daily pivot level (PP, R1, or S1).
 *   • This tests whether DT signals with pivot confluence are materially better
 *     than DT signals in the absence of a nearby institutional level.
 *
 * DT signal (unchanged):
 *   LONG : prev close < EMA21, current close > EMA21
 *          + session ORB bias LONG
 *          + EMA50 rising (4-bar lookback)
 *          + ADX > 20
 *   SHORT: inverse
 *
 * Daily pivots: PP = (prevH + prevL + prevC) / 3
 *               R1 = 2*PP - prevL,  S1 = 2*PP - prevH
 *   Derived from previous UTC day's high/low/close (from 15m data)
 *
 * Run: node backtest_dt_pivot.mjs [DAYS] [START_BAL]
 */

import https from 'https';

const DAYS    = parseInt(process.argv[2] || '365');
const CAPITAL = parseFloat(process.argv[3] || '5000');
const INTERVAL = '15m';

// DT config (mirrors bot_daytrading_v01.js)
const LEVERAGE    = 5;
const RISK_PCT    = 0.008;
const SL_PCT      = 0.008;   // 0.8% of entry
const TP_PCT      = 0.016;   // 1.6% of entry (2:1 R:R)
const MAX_HOLD    = 8;        // bars (2 hours)
const MAX_POS     = 6;
const ADX_MIN     = 20;

// Pivot confluence tolerance: EMA21 within ±X% of pivot level
const PIVOT_TOL   = 0.004;   // 0.4%
const PIVOT_LEVELS = ['pp', 'r1', 's1']; // levels to check

const PAIRS = ['BTCUSDT','BNBUSDT','XRPUSDT','SUIUSDT','LTCUSDT','AVAXUSDT'];
const EMA50_PAIRS = new Set(['BTCUSDT','SUIUSDT']);

// ─── Fetch ────────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol) {
  const end   = Date.now();
  const start = end - (DAYS + 10) * 86400000;
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
function rsiSeries(closes, p=14) {
  const r = new Array(closes.length).fill(null);
  for (let i = p; i < closes.length; i++) {
    let g=0, l=0;
    for (let j=i-p+1; j<=i; j++) { const d=closes[j]-closes[j-1]; d>0?g+=d:l-=d; }
    r[i] = l===0 ? 100 : 100 - 100/(1+(g/p)/(l/p));
  }
  return r;
}
function adxSeries(candles, p=14) {
  const n = candles.length;
  const adx = new Array(n).fill(null);
  if (n < p*2+1) return adx;
  const tr=[], pdm=[], ndm=[];
  for (let i=1; i<n; i++) {
    const h=candles[i].high, l=candles[i].low, pc=candles[i-1].close;
    tr.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
    pdm.push(Math.max(h-candles[i-1].high, 0));
    ndm.push(Math.max(candles[i-1].low-l, 0));
  }
  let atr=tr.slice(0,p).reduce((a,b)=>a+b,0);
  let pDM=pdm.slice(0,p).reduce((a,b)=>a+b,0);
  let nDM=ndm.slice(0,p).reduce((a,b)=>a+b,0);
  const pDI=[pDM/atr*100], nDI=[nDM/atr*100];
  for (let i=p; i<tr.length; i++) {
    atr=atr-atr/p+tr[i];
    pDM=pDM-pDM/p+pdm[i];
    nDM=nDM-nDM/p+ndm[i];
    pDI.push(pDM/atr*100);
    nDI.push(nDM/atr*100);
  }
  let dx0=Math.abs(pDI[0]-nDI[0])/(pDI[0]+nDI[0])*100;
  const dxArr=[dx0];
  for (let i=1; i<pDI.length; i++) {
    const dx=Math.abs(pDI[i]-nDI[i])/(pDI[i]+nDI[i])*100;
    dxArr.push(dx);
  }
  let adxVal=dxArr.slice(0,p).reduce((a,b)=>a+b,0)/p;
  adx[p*2]=adxVal;
  for (let i=p; i<dxArr.length; i++) {
    adxVal=(adxVal*(p-1)+dxArr[i])/p;
    adx[i+p+1]=adxVal;
  }
  return adx;
}

// ─── Pivots ───────────────────────────────────────────────────────────────────

function buildDailyOHLC(candles) {
  const days = {};
  for (const c of candles) {
    const day = new Date(c.time).toISOString().slice(0,10);
    if (!days[day]) days[day] = { H:-Infinity, L:Infinity, C:0 };
    days[day].H = Math.max(days[day].H, c.high);
    days[day].L = Math.min(days[day].L, c.low);
    days[day].C = c.close;
  }
  return days;
}

function getPivots(dayStr, dailyOHLC, sortedDays) {
  const idx = sortedDays.indexOf(dayStr);
  if (idx < 1) return null;
  const prev = sortedDays[idx-1];
  const d = dailyOHLC[prev];
  if (!d || d.H===-Infinity) return null;
  const pp = (d.H + d.L + d.C) / 3;
  return {
    pp,
    r1: 2*pp - d.L,
    s1: 2*pp - d.H,
  };
}

// Check if a price level (EMA21) is within tolerance of any pivot level
function nearPivot(price, pivots) {
  if (!pivots) return false;
  return PIVOT_LEVELS.some(k => {
    const lvl = pivots[k];
    return lvl && Math.abs(price - lvl) / lvl <= PIVOT_TOL;
  });
}

// ─── ORB Bias ─────────────────────────────────────────────────────────────────

// Returns 'LONG', 'SHORT', or null based on ORB session bias
// Sessions (UTC): Asia=01:00, London=08:00, NY=13:00
// ORB = first 2 bars (30 min) of session
// Bias = direction first bar breaks the 30-min range

function getORBBias(candles, i) {
  const sessionStarts = [1, 8, 13]; // UTC hours
  const bar = candles[i];
  const h   = new Date(bar.time).getUTCHours();
  const m   = new Date(bar.time).getUTCMinutes();

  // Find the applicable session for this bar
  let sessionStart = null;
  for (let s = sessionStarts.length - 1; s >= 0; s--) {
    if (h > sessionStarts[s] || (h === sessionStarts[s] && m >= 30)) {
      sessionStart = sessionStarts[s];
      break;
    }
  }
  if (sessionStart === null) sessionStart = 13; // previous day's NY session

  // Find the ORB candles (first 2 bars of session = 0 and 15 min marks)
  const orbBars = candles.filter(c => {
    const ch = new Date(c.time).getUTCHours();
    const cm = new Date(c.time).getUTCMinutes();
    return ch === sessionStart && (cm === 0 || cm === 15);
  });

  // Find the ORB for the same calendar day as bar i
  const barDay = new Date(bar.time).toISOString().slice(0,10);
  const dayOrb = orbBars.filter(c => new Date(c.time).toISOString().slice(0,10) === barDay);
  if (dayOrb.length < 2) return null;

  const orbHigh = Math.max(...dayOrb.map(c=>c.high));
  const orbLow  = Math.min(...dayOrb.map(c=>c.low));

  // Bias: first close OUTSIDE the ORB range
  const postOrb = candles.filter(c => {
    const ct = c.time;
    return ct > dayOrb[dayOrb.length-1].time && ct <= bar.time &&
           new Date(c.time).toISOString().slice(0,10) === barDay;
  });

  for (const pb of postOrb) {
    if (pb.close > orbHigh) return 'LONG';
    if (pb.close < orbLow)  return 'SHORT';
  }
  return null; // ranging — no bias yet
}

// ─── Simulation ───────────────────────────────────────────────────────────────

function runSim(allData, usePivotFilter) {
  let balance = CAPITAL;
  const open  = new Map();
  const trades = [];
  const monthly = {};
  let filtered = 0;

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
    if (!monthly[ym]) monthly[ym] = { pnl:0, trades:0 };

    // ── Exit checks ───────────────────────────────────────────────────────────
    if (open.has(sym)) {
      const pos = open.get(sym);
      const { dir, entry, sl, tp, size, barEntered } = pos;
      const held  = i - barEntered;
      let closed=false, won=false, pnlDollar=0;

      if (dir==='LONG') {
        if      (bar.low  <= sl)           { pnlDollar=-(size*SL_PCT*LEVERAGE); closed=true; }
        else if (bar.high >= tp)           { pnlDollar=  size*TP_PCT*LEVERAGE;  closed=true; won=true; }
        else if (held >= MAX_HOLD)         { pnlDollar=(bar.close-entry)/entry*size*LEVERAGE; closed=true; won=pnlDollar>0; }
      } else {
        if      (bar.high >= sl)           { pnlDollar=-(size*SL_PCT*LEVERAGE); closed=true; }
        else if (bar.low  <= tp)           { pnlDollar=  size*TP_PCT*LEVERAGE;  closed=true; won=true; }
        else if (held >= MAX_HOLD)         { pnlDollar=(entry-bar.close)/entry*size*LEVERAGE; closed=true; won=pnlDollar>0; }
      }
      if (closed) {
        balance += pnlDollar;
        trades.push({ sym, dir, won, pnl: pnlDollar });
        monthly[ym].pnl += pnlDollar;
        monthly[ym].trades++;
        open.delete(sym);
      }
    }

    if (open.has(sym) || open.size >= MAX_POS || i < 55 || balance < 10) continue;

    // ── Signal detection (DT logic) ───────────────────────────────────────────
    const { closes, e21, e50, adx14, rsi14 } = d;
    const e21Cur = e21[i], e21Prv = e21[i-1];
    if (!e21Cur || !e21Prv) continue;

    const c    = closes[i];
    const cPrv = closes[i-1];
    const adx  = adx14[i];
    if (!adx || adx < ADX_MIN) continue;

    // EMA21 recapture (LONG) or rejection (SHORT)
    const longSignal  = cPrv <= e21Prv && c > e21Cur;
    const shortSignal = cPrv >= e21Prv && c < e21Cur;
    if (!longSignal && !shortSignal) continue;

    // EMA50 direction filter
    const e50_4ago = e50[Math.max(0, i-4)];
    const e50Rising  = e50[i] > e50_4ago;
    const e50Falling = e50[i] < e50_4ago;

    if (longSignal  && EMA50_PAIRS.has(sym) && !e50Rising)  continue;
    if (shortSignal && EMA50_PAIRS.has(sym) && !e50Falling) continue;

    // ORB bias
    const orbBias = getORBBias(d.candles, i);
    if (!orbBias) continue;
    if (longSignal  && orbBias !== 'LONG')  continue;
    if (shortSignal && orbBias !== 'SHORT') continue;

    const dir = longSignal ? 'LONG' : 'SHORT';

    // ── Pivot confluence filter (optional) ────────────────────────────────────
    if (usePivotFilter) {
      const dayStr = new Date(time).toISOString().slice(0,10);
      const pivots = getPivots(dayStr, d.dailyOHLC, d.sortedDays);
      // Check if EMA21 (the level being recaptured) is near a pivot
      if (!nearPivot(e21Cur, pivots)) {
        filtered++;
        continue;
      }
    }

    // Entry
    const entry = c; // enter at signal bar close (DT style)
    const risk  = Math.max(balance * RISK_PCT, 1);
    const size  = risk / SL_PCT;
    const sl    = dir==='LONG'  ? entry*(1-SL_PCT) : entry*(1+SL_PCT);
    const tp    = dir==='LONG'  ? entry*(1+TP_PCT) : entry*(1-TP_PCT);

    open.set(sym, { dir, entry, sl, tp, size, barEntered: i });
  }

  // Close remainders
  for (const [sym, pos] of open) {
    const d    = allData.find(x => x.symbol===sym);
    const last = d.candles[d.candles.length-1];
    const { dir, entry, size } = pos;
    const pnl  = dir==='LONG'
      ? (last.close-entry)/entry*size*LEVERAGE
      : (entry-last.close)/entry*size*LEVERAGE;
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
    run+=t.pnl; if(run>peak)peak=run;
    const d2=(peak-run)/peak*100; if(d2>dd)dd=d2;
  }

  return { balance, pnl, ret, trades:trades.length, wins, wr, pf, dd, monthly, filtered };
}

// ─── Display ─────────────────────────────────────────────────────────────────

const $  = n => (n>=0?'+$':'-$')+Math.abs(n).toFixed(0);
const pc = n => (n>=0?'+':'')+n.toFixed(1)+'%';
const bar72 = '═'.repeat(72);

function printCompare(base, filt) {
  console.log(`\n${bar72}`);
  console.log(`  DT BASELINE vs DT + PIVOT FILTER  —  ${DAYS}d  $${CAPITAL.toLocaleString()}`);
  console.log(`  Pivot filter: EMA21 within ±0.4% of daily PP / R1 / S1`);
  console.log(bar72);

  const col = 22;
  const h = s => String(s).padEnd(col);
  console.log(`\n  ${'Metric'.padEnd(26)}${h('DT Baseline')}${h('DT + Pivot Filter')}`);
  console.log(`  ${'─'.repeat(66)}`);

  const cmp = (a, b, higherBetter=true) => {
    const na=parseFloat(a), nb=parseFloat(b);
    if (isNaN(na)||isNaN(nb)) return '';
    if (higherBetter) return nb > na+0.1 ? '  ✅' : nb < na-0.1 ? '  ❌' : '  →';
    return nb < na-0.1 ? '  ✅' : nb > na+0.1 ? '  ❌' : '  →';
  };

  const rows = [
    ['Final balance',   `$${base.balance.toFixed(0)}`,   `$${filt.balance.toFixed(0)}`],
    ['Return',         pc(base.ret),                     pc(filt.ret)],
    ['Total trades',   String(base.trades),               String(filt.trades)],
    ['Signals filtered','-',                              String(filt.filtered)],
    ['Win rate',       base.wr.toFixed(1)+'%',           filt.wr.toFixed(1)+'%'],
    ['Profit factor',  base.pf.toFixed(2),               filt.pf.toFixed(2)],
    ['Max drawdown',   base.dd.toFixed(1)+'%',           filt.dd.toFixed(1)+'%'],
  ];
  for (const [label, a, b] of rows) {
    const lowerBetter = label.includes('drawdown');
    const arrow = label==='-' ? '' : cmp(a, b, !lowerBetter);
    console.log(`  ${label.padEnd(26)}${h(a)}${h(b)}${arrow}`);
  }

  console.log(`\n  MONTHLY P&L COMPARISON`);
  console.log(`  ${'Month'.padEnd(10)}${'Baseline'.padEnd(14)}${'+ Pivot'.padEnd(14)}${'Diff'}`);
  console.log(`  ${'─'.repeat(50)}`);
  const months = new Set([...Object.keys(base.monthly), ...Object.keys(filt.monthly)]);
  let bTot=0, fTot=0;
  for (const ym of [...months].sort()) {
    const bp = base.monthly[ym]?.pnl||0;
    const fp = filt.monthly[ym]?.pnl||0;
    bTot+=bp; fTot+=fp;
    const diff=fp-bp;
    const icon = diff>50?'✅':diff<-50?'❌':'→';
    console.log(`  ${ym.padEnd(10)}${$(bp).padEnd(14)}${$(fp).padEnd(14)}${$(diff)} ${icon}`);
  }
  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  ${'TOTAL'.padEnd(10)}${$(bTot).padEnd(14)}${$(fTot).padEnd(14)}${$(fTot-bTot)} ${fTot>bTot?'✅':'❌'}`);

  console.log(`\n${bar72}`);
  const verdict = filt.pnl > base.pnl;
  console.log(`  VERDICT: Pivot filter ${verdict?'✅ IMPROVES':'❌ HURTS'} DT performance`);
  if (verdict) {
    console.log(`  Extra P&L: ${$(filt.pnl-base.pnl)}  |  WR gain: ${(filt.wr-base.wr).toFixed(1)}%`);
    console.log(`  Filtered out ${filt.filtered} poor signals — kept ${filt.trades} high-confluence trades`);
  } else {
    console.log(`  Filtered out ${filt.filtered} signals — too many were actually profitable`);
    console.log(`  Baseline outperforms by ${$(base.pnl-filt.pnl)}`);
  }
  console.log(bar72+'\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\n${bar72}`);
  console.log(`  DT + PIVOT FILTER BACKTEST  |  ${DAYS}d  |  $${CAPITAL.toLocaleString()}`);
  console.log(`  Pairs: ${PAIRS.join(', ')}`);
  console.log(bar72);
  console.log(`\n  Fetching ${PAIRS.length} pairs (15m)...\n`);

  const allData = [];
  for (const symbol of PAIRS) {
    try {
      const candles  = await fetchKlines(symbol);
      if (candles.length < 200) { console.log(`  ${symbol.padEnd(14)} ⚠️  insufficient`); continue; }
      const closes   = candles.map(c=>c.close);
      const e21      = ema(closes, 21);
      const e50      = ema(closes, 50);
      const rsi14    = rsiSeries(closes, 14);
      const adx14    = adxSeries(candles, 14);
      const dailyOHLC = buildDailyOHLC(candles);
      const sortedDays = Object.keys(dailyOHLC).sort();
      allData.push({ symbol, candles, closes, e21, e50, rsi14, adx14, dailyOHLC, sortedDays });
      process.stdout.write(`  ${symbol.padEnd(14)} ${candles.length} bars ✓\n`);
    } catch(e) {
      console.log(`  ${symbol.padEnd(14)} ❌ ${e.message}`);
    }
    await delay(100);
  }

  console.log(`\n  Running DT baseline...`);
  const base = runSim(allData, false);

  console.log(`  Running DT + pivot filter...`);
  const filt = runSim(allData, true);

  printCompare(base, filt);
})().catch(console.error);
