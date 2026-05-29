import https from 'https';

// ── Config ─────────────────────────────────────────────────────────────────────
const DAYS       = 150;
const TOTAL_POOL = 6250;
const LEVERAGE   = 5;
const RISK_PCT   = 0.008;
const MIN_BARS   = 5000;    // skip symbols with insufficient history

// All MEXC stock futures
const ALL_SYMBOLS = [
  'AAPLSTOCK_USDT','ABBVSTOCK_USDT','ADBESTOCK_USDT','AMATSTOCK_USDT','AMDSTOCK_USDT',
  'AMZNSTOCK_USDT','APLDSTOCK_USDT','ARMSTOCK_USDT','ASMLSTOCK_USDT','ASTSSTOCK_USDT',
  'AVGOSTOCK_USDT','BABASTOCK_USDT','BACSTOCK_USDT','BASTOCK_USDT','BESTOCK_USDT',
  'BMNRSTOCK_USDT','BRKBSTOCK_USDT','CBRSSTOCK_USDT','COHRSTOCK_USDT','COINBASE_USDT',
  'COPSTOCK_USDT','COSTSTOCK_USDT','CRCLSTOCK_USDT','CRMSTOCK_USDT','CRWDSTOCK_USDT',
  'CRWVSTOCK_USDT','CSCOSTOCK_USDT','CSTOCK_USDT','CVNASTOCK_USDT','CVXSTOCK_USDT',
  'DISSTOCK_USDT','FIGSTOCK_USDT','FLNCSTOCK_USDT','FUTUSTOCK_USDT','GESTOCK_USDT',
  'GEVSTOCK_USDT','GLWSTOCK_USDT','GMESTOCK_USDT','GOOGLSTOCK_USDT','HDSTOCK_USDT',
  'HIMSSTOCK_USDT','IBMSTOCK_USDT','INTCSTOCK_USDT','INTUSTOCK_USDT','IONQSTOCK_USDT',
  'IRENSTOCK_USDT','JDSTOCK_USDT','JPMSTOCK_USDT','KLACSTOCK_USDT','KOSTOCK_USDT',
  'LITESTOCK_USDT','LLYSTOCK_USDT','LMTSTOCK_USDT','LRCXSTOCK_USDT','MASTOCK_USDT',
  'MCDSTOCK_USDT','METASTOCK_USDT','MRVLSTOCK_USDT','MSFTSTOCK_USDT','MSTRSTOCK_USDT',
  'MUSTOCK_USDT','NBISSTOCK_USDT','NFLXSTOCK_USDT','NKESTOCK_USDT','NOWSTOCK_USDT',
  'NVIDIA_USDT','ONDSSTOCK_USDT','ORCLSTOCK_USDT','OXYSTOCK_USDT','PANWSTOCK_USDT',
  'PAYPSTOCK_USDT','PDDSTOCK_USDT','PGSTOCK_USDT','PLTRSTOCK_USDT','PYPLSTOCK_USDT',
  'QCOMSTOCK_USDT','QQQSTOCK_USDT','RDDTSTOCK_USDT','RKLBSTOCK_USDT','RTXSTOCK_USDT',
  'SAMSUNGSTOCK_USDT','SBUXSTOCK_USDT','SHOPSTOCK_USDT','SKHYNIXSTOCK_USDT','SMCISTOCK_USDT',
  'SNDKSTOCK_USDT','SNOWSTOCK_USDT','SPCXSTOCK_USDT','SPOTSTOCK_USDT','STXSTOCK_USDT',
  'TESLA_USDT','TSMSTOCK_USDT','TXNSTOCK_USDT','UBERSTOCK_USDT','UNHSTOCK_USDT',
  'USARSTOCK_USDT','VRTSTOCK_USDT','VSTOCK_USDT','VZSTOCK_USDT','WDCSTOCK_USDT',
  'WFCSTOCK_USDT','WMTSTOCK_USDT','XOMSTOCK_USDT',
];

// ── ORB constants ──────────────────────────────────────────────────────────────
const ORB_TPMULT = 1.5, ORB_VOLMULT = 1.3;
const OR_START = 13*60+30, OR_END = 14*60, TRADE_END = 18*60, EOD_CLOSE = 19*60+55;
const RTH_S = 13, RTH_E = 20;

// ── API ────────────────────────────────────────────────────────────────────────
function get(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)) } catch { res(null) } });
    }).on('error', rej);
  });
}

async function fetchBars(symbol) {
  const now   = Math.floor(Date.now() / 1000);
  const start = now - DAYS * 86400;
  const step  = 2000 * 300;
  let bars = [], cursor = start;
  while (cursor < now) {
    const end  = Math.min(cursor + step, now);
    const resp = await get(`https://futures.mexc.com/api/v1/contract/kline/${symbol}?interval=Min5&start=${cursor}&end=${end}`);
    if (!resp?.data?.time?.length) break;
    const d = resp.data;
    for (let i = 0; i < d.time.length; i++) {
      if (d.open[i] && d.close[i])
        bars.push({ t: d.time[i]*1000, o:+d.open[i], h:+d.high[i], l:+d.low[i], c:+d.close[i], v:+(d.vol[i]||0) });
    }
    cursor = d.time[d.time.length-1] + 300;
    await new Promise(r => setTimeout(r, 150));
  }
  const seen = new Set();
  return bars.filter(b => { if(seen.has(b.t)) return false; seen.add(b.t); return true; }).sort((a,b)=>a.t-b.t);
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function mk(t) { const d=new Date(t); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function minUTC(t) { const d=new Date(t); return d.getUTCHours()*60+d.getUTCMinutes(); }
function isRTH(t) { const h=new Date(t).getUTCHours(); return h>=RTH_S && h<RTH_E; }

// ── ORB — calibrated (RTH-session vol baseline) ─────────────────────────────────
function runORB(bars5, startBal) {
  const dayMap = {};
  for (const b of bars5) {
    const d=new Date(b.t), k=`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    if (!dayMap[k]) dayMap[k]=[]; dayMap[k].push(b);
  }

  let bal=startBal, peak=startBal, maxDD=0;
  const trades=[], monthly={};
  const sessionVols=[];   // rolling RTH avg vols

  for (const key of Object.keys(dayMap).sort()) {
    const db = dayMap[key];
    // Rolling RTH session avg volume baseline
    const rthBars = db.filter(b => isRTH(b.t));
    const rthAvg  = rthBars.length > 0 ? rthBars.reduce((s,b)=>s+b.v,0)/rthBars.length : 0;
    if (rthAvg > 0) { sessionVols.push(rthAvg); if (sessionVols.length > 20) sessionVols.shift(); }
    const avgVol = sessionVols.length > 0 ? sessionVols.reduce((s,v)=>s+v,0)/sessionVols.length : 1;

    // OR window
    const orB = db.filter(b => { const m=minUTC(b.t); return m>=OR_START && m<OR_END; });
    if (orB.length < 3) continue;
    const orH=Math.max(...orB.map(b=>b.h)), orL=Math.min(...orB.map(b=>b.l)), orR=orH-orL;
    if (orR <= 0) continue;

    // Trade window
    const tB = db.filter(b => { const m=minUTC(b.t); return m>=OR_END && m<TRADE_END; });
    let inTrade=false, trade={};

    for (const b of tB) {
      const m=minUTC(b.t), vok=b.v > ORB_VOLMULT*avgVol;
      if (inTrade) {
        const lng=trade.dir==='LONG';
        let closed=false, ep=0;
        if(lng&&b.l<=trade.sl)       {ep=trade.sl;closed=true;}
        else if(!lng&&b.h>=trade.sl) {ep=trade.sl;closed=true;}
        else if(lng&&b.h>=trade.tp)  {ep=trade.tp;closed=true;}
        else if(!lng&&b.l<=trade.tp) {ep=trade.tp;closed=true;}
        else if(m>=EOD_CLOSE)        {ep=b.c;closed=true;}
        if (closed) {
          const raw=lng?(ep-trade.entry)/trade.entry:(trade.entry-ep)/trade.entry;
          const slPct=orR/trade.entry;
          const pnl=bal*RISK_PCT*LEVERAGE*(raw/slPct);
          bal+=pnl; peak=Math.max(peak,bal); maxDD=Math.max(maxDD,(peak-bal)/peak*100);
          const mm=mk(b.t); if(!monthly[mm]) monthly[mm]={tr:0,wins:0,pnl:0};
          monthly[mm].tr++; monthly[mm].pnl+=pnl; if(pnl>0) monthly[mm].wins++;
          trades.push(pnl); inTrade=false;
        }
      }
      if (!inTrade && vok) {
        if(b.c>orH&&b.o<=orH)       {trade={dir:'LONG', entry:b.c,sl:orL,tp:b.c+orR*ORB_TPMULT};inTrade=true;}
        else if(b.c<orL&&b.o>=orL)  {trade={dir:'SHORT',entry:b.c,sl:orH,tp:b.c-orR*ORB_TPMULT};inTrade=true;}
      }
    }
    // EOD force-close
    if (inTrade) {
      const b=db[db.length-1], lng=trade.dir==='LONG';
      const raw=lng?(b.c-trade.entry)/trade.entry:(trade.entry-b.c)/trade.entry;
      const slPct=orR/trade.entry;
      const pnl=bal*RISK_PCT*LEVERAGE*(raw/slPct);
      bal+=pnl; peak=Math.max(peak,bal); maxDD=Math.max(maxDD,(peak-bal)/peak*100);
      const mm=mk(b.t); if(!monthly[mm]) monthly[mm]={tr:0,wins:0,pnl:0};
      monthly[mm].tr++; monthly[mm].pnl+=pnl; if(pnl>0) monthly[mm].wins++;
      trades.push(pnl);
    }
  }

  const wins=trades.filter(t=>t>0).length;
  const gW=trades.filter(t=>t>0).reduce((s,t)=>s+t,0);
  const gL=Math.abs(trades.filter(t=>t<=0).reduce((s,t)=>s+t,0));
  const pf = gL>0 ? gW/gL : wins>0 ? 99 : 0;
  const ret=(bal-startBal)/startBal*100;
  const annRet=ret*(365/DAYS);
  const calmar=maxDD>0 ? annRet/maxDD : 0;
  return { total:trades.length, wins, wr:wins/(trades.length||1)*100, pf, maxDD, balance:bal, ret, calmar, monthly };
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
const MNAMES=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmtP = n => (n>=0?'+':'')+n.toFixed(1)+'%';
const fmtD = n => (n>=0?'+$':'-$')+Math.abs(n).toFixed(0);

console.log('\n'+'═'.repeat(90));
console.log(`  MEXC ORB WIDE SCAN — ${ALL_SYMBOLS.length} stock futures  |  RTH-calibrated  |  150 days`);
console.log('  Finding best ORB symbols across all MEXC stock futures');
console.log('═'.repeat(90));
console.log('  Scanning... (streaming results as each symbol completes)\n');

// Dynamic per-symbol allocation — we'll pick top N, split pool
const TEMP_BAL = TOTAL_POOL / 10;   // assume 10 symbols for per-symbol runs
const allResults = [];
let done = 0;

for (const sym of ALL_SYMBOLS) {
  process.stdout.write(`  [${String(++done).padStart(3)}/${ALL_SYMBOLS.length}] ${sym.padEnd(22)} `);
  let bars;
  try { bars = await fetchBars(sym); } catch { process.stdout.write(`fetch error\n`); continue; }

  if (bars.length < MIN_BARS) {
    process.stdout.write(`skip (${bars.length} bars)\n`);
    continue;
  }

  const res = runORB(bars, TEMP_BAL);
  const marker = res.ret > 20 ? '🔥' : res.ret > 10 ? '✅' : res.ret > 0 ? '·' : '❌';
  process.stdout.write(
    `${String(bars.length).padStart(6)} bars  ` +
    `${String(res.total).padStart(3)} trades  ` +
    `WR:${res.wr.toFixed(0).padStart(3)}%  ` +
    `PF:${res.pf.toFixed(2).padStart(5)}  ` +
    `DD:${res.maxDD.toFixed(1).padStart(5)}%  ` +
    `${fmtP(res.ret).padStart(8)}  ` +
    `Calmar:${res.calmar.toFixed(2).padStart(6)}  ${marker}\n`
  );
  allResults.push({ sym, ...res });
}

// ── Top results ────────────────────────────────────────────────────────────────
allResults.sort((a,b) => b.calmar - a.calmar);
const profitable = allResults.filter(r => r.ret > 0 && r.total >= 5);
const top10 = profitable.slice(0, 10);

console.log('\n\n'+'═'.repeat(100));
console.log(`  TOP PERFORMERS — Ranked by Calmar (return/risk)  |  ${profitable.length} profitable symbols found`);
console.log('═'.repeat(100));
console.log(`  ${'Symbol'.padEnd(22)} ${'Trades'.padStart(7)} ${'WR'.padStart(5)} ${'PF'.padStart(6)} ${'MaxDD'.padStart(7)} ${'Return'.padStart(9)} ${'Calmar'.padStart(8)} ${'$625→'.padStart(8)}`);
console.log('  '+'-'.repeat(92));

for (const r of profitable.slice(0,20)) {
  const flag = r.calmar > 8 ? '⭐' : r.calmar > 5 ? '✅' : '·';
  console.log(
    `  ${r.sym.padEnd(22)}` +
    `${String(r.total).padStart(7)}` +
    `${(r.wr.toFixed(0)+'%').padStart(5)}` +
    `${r.pf.toFixed(2).padStart(6)}` +
    `${(r.maxDD.toFixed(1)+'%').padStart(7)}` +
    `${fmtP(r.ret).padStart(9)}` +
    `${r.calmar.toFixed(2).padStart(8)}` +
    `${'$'+r.balance.toFixed(0).padStart(7)}  ${flag}`
  );
}

// ── Dream portfolio with top 10 ────────────────────────────────────────────────
if (top10.length === 0) { console.log('\n  No profitable symbols found.'); process.exit(0); }

const perSym   = TOTAL_POOL / top10.length;
const scaleFactor = perSym / TEMP_BAL;

console.log('\n\n'+'═'.repeat(90));
console.log(`  DREAM PORTFOLIO — Top ${top10.length} symbols  |  $${perSym.toFixed(0)}/symbol ($${TOTAL_POOL.toLocaleString()} total)`);
console.log(`  All ORB strategy  |  5x leverage  |  0% MEXC fees`);
console.log('═'.repeat(90));

// Rebuild combined monthly with correct per-symbol allocation
const combinedMonthly = {};
for (const r of top10) {
  // Re-run with correct per-symbol start balance
  // We stored monthly P&L based on TEMP_BAL — scale it
  for (const [m, data] of Object.entries(r.monthly)) {
    if (!combinedMonthly[m]) combinedMonthly[m] = { pnl:0, tr:0, wins:0 };
    combinedMonthly[m].pnl  += data.pnl * scaleFactor;
    combinedMonthly[m].tr   += data.tr;
    combinedMonthly[m].wins += data.wins;
  }
}

const totalStart = top10.length * perSym;
let runBal = totalStart;

console.log(`\n  ${'Month'.padEnd(10)} ${'Trades'.padStart(7)} ${'Wins'.padStart(5)} ${'WR'.padStart(5)} ${'P&L'.padStart(10)} ${'Month%'.padStart(8)} ${'Balance'.padStart(11)} ${'CumRet%'.padStart(9)}`);
console.log('  '+'-'.repeat(72));

for (const m of Object.keys(combinedMonthly).sort()) {
  const d=combinedMonthly[m], prevBal=runBal; runBal+=d.pnl;
  const [yr,mo]=m.split('-');
  console.log(
    `  ${(MNAMES[+mo]+' '+yr).padEnd(10)}` +
    `${String(d.tr).padStart(7)}` +
    `${String(d.wins).padStart(5)}` +
    `${(d.wins/(d.tr||1)*100).toFixed(0)+'%'.padStart(4)}` +
    `${fmtD(d.pnl).padStart(10)}` +
    `${fmtP(d.pnl/prevBal*100).padStart(8)}` +
    `${'$'+runBal.toFixed(0).padStart(9)}` +
    `${fmtP((runBal-totalStart)/totalStart*100).padStart(9)}`
  );
}

const totalFinal = top10.reduce((s,r) => s + r.balance*scaleFactor + perSym - TEMP_BAL*scaleFactor, 0);
// Simpler: scale returns
const portRet = top10.reduce((s,r) => s + r.ret, 0) / top10.length;
const avgDD   = top10.reduce((s,r) => s + r.maxDD, 0) / top10.length;
const avgWR   = top10.reduce((s,r) => s + r.wr, 0) / top10.length;
const scaledPnl = top10.reduce((s,r) => s + (r.balance-TEMP_BAL)*scaleFactor, 0);
const scaledFinal = totalStart + scaledPnl;
const scaledRet = scaledPnl / totalStart * 100;
const calmar = avgDD > 0 ? scaledRet*(365/DAYS)/avgDD : 0;

console.log('  '+'-'.repeat(72));
console.log(`\n  Starting capital:  $${totalStart.toLocaleString()}`);
console.log(`  Final balance:     $${scaledFinal.toFixed(0)}`);
console.log(`  Total P&L:         ${fmtD(scaledPnl)}`);
console.log(`  Portfolio return:  ${fmtP(scaledRet)}`);
console.log(`  Calmar ratio:      ${calmar.toFixed(2)}`);
console.log(`  Avg max drawdown:  ${avgDD.toFixed(1)}%`);
console.log(`  Avg win rate:      ${avgWR.toFixed(1)}%`);

console.log('\n\n'+'═'.repeat(90));
console.log('  SELECTED DREAM PORTFOLIO — Top 10 by Calmar');
console.log('═'.repeat(90));
for (const r of top10) {
  const scaled = perSym * (1 + r.ret/100);
  console.log(`  ${r.sym.padEnd(22)}  ORB  $${perSym.toFixed(0)} → $${scaled.toFixed(0)}  (${fmtP(r.ret)})  DD:${r.maxDD.toFixed(1)}%  Calmar:${r.calmar.toFixed(2)}`);
}
console.log('');
