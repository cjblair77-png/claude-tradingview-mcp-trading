import https from 'https';

// ── Shared config ─────────────────────────────────────────────────────────────
const START_BAL  = 5000;
const LEVERAGE   = 5;
const RISK_PCT   = 0.008;

// DT (EMA21 15m) params
const DT_SL      = 0.0042;
const DT_TP      = DT_SL * 1.3;
const DT_MAXHOLD = 12;
const DT_VOLMULT = 1.2;
const RTH_S      = 13, RTH_E = 20;   // 9:30am–4pm ET

// ORB params
const ORB_TPMULT = 1.5;
const ORB_VOLMULT= 1.3;
const OR_START   = 13 * 60 + 30;    // 13:30 UTC
const OR_END     = 14 * 60;          // 14:00 UTC
const TRADE_END  = 18 * 60;
const EOD_CLOSE  = 19 * 60 + 55;

// 4H breakout (v09-style, stock-calibrated)
const H4_SL      = 0.03;            // 3% SL  (vs v09's 6.5% — stocks less volatile)
const H4_TP      = 0.08;            // 8% TP  (vs v09's 23%)
const H4_VOLMULT = 1.5;
const H4_LOOKBACK= 50;              // 50×4H = 200 hours lookback for breakout high/low
const H4_MAXHOLD = 20;              // 20×4H bars = 80h max hold

// All symbols with data
const SYMBOLS_162 = ['SPYUSDT','QQQUSDT','TSLAUSDT','NVDAUSDT','AAPLUSDT','METAUSDT','AMZNUSDT','COINUSDT','HOODUSDT'];
const SYMBOLS_76  = ['JPMUSDT','PLTRUSDT','NFLXUSDT','GOOGLUSDT','ORCLUSDT','AVGOUSDT','XOMUSDT','INTCUSDT','MSFTUSDT','MSTRUSDT','XAGUSDT'];

function get(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch { res([]); } });
    }).on('error', rej);
  });
}

async function fetchBars(symbol, binSize, days) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  let raw = [], cursor = cutoff, page = 0;
  while (true) {
    const url = `https://www.bitmex.com/api/v1/trade/bucketed?binSize=${binSize}&symbol=${symbol}&count=1000&reverse=false&partial=false&startTime=${cursor}`;
    const chunk = await get(url);
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    raw = raw.concat(page === 0 ? chunk : chunk.slice(1));
    if (chunk.length < 1000) break;
    cursor = chunk[chunk.length - 1].timestamp;
    page++;
    await new Promise(r => setTimeout(r, 280));
  }
  return raw.filter(b => b.open && b.high && b.low && b.close)
            .map(b => ({ t: new Date(b.timestamp).getTime(), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume || 0 }));
}

function aggBars(bars, factor) {
  const out = [];
  for (let i = 0; i + factor - 1 < bars.length; i += factor) {
    const grp = bars.slice(i, i + factor);
    out.push({ t: grp[0].t, o: grp[0].o, h: Math.max(...grp.map(b => b.h)), l: Math.min(...grp.map(b => b.l)), c: grp[grp.length-1].c, v: grp.reduce((s, b) => s + b.v, 0) });
  }
  return out;
}

function calcEma(arr, p) {
  const k = 2/(p+1); let e = arr[0];
  return arr.map(v => { e = v*k+e*(1-k); return e; });
}
function volSmaFn(vols) {
  return (i, p=20) => { if(i<p) return null; let s=0; for(let j=i-p;j<i;j++) s+=vols[j]; return s/p; };
}
function minUTC(t) { const d=new Date(t); return d.getUTCHours()*60+d.getUTCMinutes(); }
function monthKey(t) { const d=new Date(t); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }

// ── Strategy 1: DT EMA21 (15m) ───────────────────────────────────────────────
function runDT(bars15) {
  const closes=bars15.map(b=>b.c), vols=bars15.map(b=>b.v);
  const e21=calcEma(closes,21), e50=calcEma(closes,50);
  const vSma=volSmaFn(vols);
  let bal=START_BAL,peak=START_BAL,maxDD=0,inTrade=false,trade={};
  const trades=[],monthly={};
  for (let i=Math.max(51,20);i<bars15.length;i++) {
    const b=bars15[i],prev=bars15[i-1];
    const h=new Date(b.t).getUTCHours();
    const inRTH=h>=RTH_S&&h<RTH_E;
    if (inTrade) {
      const held=i-trade.bar,isLong=trade.dir==='LONG';
      let closed=false,ep=0,why='';
      if      (isLong&&b.l<=trade.sl){ep=trade.sl;why='SL';closed=true;}
      else if (!isLong&&b.h>=trade.sl){ep=trade.sl;why='SL';closed=true;}
      else if (isLong&&b.h>=trade.tp){ep=trade.tp;why='TP';closed=true;}
      else if (!isLong&&b.l<=trade.tp){ep=trade.tp;why='TP';closed=true;}
      else if (held>=DT_MAXHOLD){ep=b.c;why='TIME';closed=true;}
      if (closed) {
        const raw=isLong?(ep-trade.entry)/trade.entry:(trade.entry-ep)/trade.entry;
        const pnl=bal*RISK_PCT*LEVERAGE*(raw/DT_SL);
        bal+=pnl;peak=Math.max(peak,bal);maxDD=Math.max(maxDD,(peak-bal)/peak*100);
        const m=monthKey(b.t);if(!monthly[m])monthly[m]={tr:0,wins:0,pnl:0,b0:bal-pnl};
        monthly[m].tr++;monthly[m].pnl+=pnl;if(pnl>0)monthly[m].wins++;
        trades.push({pnl,why});inTrade=false;
      }
    }
    if (!inTrade&&inRTH) {
      const rising=e50[i]>e50[i-4],falling=e50[i]<e50[i-4];
      const vs=vSma(i);const volOk=vs&&b.v>DT_VOLMULT*vs;
      const lng=prev.c<e21[i-1]&&b.c>e21[i]&&rising&&volOk;
      const sht=prev.c>e21[i-1]&&b.c<e21[i]&&falling&&volOk;
      if(lng||sht){trade={dir:lng?'LONG':'SHORT',entry:b.c,sl:lng?b.c*(1-DT_SL):b.c*(1+DT_SL),tp:lng?b.c*(1+DT_TP):b.c*(1-DT_TP),bar:i};inTrade=true;}
    }
  }
  return summarise(trades,bal,peak,maxDD,monthly);
}

// ── Strategy 2: ORB (5m) ─────────────────────────────────────────────────────
function runORB(bars5) {
  const days={};
  for (const b of bars5) {
    const d=new Date(b.t),key=`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    if(!days[key])days[key]=[];days[key].push(b);
  }
  let bal=START_BAL,peak=START_BAL,maxDD=0;
  const trades=[],monthly={};
  let totalVol=0,totalBars=0;
  for (const key of Object.keys(days).sort()) {
    const db=days[key];
    for(const b of db){totalVol+=b.v;totalBars++;}
    const avgVol=totalBars>0?totalVol/totalBars:1;
    const orBars=db.filter(b=>{const m=minUTC(b.t);return m>=OR_START&&m<OR_END;});
    if(orBars.length<3)continue;
    const orH=Math.max(...orBars.map(b=>b.h)),orL=Math.min(...orBars.map(b=>b.l));
    const orR=orH-orL;if(orR<=0)continue;
    const tBars=db.filter(b=>{const m=minUTC(b.t);return m>=OR_END&&m<TRADE_END;});
    let inTrade=false,trade={};
    for (const b of tBars) {
      const m=minUTC(b.t),volOk=b.v>ORB_VOLMULT*avgVol;
      if(inTrade){
        const isLong=trade.dir==='LONG';
        let closed=false,ep=0,why='';
        if(isLong&&b.l<=trade.sl){ep=trade.sl;why='SL';closed=true;}
        else if(!isLong&&b.h>=trade.sl){ep=trade.sl;why='SL';closed=true;}
        else if(isLong&&b.h>=trade.tp){ep=trade.tp;why='TP';closed=true;}
        else if(!isLong&&b.l<=trade.tp){ep=trade.tp;why='TP';closed=true;}
        else if(m>=EOD_CLOSE){ep=b.c;why='EOD';closed=true;}
        if(closed){
          const raw=isLong?(ep-trade.entry)/trade.entry:(trade.entry-ep)/trade.entry;
          const slPct=orR/trade.entry;
          const pnl=bal*RISK_PCT*LEVERAGE*(raw/slPct);
          bal+=pnl;peak=Math.max(peak,bal);maxDD=Math.max(maxDD,(peak-bal)/peak*100);
          const mk=monthKey(b.t);if(!monthly[mk])monthly[mk]={tr:0,wins:0,pnl:0,b0:bal-pnl};
          monthly[mk].tr++;monthly[mk].pnl+=pnl;if(pnl>0)monthly[mk].wins++;
          trades.push({pnl,why});inTrade=false;
        }
      }
      if(!inTrade&&volOk){
        if(b.c>orH&&b.o<=orH){trade={dir:'LONG',entry:b.c,sl:orL,tp:b.c+orR*ORB_TPMULT};inTrade=true;}
        else if(b.c<orL&&b.o>=orL){trade={dir:'SHORT',entry:b.c,sl:orH,tp:b.c-orR*ORB_TPMULT};inTrade=true;}
      }
    }
    if(inTrade){
      const b=db[db.length-1],isLong=trade.dir==='LONG';
      const raw=isLong?(b.c-trade.entry)/trade.entry:(trade.entry-b.c)/trade.entry;
      const slPct=orR/trade.entry;
      const pnl=bal*RISK_PCT*LEVERAGE*(raw/slPct);
      bal+=pnl;peak=Math.max(peak,bal);maxDD=Math.max(maxDD,(peak-bal)/peak*100);
      const mk=monthKey(b.t);if(!monthly[mk])monthly[mk]={tr:0,wins:0,pnl:0,b0:bal-pnl};
      monthly[mk].tr++;monthly[mk].pnl+=pnl;if(pnl>0)monthly[mk].wins++;
      trades.push({pnl,why:'EOD'});
    }
  }
  return summarise(trades,bal,peak,maxDD,monthly);
}

// ── Strategy 3: 4H Breakout (v09-style) ──────────────────────────────────────
function run4H(bars4h) {
  const closes=bars4h.map(b=>b.c),vols=bars4h.map(b=>b.v);
  const ema200=calcEma(closes,200);
  const vSma=volSmaFn(vols);
  let bal=START_BAL,peak=START_BAL,maxDD=0,inTrade=false,trade={};
  const trades=[],monthly={};
  const LB=H4_LOOKBACK;
  for (let i=Math.max(200,LB+1);i<bars4h.length;i++) {
    const b=bars4h[i],prev=bars4h[i-1];
    if(inTrade){
      const held=i-trade.bar,isLong=trade.dir==='LONG';
      let closed=false,ep=0,why='';
      if(isLong&&b.l<=trade.sl){ep=trade.sl;why='SL';closed=true;}
      else if(!isLong&&b.h>=trade.sl){ep=trade.sl;why='SL';closed=true;}
      else if(isLong&&b.h>=trade.tp){ep=trade.tp;why='TP';closed=true;}
      else if(!isLong&&b.l<=trade.tp){ep=trade.tp;why='TP';closed=true;}
      else if(held>=H4_MAXHOLD){ep=b.c;why='TIME';closed=true;}
      if(closed){
        const raw=isLong?(ep-trade.entry)/trade.entry:(trade.entry-ep)/trade.entry;
        const pnl=bal*RISK_PCT*LEVERAGE*(raw/H4_SL);
        bal+=pnl;peak=Math.max(peak,bal);maxDD=Math.max(maxDD,(peak-bal)/peak*100);
        const m=monthKey(b.t);if(!monthly[m])monthly[m]={tr:0,wins:0,pnl:0,b0:bal-pnl};
        monthly[m].tr++;monthly[m].pnl+=pnl;if(pnl>0)monthly[m].wins++;
        trades.push({pnl,why});inTrade=false;
      }
    }
    if(!inTrade){
      // Rolling high/low over LB bars
      let hi=0,lo=Infinity;
      for(let j=i-LB;j<i;j++){hi=Math.max(hi,bars4h[j].c);lo=Math.min(lo,bars4h[j].c);}
      const vs=vSma(i);const volOk=vs&&b.v>H4_VOLMULT*vs;
      // Breakout
      const BREAKOUT = prev.c<=hi && b.c>hi && volOk;
      const BREAKDOWN= prev.c>=lo && b.c<lo && volOk;
      // Rebound
      const REBOUND_L= prev.c<ema200[i-1] && b.c>ema200[i] && volOk;
      const REBOUND_S= prev.c>ema200[i-1] && b.c<ema200[i] && volOk;
      if(BREAKOUT||REBOUND_L){trade={dir:'LONG',entry:b.c,sl:b.c*(1-H4_SL),tp:b.c*(1+H4_TP),bar:i,sig:BREAKOUT?'BO':'RBL'};inTrade=true;}
      else if(BREAKDOWN||REBOUND_S){trade={dir:'SHORT',entry:b.c,sl:b.c*(1+H4_SL),tp:b.c*(1-H4_TP),bar:i,sig:BREAKDOWN?'BD':'RBS'};inTrade=true;}
    }
  }
  return summarise(trades,bal,peak,maxDD,monthly);
}

function summarise(trades,bal,peak,maxDD,monthly) {
  const wins=trades.filter(t=>t.pnl>0).length;
  const gW=trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
  const gL=Math.abs(trades.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0));
  return {total:trades.length,wins,wr:wins/(trades.length||1)*100,pf:gW/(gL||1),maxDD,balance:bal,ret:(bal-START_BAL)/START_BAL*100,monthly};
}

// ── Run all ───────────────────────────────────────────────────────────────────
const allResults = [];

async function runSymbol(sym, days) {
  process.stdout.write(`\n  ${sym.padEnd(12)} fetching 5m...`);
  const bars5   = await fetchBars(sym, '5m', days);
  const bars15  = aggBars(bars5, 3);
  process.stdout.write(` ${bars15.length} 15m bars | running DT...`);
  const dt = runDT(bars15);

  process.stdout.write(` ORB...`);
  const orb = runORB(bars5);

  process.stdout.write(` 4H...`);
  const bars1h  = await fetchBars(sym, '1h', days);
  const bars4h  = aggBars(bars1h, 4);
  process.stdout.write(` ${bars4h.length} 4H bars...`);
  const h4 = run4H(bars4h);

  process.stdout.write(` done | DT:${dt.ret>=0?'+':''}${dt.ret.toFixed(0)}%  ORB:${orb.ret>=0?'+':''}${orb.ret.toFixed(0)}%  4H:${h4.ret>=0?'+':''}${h4.ret.toFixed(0)}%\n`);
  allResults.push({ sym, days, dt, orb, h4 });
}

console.log('\n' + '='.repeat(90));
console.log('  BITMEX STOCKS — 3-STRATEGY MASTER BACKTEST');
console.log('  DT (EMA21 15m RTH)  |  ORB (30min range 5m)  |  4H Breakout (v09-style, SL3% TP8%)');
console.log('='.repeat(90));

console.log('\n── 162-DAY SYMBOLS ─────────────────────────────────────────────────────────────');
for (const sym of SYMBOLS_162) await runSymbol(sym, 162);

console.log('\n── 76-DAY SYMBOLS ──────────────────────────────────────────────────────────────');
for (const sym of SYMBOLS_76)  await runSymbol(sym, 76);

// ── Master results table ──────────────────────────────────────────────────────
const fmtR = (r) => {
  const s = (r >= 0 ? '+' : '') + r.toFixed(1) + '%';
  const flag = r > 30 ? '🔥' : r > 10 ? '✅' : r > 0 ? '→' : '❌';
  return (s + flag).padStart(12);
};

console.log('\n\n' + '='.repeat(110));
console.log('  MASTER RESULTS TABLE  |  $5,000 start per strategy  |  5x leverage  |  0.8% risk/trade');
console.log('='.repeat(110));
console.log(`  ${'Symbol'.padEnd(13)} ${'Days'.padStart(5)}  ${'── DT (EMA21 15m) ──'.padEnd(28)}  ${'── ORB (30min) ──'.padEnd(28)}  ${'── 4H Breakout ──'.padEnd(28)}`);
console.log(`  ${''.padEnd(13)} ${''.padStart(5)}  ${'Ret%   WR    PF   DD'.padEnd(28)}  ${'Ret%   WR    PF   DD'.padEnd(28)}  ${'Ret%   WR    PF   DD'.padEnd(28)}`);
console.log('  ' + '-'.repeat(105));

for (const r of allResults) {
  const fmt = s => `${(s.ret>=0?'+':'')+s.ret.toFixed(1)+'%'}  ${s.wr.toFixed(0)+'%'}  ${s.pf.toFixed(2)}  ${s.maxDD.toFixed(1)+'%'}`;
  const best = [r.dt.ret, r.orb.ret, r.h4.ret].indexOf(Math.max(r.dt.ret, r.orb.ret, r.h4.ret));
  const stars = ['←','←','←'];
  stars[best] = '★';
  console.log(`  ${r.sym.padEnd(13)} ${String(r.days).padStart(5)}  ${fmt(r.dt).padEnd(26)} ${stars[0]}  ${fmt(r.orb).padEnd(26)} ${stars[1]}  ${fmt(r.h4).padEnd(26)} ${stars[2]}`);
}

// ── Best strategy per symbol ──────────────────────────────────────────────────
console.log('\n' + '-'.repeat(110));
console.log('  BEST STRATEGY PER SYMBOL  (highest return wins)');
console.log('-'.repeat(110));
const stratNames = ['DT (EMA21)', 'ORB', '4H Breakout'];
for (const r of allResults) {
  const rets = [r.dt.ret, r.orb.ret, r.h4.ret];
  const bestIdx = rets.indexOf(Math.max(...rets));
  const best = [r.dt, r.orb, r.h4][bestIdx];
  if (best.ret > 0) {
    console.log(`  ${r.sym.padEnd(13)} → ${stratNames[bestIdx].padEnd(14)} | ${(best.ret>=0?'+':'')+best.ret.toFixed(1)+'%'} return | WR ${best.wr.toFixed(0)}% | PF ${best.pf.toFixed(2)} | MaxDD ${best.maxDD.toFixed(1)}%`);
  } else {
    console.log(`  ${r.sym.padEnd(13)} → None profitable`);
  }
}

// ── Dream portfolio: best strategy per instrument ─────────────────────────────
console.log('\n' + '='.repeat(90));
console.log('  DREAM PORTFOLIO — Best strategy per symbol, $5,000 each');
console.log('='.repeat(90));
let dreamTotal=0, dreamStart=0;
const dreamPicks = allResults.map(r => {
  const rets=[r.dt.ret,r.orb.ret,r.h4.ret];
  const bestIdx=rets.indexOf(Math.max(...rets));
  const best=[r.dt,r.orb,r.h4][bestIdx];
  return {sym:r.sym, strat:stratNames[bestIdx], ret:best.ret, bal:best.balance, wr:best.wr, pf:best.pf};
}).filter(p=>p.ret>0);

dreamPicks.sort((a,b)=>b.ret-a.ret);
for (const p of dreamPicks) {
  dreamTotal += p.bal; dreamStart += START_BAL;
  console.log(`  ${p.sym.padEnd(13)} ${p.strat.padEnd(16)} | ${(p.ret>=0?'+':'')+p.ret.toFixed(1)+'%'} | WR ${p.wr.toFixed(0)}% | PF ${p.pf.toFixed(2)} | $${p.bal.toFixed(0)}`);
}
console.log(`\n  Symbols: ${dreamPicks.length} | Capital: $${dreamStart.toLocaleString()} | Final: $${dreamTotal.toFixed(0)} | Return: ${((dreamTotal-dreamStart)/dreamStart*100).toFixed(1)}%\n`);
