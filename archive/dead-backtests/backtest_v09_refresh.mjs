/**
 * backtest_v09_refresh.mjs — v09 Pair Universe Refresh
 *
 * Screens ~55 candidate USDT pairs with the v09 signal logic over the
 * trailing 200 days, ranks them by composite score, then compares:
 *   A) Portfolio using CURRENT 30 pairs
 *   B) Portfolio using NEW top-30 from screening
 *
 * Ranking formula: score = PF × WR/100 × (1 + ret/100) / (DD/100 + 0.1)
 *   Rewards high PF, high WR, positive return; penalises high drawdown.
 *   Pairs with <20 trades, negative return, or PF<1.0 are excluded.
 *
 * Run: node backtest_v09_refresh.mjs [DAYS] [START_BAL]
 *      node backtest_v09_refresh.mjs 200 5000
 */

import https from 'https';

const DAYS     = parseInt(process.argv[2] || '200');
const CAPITAL  = parseFloat(process.argv[3] || '5000');
const INTERVAL = '4h';
const MAX_POS  = 10;
const RISK_PCT = 0.008;
const SL_PCT   = 0.065;
const TP_PCT   = 0.23;
const REB_SL   = 0.035;
const REB_TP   = 0.22;

// ─── Current 30 pairs ────────────────────────────────────────────────────────

const CURRENT_30 = [
  'KAIAUSDT','SUSDT',   'FILUSDT', 'ARUSDT',    'PLUMEUSDT',
  'FIDAUSDT','GMTUSDT', 'ENAUSDT', 'TIAUSDT',   'TURBOUSDT',
  'WIFUSDT', 'SHIBUSDT','BCHUSDT', 'VETUSDT',   'ONDOUSDT',
  'THETAUSDT','HBARUSDT','RUNEUSDT','IOTAUSDT',  'JUPUSDT',
  'FLUXUSDT','WUSDT',   'CATIUSDT','ZKUSDT',    'KAITOUSDT',
  'WLDUSDT', 'AIXBTUSDT','LAUSDT',  'JASMYUSDT', 'HOMEUSDT',
];

// ─── Candidate universe (~55 pairs) ──────────────────────────────────────────
// Current 30 + 25 additional liquid USDT pairs to screen

const CANDIDATES = [
  // Current 30
  ...CURRENT_30,
  // Additional large/mid-caps
  'SOLUSDT', 'ADAUSDT', 'DOTUSDT',  'LINKUSDT', 'UNIUSDT',
  'XLMUSDT', 'ATOMUSDT','NEARUSDT', 'APTUSDT',  'ARBUSDT',
  'OPUSDT',  'INJUSDT', 'SEIUSDT',  'SUIUSDT',  'AVAXUSDT',
  'RENDERUSDT','TAOUSDT','FETUSDT',  'GRTUSDT',  'STXUSDT',
  'LDOUSDT', 'PENDLEUSDT','ENAUSDT','EIGENUSDT','POLUSDT',
];

// ─── Fetch ────────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol) {
  const end   = Date.now();
  const start = end - (DAYS + 90) * 24 * 60 * 60 * 1000;
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

// ─── Per-pair screening ───────────────────────────────────────────────────────
// Returns stats for a single pair in isolation (no MAX_POS constraint)

function screenPair(d) {
  let balance = CAPITAL;
  let pos = null;
  const trades = [];
  const cutoff = Date.now() - DAYS * 86400000;

  for (let i = 1; i < d.candles.length; i++) {
    const bar = d.candles[i];
    if (bar.time < cutoff) continue;

    // Exit
    if (pos) {
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
        trades.push({ won, pnl: pnlDollar });
        pos = null;
      }
    }

    // Entry
    if (!pos && i > 0) {
      const { closes, e21, e50, e200, rsi14, mc, vsma } = d;
      const sig = getSignals(i-1, d.candles, closes, e21, e50, e200, rsi14, mc, vsma);
      if (sig) {
        const { dir, type, reg } = sig;
        const slPct_ = type==='REBOUND' ? REB_SL : SL_PCT;
        const tpPct_ = type==='REBOUND' ? REB_TP : TP_PCT;
        const risk   = riskDollars(balance, reg, dir);
        const entry  = bar.open;
        const sl     = dir==='LONG'  ? entry*(1-slPct_) : entry*(1+slPct_);
        const tp     = dir==='LONG'  ? entry*(1+tpPct_) : entry*(1-tpPct_);
        const size   = risk / slPct_;
        pos = { dir, entry, sl, tp, size, slPct: slPct_, tpPct: tpPct_, type };
      }
    }
  }

  // Close remaining
  if (pos) {
    const last = d.candles[d.candles.length-1];
    const { dir, entry, size } = pos;
    const pnl = dir==='LONG'
      ? (last.close - entry)/entry * size
      : (entry - last.close)/entry * size;
    balance += pnl;
    trades.push({ won: pnl>0, pnl });
  }

  const n   = trades.length;
  if (n === 0) return { sym: d.symbol, trades: 0, wr: 0, pf: 0, ret: 0, dd: 0, score: -999 };

  const wins   = trades.filter(t=>t.won).length;
  const wr     = wins/n*100;
  const pnl    = balance - CAPITAL;
  const ret    = pnl/CAPITAL*100;
  const gw     = trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
  const gl     = Math.abs(trades.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0));
  const pf     = gl ? gw/gl : Infinity;

  let peak=CAPITAL, dd=0, run=CAPITAL;
  for (const t of trades) {
    run += t.pnl;
    if (run>peak) peak=run;
    const dv=(peak-run)/peak*100;
    if (dv>dd) dd=dv;
  }

  // Score: reward high PF × WR, penalise drawdown. Disqualify if ret<0 or PF<1.
  const score = ret > 0 && pf >= 1.0 && n >= 10
    ? pf * (wr/100) * (1 + ret/100) / (dd/100 + 0.10)
    : -999;

  return { sym: d.symbol, trades: n, wr, pf, ret, dd, score };
}

// ─── Portfolio simulation ─────────────────────────────────────────────────────

function runPortfolio(allData, pairs) {
  const universe = allData.filter(d => pairs.includes(d.symbol));

  let balance = CAPITAL;
  const open  = new Map();
  const trades = [];

  const timeline = [];
  for (const d of universe)
    for (let i = 0; i < d.candles.length; i++)
      timeline.push({ sym: d.symbol, i, time: d.candles[i].time });
  timeline.sort((a,b) => a.time - b.time);

  const cutoff = Date.now() - DAYS * 86400000;
  const entries = timeline.filter(e => e.time >= cutoff);

  for (const { sym, i, time } of entries) {
    const d   = universe.find(x => x.symbol===sym);
    if (!d) continue;
    const bar = d.candles[i];

    // Exit
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
        trades.push({ sym, dir, won, pnl: pnlDollar, type: pos.type });
        open.delete(sym);
      }
    }

    // Entry
    const canFade = !open.has(sym) && open.size < MAX_POS && balance > 10;
    if (canFade && i > 0) {
      const { closes, e21, e50, e200, rsi14, mc, vsma } = d;
      const sig = getSignals(i, d.candles, closes, e21, e50, e200, rsi14, mc, vsma);
      if (sig) {
        const { dir, type, reg } = sig;
        const slPct_  = type==='REBOUND' ? REB_SL : SL_PCT;
        const tpPct_  = type==='REBOUND' ? REB_TP : TP_PCT;
        const risk    = riskDollars(balance, reg, dir);
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

  // Close remaining
  for (const [sym, pos] of open) {
    const d    = universe.find(x => x.symbol===sym);
    const last = d.candles[d.candles.length-1];
    const { dir, entry, size } = pos;
    const pnl  = dir==='LONG'
      ? (last.close - entry)/entry * size
      : (entry - last.close)/entry * size;
    balance += pnl;
    trades.push({ sym, dir, won: pnl>0, pnl, type: pos.type });
  }

  const wins   = trades.filter(t=>t.won).length;
  const wr     = trades.length ? wins/trades.length*100 : 0;
  const pnl    = balance - CAPITAL;
  const ret    = pnl/CAPITAL*100;
  const gw     = trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
  const gl     = Math.abs(trades.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0));
  const pf     = gl ? gw/gl : Infinity;

  let peak=CAPITAL, dd=0, run=CAPITAL;
  for (const t of trades) {
    run += t.pnl;
    if (run>peak) peak=run;
    const dv=(peak-run)/peak*100;
    if (dv>dd) dd=dv;
  }

  return { balance, pnl, ret, trades: trades.length, wins, wr, pf, dd };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const bar = '═'.repeat(110);
  console.log(`\n${bar}`);
  console.log(`  v09 PAIR UNIVERSE REFRESH — ${DAYS}d screening, $${CAPITAL.toLocaleString()} start`);
  console.log(`${bar}\n`);

  // Deduplicate candidates
  const uniqueCandidates = [...new Set(CANDIDATES)];
  console.log(`Screening ${uniqueCandidates.length} candidate pairs...\n`);

  // Fetch all
  const allData = [];
  const fetchErrors = [];
  for (const sym of uniqueCandidates) {
    process.stdout.write(`  ${sym.padEnd(16)}`);
    try {
      const candles = await fetchKlines(sym);
      if (candles.length < 60) {
        console.log(`skip (only ${candles.length} bars)`);
        fetchErrors.push(sym);
        continue;
      }
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
      });
      console.log(`${candles.length} bars  OK`);
    } catch(e) {
      console.log(`error: ${e.message}`);
      fetchErrors.push(sym);
    }
    await delay(100);
  }

  console.log(`\nLoaded ${allData.length}/${uniqueCandidates.length} pairs (${fetchErrors.length} errors)\n`);

  // Screen each pair individually
  console.log('Running per-pair screening...');
  const screenResults = allData.map(d => screenPair(d));

  // Sort by score descending
  screenResults.sort((a, b) => b.score - a.score);

  // ── Screening results table ───────────────────────────────────────────────
  console.log(`\n${bar}`);
  console.log('  SCREENING RESULTS (all candidates, sorted by score)');
  console.log(`${bar}`);
  console.log(`  ${'Rank'.padStart(4)}  ${'Pair'.padEnd(16)} ${'Trades'.padStart(7)} ${'WR%'.padStart(6)} ${'PF'.padStart(6)} ${'Ret%'.padStart(8)} ${'DD%'.padStart(6)} ${'Score'.padStart(8)}  Status`);
  console.log(`  ${'─'.repeat(90)}`);

  const top30 = [];
  let rank = 1;
  for (const r of screenResults) {
    const inCurrent = CURRENT_30.includes(r.sym);
    const qualified = r.score > 0;
    if (qualified && top30.length < 30) top30.push(r.sym);
    const status  = !qualified ? '─ SKIP' : inCurrent ? '✓ current' : '★ NEW';
    const retSign = r.ret >= 0 ? '+' : '';
    console.log(
      `  ${String(qualified ? rank++ : '-').padStart(4)}  ${r.sym.padEnd(16)} ` +
      `${String(r.trades).padStart(7)} ${r.wr.toFixed(1).padStart(6)} ` +
      `${r.pf.toFixed(2).padStart(6)} ${(retSign+r.ret.toFixed(1)+'%').padStart(8)} ` +
      `${r.dd.toFixed(1).padStart(6)} ${r.score > 0 ? r.score.toFixed(2).padStart(8) : '     ---'}  ${status}`
    );
  }

  // ── New vs current comparison ─────────────────────────────────────────────
  const newPairs     = top30.filter(s => !CURRENT_30.includes(s));
  const droppedPairs = CURRENT_30.filter(s => !top30.includes(s));
  const keptPairs    = CURRENT_30.filter(s => top30.includes(s));

  console.log(`\n${bar}`);
  console.log('  PORTFOLIO CHANGE SUMMARY');
  console.log(`${bar}`);
  console.log(`  Qualified pairs:  ${screenResults.filter(r=>r.score>0).length} / ${screenResults.length}`);
  console.log(`  Top-30 selected:  ${top30.length}`);
  console.log(`  Pairs kept:       ${keptPairs.length}  → ${keptPairs.join(', ')}`);
  console.log(`  Pairs ADDED:      ${newPairs.length}  → ${newPairs.join(', ')}`);
  console.log(`  Pairs DROPPED:    ${droppedPairs.length}  → ${droppedPairs.join(', ')}`);

  // ── Portfolio comparison ──────────────────────────────────────────────────
  console.log(`\n${bar}`);
  console.log('  PORTFOLIO SIMULATION: Current-30 vs New Top-30');
  console.log(`${bar}\n`);

  // Run on pairs that were actually fetched
  const currentAvail = CURRENT_30.filter(s => allData.find(d => d.symbol===s));
  const newAvail     = top30.filter(s => allData.find(d => d.symbol===s));

  process.stdout.write(`  Running CURRENT-30 portfolio (${currentAvail.length} fetched)... `);
  const currentResult = runPortfolio(allData, currentAvail);
  console.log(`done`);

  process.stdout.write(`  Running NEW TOP-30 portfolio (${newAvail.length} fetched)... `);
  const newResult     = runPortfolio(allData, newAvail);
  console.log(`done\n`);

  const pSign = n => (n >= 0 ? '+' : '') + n.toFixed(1);
  const $ = n => (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(0);

  console.log(`  ${'Metric'.padEnd(24)} ${'CURRENT-30'.padEnd(20)} ${'NEW TOP-30'.padEnd(20)}`);
  console.log(`  ${'─'.repeat(68)}`);
  const rows = [
    ['Return',        pSign(currentResult.ret)+'%',     pSign(newResult.ret)+'%'],
    ['P&L',           $(currentResult.pnl),              $(newResult.pnl)],
    ['Total trades',  String(currentResult.trades),      String(newResult.trades)],
    ['Win rate',      currentResult.wr.toFixed(1)+'%',   newResult.wr.toFixed(1)+'%'],
    ['Profit factor', currentResult.pf.toFixed(2),       newResult.pf.toFixed(2)],
    ['Max drawdown',  currentResult.dd.toFixed(1)+'%',   newResult.dd.toFixed(1)+'%'],
  ];
  for (const [label, a, b] of rows) {
    const valA = parseFloat(a), valB = parseFloat(b);
    const arrow = !isNaN(valA) && !isNaN(valB)
      ? (valB > valA + 0.1 ? '  ✅ better' : (valB < valA - 0.1 ? '  ❌ worse' : '  →'))
      : '';
    console.log(`  ${label.padEnd(24)} ${a.padEnd(20)} ${b.padEnd(20)}${arrow}`);
  }

  console.log(`\n${bar}\n`);
})();
