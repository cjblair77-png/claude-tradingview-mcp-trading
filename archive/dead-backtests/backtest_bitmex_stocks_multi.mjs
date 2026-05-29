import https from 'https';

// ── Config ────────────────────────────────────────────────────────────────────
const DAYS      = 150;
const START_BAL = 5000;
const LEVERAGE  = 5;
const RISK_PCT  = 0.008;
const SL_PCT    = 0.0042;
const TP_PCT    = SL_PCT * 1.3;
const VOL_MULT  = 1.2;
const EMA_S     = 21;
const EMA_L     = 50;
const EMA_LB    = 4;
const MAX_HOLD  = 12;
const RTH_START = 13;
const RTH_END   = 20;

// Symbols with ~150d of data on BitMEX (listed Dec 2025)
const SYMBOLS = [
  'TSLAUSDT','NVDAUSDT','AAPLUSDT','METAUSDT','AMZNUSDT',
  'HOODUSDT','COINUSDT','SPYUSDT','QQQUSDT'
];

function get(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch { res([]); } });
    }).on('error', rej);
  });
}

async function fetch5m(symbol) {
  const cutoff = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  let raw = [], cursor = cutoff, page = 0;
  while (true) {
    const url = `https://www.bitmex.com/api/v1/trade/bucketed?binSize=5m&symbol=${symbol}&count=1000&reverse=false&partial=false&startTime=${cursor}`;
    const chunk = await get(url);
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    const slice = page === 0 ? chunk : chunk.slice(1);
    raw = raw.concat(slice);
    if (chunk.length < 1000) break;
    cursor = chunk[chunk.length - 1].timestamp;
    page++;
    await new Promise(r => setTimeout(r, 300));
  }
  return raw.filter(b => b.open && b.high && b.low && b.close)
            .map(b => ({ t: new Date(b.timestamp).getTime(), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume || 0 }));
}

function agg15m(bars5) {
  const out = [];
  for (let i = 0; i + 2 < bars5.length; i += 3) {
    const t = [bars5[i], bars5[i+1], bars5[i+2]];
    out.push({ t: t[0].t, o: t[0].o, h: Math.max(...t.map(b=>b.h)), l: Math.min(...t.map(b=>b.l)), c: t[2].c, v: t.reduce((s,b)=>s+b.v,0) });
  }
  return out;
}

function calcEma(arr, p) {
  const k = 2/(p+1); let e = arr[0];
  return arr.map(v => { e = v*k + e*(1-k); return e; });
}

function simulate(bars) {
  const closes = bars.map(b=>b.c), vols = bars.map(b=>b.v);
  const e21 = calcEma(closes, EMA_S), e50 = calcEma(closes, EMA_L);
  const volSma = (i, p=20) => { if(i<p) return null; let s=0; for(let j=i-p;j<i;j++) s+=vols[j]; return s/p; };

  let bal=START_BAL, peak=START_BAL, maxDD=0, inTrade=false, trade={};
  const trades=[], monthly={};
  const mk = t => { const d=new Date(t); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; };

  for (let i=Math.max(EMA_L+1,20); i<bars.length; i++) {
    const b=bars[i], prev=bars[i-1];
    const h=new Date(b.t).getUTCHours();
    const inRTH = h>=RTH_START && h<RTH_END;

    if (inTrade) {
      const held=i-trade.bar, isLong=trade.dir==='LONG';
      let closed=false, ep=0, why='';
      if      (isLong  && b.l<=trade.sl) { ep=trade.sl; why='SL'; closed=true; }
      else if (!isLong && b.h>=trade.sl) { ep=trade.sl; why='SL'; closed=true; }
      else if (isLong  && b.h>=trade.tp) { ep=trade.tp; why='TP'; closed=true; }
      else if (!isLong && b.l<=trade.tp) { ep=trade.tp; why='TP'; closed=true; }
      else if (held>=MAX_HOLD)            { ep=b.c;     why='TIME'; closed=true; }
      if (closed) {
        const rawPct = isLong ? (ep-trade.entry)/trade.entry : (trade.entry-ep)/trade.entry;
        const pnl = bal*RISK_PCT*LEVERAGE*(rawPct/SL_PCT);
        bal += pnl; peak=Math.max(peak,bal);
        maxDD=Math.max(maxDD,(peak-bal)/peak*100);
        const m=mk(b.t);
        if(!monthly[m]) monthly[m]={tr:0,wins:0,pnl:0,bal0:bal-pnl};
        monthly[m].tr++; monthly[m].pnl+=pnl;
        if(pnl>0) monthly[m].wins++;
        trades.push({dir:trade.dir,entry:trade.entry,exit:ep,why,pnl,time:new Date(b.t).toISOString().slice(0,13)});
        inTrade=false;
      }
    }

    if (!inTrade && inRTH) {
      const rising=e50[i]>e50[i-EMA_LB], falling=e50[i]<e50[i-EMA_LB];
      const vs=volSma(i); const volOk=vs&&b.v>VOL_MULT*vs;
      const longSig  = prev.c<e21[i-1] && b.c>e21[i] && rising  && volOk;
      const shortSig = prev.c>e21[i-1] && b.c<e21[i] && falling && volOk;
      if (longSig||shortSig) {
        const dir=longSig?'LONG':'SHORT';
        trade={dir,entry:b.c,sl:longSig?b.c*(1-SL_PCT):b.c*(1+SL_PCT),tp:longSig?b.c*(1+TP_PCT):b.c*(1-TP_PCT),bar:i};
        inTrade=true;
      }
    }
  }

  const wins=trades.filter(t=>t.pnl>0).length;
  const grossW=trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
  const grossL=Math.abs(trades.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0));
  return {
    trades, monthly,
    total: trades.length,
    wins, losses: trades.length-wins,
    wr: wins/(trades.length||1)*100,
    pf: grossW/(grossL||1),
    maxDD, balance: bal,
    ret: (bal-START_BAL)/START_BAL*100,
    tpCount: trades.filter(t=>t.why==='TP').length,
    slCount: trades.filter(t=>t.why==='SL').length,
    timeCount: trades.filter(t=>t.why==='TIME').length,
  };
}

// ── Run all symbols ───────────────────────────────────────────────────────────
const results = [];
const MNAMES = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

for (const sym of SYMBOLS) {
  process.stdout.write(`\n[${SYMBOLS.indexOf(sym)+1}/${SYMBOLS.length}] ${sym} — fetching...`);
  const bars5 = await fetch5m(sym);
  const bars  = agg15m(bars5);
  process.stdout.write(` ${bars.length} 15m bars — simulating...`);
  const r = simulate(bars);
  process.stdout.write(` done. ${r.total} trades, ${r.wr.toFixed(0)}% WR, ${r.ret >= 0 ? '+' : ''}${r.ret.toFixed(1)}%\n`);
  results.push({ sym, ...r, bars });
}

// ── Summary table ─────────────────────────────────────────────────────────────
const fmtD = n => (n>=0?'+$':'-$')+Math.abs(n).toFixed(0);
const fmtPct = n => (n>=0?'+':'')+n.toFixed(1)+'%';

console.log('\n\n' + '='.repeat(100));
console.log(`  BITMEX STOCK FUTURES — DT STRATEGY  |  ${DAYS} days  |  $${START_BAL.toLocaleString()} start  |  5x lev  |  RTH only`);
console.log('='.repeat(100));
console.log(`  ${'Symbol'.padEnd(14)} ${'Trades'.padStart(7)} ${'WR%'.padStart(6)} ${'PF'.padStart(6)} ${'MaxDD'.padStart(7)} ${'Return'.padStart(9)} ${'Final Bal'.padStart(11)} ${'TP/SL/TIME'.padStart(12)}`);
console.log('  ' + '-'.repeat(80));

// Sort by return
results.sort((a,b) => b.ret - a.ret);
for (const r of results) {
  const flag = r.ret > 20 ? '✅' : r.ret > 0 ? '→' : '❌';
  console.log(`  ${r.sym.padEnd(14)} ${String(r.total).padStart(7)} ${(r.wr.toFixed(1)+'%').padStart(6)} ${r.pf.toFixed(2).padStart(6)} ${(r.maxDD.toFixed(1)+'%').padStart(7)} ${fmtPct(r.ret).padStart(9)} ${'$'+r.balance.toFixed(0).padStart(9)} ${(r.tpCount+'/'+r.slCount+'/'+r.timeCount).padStart(12)}  ${flag}`);
}

// ── Monthly breakdown for winners ─────────────────────────────────────────────
const winners = results.filter(r => r.ret > 0);
for (const r of winners) {
  console.log('\n' + '-'.repeat(90));
  console.log(`  ${r.sym} — MONTHLY BREAKDOWN  (${fmtPct(r.ret)}, PF ${r.pf.toFixed(2)}, WR ${r.wr.toFixed(1)}%, MaxDD ${r.maxDD.toFixed(1)}%)`);
  console.log('-'.repeat(90));
  console.log(`  ${'Month'.padEnd(10)} ${'Tr'.padStart(4)} ${'W'.padStart(4)} ${'WR'.padStart(5)} ${'P&L'.padStart(10)} ${'Month%'.padStart(8)} ${'Balance'.padStart(11)} ${'CumRet%'.padStart(10)}`);
  console.log('  ' + '-'.repeat(65));
  let runBal = START_BAL;
  for (const key of Object.keys(r.monthly).sort()) {
    const m = r.monthly[key];
    runBal += m.pnl;
    const [yr, mo] = key.split('-');
    const label  = `${MNAMES[+mo]} ${yr}`;
    const wr_    = (m.wins/(m.tr||1)*100).toFixed(0)+'%';
    const monPct = (m.pnl/m.bal0*100);
    const cumRet = (runBal-START_BAL)/START_BAL*100;
    console.log(`  ${label.padEnd(10)} ${String(m.tr).padStart(4)} ${String(m.wins).padStart(4)} ${wr_.padStart(5)} ${fmtD(m.pnl).padStart(10)} ${fmtPct(monPct).padStart(8)} ${'$'+runBal.toFixed(0).padStart(10)} ${fmtPct(cumRet).padStart(10)}`);
  }
}

// ── Combined portfolio ────────────────────────────────────────────────────────
const profitable = results.filter(r => r.ret > 0);
console.log('\n' + '='.repeat(90));
console.log(`  COMBINED PORTFOLIO — All ${profitable.length} profitable symbols, $${START_BAL.toLocaleString()} each`);
console.log('='.repeat(90));
const totalStart = profitable.length * START_BAL;
const totalFinal = profitable.reduce((s,r) => s + r.balance, 0);
const totalRet   = (totalFinal - totalStart) / totalStart * 100;
const avgDD      = profitable.reduce((s,r) => s + r.maxDD, 0) / profitable.length;
const avgWR      = profitable.reduce((s,r) => s + r.wr, 0) / profitable.length;
console.log(`  Symbols: ${profitable.map(r=>r.sym).join(', ')}`);
console.log(`  Total capital:  $${totalStart.toLocaleString()}`);
console.log(`  Total final:    $${totalFinal.toFixed(0)}`);
console.log(`  Total P&L:      ${fmtD(totalFinal-totalStart)}`);
console.log(`  Portfolio return: ${fmtPct(totalRet)}`);
console.log(`  Avg WR:          ${avgWR.toFixed(1)}%`);
console.log(`  Avg max DD:      ${avgDD.toFixed(1)}%\n`);
