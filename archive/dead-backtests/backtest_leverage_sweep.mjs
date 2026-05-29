import https from 'https';

// ── Dream portfolio symbols (profitable from baseline run) ─────────────────────
const DREAM_DT  = ['SPYUSDT','MSTRUSDT','TSLAUSDT','NFLXUSDT','AMZNUSDT','MSFTUSDT','ORCLUSDT'];
const DREAM_ORB = ['COINUSDT','NVDAUSDT','GOOGLUSDT'];
const ALL_SYMS  = [...DREAM_DT, ...DREAM_ORB];
const DAYS      = 150;
const POOL      = 6250;
const N_SYMS    = 10;
const START_BAL = POOL / N_SYMS;   // $625/symbol

// ── Strategy constants (unchanged) ────────────────────────────────────────────
const DT_SL = 0.0042, DT_TP = DT_SL * 1.3, DT_MAXHOLD = 12, DT_VOLMULT = 1.2;
const RTH_S = 13, RTH_E = 20;
const ORB_TPMULT = 1.5, ORB_VOLMULT = 1.3;
const OR_START = 13*60+30, OR_END = 14*60, TRADE_END = 18*60, EOD_CLOSE = 19*60+55;

// ── Sweep combinations ────────────────────────────────────────────────────────
const COMBOS = [
  { risk: 0.008, lev: 5  },   // baseline
  { risk: 0.008, lev: 8  },
  { risk: 0.010, lev: 5  },
  { risk: 0.010, lev: 8  },
  { risk: 0.010, lev: 10 },
  { risk: 0.012, lev: 8  },
  { risk: 0.012, lev: 10 },
  { risk: 0.015, lev: 10 },   // aggressive ceiling
];

function get(url) {
  return new Promise((res,rej)=>{
    https.get(url,{headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'}},r=>{
      let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch{res([])}});
    }).on('error',rej);
  });
}

async function fetchBars(symbol, binSize, days) {
  const cutoff = new Date(Date.now()-days*86400000).toISOString().slice(0,10);
  let raw=[],cursor=cutoff,page=0;
  while(true){
    const chunk = await get(`https://www.bitmex.com/api/v1/trade/bucketed?binSize=${binSize}&symbol=${symbol}&count=1000&reverse=false&partial=false&startTime=${cursor}`);
    if(!Array.isArray(chunk)||chunk.length===0) break;
    raw=raw.concat(page===0?chunk:chunk.slice(1));
    if(chunk.length<1000) break;
    cursor=chunk[chunk.length-1].timestamp;
    page++;
    await new Promise(r=>setTimeout(r,280));
  }
  return raw.filter(b=>b.open&&b.high&&b.low&&b.close)
            .map(b=>({t:new Date(b.timestamp).getTime(),o:b.open,h:b.high,l:b.low,c:b.close,v:b.volume||0}));
}

function agg(bars,n){
  const out=[];
  for(let i=0;i+n-1<bars.length;i+=n){
    const g=bars.slice(i,i+n);
    out.push({t:g[0].t,o:g[0].o,h:Math.max(...g.map(b=>b.h)),l:Math.min(...g.map(b=>b.l)),c:g[g.length-1].c,v:g.reduce((s,b)=>s+b.v,0)});
  }
  return out;
}

function calcEma(arr,p){const k=2/(p+1);let e=arr[0];return arr.map(v=>{e=v*k+e*(1-k);return e;});}
function vSmaFn(v){return(i,p=20)=>{if(i<p)return null;let s=0;for(let j=i-p;j<i;j++)s+=v[j];return s/p;};}
function mk(t){const d=new Date(t);return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;}

function runDT(bars15, RISK_PCT, LEVERAGE) {
  const c=bars15.map(b=>b.c),v=bars15.map(b=>b.v);
  const e21=calcEma(c,21),e50=calcEma(c,50),vs=vSmaFn(v);
  let bal=START_BAL,peak=START_BAL,maxDD=0,inTrade=false,trade={};
  const trades=[],monthly={};
  for(let i=Math.max(51,20);i<bars15.length;i++){
    const b=bars15[i],p=bars15[i-1],h=new Date(b.t).getUTCHours();
    if(inTrade){
      const held=i-trade.bar,lng=trade.dir==='LONG';
      let closed=false,ep=0;
      if(lng&&b.l<=trade.sl){ep=trade.sl;closed=true;}
      else if(!lng&&b.h>=trade.sl){ep=trade.sl;closed=true;}
      else if(lng&&b.h>=trade.tp){ep=trade.tp;closed=true;}
      else if(!lng&&b.l<=trade.tp){ep=trade.tp;closed=true;}
      else if(held>=DT_MAXHOLD){ep=b.c;closed=true;}
      if(closed){
        const raw=lng?(ep-trade.entry)/trade.entry:(trade.entry-ep)/trade.entry;
        const pnl=bal*RISK_PCT*LEVERAGE*(raw/DT_SL);
        bal+=pnl;peak=Math.max(peak,bal);maxDD=Math.max(maxDD,(peak-bal)/peak*100);
        const m=mk(b.t);if(!monthly[m])monthly[m]={tr:0,wins:0,pnl:0};
        monthly[m].tr++;monthly[m].pnl+=pnl;if(pnl>0)monthly[m].wins++;
        trades.push(pnl);inTrade=false;
      }
    }
    if(!inTrade&&h>=RTH_S&&h<RTH_E){
      const rising=e50[i]>e50[i-4],falling=e50[i]<e50[i-4];
      const vv=vs(i);const vok=vv&&b.v>DT_VOLMULT*vv;
      const lng=p.c<e21[i-1]&&b.c>e21[i]&&rising&&vok;
      const sht=p.c>e21[i-1]&&b.c<e21[i]&&falling&&vok;
      if(lng||sht){trade={dir:lng?'LONG':'SHORT',entry:b.c,sl:lng?b.c*(1-DT_SL):b.c*(1+DT_SL),tp:lng?b.c*(1+DT_TP):b.c*(1-DT_TP),bar:i};inTrade=true;}
    }
  }
  return summarise(trades,bal,peak,maxDD,monthly);
}

function runORB(bars5, RISK_PCT, LEVERAGE) {
  const days={};
  for(const b of bars5){const d=new Date(b.t),k=`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;if(!days[k])days[k]=[];days[k].push(b);}
  let bal=START_BAL,peak=START_BAL,maxDD=0,totalVol=0,totalBars=0;
  const trades=[],monthly={};
  for(const key of Object.keys(days).sort()){
    const db=days[key];
    for(const b of db){totalVol+=b.v;totalBars++;}
    const avgVol=totalBars>0?totalVol/totalBars:1;
    const orB=db.filter(b=>{const m=new Date(b.t).getUTCHours()*60+new Date(b.t).getUTCMinutes();return m>=OR_START&&m<OR_END;});
    if(orB.length<3)continue;
    const orH=Math.max(...orB.map(b=>b.h)),orL=Math.min(...orB.map(b=>b.l)),orR=orH-orL;
    if(orR<=0)continue;
    const tB=db.filter(b=>{const m=new Date(b.t).getUTCHours()*60+new Date(b.t).getUTCMinutes();return m>=OR_END&&m<TRADE_END;});
    let inTrade=false,trade={};
    for(const b of tB){
      const m=new Date(b.t).getUTCHours()*60+new Date(b.t).getUTCMinutes(),vok=b.v>ORB_VOLMULT*avgVol;
      if(inTrade){
        const lng=trade.dir==='LONG';
        let closed=false,ep=0;
        if(lng&&b.l<=trade.sl){ep=trade.sl;closed=true;}
        else if(!lng&&b.h>=trade.sl){ep=trade.sl;closed=true;}
        else if(lng&&b.h>=trade.tp){ep=trade.tp;closed=true;}
        else if(!lng&&b.l<=trade.tp){ep=trade.tp;closed=true;}
        else if(m>=EOD_CLOSE){ep=b.c;closed=true;}
        if(closed){
          const raw=lng?(ep-trade.entry)/trade.entry:(trade.entry-ep)/trade.entry;
          const slPct=orR/trade.entry;
          const pnl=bal*RISK_PCT*LEVERAGE*(raw/slPct);
          bal+=pnl;peak=Math.max(peak,bal);maxDD=Math.max(maxDD,(peak-bal)/peak*100);
          const m_=mk(b.t);if(!monthly[m_])monthly[m_]={tr:0,wins:0,pnl:0};
          monthly[m_].tr++;monthly[m_].pnl+=pnl;if(pnl>0)monthly[m_].wins++;
          trades.push(pnl);inTrade=false;
        }
      }
      if(!inTrade&&vok){
        if(b.c>orH&&b.o<=orH){trade={dir:'LONG',entry:b.c,sl:orL,tp:b.c+orR*ORB_TPMULT};inTrade=true;}
        else if(b.c<orL&&b.o>=orL){trade={dir:'SHORT',entry:b.c,sl:orH,tp:b.c-orR*ORB_TPMULT};inTrade=true;}
      }
    }
    if(inTrade){
      const b=db[db.length-1],lng=trade.dir==='LONG';
      const raw=lng?(b.c-trade.entry)/trade.entry:(trade.entry-b.c)/trade.entry;
      const slPct=orR/trade.entry;
      const pnl=bal*RISK_PCT*LEVERAGE*(raw/slPct);
      bal+=pnl;peak=Math.max(peak,bal);maxDD=Math.max(maxDD,(peak-bal)/peak*100);
      const m_=mk(b.t);if(!monthly[m_])monthly[m_]={tr:0,wins:0,pnl:0};
      monthly[m_].tr++;monthly[m_].pnl+=pnl;if(pnl>0)monthly[m_].wins++;
      trades.push(pnl);
    }
  }
  return summarise(trades,bal,peak,maxDD,monthly);
}

function summarise(trades,bal,peak,maxDD,monthly){
  const wins=trades.filter(t=>t>0).length;
  const gW=trades.filter(t=>t>0).reduce((s,t)=>s+t,0);
  const gL=Math.abs(trades.filter(t=>t<=0).reduce((s,t)=>s+t,0));
  return{total:trades.length,wins,wr:wins/(trades.length||1)*100,pf:gW/(gL||1),maxDD,balance:bal,ret:(bal-START_BAL)/START_BAL*100,monthly};
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
console.log('\n'+'═'.repeat(90));
console.log('  LEVERAGE SWEEP — Stock Futures Dream Portfolio  |  $6,250 pool  |  150 days');
console.log('  Symbols: SPY MSTR TSLA NFLX AMZN MSFT ORCL (DT)  +  COIN NVDA GOOGL (ORB)');
console.log('═'.repeat(90));
console.log('\n  Fetching market data (once)...\n');

// Fetch all data first
const dataCache = {};
for(const sym of ALL_SYMS){
  process.stdout.write(`    ${sym.padEnd(14)} `);
  const bars5  = await fetchBars(sym, '5m', DAYS);
  const bars15 = agg(bars5, 3);
  dataCache[sym] = { bars5, bars15 };
  process.stdout.write(`${bars5.length} bars\n`);
  await new Promise(r=>setTimeout(r,200));
}

console.log('\n  Running sweep across all combinations...\n');

// ── Sweep results storage ────────────────────────────────────────────────────
const sweepResults = [];

for(const {risk, lev} of COMBOS){
  const symResults = [];
  for(const sym of ALL_SYMS){
    const { bars5, bars15 } = dataCache[sym];
    const isDT = DREAM_DT.includes(sym);
    const res = isDT ? runDT(bars15, risk, lev) : runORB(bars5, risk, lev);
    symResults.push({ sym, ...res, strat: isDT ? 'DT' : 'ORB' });
  }

  // Combine monthly across all dream symbols
  const combinedMonthly = {};
  for(const r of symResults){
    for(const [m, data] of Object.entries(r.monthly)){
      if(!combinedMonthly[m]) combinedMonthly[m] = { pnl:0, tr:0, wins:0 };
      combinedMonthly[m].pnl += data.pnl;
      combinedMonthly[m].tr  += data.tr;
      combinedMonthly[m].wins+= data.wins;
    }
  }

  const totalStart = N_SYMS * START_BAL;
  const totalFinal = symResults.reduce((s,r)=>s+r.balance, 0);
  const totalRet   = (totalFinal - totalStart) / totalStart * 100;
  const avgDD      = symResults.reduce((s,r)=>s+r.maxDD, 0) / symResults.length;
  const avgWR      = symResults.reduce((s,r)=>s+r.wr,    0) / symResults.length;
  const totalTrades= symResults.reduce((s,r)=>s+r.total, 0);

  // Worst single month
  let worstMonth = 0;
  let runBal = totalStart;
  for(const m of Object.keys(combinedMonthly).sort()){
    const pct = combinedMonthly[m].pnl / runBal * 100;
    worstMonth = Math.min(worstMonth, pct);
    runBal += combinedMonthly[m].pnl;
  }

  // Calmar = annual return / maxDD
  const annualRet = totalRet * (365/DAYS);
  const calmar    = avgDD > 0 ? annualRet / avgDD : 0;
  const effRisk   = (risk * lev * 100).toFixed(1);

  sweepResults.push({
    risk, lev, effRisk,
    ret: totalRet, finalBal: totalFinal,
    avgDD, avgWR, totalTrades,
    worstMonth, calmar,
    pnl: totalFinal - totalStart,
    monthly: combinedMonthly,
    symResults
  });
}

// ── Main comparison table ─────────────────────────────────────────────────────
const fmtP = n => (n>=0?'+':'')+n.toFixed(1)+'%';
const fmtD = n => (n>=0?'+$':'-$')+Math.abs(n).toFixed(0);

console.log('═'.repeat(100));
console.log('  RESULTS SUMMARY — Dream Portfolio ($6,250 pool, 10 symbols, 150 days)');
console.log('═'.repeat(100));
console.log(`  ${'Risk%'.padStart(5)} ${'Lev'.padStart(4)} ${'Eff.Risk'.padStart(9)} ${'Return'.padStart(8)} ${'P&L'.padStart(8)} ${'Final'.padStart(8)} ${'AvgDD'.padStart(7)} ${'WrstMo'.padStart(8)} ${'Calmar'.padStart(7)} ${'Trades'.padStart(7)}`);
console.log('  '+'-'.repeat(92));

for(const r of sweepResults){
  const isBaseline = r.risk === 0.008 && r.lev === 5;
  const tag = isBaseline ? ' ← baseline' :
              r.calmar >= sweepResults.reduce((mx,x)=>x.calmar>mx?x.calmar:mx, 0)*0.95 ? ' ⭐ best Calmar' :
              r.ret > 60 && r.avgDD < 25 ? ' ✅' : '';

  console.log(
    `  ${(r.risk*100).toFixed(1)+'%'.padStart(5)} ` +
    `${(r.lev+'x').padStart(4)} ` +
    `${(r.effRisk+'%').padStart(9)} ` +
    `${fmtP(r.ret).padStart(8)} ` +
    `${fmtD(r.pnl).padStart(8)} ` +
    `${'$'+r.finalBal.toFixed(0).padStart(7)} ` +
    `${fmtP(r.avgDD).padStart(7)} ` +
    `${fmtP(r.worstMonth).padStart(8)} ` +
    `${r.calmar.toFixed(2).padStart(7)} ` +
    `${String(r.totalTrades).padStart(7)}` +
    tag
  );
}

// ── Month-by-month for key scenarios ─────────────────────────────────────────
const MNAMES=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const keyScenarios = [
  sweepResults[0],   // baseline 0.8/5x
  sweepResults[3],   // 1.0/8x
  sweepResults[6],   // 1.2/10x
];
const scenarioLabels = ['0.8%/5x (baseline)','1.0%/8x (recommended)','1.2%/10x (aggressive)'];

console.log('\n\n'+'═'.repeat(95));
console.log('  MONTH-BY-MONTH — 3 key scenarios side by side');
console.log('═'.repeat(95));

// Gather all months
const allMonths = [...new Set(keyScenarios.flatMap(s=>Object.keys(s.monthly)))].sort();

const hdr = `  ${'Month'.padEnd(10)}  ` +
  keyScenarios.map((s,i)=>`${scenarioLabels[i].padEnd(22)}`).join('  ');
console.log(hdr);
console.log('  '+'-'.repeat(90));

for(const m of allMonths){
  const [yr,mo] = m.split('-');
  const label = `${MNAMES[+mo]} ${yr}`;
  const cols = keyScenarios.map(s=>{
    const d = s.monthly[m];
    if(!d) return '    —    (no trades)      ';
    const totalAtStart = N_SYMS * START_BAL; // approx, use fixed for display
    const pct = (d.pnl / (N_SYMS * START_BAL) * 100).toFixed(1);
    return `${fmtD(d.pnl).padStart(8)} (${(d.pnl>=0?'+':'')+pct+'%'.padEnd(7)})`;
  });
  console.log(`  ${label.padEnd(10)}  ${cols.join('   ')}`);
}

// ── Max drawdown context ──────────────────────────────────────────────────────
console.log('\n\n'+'═'.repeat(95));
console.log('  RISK CONTEXT — what each scenario means in dollar terms on $6,250');
console.log('═'.repeat(95));

for(const [i,r] of sweepResults.entries()){
  const isBaseline = r.risk === 0.008 && r.lev === 5;
  const lossPerTrade = START_BAL * r.risk * r.lev;   // per symbol per trade
  const totalLossPerBadTrade = lossPerTrade * N_SYMS;
  const maxDDdollars = POOL * r.avgDD / 100;
  const flag = isBaseline ? ' ← baseline' : '';

  console.log(
    `  ${(r.risk*100).toFixed(1)}%/${r.lev}x  ` +
    `Loss/trade/symbol: $${lossPerTrade.toFixed(2).padStart(6)}  ` +
    `Avg max DD: $${maxDDdollars.toFixed(0).padStart(5)} (${r.avgDD.toFixed(1)}%)  ` +
    `Annual proj: ${fmtP(r.ret*(365/DAYS))}${flag}`
  );
}

console.log('\n  Note: BitMEX stock futures max leverage is typically 5–10×.');
console.log('  Effective Risk = Risk% × Leverage = actual % of balance at risk per trade.\n');
