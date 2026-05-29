import https from 'https';

// ── Config ────────────────────────────────────────────────────────────────────
const DAYS       = 150;
const TOTAL_POOL = 6250;
const LEVERAGE   = 5;
const RISK_PCT   = 0.008;

const SYMBOLS = [
  { bitmex: 'SPYUSDT',   mexc: 'QQQSTOCK_USDT'  },
  { bitmex: 'MSTRUSDT',  mexc: 'MSTRSTOCK_USDT'  },
  { bitmex: 'TSLAUSDT',  mexc: 'TESLA_USDT'       },
  { bitmex: 'NFLXUSDT',  mexc: 'NFLXSTOCK_USDT'  },
  { bitmex: 'AMZNUSDT',  mexc: 'AMZNSTOCK_USDT'  },
  { bitmex: 'MSFTUSDT',  mexc: 'MSFTSTOCK_USDT'  },
  { bitmex: 'ORCLUSDT',  mexc: 'ORCLSTOCK_USDT'  },
  { bitmex: 'COINUSDT',  mexc: 'COINBASE_USDT'    },
  { bitmex: 'NVDAUSDT',  mexc: 'NVIDIA_USDT'      },
  { bitmex: 'GOOGLUSDT', mexc: 'GOOGLSTOCK_USDT'  },
];

const N_SYMS    = SYMBOLS.length;
const START_BAL = TOTAL_POOL / N_SYMS;   // $625/symbol

// ── Strategy constants ────────────────────────────────────────────────────────
const DT_SL = 0.0042, DT_TP = DT_SL * 1.3, DT_MAXHOLD = 12, DT_VOLMULT = 1.2;
const RTH_S = 13, RTH_E = 20;
const RTH_START_MIN = 13*60+30;          // 13:30 UTC = NYSE open
const ORB_TPMULT = 1.5, ORB_VOLMULT = 1.3;
const OR_START = 13*60+30, OR_END = 14*60, TRADE_END = 18*60, EOD_CLOSE = 19*60+55;

// ── MEXC API ──────────────────────────────────────────────────────────────────
function get(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)) } catch { res(null) } });
    }).on('error', rej);
  });
}

async function fetchMexcBars(symbol) {
  const now   = Math.floor(Date.now() / 1000);
  const start = now - DAYS * 86400;
  const windowSize = 2000 * 300;
  let bars = [], cursor = start;
  while (cursor < now) {
    const end  = Math.min(cursor + windowSize, now);
    const resp = await get(`https://futures.mexc.com/api/v1/contract/kline/${symbol}?interval=Min5&start=${cursor}&end=${end}`);
    if (!resp?.data?.time?.length) break;
    const d = resp.data;
    for (let i = 0; i < d.time.length; i++) {
      if (d.open[i] && d.high[i] && d.low[i] && d.close[i])
        bars.push({ t: d.time[i]*1000, o:+d.open[i], h:+d.high[i], l:+d.low[i], c:+d.close[i], v:+(d.vol[i]||0) });
    }
    cursor = d.time[d.time.length-1] + 300;
    await new Promise(r => setTimeout(r, 200));
  }
  const seen = new Set();
  return bars.filter(b => { if(seen.has(b.t)) return false; seen.add(b.t); return true; }).sort((a,b)=>a.t-b.t);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function agg(bars, n) {
  const out = [];
  for (let i = 0; i+n-1 < bars.length; i += n) {
    const g = bars.slice(i, i+n);
    out.push({ t:g[0].t, o:g[0].o, h:Math.max(...g.map(b=>b.h)), l:Math.min(...g.map(b=>b.l)), c:g[g.length-1].c, v:g.reduce((s,b)=>s+b.v,0) });
  }
  return out;
}

function calcEma(arr, p) { const k=2/(p+1); let e=arr[0]; return arr.map(v=>{e=v*k+e*(1-k);return e;}); }
function mk(t) { const d=new Date(t); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function minUTC(t) { const d=new Date(t); return d.getUTCHours()*60+d.getUTCMinutes(); }
function isRTH(t) { const h=new Date(t).getUTCHours(); return h>=RTH_S && h<RTH_E; }
function isOpenBar(t) { return minUTC(t)===RTH_START_MIN; }  // exactly 13:30

// ── RTH-only volume SMA (the key fix for MEXC) ───────────────────────────────
// Builds a per-bar RTH volume SMA: for each bar, looks back at the last N RTH bars only
function buildRthVolSma(bars15, period=20) {
  const sma = new Array(bars15.length).fill(null);
  const rthHistory = [];   // rolling window of RTH volume values
  for (let i = 0; i < bars15.length; i++) {
    if (isRTH(bars15[i].t)) {
      rthHistory.push(bars15[i].v);
      if (rthHistory.length > period*3) rthHistory.shift();  // keep a buffer
      if (rthHistory.length >= period) {
        const window = rthHistory.slice(-period);
        sma[i] = window.reduce((s,v)=>s+v,0) / period;
      }
    }
  }
  return sma;
}

// ── DT Strategy — MEXC calibrated ────────────────────────────────────────────
function runDT_calibrated(bars15, skipOpenBar=true) {
  const c = bars15.map(b=>b.c);
  const e21 = calcEma(c, 21), e50 = calcEma(c, 50);
  const rthVolSma = buildRthVolSma(bars15);   // FIX: RTH-only volume baseline

  let bal=START_BAL, peak=START_BAL, maxDD=0, inTrade=false, trade={};
  const trades=[], monthly={};

  for (let i=Math.max(51,20); i<bars15.length; i++) {
    const b=bars15[i], p=bars15[i-1], h=new Date(b.t).getUTCHours();
    if (inTrade) {
      const held=i-trade.bar, lng=trade.dir==='LONG';
      let closed=false, ep=0;
      if (lng&&b.l<=trade.sl)       {ep=trade.sl;closed=true;}
      else if(!lng&&b.h>=trade.sl)  {ep=trade.sl;closed=true;}
      else if(lng&&b.h>=trade.tp)   {ep=trade.tp;closed=true;}
      else if(!lng&&b.l<=trade.tp)  {ep=trade.tp;closed=true;}
      else if(held>=DT_MAXHOLD)     {ep=b.c;closed=true;}
      if (closed) {
        const raw=lng?(ep-trade.entry)/trade.entry:(trade.entry-ep)/trade.entry;
        const pnl=bal*RISK_PCT*LEVERAGE*(raw/DT_SL);
        bal+=pnl; peak=Math.max(peak,bal); maxDD=Math.max(maxDD,(peak-bal)/peak*100);
        const m=mk(b.t); if(!monthly[m]) monthly[m]={tr:0,wins:0,pnl:0};
        monthly[m].tr++; monthly[m].pnl+=pnl; if(pnl>0) monthly[m].wins++;
        trades.push(pnl); inTrade=false;
      }
    }
    if (!inTrade && h>=RTH_S && h<RTH_E) {
      // FIX 2: Skip the first 15m bar at open (gap risk)
      if (skipOpenBar && isOpenBar(b.t)) continue;

      const rising=e50[i]>e50[i-4], falling=e50[i]<e50[i-4];
      const volSma=rthVolSma[i];   // FIX 1: use RTH-only SMA
      const vok=volSma!=null && b.v>DT_VOLMULT*volSma;
      const lng=p.c<e21[i-1]&&b.c>e21[i]&&rising&&vok;
      const sht=p.c>e21[i-1]&&b.c<e21[i]&&falling&&vok;
      if (lng||sht) { trade={dir:lng?'LONG':'SHORT',entry:b.c,sl:lng?b.c*(1-DT_SL):b.c*(1+DT_SL),tp:lng?b.c*(1+DT_TP):b.c*(1-DT_TP),bar:i}; inTrade=true; }
    }
  }
  return summarise(trades, bal, peak, maxDD, monthly);
}

// ── ORB Strategy — MEXC calibrated ───────────────────────────────────────────
function runORB_calibrated(bars5) {
  const dayMap={};
  for (const b of bars5) {
    const d=new Date(b.t), k=`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    if (!dayMap[k]) dayMap[k]=[]; dayMap[k].push(b);
  }

  let bal=START_BAL, peak=START_BAL, maxDD=0;
  const trades=[], monthly={};
  // FIX: rolling RTH-only average volume (last 20 RTH sessions)
  const sessionRthVols=[];

  for (const key of Object.keys(dayMap).sort()) {
    const db=dayMap[key];
    const rthBars=db.filter(b=>isRTH(b.t));
    const rthAvgVol = rthBars.length>0 ? rthBars.reduce((s,b)=>s+b.v,0)/rthBars.length : 0;
    if (rthAvgVol>0) { sessionRthVols.push(rthAvgVol); if(sessionRthVols.length>20) sessionRthVols.shift(); }

    // Use rolling mean of recent RTH sessions as volume baseline
    const avgVol = sessionRthVols.length>0 ? sessionRthVols.reduce((s,v)=>s+v,0)/sessionRthVols.length : 1;

    const orB=db.filter(b=>{const m=minUTC(b.t);return m>=OR_START&&m<OR_END;});
    if (orB.length<3) continue;
    const orH=Math.max(...orB.map(b=>b.h)), orL=Math.min(...orB.map(b=>b.l)), orR=orH-orL;
    if (orR<=0) continue;

    const tB=db.filter(b=>{const m=minUTC(b.t);return m>=OR_END&&m<TRADE_END;});
    let inTrade=false, trade={};

    for (const b of tB) {
      const m=minUTC(b.t), vok=b.v>ORB_VOLMULT*avgVol;
      if (inTrade) {
        const lng=trade.dir==='LONG';
        let closed=false, ep=0;
        if(lng&&b.l<=trade.sl)      {ep=trade.sl;closed=true;}
        else if(!lng&&b.h>=trade.sl){ep=trade.sl;closed=true;}
        else if(lng&&b.h>=trade.tp) {ep=trade.tp;closed=true;}
        else if(!lng&&b.l<=trade.tp){ep=trade.tp;closed=true;}
        else if(m>=EOD_CLOSE)       {ep=b.c;closed=true;}
        if (closed) {
          const raw=lng?(ep-trade.entry)/trade.entry:(trade.entry-ep)/trade.entry;
          const slPct=orR/trade.entry;
          const pnl=bal*RISK_PCT*LEVERAGE*(raw/slPct);
          bal+=pnl; peak=Math.max(peak,bal); maxDD=Math.max(maxDD,(peak-bal)/peak*100);
          const m_=mk(b.t); if(!monthly[m_]) monthly[m_]={tr:0,wins:0,pnl:0};
          monthly[m_].tr++; monthly[m_].pnl+=pnl; if(pnl>0) monthly[m_].wins++;
          trades.push(pnl); inTrade=false;
        }
      }
      if (!inTrade&&vok) {
        if(b.c>orH&&b.o<=orH)      {trade={dir:'LONG', entry:b.c,sl:orL,tp:b.c+orR*ORB_TPMULT};inTrade=true;}
        else if(b.c<orL&&b.o>=orL) {trade={dir:'SHORT',entry:b.c,sl:orH,tp:b.c-orR*ORB_TPMULT};inTrade=true;}
      }
    }
    if (inTrade) {
      const b=db[db.length-1], lng=trade.dir==='LONG';
      const raw=lng?(b.c-trade.entry)/trade.entry:(trade.entry-b.c)/trade.entry;
      const slPct=orR/trade.entry;
      const pnl=bal*RISK_PCT*LEVERAGE*(raw/slPct);
      bal+=pnl; peak=Math.max(peak,bal); maxDD=Math.max(maxDD,(peak-bal)/peak*100);
      const m_=mk(b.t); if(!monthly[m_]) monthly[m_]={tr:0,wins:0,pnl:0};
      monthly[m_].tr++; monthly[m_].pnl+=pnl; if(pnl>0) monthly[m_].wins++;
      trades.push(pnl);
    }
  }
  return summarise(trades, bal, peak, maxDD, monthly);
}

function summarise(trades, bal, peak, maxDD, monthly) {
  const wins=trades.filter(t=>t>0).length;
  const gW=trades.filter(t=>t>0).reduce((s,t)=>s+t,0);
  const gL=Math.abs(trades.filter(t=>t<=0).reduce((s,t)=>s+t,0));
  return { total:trades.length, wins, wr:wins/(trades.length||1)*100, pf:gW/(gL||1), maxDD, balance:bal, ret:(bal-START_BAL)/START_BAL*100, monthly };
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
const MNAMES=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmtP = n => (n>=0?'+':'')+n.toFixed(1)+'%';
const fmtD = n => (n>=0?'+$':'-$')+Math.abs(n).toFixed(0);

console.log('\n'+'═'.repeat(95));
console.log('  MEXC CALIBRATED BACKTEST — RTH Volume Fix + Gap Filter  |  $6,250 pool  |  150 days');
console.log('  Fixes: (1) RTH-only volume SMA  (2) Skip 13:30 open bar  (3) RTH session vol baseline for ORB');
console.log('═'.repeat(95));
console.log('  Fetching data...\n');

const results = [];

for (const sym of SYMBOLS) {
  process.stdout.write(`  ${sym.mexc.padEnd(20)} `);
  const bars5  = await fetchMexcBars(sym.mexc);
  const bars15 = agg(bars5, 3);
  process.stdout.write(`${bars5.length} bars  `);

  if (bars5.length < 200) {
    process.stdout.write(`⚠️  insufficient data\n`);
    const empty = summarise([],START_BAL,START_BAL,0,{});
    results.push({ ...sym, dt:empty, orb:empty, best:{...empty,strat:'N/A'} });
    continue;
  }

  const dt  = runDT_calibrated(bars15);
  const orb = runORB_calibrated(bars5);
  const best = dt.ret >= orb.ret ? {...dt, strat:'DT'} : {...orb, strat:'ORB'};
  process.stdout.write(`DT:${(dt.ret>=0?'+':'')+dt.ret.toFixed(0)}%  ORB:${(orb.ret>=0?'+':'')+orb.ret.toFixed(0)}%  → Best: ${best.strat} ${(best.ret>=0?'+':'')+best.ret.toFixed(1)}%\n`);
  results.push({ ...sym, dt, orb, best });
}

// ── Results table ─────────────────────────────────────────────────────────────
results.sort((a,b) => b.best.ret - a.best.ret);
const profitable = results.filter(r => r.best.ret > 0);
const losers     = results.filter(r => r.best.ret <= 0);

console.log('\n\n'+'═'.repeat(105));
console.log('  RESULTS — Best strategy per symbol  |  MEXC Calibrated  |  $625/symbol  |  5x leverage');
console.log('═'.repeat(105));
console.log(`  ${'MEXC Symbol'.padEnd(20)} ${'Best'.padEnd(5)} ${'Trades'.padStart(7)} ${'WR'.padStart(5)} ${'PF'.padStart(5)} ${'MaxDD'.padStart(7)} ${'Return'.padStart(8)} ${'$625→'.padStart(7)}  DT vs ORB`);
console.log('  '+'-'.repeat(96));

for (const r of profitable) {
  const flag = r.best.ret>50?'🔥':r.best.ret>20?'✅':r.best.ret>5?'→':'·';
  console.log(
    `  ${r.mexc.padEnd(20)} ${r.best.strat.padEnd(5)}` +
    `${String(r.best.total).padStart(7)}` +
    `${(r.best.wr.toFixed(0)+'%').padStart(5)}` +
    `${r.best.pf.toFixed(2).padStart(5)}` +
    `${(r.best.maxDD.toFixed(1)+'%').padStart(7)}` +
    `${fmtP(r.best.ret).padStart(8)}` +
    `${'$'+r.best.balance.toFixed(0).padStart(6)}  ` +
    `DT:${fmtP(r.dt.ret).padStart(7)}  ORB:${fmtP(r.orb.ret).padStart(7)}  ${flag}`
  );
}
console.log('  '+'-'.repeat(96));
for (const r of losers) {
  console.log(
    `  ${r.mexc.padEnd(20)} ${r.best.strat.padEnd(5)}` +
    `${String(r.best.total).padStart(7)}` +
    `${(r.best.wr.toFixed(0)+'%').padStart(5)}` +
    `${r.best.pf.toFixed(2).padStart(5)}` +
    `${(r.best.maxDD.toFixed(1)+'%').padStart(7)}` +
    `${fmtP(r.best.ret).padStart(8)}` +
    `${'$'+r.best.balance.toFixed(0).padStart(6)}  ` +
    `DT:${fmtP(r.dt.ret).padStart(7)}  ORB:${fmtP(r.orb.ret).padStart(7)}  ❌`
  );
}

// ── Dream portfolio ───────────────────────────────────────────────────────────
console.log('\n\n'+'═'.repeat(95));
console.log(`  DREAM PORTFOLIO — ${profitable.length} profitable symbols`);
console.log(`  Strategy mix: ${profitable.filter(r=>r.best.strat==='DT').length}× DT  |  ${profitable.filter(r=>r.best.strat==='ORB').length}× ORB`);
console.log('═'.repeat(95));

const combinedMonthly={};
for (const r of profitable) {
  for (const [m,data] of Object.entries(r.best.monthly)) {
    if(!combinedMonthly[m]) combinedMonthly[m]={pnl:0,tr:0,wins:0};
    combinedMonthly[m].pnl+=data.pnl; combinedMonthly[m].tr+=data.tr; combinedMonthly[m].wins+=data.wins;
  }
}

const totalStart=profitable.length*START_BAL;
let runBal=totalStart;
console.log(`\n  ${'Month'.padEnd(10)} ${'Trades'.padStart(7)} ${'Wins'.padStart(5)} ${'WR'.padStart(5)} ${'P&L'.padStart(10)} ${'Month%'.padStart(8)} ${'Balance'.padStart(11)} ${'CumRet%'.padStart(9)}`);
console.log('  '+'-'.repeat(72));
for (const m of Object.keys(combinedMonthly).sort()) {
  const d=combinedMonthly[m], prevBal=runBal; runBal+=d.pnl;
  const [yr,mo]=m.split('-');
  const label=`${MNAMES[+mo]} ${yr}`;
  console.log(
    `  ${label.padEnd(10)}` +
    `${String(d.tr).padStart(7)}` +
    `${String(d.wins).padStart(5)}` +
    `${(d.wins/(d.tr||1)*100).toFixed(0)+'%'.padStart(5)}` +
    `${fmtD(d.pnl).padStart(10)}` +
    `${fmtP(d.pnl/prevBal*100).padStart(8)}` +
    `${'$'+runBal.toFixed(0).padStart(9)}` +
    `${fmtP((runBal-totalStart)/totalStart*100).padStart(9)}`
  );
}

const totalFinal=profitable.reduce((s,r)=>s+r.best.balance,0);
const totalRet=(totalFinal-totalStart)/totalStart*100;
const avgDD=profitable.reduce((s,r)=>s+r.best.maxDD,0)/(profitable.length||1);
const avgWR=profitable.reduce((s,r)=>s+r.best.wr,0)/(profitable.length||1);

console.log('  '+'-'.repeat(72));
console.log(`\n  Starting capital:  $${totalStart.toFixed(0)} (${profitable.length} symbols × $${START_BAL.toFixed(0)})`);
console.log(`  Final balance:     $${totalFinal.toFixed(0)}`);
console.log(`  Total P&L:         ${fmtD(totalFinal-totalStart)}`);
console.log(`  Portfolio return:  ${fmtP(totalRet)}`);
console.log(`  Calmar ratio:      ${(totalRet*(365/DAYS)/avgDD).toFixed(2)}`);
console.log(`  Avg max drawdown:  ${avgDD.toFixed(1)}%`);
console.log(`  Avg win rate:      ${avgWR.toFixed(1)}%`);

// ── Side-by-side comparison ───────────────────────────────────────────────────
console.log('\n\n'+'═'.repeat(75));
console.log('  BEFORE vs AFTER CALIBRATION (MEXC)  +  BitMEX baseline');
console.log('═'.repeat(75));
console.log(`  ${'Metric'.padEnd(28)} ${'BitMEX'.padStart(10)} ${'MEXC raw'.padStart(10)} ${'MEXC fixed'.padStart(12)}`);
console.log('  '+'-'.repeat(65));
const bitmexRet=22.8, bitmexDD=9.4, bitmexSyms=10, bitmexPnl=1187;
const rawRet=83.6, rawDD=32.5, rawSyms=4, rawPnl=2091;  // from prior run
console.log(`  ${'Profitable symbols'.padEnd(28)} ${String(bitmexSyms).padStart(10)} ${String(rawSyms).padStart(10)} ${String(profitable.length).padStart(12)}`);
console.log(`  ${'Portfolio return'.padEnd(28)} ${('+'+bitmexRet+'%').padStart(10)} ${('+'+rawRet+'%').padStart(10)} ${fmtP(totalRet).padStart(12)}`);
console.log(`  ${'Avg max drawdown'.padEnd(28)} ${(bitmexDD+'%').padStart(10)} ${(rawDD+'%').padStart(10)} ${(avgDD.toFixed(1)+'%').padStart(12)}`);
console.log(`  ${'Total P&L ($)'.padEnd(28)} ${('+$'+bitmexPnl).padStart(10)} ${('+$'+rawPnl).padStart(10)} ${fmtD(totalFinal-totalStart).padStart(12)}`);
console.log(`  ${'Calmar ratio'.padEnd(28)} ${'2.43'.padStart(10)} ${'~2.5'.padStart(10)} ${((totalRet*(365/DAYS)/avgDD).toFixed(2)).padStart(12)}`);
console.log('');
