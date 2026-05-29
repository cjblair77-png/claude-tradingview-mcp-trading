/**
 * Crypto Strategy v3 — 50 Pairs · 4H · 200 Days
 *
 * KEY CHANGE: Short from STRENGTH, not after confirmed bear.
 *
 * LONG  — RSI momentum in uptrend:
 *   price > EMA200, EMA50 > EMA200, RSI crosses above 55, MACD > 0
 *   SL: 4%   TP: 12%  (3:1)
 *
 * SHORT — Early breakdown from overbought:
 *   RSI was ≥65 in last 4 bars (asset was strong/overbought)
 *   RSI now drops below 58 (momentum fading) OR MACD hist turns negative
 *   Price closes below EMA21 (short-term trend broken)
 *   RSI still > 35 (not already deeply crashed)
 *   Volume above average (confirms the move)
 *   NO 200 EMA requirement — short the breakdown, not the aftermath
 *   SL: 7%   TP: 21%  (3:1, wider to survive dead-cat bounces)
 *
 * Runs 3 sims: Long-only | Short-only | Combined
 */

import https from 'https';

const CRYPTO = [
  'BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT',
  'DOGEUSDT','LINKUSDT','SUIUSDT','LTCUSDT','AVAXUSDT','HBARUSDT',
  'ADAUSDT','TRXUSDT','TONUSDT','SHIBUSDT','DOTUSDT','BCHUSDT',
  'UNIUSDT','NEARUSDT','APTUSDT','ICPUSDT','ETCUSDT','POLUSDT',
  'VETUSDT','ATOMUSDT','OPUSDT','ARBUSDT','FILUSDT','ALGOUSDT',
  'INJUSDT','BONKUSDT','GRTUSDT','PEPEUSDT','WLDUSDT','AAVEUSDT',
  'TAOUSDT','RENDERUSDT','FETUSDT','STXUSDT','CRVUSDT','THETAUSDT',
  'JASMYUSDT','ONDOUSDT','RUNEUSDT','SANDUSDT','MANAUSDT','ENAUSDT',
  'LDOUSDT','SEIUSDT','TIAUSDT',
];

const START_BAL = 10000;
const TRADE_SIZE = 50;
const DAYS       = 200;
const CAP        = 30;
const INTERVAL   = '4h';
const DELAY_MS   = 80;

// Different SL/TP for each side
const LONG_SL  = 0.04;  // 4%
const LONG_TP  = 0.12;  // 12%  → 3:1
const SHORT_SL = 0.07;  // 7%  — wide to survive dead-cat bounces
const SHORT_TP = 0.21;  // 21% — wide to catch full crash move → 3:1

// ─── Fetch ────────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchCrypto(symbol) {
  const end   = Date.now();
  const start = end - DAYS * 24 * 60 * 60 * 1000;
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
    await delay(DELAY_MS);
  }
  return bars.map(k => ({
    time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
  }));
}

// ─── Indicators ───────────────────────────────────────────────────────────────

const mkEMA = (v, p) => {
  const k = 2/(p+1), r = [v[0]];
  for (let i = 1; i < v.length; i++) r.push(v[i]*k + r[i-1]*(1-k));
  return r;
};

const mkRSI = (c, p=14) => {
  const r = new Array(c.length).fill(null);
  for (let i = p; i < c.length; i++) {
    let g=0, l=0;
    for (let j=i-p+1; j<=i; j++) { const d=c[j]-c[j-1]; d>0?g+=d:l-=d; }
    r[i] = l===0 ? 100 : 100 - 100/(1+(g/p)/(l/p));
  }
  return r;
};

const mkMACD = (c, f=12, s=26, sg=9) => {
  const fl=mkEMA(c,f), sl=mkEMA(c,s);
  const ml=c.map((_,i)=>fl[i]-sl[i]);
  const sig=[ml[0]]; const k=2/(sg+1);
  for (let i=1; i<c.length; i++) sig.push(ml[i]*k+sig[i-1]*(1-k));
  return { line:ml, sig, hist:ml.map((v,i)=>v-sig[i]) };
};

const mkVolSMA = (candles, p=20) =>
  candles.map((_,i) => i<p-1 ? null :
    candles.slice(i-p+1,i+1).reduce((s,c)=>s+c.volume,0)/p);

// ─── Signals ─────────────────────────────────────────────────────────────────

// LONG: RSI momentum cross in aligned uptrend
function getLong(i, d) {
  const { candles, e50, e200, mc, rsi14 } = d;
  if (i < 2 || !rsi14[i] || !e200[i] || !e50[i]) return false;
  const c = candles[i].close;
  return (
    c > e200[i] &&            // bull regime
    e50[i] > e200[i] &&       // EMA50 above EMA200 (aligned)
    rsi14[i-1] < 55 &&        // RSI was below 55
    rsi14[i] >= 55 &&         // RSI just crossed above 55
    mc.line[i] > 0            // MACD positive (trend momentum)
  );
}

// SHORT: Early breakdown from overbought — NO 200 EMA requirement
function getShort(i, d) {
  const { candles, e21, mc, rsi14, vsma } = d;
  if (i < 5 || !rsi14[i] || !e21[i] || !vsma[i]) return false;

  // Was the asset overbought/strong recently? (RSI ≥ 65 in last 4 bars)
  const wasStrong = [1,2,3,4].some(k => rsi14[i-k] != null && rsi14[i-k] >= 65);

  // Momentum fading: RSI crosses below 58 OR MACD hist turns negative
  const rsiFade    = rsi14[i-1] >= 58 && rsi14[i] < 58;
  const macdBreak  = mc.hist[i-1] >= 0 && mc.hist[i] < 0;

  return (
    wasStrong &&                          // was in overbought zone
    (rsiFade || macdBreak) &&             // momentum now fading
    candles[i].close < e21[i] &&          // price broke below EMA21
    rsi14[i] > 35 &&                      // not already deeply oversold
    candles[i].volume > vsma[i]           // volume confirms
  );
}

// ─── Simulation ───────────────────────────────────────────────────────────────

function mkSim(label) {
  return { label, balance:START_BAL, peak:START_BAL, minBal:START_BAL,
           maxDD:0, open:{}, trades:[], snaps:[], _mo:null };
}

function enter(sim, symbol, direction, price, source, time) {
  if (sim.open[symbol]) return;
  if (Object.keys(sim.open).length >= CAP) return;
  if (sim.balance < TRADE_SIZE) return;
  const isLong = direction === 'LONG';
  const sl = isLong ? price*(1-LONG_SL)  : price*(1+SHORT_SL);
  const tp = isLong ? price*(1+LONG_TP)  : price*(1-SHORT_TP);
  sim.balance -= TRADE_SIZE;
  sim.open[symbol] = { symbol, direction, entryPrice:price, size:TRADE_SIZE, sl, tp, source, time };
}

function tick(sim, symbol, bar) {
  const pos = sim.open[symbol]; if (!pos) return;
  const isLong = pos.direction === 'LONG';
  let exitPrice = null, reason = null;
  if (isLong) {
    if      (bar.open <= pos.sl) { exitPrice=bar.open; reason='SL'; }
    else if (bar.open >= pos.tp) { exitPrice=bar.open; reason='TP'; }
    else if (bar.low  <= pos.sl) { exitPrice=pos.sl;   reason='SL'; }
    else if (bar.high >= pos.tp) { exitPrice=pos.tp;   reason='TP'; }
  } else {
    if      (bar.open >= pos.sl) { exitPrice=bar.open; reason='SL'; }
    else if (bar.open <= pos.tp) { exitPrice=bar.open; reason='TP'; }
    else if (bar.high >= pos.sl) { exitPrice=pos.sl;   reason='SL'; }
    else if (bar.low  <= pos.tp) { exitPrice=pos.tp;   reason='TP'; }
  }
  if (exitPrice !== null) {
    const pct = isLong
      ? (exitPrice-pos.entryPrice)/pos.entryPrice
      : (pos.entryPrice-exitPrice)/pos.entryPrice;
    const pnl = pct * pos.size;
    sim.balance += pos.size + pnl;
    if (sim.balance > sim.peak)   sim.peak   = sim.balance;
    if (sim.balance < sim.minBal) sim.minBal = sim.balance;
    const dd = (sim.peak-sim.balance)/sim.peak*100;
    if (dd > sim.maxDD) sim.maxDD = dd;
    sim.trades.push({...pos, exitPrice, reason, pnl});
    delete sim.open[symbol];
  }
}

function closeAll(sim, allData) {
  for (const sym of Object.keys(sim.open)) {
    const pos  = sim.open[sym];
    const last = allData[sym].candles.at(-1);
    const isLong = pos.direction === 'LONG';
    const pct = isLong
      ? (last.close-pos.entryPrice)/pos.entryPrice
      : (pos.entryPrice-last.close)/pos.entryPrice;
    const pnl = pct * pos.size;
    sim.balance += pos.size + pnl;
    sim.trades.push({...pos, exitPrice:last.close, reason:'EOD', pnl});
    delete sim.open[sym];
  }
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function calcStats(sim) {
  const t     = sim.trades;
  const wins  = t.filter(x => x.pnl > 0);
  const loss  = t.filter(x => x.pnl <= 0);
  const pnl   = t.reduce((s,x) => s+x.pnl, 0);
  const gW    = wins.reduce((s,x) => s+x.pnl, 0);
  const gL    = Math.abs(loss.reduce((s,x) => s+x.pnl, 0));
  const wr    = t.length ? (wins.length/t.length*100).toFixed(1) : '0.0';
  const pf    = gL > 0 ? (gW/gL).toFixed(2) : gW>0 ? '∞' : '0.00';
  const ret   = ((sim.balance-START_BAL)/START_BAL*100).toFixed(2);
  const ann   = (parseFloat(ret)/DAYS*365).toFixed(1);
  const longs = t.filter(x => x.direction==='LONG');
  const shrt  = t.filter(x => x.direction==='SHORT');
  const lPnl  = longs.reduce((s,x)=>s+x.pnl,0);
  const sPnl  = shrt.reduce((s,x)=>s+x.pnl,0);
  const lWr   = longs.length ? (longs.filter(x=>x.pnl>0).length/longs.length*100).toFixed(1) : '-';
  const sWr   = shrt.length  ? (shrt.filter(x=>x.pnl>0).length/shrt.length*100).toFixed(1)   : '-';
  const slHit = t.filter(x=>x.reason==='SL').length;
  const tpHit = t.filter(x=>x.reason==='TP').length;

  const bySymbol = {};
  for (const x of t) {
    if (!bySymbol[x.symbol]) bySymbol[x.symbol]={n:0,w:0,pnl:0};
    bySymbol[x.symbol].n++; if(x.pnl>0) bySymbol[x.symbol].w++;
    bySymbol[x.symbol].pnl += x.pnl;
  }
  const sorted = Object.entries(bySymbol).sort((a,b)=>b[1].pnl-a[1].pnl);

  return { t, wins, pnl, wr, pf, ret, ann, longs, shrt, lPnl, sPnl, lWr, sWr, slHit, tpHit, sorted };
}

// ─── Print ────────────────────────────────────────────────────────────────────

const W    = 88;
const line = (ch='-') => console.log(ch.repeat(W));

function printSim(sim, st) {
  line('═');
  console.log(`  ${sim.label}  |  $${sim.balance.toFixed(2)}  |  P&L: ${st.pnl>=0?'+':''}$${st.pnl.toFixed(2)}  |  WR: ${st.wr}%  |  PF: ${st.pf}  |  DD: ${sim.maxDD.toFixed(1)}%`);
  line('═');

  // Long vs Short breakdown
  console.log(`\n  LONGS : ${st.longs.length} trades  WR ${st.lWr}%  P&L ${st.lPnl>=0?'+':''}$${st.lPnl.toFixed(2)}  (SL${LONG_SL*100}% / TP${LONG_TP*100}%)`);
  console.log(`  SHORTS: ${st.shrt.length} trades   WR ${st.sWr}%  P&L ${st.sPnl>=0?'+':''}$${st.sPnl.toFixed(2)}  (SL${SHORT_SL*100}% / TP${SHORT_TP*100}%)`);
  console.log(`  SL hits: ${st.slHit}   TP hits: ${st.tpHit}   EOD: ${st.t.length-st.slHit-st.tpHit}`);

  // Equity curve
  console.log(`\n  ${'Month'.padEnd(10)}${'Balance'.padEnd(14)}${'Open'.padEnd(8)}${'Trades'.padEnd(10)}vs Start`);
  line();
  for (const s of sim.snaps) {
    const diff = s.balance-START_BAL;
    console.log(`  ${s.date.padEnd(10)}$${s.balance.toFixed(2).padEnd(13)}${String(s.open).padEnd(8)}${String(s.trades).padEnd(10)}${diff>=0?'+':''}$${diff.toFixed(2)}  ${diff>=0?'📈':'📉'}`);
  }
  line();
  console.log(`  ${'FINAL'.padEnd(10)}$${sim.balance.toFixed(2).padEnd(13)}${'—'.padEnd(8)}${String(st.t.length).padEnd(10)}${st.pnl>=0?'+':''}$${st.pnl.toFixed(2)}`);

  // Top / Bottom
  console.log(`\n  TOP 10:`);
  st.sorted.slice(0,10).forEach(([sym,d],i)=>{
    const w = d.n?(d.w/d.n*100).toFixed(0):'0';
    console.log(`    #${String(i+1).padEnd(3)}${sym.padEnd(14)}${String(d.n).padEnd(4)}t  ${String(w).padEnd(5)}% win  ${d.pnl>=0?'+':''}$${d.pnl.toFixed(2)}`);
  });
  console.log(`\n  BOTTOM 10:`);
  st.sorted.slice(-10).reverse().forEach(([sym,d],i)=>{
    const w = d.n?(d.w/d.n*100).toFixed(0):'0';
    console.log(`    #${String(i+1).padEnd(3)}${sym.padEnd(14)}${String(d.n).padEnd(4)}t  ${String(w).padEnd(5)}% win  ${d.pnl>=0?'+':''}$${d.pnl.toFixed(2)}`);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  line('═');
  console.log(`  CRYPTO v3  |  4H  |  ${DAYS} days  |  $${START_BAL.toLocaleString()}  |  Cap ${CAP}`);
  console.log(`  LONG  SL ${LONG_SL*100}% / TP ${LONG_TP*100}%  |  SHORT SL ${SHORT_SL*100}% / TP ${SHORT_TP*100}%`);
  console.log(`  Short logic: Breakdown from overbought — NO 200 EMA gate`);
  line('═');

  // Fetch + indicators
  console.log('\n  Fetching 50 pairs...\n');
  const allData = {};
  for (const sym of CRYPTO) {
    process.stdout.write(`  ${sym.padEnd(14)}...`);
    try {
      const candles = await fetchCrypto(sym);
      if (candles.length < 210) { console.log(` skip (${candles.length} bars)`); continue; }
      const closes = candles.map(c=>c.close);
      const mc = mkMACD(closes);
      allData[sym] = {
        candles,
        e21:   mkEMA(closes, 21),
        e50:   mkEMA(closes, 50),
        e200:  mkEMA(closes, 200),
        mc,
        rsi14: mkRSI(closes),
        vsma:  mkVolSMA(candles),
      };
      console.log(` ${candles.length} bars ✓`);
    } catch(e) { console.log(` ❌ ${e.message}`); }
  }

  // Timeline
  const timeSet = new Set();
  for (const d of Object.values(allData)) d.candles.forEach(c => timeSet.add(c.time));
  const timeline = [...timeSet].sort((a,b)=>a-b);
  for (const d of Object.values(allData)) {
    d.idx = {};
    d.candles.forEach((c,i) => { d.idx[c.time] = i; });
  }

  // 3 sims: long-only, short-only, combined
  const simLong  = mkSim('LONG ONLY  (RSI momentum in uptrend)');
  const simShort = mkSim('SHORT ONLY (early breakdown from strength)');
  const simCombo = mkSim('COMBINED   (long + short)');

  console.log(`\n  Running across ${timeline.length.toLocaleString()} bars...\n`);

  for (const t of timeline) {
    const mo = new Date(t).toISOString().slice(0,7);
    for (const sim of [simLong, simShort, simCombo]) {
      if (sim._mo !== mo) {
        sim._mo = mo;
        sim.snaps.push({ date:mo, balance:sim.balance, open:Object.keys(sim.open).length, trades:sim.trades.length });
      }
    }
    for (const [sym, d] of Object.entries(allData)) {
      const i = d.idx[t];
      if (i == null || i < 205) continue;

      const bar   = d.candles[i];
      const isLong  = getLong(i-1, d);
      const isShort = getShort(i-1, d);
      const entry   = bar.open;

      // Long only sim
      tick(simLong, sym, bar);
      if (isLong  && i+1 < d.candles.length) enter(simLong,  sym, 'LONG',  entry, 'RSI Momentum', t);

      // Short only sim
      tick(simShort, sym, bar);
      if (isShort && i+1 < d.candles.length) enter(simShort, sym, 'SHORT', entry, 'Early Breakdown', t);

      // Combined
      tick(simCombo, sym, bar);
      if (isLong  && !isShort && i+1 < d.candles.length) enter(simCombo, sym, 'LONG',  entry, 'RSI Momentum', t);
      if (isShort && !isLong  && i+1 < d.candles.length) enter(simCombo, sym, 'SHORT', entry, 'Early Breakdown', t);
    }
  }
  for (const sim of [simLong, simShort, simCombo]) closeAll(sim, allData);

  // ── Summary table ──────────────────────────────────────────────────────────
  const stL = calcStats(simLong);
  const stS = calcStats(simShort);
  const stC = calcStats(simCombo);

  console.log('\n\n'); line('═');
  console.log('  COMPARISON SUMMARY');
  line('═');
  console.log(`\n  ${'Metric'.padEnd(26)}${'Long Only'.padEnd(22)}${'Short Only'.padEnd(22)}Combined`);
  line();
  const rows = [
    ['Final balance',    (s,sim) => `$${sim.balance.toFixed(2)}`],
    ['Total P&L',        (s)     => `${s.pnl>=0?'+':''}$${s.pnl.toFixed(2)}`],
    [`Return (${DAYS}d)`, (s)    => `${s.ret>=0?'+':''}${s.ret}%`],
    ['Ann. return',      (s)     => `${s.ann>=0?'+':''}${s.ann}%`],
    ['Trades',           (s)     => s.t.length],
    ['Win rate',         (s)     => `${s.wr}%`],
    ['Profit factor',    (s)     => s.pf],
    ['Max drawdown',     (s,sim) => `${sim.maxDD.toFixed(2)}%`],
    ['Lowest balance',   (s,sim) => `$${sim.minBal.toFixed(2)}`],
    ['SL / TP hits',     (s)     => `${s.slHit} / ${s.tpHit}`],
  ];
  const pairs = [[stL,simLong],[stS,simShort],[stC,simCombo]];
  for (const [label, fn] of rows) {
    const cols = pairs.map(([s,sim]) => String(fn(s,sim)).padEnd(22));
    console.log(`  ${label.padEnd(26)}${cols.join('')}`);
  }

  // ── Detail ─────────────────────────────────────────────────────────────────
  console.log('\n\n'); printSim(simLong,  stL);
  console.log('\n\n'); printSim(simShort, stS);
  console.log('\n\n'); printSim(simCombo, stC);

  // ── Verdict ────────────────────────────────────────────────────────────────
  console.log('\n\n'); line('═');
  console.log('  VERDICT');
  line('═');
  const allSims = [[stL,simLong,'Long Only'],[stS,simShort,'Short Only'],[stC,simCombo,'Combined']];
  const best    = allSims.reduce((a,b) => parseFloat(a[0].ret) >= parseFloat(b[0].ret) ? a : b);
  const bestWR  = allSims.reduce((a,b) => parseFloat(a[0].wr)  >= parseFloat(b[0].wr)  ? a : b);
  console.log(`\n  Best return   : ${best[2]}   ${best[0].ret>=0?'+':''}${best[0].ret}%  (${best[0].ann>=0?'+':''}${best[0].ann}% ann.)`);
  console.log(`  Best win rate : ${bestWR[2]}   ${bestWR[0].wr}%`);
  console.log(`\n  Long  needs >25% WR at 3:1  |  Short needs >25% WR at 3:1`);
  console.log(`\n  Long  WR: ${stL.lWr}%   Short WR: ${stS.wr}%   Combined WR: ${stC.wr}%`);
  console.log('');
  line('═');

})().catch(console.error);
