import https from 'https';

// ── Config ────────────────────────────────────────────────────────────────────
const DAYS      = 150;
const TOTAL_POOL = 6250;

// MEXC symbol mapping (BitMEX name → MEXC name, strategy)
const SYMBOLS = [
  { bitmex: 'SPYUSDT',   mexc: 'QQQSTOCK_USDT',  strat: 'BOTH' },  // SPY→QQQ (ETF sub)
  { bitmex: 'MSTRUSDT',  mexc: 'MSTRSTOCK_USDT',  strat: 'BOTH' },
  { bitmex: 'TSLAUSDT',  mexc: 'TESLA_USDT',       strat: 'BOTH' },
  { bitmex: 'NFLXUSDT',  mexc: 'NFLXSTOCK_USDT',  strat: 'BOTH' },
  { bitmex: 'AMZNUSDT',  mexc: 'AMZNSTOCK_USDT',  strat: 'BOTH' },
  { bitmex: 'MSFTUSDT',  mexc: 'MSFTSTOCK_USDT',  strat: 'BOTH' },
  { bitmex: 'ORCLUSDT',  mexc: 'ORCLSTOCK_USDT',  strat: 'BOTH' },
  { bitmex: 'COINUSDT',  mexc: 'COINBASE_USDT',    strat: 'BOTH' },
  { bitmex: 'NVDAUSDT',  mexc: 'NVIDIA_USDT',      strat: 'BOTH' },
  { bitmex: 'GOOGLUSDT', mexc: 'GOOGLSTOCK_USDT',  strat: 'BOTH' },
];

const N_SYMS   = SYMBOLS.length;
const START_BAL = TOTAL_POOL / N_SYMS;    // $625/symbol

// ── Strategy constants (same as BitMEX backtest) ──────────────────────────────
const LEVERAGE   = 5;
const RISK_PCT   = 0.008;
const DT_SL      = 0.0042, DT_TP = DT_SL * 1.3, DT_MAXHOLD = 12, DT_VOLMULT = 1.2;
const RTH_S      = 13, RTH_E = 20;                          // UTC hours
const ORB_TPMULT = 1.5, ORB_VOLMULT = 1.3;
const OR_START   = 13*60+30, OR_END = 14*60, TRADE_END = 18*60, EOD_CLOSE = 19*60+55;

// ── MEXC API ──────────────────────────────────────────────────────────────────
function get(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)) } catch { res(null) } });
    }).on('error', rej);
  });
}

async function fetchMexcBars(symbol, days) {
  const now   = Math.floor(Date.now() / 1000);
  const start = now - days * 86400;
  const windowSize = 2000 * 300;  // 2000 bars × 5min in seconds
  let bars = [], cursor = start;

  while (cursor < now) {
    const end = Math.min(cursor + windowSize, now);
    const resp = await get(`https://futures.mexc.com/api/v1/contract/kline/${symbol}?interval=Min5&start=${cursor}&end=${end}`);
    if (!resp?.data?.time?.length) break;
    const d = resp.data;
    for (let i = 0; i < d.time.length; i++) {
      if (d.open[i] && d.high[i] && d.low[i] && d.close[i]) {
        bars.push({ t: d.time[i] * 1000, o: +d.open[i], h: +d.high[i], l: +d.low[i], c: +d.close[i], v: +(d.vol[i] || 0) });
      }
    }
    cursor = d.time[d.time.length - 1] + 300;
    await new Promise(r => setTimeout(r, 200));
  }

  // Deduplicate + sort
  const seen = new Set();
  return bars.filter(b => { if (seen.has(b.t)) return false; seen.add(b.t); return true; })
             .sort((a, b) => a.t - b.t);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function agg(bars, n) {
  const out = [];
  for (let i = 0; i + n - 1 < bars.length; i += n) {
    const g = bars.slice(i, i + n);
    out.push({ t: g[0].t, o: g[0].o, h: Math.max(...g.map(b => b.h)), l: Math.min(...g.map(b => b.l)), c: g[g.length-1].c, v: g.reduce((s,b) => s+b.v, 0) });
  }
  return out;
}

function calcEma(arr, p) { const k = 2/(p+1); let e = arr[0]; return arr.map(v => { e = v*k + e*(1-k); return e; }); }
function vSmaFn(v) { return (i, p=20) => { if (i < p) return null; let s = 0; for (let j=i-p; j<i; j++) s+=v[j]; return s/p; }; }
function mk(t) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function minUTC(t) { const d = new Date(t); return d.getUTCHours()*60 + d.getUTCMinutes(); }

// ── DT Strategy ───────────────────────────────────────────────────────────────
function runDT(bars15) {
  const c = bars15.map(b => b.c), v = bars15.map(b => b.v);
  const e21 = calcEma(c, 21), e50 = calcEma(c, 50), vs = vSmaFn(v);
  let bal = START_BAL, peak = START_BAL, maxDD = 0, inTrade = false, trade = {};
  const trades = [], monthly = {};

  for (let i = Math.max(51,20); i < bars15.length; i++) {
    const b = bars15[i], p = bars15[i-1], h = new Date(b.t).getUTCHours();
    if (inTrade) {
      const held = i - trade.bar, lng = trade.dir === 'LONG';
      let closed = false, ep = 0;
      if (lng && b.l <= trade.sl)      { ep = trade.sl; closed = true; }
      else if (!lng && b.h >= trade.sl) { ep = trade.sl; closed = true; }
      else if (lng && b.h >= trade.tp)  { ep = trade.tp; closed = true; }
      else if (!lng && b.l <= trade.tp) { ep = trade.tp; closed = true; }
      else if (held >= DT_MAXHOLD)      { ep = b.c;      closed = true; }
      if (closed) {
        const raw = lng ? (ep - trade.entry)/trade.entry : (trade.entry - ep)/trade.entry;
        const pnl = bal * RISK_PCT * LEVERAGE * (raw / DT_SL);
        bal += pnl; peak = Math.max(peak, bal); maxDD = Math.max(maxDD, (peak-bal)/peak*100);
        const m = mk(b.t); if (!monthly[m]) monthly[m] = { tr:0, wins:0, pnl:0 };
        monthly[m].tr++; monthly[m].pnl += pnl; if (pnl > 0) monthly[m].wins++;
        trades.push(pnl); inTrade = false;
      }
    }
    if (!inTrade && h >= RTH_S && h < RTH_E) {
      const rising = e50[i] > e50[i-4], falling = e50[i] < e50[i-4];
      const vv = vs(i); const vok = vv && b.v > DT_VOLMULT * vv;
      const lng = p.c < e21[i-1] && b.c > e21[i] && rising && vok;
      const sht = p.c > e21[i-1] && b.c < e21[i] && falling && vok;
      if (lng || sht) { trade = { dir: lng?'LONG':'SHORT', entry: b.c, sl: lng?b.c*(1-DT_SL):b.c*(1+DT_SL), tp: lng?b.c*(1+DT_TP):b.c*(1-DT_TP), bar: i }; inTrade = true; }
    }
  }
  return summarise(trades, bal, peak, maxDD, monthly);
}

// ── ORB Strategy ──────────────────────────────────────────────────────────────
function runORB(bars5) {
  const days = {};
  for (const b of bars5) {
    const d = new Date(b.t), k = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    if (!days[k]) days[k] = []; days[k].push(b);
  }
  let bal = START_BAL, peak = START_BAL, maxDD = 0, totalVol = 0, totalBars = 0;
  const trades = [], monthly = {};

  for (const key of Object.keys(days).sort()) {
    const db = days[key];
    for (const b of db) { totalVol += b.v; totalBars++; }
    const avgVol = totalBars > 0 ? totalVol / totalBars : 1;
    const orB = db.filter(b => { const m = minUTC(b.t); return m >= OR_START && m < OR_END; });
    if (orB.length < 3) continue;
    const orH = Math.max(...orB.map(b => b.h)), orL = Math.min(...orB.map(b => b.l)), orR = orH - orL;
    if (orR <= 0) continue;
    const tB = db.filter(b => { const m = minUTC(b.t); return m >= OR_END && m < TRADE_END; });
    let inTrade = false, trade = {};

    for (const b of tB) {
      const m = minUTC(b.t), vok = b.v > ORB_VOLMULT * avgVol;
      if (inTrade) {
        const lng = trade.dir === 'LONG';
        let closed = false, ep = 0;
        if (lng && b.l <= trade.sl)      { ep = trade.sl; closed = true; }
        else if (!lng && b.h >= trade.sl) { ep = trade.sl; closed = true; }
        else if (lng && b.h >= trade.tp)  { ep = trade.tp; closed = true; }
        else if (!lng && b.l <= trade.tp) { ep = trade.tp; closed = true; }
        else if (m >= EOD_CLOSE)          { ep = b.c;      closed = true; }
        if (closed) {
          const raw = lng ? (ep-trade.entry)/trade.entry : (trade.entry-ep)/trade.entry;
          const slPct = orR / trade.entry;
          const pnl = bal * RISK_PCT * LEVERAGE * (raw / slPct);
          bal += pnl; peak = Math.max(peak, bal); maxDD = Math.max(maxDD, (peak-bal)/peak*100);
          const m_ = mk(b.t); if (!monthly[m_]) monthly[m_] = { tr:0, wins:0, pnl:0 };
          monthly[m_].tr++; monthly[m_].pnl += pnl; if (pnl > 0) monthly[m_].wins++;
          trades.push(pnl); inTrade = false;
        }
      }
      if (!inTrade && vok) {
        if (b.c > orH && b.o <= orH)      { trade = { dir:'LONG',  entry:b.c, sl:orL, tp:b.c + orR*ORB_TPMULT }; inTrade = true; }
        else if (b.c < orL && b.o >= orL) { trade = { dir:'SHORT', entry:b.c, sl:orH, tp:b.c - orR*ORB_TPMULT }; inTrade = true; }
      }
    }
    if (inTrade) {
      const b = db[db.length-1], lng = trade.dir === 'LONG';
      const raw = lng ? (b.c-trade.entry)/trade.entry : (trade.entry-b.c)/trade.entry;
      const slPct = orR / trade.entry;
      const pnl = bal * RISK_PCT * LEVERAGE * (raw / slPct);
      bal += pnl; peak = Math.max(peak, bal); maxDD = Math.max(maxDD, (peak-bal)/peak*100);
      const m_ = mk(b.t); if (!monthly[m_]) monthly[m_] = { tr:0, wins:0, pnl:0 };
      monthly[m_].tr++; monthly[m_].pnl += pnl; if (pnl > 0) monthly[m_].wins++;
      trades.push(pnl);
    }
  }
  return summarise(trades, bal, peak, maxDD, monthly);
}

function summarise(trades, bal, peak, maxDD, monthly) {
  const wins = trades.filter(t => t > 0).length;
  const gW = trades.filter(t => t > 0).reduce((s,t) => s+t, 0);
  const gL = Math.abs(trades.filter(t => t <= 0).reduce((s,t) => s+t, 0));
  return { total: trades.length, wins, wr: wins/(trades.length||1)*100, pf: gW/(gL||1), maxDD, balance: bal, ret: (bal-START_BAL)/START_BAL*100, monthly };
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
const MNAMES = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmtP = n => (n>=0?'+':'')+n.toFixed(1)+'%';
const fmtD = n => (n>=0?'+$':'-$')+Math.abs(n).toFixed(0);

console.log('\n'+'═'.repeat(90));
console.log('  MEXC STOCKS BACKTEST — DT + ORB  |  $6,250 pool ($625/symbol)  |  5x lev  |  150 days');
console.log('  Comparing MEXC data vs prior BitMEX results');
console.log('═'.repeat(90));
console.log('  Fetching MEXC data...\n');

const results = [];

for (const sym of SYMBOLS) {
  process.stdout.write(`  ${sym.mexc.padEnd(18)} `);
  const bars5  = await fetchMexcBars(sym.mexc, DAYS);
  const bars15 = agg(bars5, 3);
  process.stdout.write(`${bars5.length} bars  `);

  if (bars5.length < 100) {
    process.stdout.write(`⚠️  insufficient data\n`);
    results.push({ ...sym, dt: summarise([],START_BAL,START_BAL,0,{}), orb: summarise([],START_BAL,START_BAL,0,{}), best: { ...summarise([],START_BAL,START_BAL,0,{}), strat:'N/A' } });
    continue;
  }

  const dt  = runDT(bars15);
  const orb = runORB(bars5);
  const best = dt.ret >= orb.ret ? { ...dt, strat:'DT' } : { ...orb, strat:'ORB' };
  process.stdout.write(`DT:${(dt.ret>=0?'+':'')+dt.ret.toFixed(0)}%  ORB:${(orb.ret>=0?'+':'')+orb.ret.toFixed(0)}%  → Best: ${best.strat} ${(best.ret>=0?'+':'')+best.ret.toFixed(1)}%\n`);
  results.push({ ...sym, dt, orb, best });
}

// ── Per-symbol results table ──────────────────────────────────────────────────
results.sort((a, b) => b.best.ret - a.best.ret);

const profitable = results.filter(r => r.best.ret > 0);
const losers     = results.filter(r => r.best.ret <= 0);

console.log('\n\n'+'═'.repeat(100));
console.log('  RESULTS — Best strategy per symbol  |  $625/symbol  |  5x leverage');
console.log('═'.repeat(100));
console.log(`  ${'MEXC Symbol'.padEnd(20)} ${'BitMEX'.padEnd(13)} ${'Best'.padEnd(5)} ${'Trades'.padStart(7)} ${'WR'.padStart(5)} ${'PF'.padStart(5)} ${'MaxDD'.padStart(7)} ${'Return'.padStart(8)} ${'$625→'.padStart(8)}`);
console.log('  '+'-'.repeat(92));

for (const r of profitable) {
  const flag = r.best.ret > 50 ? '🔥' : r.best.ret > 20 ? '✅' : r.best.ret > 10 ? '→' : '·';
  console.log(
    `  ${r.mexc.padEnd(20)} ${r.bitmex.padEnd(13)} ${r.best.strat.padEnd(5)}` +
    `${String(r.best.total).padStart(7)}` +
    `${(r.best.wr.toFixed(0)+'%').padStart(5)}` +
    `${r.best.pf.toFixed(2).padStart(5)}` +
    `${(r.best.maxDD.toFixed(1)+'%').padStart(7)}` +
    `${fmtP(r.best.ret).padStart(8)}` +
    `${'$'+r.best.balance.toFixed(0).padStart(7)}  ${flag}`
  );
}
console.log('  '+'-'.repeat(92));
for (const r of losers) {
  console.log(
    `  ${r.mexc.padEnd(20)} ${r.bitmex.padEnd(13)} ${r.best.strat.padEnd(5)}` +
    `${String(r.best.total).padStart(7)}` +
    `${(r.best.wr.toFixed(0)+'%').padStart(5)}` +
    `${r.best.pf.toFixed(2).padStart(5)}` +
    `${(r.best.maxDD.toFixed(1)+'%').padStart(7)}` +
    `${fmtP(r.best.ret).padStart(8)}` +
    `${'$'+r.best.balance.toFixed(0).padStart(7)}  ❌`
  );
}

// ── Dream portfolio combined ──────────────────────────────────────────────────
console.log('\n\n'+'═'.repeat(90));
console.log(`  DREAM PORTFOLIO — ${profitable.length} profitable symbols`);
console.log(`  Strategy mix: ${profitable.filter(r=>r.best.strat==='DT').length}× DT  |  ${profitable.filter(r=>r.best.strat==='ORB').length}× ORB`);
console.log('═'.repeat(90));

const combinedMonthly = {};
for (const r of profitable) {
  for (const [m, data] of Object.entries(r.best.monthly)) {
    if (!combinedMonthly[m]) combinedMonthly[m] = { pnl:0, tr:0, wins:0 };
    combinedMonthly[m].pnl  += data.pnl;
    combinedMonthly[m].tr   += data.tr;
    combinedMonthly[m].wins += data.wins;
  }
}

const totalStart = profitable.length * START_BAL;
let runBal = totalStart;

console.log(`\n  ${'Month'.padEnd(10)} ${'Trades'.padStart(7)} ${'Wins'.padStart(5)} ${'WR'.padStart(5)} ${'P&L'.padStart(10)} ${'Month%'.padStart(8)} ${'Balance'.padStart(11)} ${'CumRet%'.padStart(9)}`);
console.log('  '+'-'.repeat(72));

for (const m of Object.keys(combinedMonthly).sort()) {
  const d = combinedMonthly[m];
  const prevBal = runBal; runBal += d.pnl;
  const [yr,mo] = m.split('-');
  const label = `${MNAMES[+mo]} ${yr}`;
  const wr_ = (d.wins/(d.tr||1)*100).toFixed(0)+'%';
  const monPct = (d.pnl / prevBal * 100);
  const cumRet = (runBal - totalStart) / totalStart * 100;
  console.log(
    `  ${label.padEnd(10)}` +
    `${String(d.tr).padStart(7)}` +
    `${String(d.wins).padStart(5)}` +
    `${wr_.padStart(5)}` +
    `${fmtD(d.pnl).padStart(10)}` +
    `${fmtP(monPct).padStart(8)}` +
    `${'$'+runBal.toFixed(0).padStart(9)}` +
    `${fmtP(cumRet).padStart(9)}`
  );
}

const totalFinal = profitable.reduce((s,r) => s + r.best.balance, 0);
const totalRet   = (totalFinal - totalStart) / totalStart * 100;
const avgDD      = profitable.reduce((s,r) => s + r.best.maxDD, 0) / (profitable.length || 1);

console.log('  '+'-'.repeat(72));
console.log(`\n  Starting capital:  $${totalStart.toFixed(0)} (${profitable.length} symbols × $${START_BAL.toFixed(0)})`);
console.log(`  Final balance:     $${totalFinal.toFixed(0)}`);
console.log(`  Total P&L:         ${fmtD(totalFinal - totalStart)}`);
console.log(`  Portfolio return:  ${fmtP(totalRet)}`);
console.log(`  Avg max drawdown:  ${avgDD.toFixed(1)}%`);
console.log(`  Avg win rate:      ${(profitable.reduce((s,r)=>s+r.best.wr,0)/(profitable.length||1)).toFixed(1)}%`);

// ── BitMEX vs MEXC comparison summary ────────────────────────────────────────
console.log('\n\n'+'═'.repeat(90));
console.log('  MEXC vs BitMEX COMPARISON');
console.log('═'.repeat(90));
console.log(`  ${''.padEnd(25)} ${'BitMEX'.padStart(12)} ${'MEXC'.padStart(12)} ${'Diff'.padStart(10)}`);
console.log('  '+'-'.repeat(62));

const bitmexReturn = 22.8, bitmexDD = 9.4, bitmexPnl = 1187;
const diff = totalRet - bitmexReturn;

console.log(`  ${'Portfolio return'.padEnd(25)} ${('+'+bitmexReturn+'%').padStart(12)} ${fmtP(totalRet).padStart(12)} ${(diff>=0?'+':'')+diff.toFixed(1)+'%'.padStart(10)}`);
console.log(`  ${'Avg max drawdown'.padEnd(25)} ${(bitmexDD+'%').padStart(12)} ${(avgDD.toFixed(1)+'%').padStart(12)}`);
console.log(`  ${'Total P&L ($6,250)'.padEnd(25)} ${('+$'+bitmexPnl).padStart(12)} ${fmtD(totalFinal-totalStart).padStart(12)}`);
console.log(`  ${'SPY coverage'.padEnd(25)} ${'SPY (exact)'.padStart(12)} ${'QQQ (proxy)'.padStart(12)}`);
console.log(`  ${'Stock futures fees'.padEnd(25)} ${'~0.04%/trade'.padStart(12)} ${'0% (FREE)'.padStart(12)}`);
console.log(`  ${'Max stock leverage'.padEnd(25)} ${'5-10x'.padStart(12)} ${'100x'.padStart(12)}`);
console.log('');
