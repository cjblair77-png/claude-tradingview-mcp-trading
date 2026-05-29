import https from 'https';

const TOTAL_POOL = 6250;          // combined capital across dream portfolio (Option B weighting)
const START_BAL  = TOTAL_POOL / 12; // $520.83/symbol (12 profitable symbols from prior run)
const LEVERAGE   = 5;
const RISK_PCT   = 0.008;

// DT config
const DT_SL = 0.0042, DT_TP = DT_SL * 1.3, DT_MAXHOLD = 12, DT_VOLMULT = 1.2;
const RTH_S = 13, RTH_E = 20;

// ORB config
const ORB_TPMULT = 1.5, ORB_VOLMULT = 1.3;
const OR_START = 13*60+30, OR_END = 14*60, TRADE_END = 18*60, EOD_CLOSE = 19*60+55;

const SYMBOLS_162 = ['SPYUSDT','QQQUSDT','TSLAUSDT','NVDAUSDT','AAPLUSDT','METAUSDT','AMZNUSDT','COINUSDT','HOODUSDT'];
const SYMBOLS_76  = ['JPMUSDT','PLTRUSDT','NFLXUSDT','GOOGLUSDT','ORCLUSDT','AVGOUSDT','XOMUSDT','INTCUSDT','MSFTUSDT','MSTRUSDT','XAGUSDT'];

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
function minUTC(t){const d=new Date(t);return d.getUTCHours()*60+d.getUTCMinutes();}
function mk(t){const d=new Date(t);return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;}

function runDT(bars15){
  const c=bars15.map(b=>b.c),v=bars15.map(b=>b.v);
  const e21=calcEma(c,21),e50=calcEma(c,50),vs=vSmaFn(v);
  let bal=START_BAL,peak=START_BAL,maxDD=0,inTrade=false,trade={};
  const trades=[],monthly={};
  for(let i=Math.max(51,20);i<bars15.length;i++){
    const b=bars15[i],p=bars15[i-1],h=new Date(b.t).getUTCHours();
    if(inTrade){
      const held=i-trade.bar,lng=trade.dir==='LONG';
      let closed=false,ep=0,why='';
      if(lng&&b.l<=trade.sl){ep=trade.sl;why='SL';closed=true;}
      else if(!lng&&b.h>=trade.sl){ep=trade.sl;why='SL';closed=true;}
      else if(lng&&b.h>=trade.tp){ep=trade.tp;why='TP';closed=true;}
      else if(!lng&&b.l<=trade.tp){ep=trade.tp;why='TP';closed=true;}
      else if(held>=DT_MAXHOLD){ep=b.c;why='TIME';closed=true;}
      if(closed){
        const raw=lng?(ep-trade.entry)/trade.entry:(trade.entry-ep)/trade.entry;
        const pnl=bal*RISK_PCT*LEVERAGE*(raw/DT_SL);
        bal+=pnl;peak=Math.max(peak,bal);maxDD=Math.max(maxDD,(peak-bal)/peak*100);
        const m=mk(b.t);if(!monthly[m])monthly[m]={tr:0,wins:0,pnl:0,b0:bal-pnl};
        monthly[m].tr++;monthly[m].pnl+=pnl;if(pnl>0)monthly[m].wins++;
        trades.push({pnl,why});inTrade=false;
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

function runORB(bars5){
  const days={};
  for(const b of bars5){const d=new Date(b.t),k=`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;if(!days[k])days[k]=[];days[k].push(b);}
  let bal=START_BAL,peak=START_BAL,maxDD=0,totalVol=0,totalBars=0;
  const trades=[],monthly={};
  for(const key of Object.keys(days).sort()){
    const db=days[key];
    for(const b of db){totalVol+=b.v;totalBars++;}
    const avgVol=totalBars>0?totalVol/totalBars:1;
    const orB=db.filter(b=>{const m=minUTC(b.t);return m>=OR_START&&m<OR_END;});
    if(orB.length<3)continue;
    const orH=Math.max(...orB.map(b=>b.h)),orL=Math.min(...orB.map(b=>b.l)),orR=orH-orL;
    if(orR<=0)continue;
    const tB=db.filter(b=>{const m=minUTC(b.t);return m>=OR_END&&m<TRADE_END;});
    let inTrade=false,trade={};
    for(const b of tB){
      const m=minUTC(b.t),vok=b.v>ORB_VOLMULT*avgVol;
      if(inTrade){
        const lng=trade.dir==='LONG';
        let closed=false,ep=0,why='';
        if(lng&&b.l<=trade.sl){ep=trade.sl;why='SL';closed=true;}
        else if(!lng&&b.h>=trade.sl){ep=trade.sl;why='SL';closed=true;}
        else if(lng&&b.h>=trade.tp){ep=trade.tp;why='TP';closed=true;}
        else if(!lng&&b.l<=trade.tp){ep=trade.tp;why='TP';closed=true;}
        else if(m>=EOD_CLOSE){ep=b.c;why='EOD';closed=true;}
        if(closed){
          const raw=lng?(ep-trade.entry)/trade.entry:(trade.entry-ep)/trade.entry;
          const slPct=orR/trade.entry;
          const pnl=bal*RISK_PCT*LEVERAGE*(raw/slPct);
          bal+=pnl;peak=Math.max(peak,bal);maxDD=Math.max(maxDD,(peak-bal)/peak*100);
          const m_=mk(b.t);if(!monthly[m_])monthly[m_]={tr:0,wins:0,pnl:0,b0:bal-pnl};
          monthly[m_].tr++;monthly[m_].pnl+=pnl;if(pnl>0)monthly[m_].wins++;
          trades.push({pnl,why});inTrade=false;
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
      const m_=mk(b.t);if(!monthly[m_])monthly[m_]={tr:0,wins:0,pnl:0,b0:bal-pnl};
      monthly[m_].tr++;monthly[m_].pnl+=pnl;if(pnl>0)monthly[m_].wins++;
      trades.push({pnl,why:'EOD'});
    }
  }
  return summarise(trades,bal,peak,maxDD,monthly);
}

function summarise(trades,bal,peak,maxDD,monthly){
  const wins=trades.filter(t=>t.pnl>0).length;
  const gW=trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
  const gL=Math.abs(trades.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0));
  return{total:trades.length,wins,wr:wins/(trades.length||1)*100,pf:gW/(gL||1),maxDD,balance:bal,ret:(bal-START_BAL)/START_BAL*100,monthly};
}

// ── Run everything ────────────────────────────────────────────────────────────
const results=[];
const MNAMES=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

console.log('\n'+'='.repeat(80));
console.log('  BITMEX STOCKS — DT + ORB  |  $5,000 pool ($416/symbol)  |  5x leverage  |  150 days');
console.log('='.repeat(80));
console.log('  Fetching data & running simulations...\n');

for(const sym of [...SYMBOLS_162,...SYMBOLS_76]){
  const days=SYMBOLS_162.includes(sym)?162:76;
  process.stdout.write(`  ${sym.padEnd(13)} `);
  const bars5=await fetchBars(sym,'5m',days);
  const bars15=agg(bars5,3);
  const dt=runDT(bars15);
  const orb=runORB(bars5);
  const best=dt.ret>=orb.ret?{...dt,strat:'DT'}:{...orb,strat:'ORB'};
  process.stdout.write(`DT:${(dt.ret>=0?'+':'')+dt.ret.toFixed(0)+'%'}  ORB:${(orb.ret>=0?'+':'')+orb.ret.toFixed(0)+'%'}  → Best: ${best.strat} ${(best.ret>=0?'+':'')+best.ret.toFixed(1)+'%'}\n`);
  results.push({sym,days,dt,orb,best});
  await new Promise(r=>setTimeout(r,100));
}

// ── Results table ─────────────────────────────────────────────────────────────
const fmtD=n=>(n>=0?'+$':'-$')+Math.abs(n).toFixed(0);
const fmtP=n=>(n>=0?'+':'')+n.toFixed(1)+'%';

results.sort((a,b)=>b.best.ret-a.best.ret);

console.log('\n\n'+'='.repeat(95));
console.log('  RESULTS — Best strategy per symbol  |  $416/symbol ($5k total pool)  |  5x leverage');
console.log('='.repeat(95));
console.log(`  ${'Symbol'.padEnd(13)} ${'Best'.padEnd(6)} ${'Trades'.padStart(7)} ${'WR'.padStart(6)} ${'PF'.padStart(6)} ${'MaxDD'.padStart(7)} ${'Return'.padStart(9)} ${'$416→'.padStart(9)}  DT vs ORB`);
console.log('  '+'-'.repeat(88));

const profitable=results.filter(r=>r.best.ret>0);
const losers=results.filter(r=>r.best.ret<=0);

for(const r of profitable){
  const flag=r.best.ret>50?'🔥':r.best.ret>20?'✅':r.best.ret>10?'→':'·';
  console.log(
    `  ${r.sym.padEnd(13)} ${r.best.strat.padEnd(6)}` +
    `${String(r.best.total).padStart(7)}` +
    `${(r.best.wr.toFixed(0)+'%').padStart(6)}` +
    `${r.best.pf.toFixed(2).padStart(6)}` +
    `${(r.best.maxDD.toFixed(1)+'%').padStart(7)}` +
    `${fmtP(r.best.ret).padStart(9)}` +
    `${'$'+r.best.balance.toFixed(0).padStart(7)}  ` +
    `DT:${fmtP(r.dt.ret).padStart(7)}  ORB:${fmtP(r.orb.ret).padStart(7)}  ${flag}`
  );
}
console.log('  '+'-'.repeat(88));
for(const r of losers){
  console.log(
    `  ${r.sym.padEnd(13)} ${r.best.strat.padEnd(6)}` +
    `${String(r.best.total).padStart(7)}` +
    `${(r.best.wr.toFixed(0)+'%').padStart(6)}` +
    `${r.best.pf.toFixed(2).padStart(6)}` +
    `${(r.best.maxDD.toFixed(1)+'%').padStart(7)}` +
    `${fmtP(r.best.ret).padStart(9)}` +
    `${'$'+r.best.balance.toFixed(0).padStart(7)}  ` +
    `DT:${fmtP(r.dt.ret).padStart(7)}  ORB:${fmtP(r.orb.ret).padStart(7)}  ❌`
  );
}

// ── Dream portfolio combined monthly ─────────────────────────────────────────
console.log('\n\n'+'='.repeat(95));
console.log(`  DREAM PORTFOLIO — ${profitable.length} profitable symbols, $${START_BAL.toFixed(0)}/symbol ($${(profitable.length*START_BAL).toFixed(0)} total capital)`);
console.log(`  Strategy mix: ${profitable.filter(r=>r.best.strat==='DT').length}× DT  |  ${profitable.filter(r=>r.best.strat==='ORB').length}× ORB`);
console.log('='.repeat(95));

// Merge all monthly P&L across profitable symbols
const combinedMonthly={};
for(const r of profitable){
  for(const[m,data] of Object.entries(r.best.monthly)){
    if(!combinedMonthly[m])combinedMonthly[m]={pnl:0,tr:0,wins:0};
    combinedMonthly[m].pnl+=data.pnl;
    combinedMonthly[m].tr+=data.tr;
    combinedMonthly[m].wins+=data.wins;
  }
}

const totalStart=profitable.length*START_BAL;
let runBal=totalStart;

console.log(`\n  ${'Month'.padEnd(10)} ${'Trades'.padStart(7)} ${'Wins'.padStart(6)} ${'WR'.padStart(6)} ${'P&L'.padStart(10)} ${'Month%'.padStart(8)} ${'Balance'.padStart(12)} ${'CumRet%'.padStart(10)}`);
console.log('  '+'-'.repeat(72));

for(const m of Object.keys(combinedMonthly).sort()){
  const d=combinedMonthly[m];
  runBal+=d.pnl;
  const[yr,mo]=m.split('-');
  const label=`${MNAMES[+mo]} ${yr}`;
  const wr_=(d.wins/(d.tr||1)*100).toFixed(0)+'%';
  const monPct=(d.pnl/(runBal-d.pnl)*100);
  const cumRet=(runBal-totalStart)/totalStart*100;
  console.log(
    `  ${label.padEnd(10)}` +
    `${String(d.tr).padStart(7)}` +
    `${String(d.wins).padStart(6)}` +
    `${wr_.padStart(6)}` +
    `${fmtD(d.pnl).padStart(10)}` +
    `${fmtP(monPct).padStart(8)}` +
    `${'$'+runBal.toFixed(0).padStart(10)}` +
    `${fmtP(cumRet).padStart(10)}`
  );
}

const totalFinal=profitable.reduce((s,r)=>s+r.best.balance,0);
const totalRet=(totalFinal-totalStart)/totalStart*100;

console.log('  '+'-'.repeat(72));
console.log(`\n  Starting capital:  $${totalStart.toLocaleString()}`);
console.log(`  Final balance:     $${totalFinal.toFixed(0)}`);
console.log(`  Total P&L:         ${fmtD(totalFinal-totalStart)}`);
console.log(`  Portfolio return:  ${fmtP(totalRet)}`);
console.log(`  Avg max drawdown:  ${(profitable.reduce((s,r)=>s+r.best.maxDD,0)/profitable.length).toFixed(1)}%`);
console.log(`  Avg win rate:      ${(profitable.reduce((s,r)=>s+r.best.wr,0)/profitable.length).toFixed(1)}%\n`);

// ── Per-symbol summary ────────────────────────────────────────────────────────
console.log('  Per-symbol breakdown:');
for(const r of profitable.sort((a,b)=>b.best.ret-a.best.ret)){
  console.log(`    ${r.sym.padEnd(13)} [${r.best.strat}]  $${START_BAL.toFixed(0)} → $${r.best.balance.toFixed(0).padStart(6)}  (${fmtP(r.best.ret)})`);
}
console.log('');
