/**
 * backtest_realfees.js — Both sizing models with REAL MEXC futures fees
 *
 * MEXC futures fees (confirmed Nov 2026):
 *   Maker: 0.00%  (limit orders that add liquidity)
 *   Taker: 0.02%  (market orders that remove liquidity)
 *
 * Our bots use market orders (taker) → 0.02% × 2 (open+close) = 0.04% round-trip
 *
 * Compares:
 *   Model A — CURRENT bot sizing: sizeUSD = (riskUSD / slDist) × entry × leverage
 *                                 v09 pnl = raw × leverage
 *             Real risk per loss = riskPct × leverage (4% for DT, 5% for ORB, 1.2% for v09)
 *
 *   Model B — OPTION 1 sizing:    sizeUSD = (riskUSD / slDist) × entry  (no × leverage)
 *                                 v09 pnl = raw                          (no × leverage)
 *             Real risk per loss = riskPct (true 0.8% for all)
 *
 * Run: node backtest_realfees.js
 */

import "dotenv/config";

const MEXC_BASE = "https://futures.mexc.com";
const DAYS      = 150;
const NOW_SEC   = Math.floor(Date.now() / 1000);
const START_150 = NOW_SEC - DAYS * 86400;
const FEE_PCT   = 0.0004; // 0.02% × 2 (REAL MEXC taker round-trip)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchChunk(symbol, intervalStr, startSec, endSec) {
  const url = `${MEXC_BASE}/api/v1/contract/kline/${symbol}?interval=${intervalStr}&start=${startSec}&end=${endSec}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return [];
    const json = await res.json();
    if (!json.data?.time?.length) return [];
    const { time, open, close, high, low, vol } = json.data;
    return time.map((t, i) => ({ t: t*1000, o: +open[i], c: +close[i], h: +high[i], l: +low[i], v: +vol[i] })).sort((a,b) => a.t - b.t);
  } catch { return []; }
}

async function fetchAllBars(symbol, intervalStr, barSecs, startSec, endSec) {
  const bars = []; const chunk = 1800 * barSecs;
  let cur = startSec, emptyRuns = 0;
  while (cur < endSec) {
    const end = Math.min(cur + chunk, endSec);
    const batch = await fetchChunk(symbol, intervalStr, cur, end);
    if (!batch.length) { emptyRuns++; if (emptyRuns >= 5) break; cur = end + barSecs; await sleep(120); continue; }
    emptyRuns = 0; bars.push(...batch);
    cur = Math.floor(batch[batch.length-1].t/1000) + barSecs;
    await sleep(180);
  }
  const seen = new Set();
  return bars.filter(b => { if (seen.has(b.t)) return false; seen.add(b.t); return true; }).sort((a,b) => a.t - b.t);
}

function emaSeries(vals,p){const k=2/(p+1),out=[vals[0]];for(let i=1;i<vals.length;i++)out.push(vals[i]*k+out[i-1]*(1-k));return out;}
function smaSeries(vals,p){return vals.map((_,i)=>i<p-1?null:vals.slice(i-p+1,i+1).reduce((a,b)=>a+b,0)/p);}
function rsiSmoothed(closes,period=14){const out=new Array(closes.length).fill(null);let g=0,l=0;for(let i=1;i<=period;i++){const d=closes[i]-closes[i-1];d>0?g+=d:l-=d;}out[period]=l===0?100:100-100/(1+g/l);for(let i=period+1;i<closes.length;i++){const d=closes[i]-closes[i-1];if(d>0){g=(g*(period-1)+d)/period;l=l*(period-1)/period;}else{g=g*(period-1)/period;l=(l*(period-1)-d)/period;}out[i]=l===0?100:100-100/(1+g/l);}return out;}
function macdSeries(closes,f=12,s=26,sig=9){const fast=emaSeries(closes,f),slow=emaSeries(closes,s);const line=closes.map((_,i)=>fast[i]-slow[i]);const signal=[line[0]];const k=2/(sig+1);for(let i=1;i<closes.length;i++)signal.push(line[i]*k+signal[i-1]*(1-k));return{line,signal,hist:line.map((v,i)=>v-signal[i])};}
function adxSeries(bars,period=14){const n=bars.length,out=new Array(n).fill(null),tr=[],pdm=[],ndm=[];for(let i=1;i<n;i++){const h=bars[i].h,l=bars[i].l,pc=bars[i-1].c,ph=bars[i-1].h,pl=bars[i-1].l;tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));const up=h-ph,dn=pl-l;pdm.push(up>dn&&up>0?up:0);ndm.push(dn>up&&dn>0?dn:0);}if(tr.length<period*2)return out;let smTR=tr.slice(0,period).reduce((a,b)=>a+b,0),smP=pdm.slice(0,period).reduce((a,b)=>a+b,0),smN=ndm.slice(0,period).reduce((a,b)=>a+b,0);const dx=[],cDX=()=>{const p=smTR?100*smP/smTR:0,nn=smTR?100*smN/smTR:0;return(p+nn)?100*Math.abs(p-nn)/(p+nn):0;};dx.push(cDX());for(let i=period;i<tr.length;i++){smTR=smTR-smTR/period+tr[i];smP=smP-smP/period+pdm[i];smN=smN-smN/period+ndm[i];dx.push(cDX());}if(dx.length<period)return out;let adxVal=dx.slice(0,period).reduce((a,b)=>a+b,0)/period;out[2*period-1]=adxVal;for(let j=period;j<dx.length;j++){adxVal=(adxVal*(period-1)+dx[j])/period;out[j+period]=adxVal;}return out;}

const V09_PAIRS = ["KAIA_USDT","S_USDT","FILECOIN_USDT","AR_USDT","PLUME_USDT","FIDA_USDT","GMT_USDT","ENA_USDT","TIA_USDT","TURBO_USDT","WIF_USDT","SHIB_USDT","BCH_USDT","VET_USDT","ONDO_USDT","THETA_USDT","HBAR_USDT","RUNE_USDT","IOTA_USDT","JUP_USDT","FLUX_USDT","W_USDT","CATI_USDT","ZKSYNC_USDT","KAITO_USDT","WLD_USDT","AIXBT_USDT","LA_USDT","JASMY_USDT","HOME_USDT"];
const V09 = { startBalance:10000, riskPct:0.008, minRisk:2, leverage:1.5, slPct:0.065, tpPct:0.23, trailPct:0.19, rebSlPct:0.035, rebTpPct:0.22, rsiOverbought:80, brsiMin:54, brsiMax:65, lookback:30, maxPositions:10, warmupDays:92 };
const DT_PAIRS = ["BTC_USDT","BNB_USDT","XRP_USDT","SUI_USDT","LTC_USDT","AVAX_USDT"];
const DT_EMA50_PAIRS = new Set(["BTC_USDT","SUI_USDT"]);
const DT = { startBalance:8750, riskPct:0.008, leverage:5, rrRatio:1.3, maxHold:12, maxSLPct:0.012, maxPositions:6 };
const ORB_SYMBOLS = ["CSCOSTOCK_USDT","NFLXSTOCK_USDT","AVGOSTOCK_USDT","JPMSTOCK_USDT","MRVLSTOCK_USDT","MSFTSTOCK_USDT","ASMLSTOCK_USDT","PLTRSTOCK_USDT","ARMSTOCK_USDT","WMTSTOCK_USDT"];
const ORB = { totalBalance:6250, riskPct:0.01, leverage:5, rrRatio:1.5, orbBars:6, eodH:19, eodM:55, volSessionsMA:20 };
const PER_SYM = ORB.totalBalance / ORB_SYMBOLS.length;

function v09Regime(i,closes,e21,e50,e200){if(!e200[i]||!e50[i]||!e21[i])return"neutral";const c=closes[i];let score=0;if(c>e200[i])score++;else score--;if(c>e50[i])score++;else score--;if(c>e21[i])score++;else score--;if(e21[i]>e50[i])score++;else score--;if(e50[i]>e200[i])score++;else score--;return score>=4?"bull":score<=-4?"bear":"neutral";}
function v09Risk(reg,dir,balance){const base=Math.max(balance*V09.riskPct,V09.minRisk);if(reg==="neutral")return base*0.75;const wt=(reg==="bull"&&dir==="LONG")||(reg==="bear"&&dir==="SHORT");return wt?base:base*0.5;}
function v09Signal(i,closes,vols,e21,e50,e200,rsi,mc,vsma){if(i<22||!rsi[i]||!rsi[i-1]||!vsma[i]||!e200[i])return null;const c=closes[i],rNow=rsi[i],rPrv=rsi[i-1],vol=vols[i],reg=v09Regime(i,closes,e21,e50,e200);const highN=Math.max(...closes.slice(Math.max(0,i-V09.lookback),i));const trendUp=e21[i]>e50[i]&&e21[i]>e21[i-1]&&e21[i-1]>e21[i-3];const lBreak=c>highN&&trendUp&&rNow>=V09.brsiMin&&rNow<=V09.brsiMax&&vol>vsma[i]*1.5;const wasOB=[1,2,3,4,5].some(k=>rsi[i-k]!=null&&rsi[i-k]>=65);const rsiBrk=rPrv>=58&&rNow<58,macdBrk=mc.hist[i-1]>=0&&mc.hist[i]<0;const sBreak=wasOB&&(rsiBrk||macdBrk)&&c<e21[i]&&rNow>35&&vol>vsma[i]*1.2;const wasOVB=[1,2,3].some(k=>rsi[i-k]!=null&&rsi[i-k]>=V09.rsiOverbought);const rsiTurnD=rPrv>=70&&rNow<70;const sRebound=wasOVB&&rsiTurnD&&reg!=="bull"&&c<e21[i]*1.08&&vol>vsma[i]*1.0&&!sBreak;return{lBreak,sBreak,sRebound,reg};}
function dtSessionBias(bars){const bias=new Array(bars.length).fill(null);let orbH=-Infinity,orbL=Infinity,building=false,confirmed=null,curBias=null;for(let j=0;j<bars.length;j++){const h=new Date(bars[j].t).getUTCHours(),m=new Date(bars[j].t).getUTCMinutes();if([1,8,13].includes(h)&&m===0){building=true;orbH=bars[j].h;orbL=bars[j].l;confirmed=null;curBias=null;}else if(building){orbH=Math.max(orbH,bars[j].h);orbL=Math.min(orbL,bars[j].l);confirmed={h:orbH,l:orbL};building=false;}if(confirmed&&curBias===null){if(bars[j].c>confirmed.h)curBias="LONG";else if(bars[j].c<confirmed.l)curBias="SHORT";}bias[j]=confirmed?curBias:null;}return bias;}
function isRTHBar(ms){const h=new Date(ms).getUTCHours(),m=new Date(ms).getUTCMinutes(),mins=h*60+m;return mins>=13*60+30&&mins<20*60;}
function isOpenBar(ms){const d=new Date(ms);return d.getUTCHours()===13&&d.getUTCMinutes()===30;}
function isEODBar(ms){const d=new Date(ms),h=d.getUTCHours(),m=d.getUTCMinutes();return h>19||(h===19&&m>=55);}
function isWeekdayMs(ms){const d=new Date(ms).getUTCDay();return d>=1&&d<=5;}
function dayKeyUTC(ms){return new Date(ms).toISOString().slice(0,10);}

// ─── Simulators (option flag selects sizing model) ─────────────────────────

function simulateV09(indicators, useOption1) {
  let balance = V09.startBalance, peak = balance, maxDD = 0;
  const positions = []; const trades = []; let totalFees = 0;
  const allTs = new Set();
  for (const sym of V09_PAIRS) { const ind = indicators[sym]; if (!ind) continue; for (const b of ind.bars) if (b.t/1000 >= START_150) allTs.add(b.t); }
  const sortedTs = [...allTs].sort((a,b)=>a-b);
  function calcBullPct(barIdx) {
    let bulls=0, total=0;
    for (const sym of V09_PAIRS) { const ind = indicators[sym]; if (!ind) continue; if (barIdx >= ind.closes.length) continue; const r = v09Regime(barIdx, ind.closes, ind.e21, ind.e50, ind.e200); if (r === "bull") bulls++; total++; }
    return total ? (bulls/total)*100 : 0;
  }
  for (const ts of sortedTs) {
    for (let p = positions.length-1; p >= 0; p--) {
      const pos = positions[p]; const ind = indicators[pos.sym]; if (!ind) continue;
      const bi = ind.bars.findIndex(b => b.t === ts); if (bi < 0) continue;
      const bar = ind.bars[bi]; const isL = pos.dir === "LONG";
      let exitReason = null, exitPrice = null;
      if (pos.trailing) {
        if (isL && bar.h > pos.trailHigh) { pos.trailHigh=bar.h; pos.sl=bar.h*(1-V09.trailPct); }
        else if (!isL && bar.l < pos.trailLow) { pos.trailLow=bar.l; pos.sl=bar.l*(1+V09.trailPct); }
        const hitTrail = isL ? bar.l<=pos.sl : bar.h>=pos.sl;
        if (hitTrail) { exitReason="TRAIL_SL"; exitPrice=pos.sl; }
      } else {
        const hitSL = isL ? bar.l<=pos.sl : bar.h>=pos.sl;
        const hitTP = isL ? bar.h>=pos.tp : bar.l<=pos.tp;
        if (hitSL&&hitTP) { exitReason="SL"; exitPrice=pos.sl; }
        else if (hitSL)   { exitReason="SL"; exitPrice=pos.sl; }
        else if (hitTP && pos.noTrail) { exitReason="TP"; exitPrice=pos.tp; }
        else if (hitTP) { pos.trailing=true; pos.trailHigh=isL?pos.tp:Infinity; pos.trailLow=isL?0:pos.tp; pos.sl = isL ? pos.tp*(1-V09.trailPct) : pos.tp*(1+V09.trailPct); }
      }
      if (exitReason) {
        const raw = isL ? (exitPrice-pos.entryPrice)/pos.entryPrice*pos.size : (pos.entryPrice-exitPrice)/pos.entryPrice*pos.size;
        const grossPnl = useOption1 ? raw : raw * V09.leverage;
        const notional = useOption1 ? pos.size : pos.size * V09.leverage;
        const fee = notional * FEE_PCT;
        const netPnl = grossPnl - fee;
        balance += netPnl; totalFees += fee;
        if (balance > peak) peak = balance;
        const dd = (peak-balance)/peak*100; if (dd>maxDD) maxDD = dd;
        trades.push({ gross:grossPnl, fee, net:netPnl });
        positions.splice(p, 1);
      }
    }
    if (positions.length < V09.maxPositions) {
      const bullPct = calcBullPct((()=>{const ind=indicators[V09_PAIRS[0]]; return ind?ind.bars.findIndex(b=>b.t===ts):0;})());
      const trailActive = bullPct >= 60;
      for (const sym of V09_PAIRS) {
        if (positions.some(p=>p.sym===sym)) continue;
        const ind = indicators[sym]; if (!ind) continue;
        const bi = ind.bars.findIndex(b=>b.t===ts); if (bi < 1) continue;
        const i = bi - 1;
        const sig = v09Signal(i, ind.closes, ind.vols, ind.e21, ind.e50, ind.e200, ind.rsi, ind.macd, ind.vsma);
        if (!sig) continue;
        const hasSig = sig.lBreak||sig.sBreak||sig.sRebound;
        if (!hasSig) continue;
        let dir, isRebound;
        if (sig.lBreak)        { dir="LONG";  isRebound=false; }
        else if (sig.sBreak)   { dir="SHORT"; isRebound=false; }
        else                   { dir="SHORT"; isRebound=true;  }
        const riskUSD = v09Risk(sig.reg, dir, balance);
        const slPct   = isRebound ? V09.rebSlPct : V09.slPct;
        const tpPct   = isRebound ? V09.rebTpPct : V09.tpPct;
        const noTrail = !trailActive || isRebound;
        const entryP  = ind.bars[bi].o;
        const size    = riskUSD / slPct;
        const isL     = dir==="LONG";
        const sl      = isL ? entryP*(1-slPct) : entryP*(1+slPct);
        const tp      = isL ? entryP*(1+tpPct) : entryP*(1-tpPct);
        positions.push({ sym, dir, entryPrice:entryP, sl, tp, size, riskUSD, trailing:false, noTrail, trailHigh:isL?tp:Infinity, trailLow:isL?0:tp });
        if (positions.length >= V09.maxPositions) break;
      }
    }
  }
  for (const pos of positions) {
    const ind = indicators[pos.sym]; if (!ind) continue;
    const lastBar = ind.bars[ind.bars.length-1];
    const exitP = lastBar.c; const isL = pos.dir==="LONG";
    const raw = isL ? (exitP-pos.entryPrice)/pos.entryPrice*pos.size : (pos.entryPrice-exitP)/pos.entryPrice*pos.size;
    const grossPnl = useOption1 ? raw : raw * V09.leverage;
    const notional = useOption1 ? pos.size : pos.size * V09.leverage;
    const fee = notional * FEE_PCT;
    const netPnl = grossPnl - fee;
    balance += netPnl; totalFees += fee;
    trades.push({ gross:grossPnl, fee, net:netPnl });
  }
  return { balance, peak, maxDD, trades, totalFees };
}

function simulateDT(indicators, useOption1) {
  let balance = DT.startBalance, peak = balance, maxDD = 0;
  const positions = []; const trades = []; let totalFees = 0;
  const allTs = new Set();
  for (const sym of DT_PAIRS) { const ind = indicators[sym]; if (!ind) continue; for (const b of ind.bars) if (b.t/1000 >= START_150) allTs.add(b.t); }
  const sortedTs = [...allTs].sort((a,b)=>a-b);
  for (const ts of sortedTs) {
    for (let p = positions.length-1; p >= 0; p--) {
      const pos = positions[p]; const ind = indicators[pos.sym]; if (!ind) continue;
      const bi = ind.bars.findIndex(b=>b.t===ts); if (bi < 0) continue;
      const bar = ind.bars[bi]; const isL = pos.dir==="LONG"; const barsHeld = bi - pos.entryBarIdx;
      const hitSL = isL ? bar.l<=pos.sl : bar.h>=pos.sl;
      const hitTP = isL ? bar.h>=pos.tp : bar.l<=pos.tp;
      const timeExit = barsHeld >= DT.maxHold;
      let exitReason=null, exitPrice=null;
      if (hitSL&&hitTP) { exitReason="SL"; exitPrice=pos.sl; }
      else if (hitSL)   { exitReason="SL"; exitPrice=pos.sl; }
      else if (hitTP)   { exitReason="TP"; exitPrice=pos.tp; }
      else if (timeExit){ exitReason="TIME"; exitPrice=bar.c; }
      if (exitReason) {
        const grossPnl = ((isL?exitPrice-pos.entry:pos.entry-exitPrice)/pos.entry) * pos.sizeUSD;
        const fee = pos.sizeUSD * FEE_PCT;
        const netPnl = grossPnl - fee;
        balance += netPnl; totalFees += fee;
        if (balance > peak) peak = balance;
        const dd = (peak-balance)/peak*100; if (dd>maxDD) maxDD = dd;
        trades.push({ gross:grossPnl, fee, net:netPnl });
        positions.splice(p, 1);
      }
    }
    if (positions.length < DT.maxPositions) {
      for (const sym of DT_PAIRS) {
        if (positions.some(p=>p.sym===sym)) continue;
        const ind = indicators[sym]; if (!ind) continue;
        const bi = ind.bars.findIndex(b=>b.t===ts); if (bi < 3) continue;
        const i = bi-1, prev = i-1;
        if (!ind.rsi[i]||!ind.vsma[i]||!ind.adx[i]||ind.adx[i]<20) continue;
        const entryHour = new Date(ind.bars[i].t).getUTCHours();
        if (entryHour>=1&&entryHour<8) continue;
        const bias = ind.bias[i]; if (!bias) continue;
        const c=ind.bars[i], p2=ind.bars[prev];
        const r=ind.rsi[i], volOk=c.v>ind.vsma[i]*1.2;
        const e50Up=ind.e50[i]>ind.e50[i-4], e50Dn=ind.e50[i]<ind.e50[i-4];
        const longRsi=r>=40&&r<65, shortRsi=r>35&&r<=60;
        let sig=null;
        if (bias==="LONG") {
          if (e50Up&&longRsi&&volOk&&p2.c<ind.e21[prev]&&c.c>ind.e21[i]) {
            const swL=Math.min(...ind.bars.slice(Math.max(0,i-3),i+1).map(x=>x.l));
            const risk=c.c-swL;
            if (risk>0 && risk/c.c<DT.maxSLPct) sig={dir:"LONG",entry:c.c,sl:swL,tp:c.c+risk*DT.rrRatio};
          }
          if (!sig&&DT_EMA50_PAIRS.has(sym)&&e50Up&&r>=38&&r<62&&volOk&&p2.c<ind.e50[prev]&&c.c>ind.e50[i]) {
            const swL=Math.min(...ind.bars.slice(Math.max(0,i-4),i+1).map(x=>x.l));
            const risk=c.c-swL;
            if (risk>0 && risk/c.c<0.018) sig={dir:"LONG",entry:c.c,sl:swL,tp:c.c+risk*DT.rrRatio};
          }
        }
        if (!sig&&bias==="SHORT") {
          if (e50Dn&&shortRsi&&volOk&&p2.c>ind.e21[prev]&&c.c<ind.e21[i]) {
            const swH=Math.max(...ind.bars.slice(Math.max(0,i-3),i+1).map(x=>x.h));
            const risk=swH-c.c;
            if (risk>0 && risk/c.c<DT.maxSLPct) sig={dir:"SHORT",entry:c.c,sl:swH,tp:c.c-risk*DT.rrRatio};
          }
          if (!sig&&DT_EMA50_PAIRS.has(sym)&&e50Dn&&r>38&&r<=62&&volOk&&p2.c>ind.e50[prev]&&c.c<ind.e50[i]) {
            const swH=Math.max(...ind.bars.slice(Math.max(0,i-4),i+1).map(x=>x.h));
            const risk=swH-c.c;
            if (risk>0 && risk/c.c<0.018) sig={dir:"SHORT",entry:c.c,sl:swH,tp:c.c-risk*DT.rrRatio};
          }
        }
        if (!sig) continue;
        const riskUSD = balance * DT.riskPct;
        const slDist = Math.abs(sig.entry - sig.sl);
        const sizeUSD = useOption1
          ? (riskUSD / slDist) * sig.entry           // Option 1: no leverage
          : (riskUSD / slDist) * sig.entry * DT.leverage;
        positions.push({ sym, dir:sig.dir, entry:sig.entry, sl:sig.sl, tp:sig.tp, sizeUSD, riskUSD, entryBarIdx:bi });
        if (positions.length >= DT.maxPositions) break;
      }
    }
  }
  for (const pos of positions) {
    const ind = indicators[pos.sym]; if (!ind) continue;
    const lastBar = ind.bars[ind.bars.length-1];
    const exitP = lastBar.c; const isL = pos.dir==="LONG";
    const grossPnl = ((isL?exitP-pos.entry:pos.entry-exitP)/pos.entry) * pos.sizeUSD;
    const fee = pos.sizeUSD * FEE_PCT;
    const netPnl = grossPnl - fee;
    balance += netPnl; totalFees += fee;
    trades.push({ gross:grossPnl, fee, net:netPnl });
  }
  return { balance, peak, maxDD, trades, totalFees };
}

function simulateORB(symData, useOption1) {
  let totalBalance = 0, grandTrades = [], grandMaxDD = 0, totalFees = 0;
  for (const sym of ORB_SYMBOLS) {
    const bars = symData[sym];
    if (!bars || bars.length < 50) { totalBalance += PER_SYM; continue; }
    let balance = PER_SYM, peak = balance, maxDD = 0;
    const days = {};
    for (const b of bars) { const k = dayKeyUTC(b.t); if (!days[k]) days[k]=[]; days[k].push(b); }
    const dayKeys = Object.keys(days).sort();
    const sessionVols = [];
    for (const dk of dayKeys) {
      const dayBars = days[dk].sort((a,b)=>a.t-b.t);
      if (!dayBars.length) continue;
      const prevSessionAvgVol = sessionVols.length>0 ? sessionVols.reduce((a,b)=>a+b,0)/sessionVols.length : null;
      const rthBars = dayBars.filter(b=>!isOpenBar(b.t));
      if (rthBars.length < ORB.orbBars) continue;
      const orbWindow = rthBars.slice(0, ORB.orbBars);
      const orHigh = Math.max(...orbWindow.map(b=>b.h));
      const orLow  = Math.min(...orbWindow.map(b=>b.l));
      const orRange = orHigh - orLow; if (orRange <= 0) continue;
      const postOrb = rthBars.slice(ORB.orbBars);
      let traded = false, position = null;
      for (const bar of postOrb) {
        if (isEODBar(bar.t)) {
          if (position) {
            const isL = position.dir==="LONG"; const exitP = bar.c;
            const grossPnl = ((isL?exitP-position.entry:position.entry-exitP)/position.entry)*position.sizeUSD;
            const fee = position.sizeUSD * FEE_PCT;
            const netPnl = grossPnl - fee;
            balance += netPnl; totalFees += fee;
            if (balance>peak) peak = balance;
            const dd=(peak-balance)/peak*100; if (dd>maxDD) maxDD=dd;
            grandTrades.push({ gross:grossPnl, fee, net:netPnl });
            position = null;
          }
          break;
        }
        if (position) {
          const isL = position.dir==="LONG";
          const hitSL = isL?bar.l<=position.sl:bar.h>=position.sl;
          const hitTP = isL?bar.h>=position.tp:bar.l<=position.tp;
          let exitReason=null, exitP=null;
          if (hitSL&&hitTP) { exitReason="SL"; exitP=position.sl; }
          else if (hitSL)   { exitReason="SL"; exitP=position.sl; }
          else if (hitTP)   { exitReason="TP"; exitP=position.tp; }
          if (exitReason) {
            const grossPnl = ((isL?exitP-position.entry:position.entry-exitP)/position.entry)*position.sizeUSD;
            const fee = position.sizeUSD * FEE_PCT;
            const netPnl = grossPnl - fee;
            balance += netPnl; totalFees += fee;
            if (balance>peak) peak = balance;
            const dd=(peak-balance)/peak*100; if (dd>maxDD) maxDD=dd;
            grandTrades.push({ gross:grossPnl, fee, net:netPnl });
            position = null;
          }
          continue;
        }
        if (traded) continue;
        if (new Date(bar.t).getUTCHours() >= 17) continue;
        const volOk = prevSessionAvgVol===null || bar.v > prevSessionAvgVol;
        if (bar.c > orHigh && volOk) {
          const entry=bar.c, sl=orLow, tp=entry+orRange*ORB.rrRatio, slDist=entry-sl;
          const riskUSD=balance*ORB.riskPct;
          const sizeUSD = useOption1 ? (riskUSD/slDist)*entry : (riskUSD/slDist)*entry*ORB.leverage;
          position={dir:"LONG",entry,sl,tp,sizeUSD,riskUSD}; traded=true;
        } else if (bar.c < orLow && volOk) {
          const entry=bar.c, sl=orHigh, tp=entry-orRange*ORB.rrRatio, slDist=sl-entry;
          const riskUSD=balance*ORB.riskPct;
          const sizeUSD = useOption1 ? (riskUSD/slDist)*entry : (riskUSD/slDist)*entry*ORB.leverage;
          position={dir:"SHORT",entry,sl,tp,sizeUSD,riskUSD}; traded=true;
        }
      }
      const dayAvgVol = dayBars.reduce((s,b)=>s+b.v,0)/dayBars.length;
      sessionVols.push(dayAvgVol);
      if (sessionVols.length > ORB.volSessionsMA) sessionVols.shift();
    }
    if (maxDD > grandMaxDD) grandMaxDD = maxDD;
    totalBalance += balance;
  }
  return { balance: totalBalance, maxDD: grandMaxDD, trades: grandTrades, totalFees };
}

function statify(start, res) {
  const wins = res.trades.filter(t=>t.net>0);
  const losses = res.trades.filter(t=>t.net<0);
  const grossW = wins.reduce((s,t)=>s+t.gross,0);
  const grossL = Math.abs(losses.reduce((s,t)=>s+t.gross,0));
  const netW = wins.reduce((s,t)=>s+t.net,0);
  const netL = Math.abs(losses.reduce((s,t)=>s+t.net,0));
  return {
    start, end: res.balance,
    ret: (res.balance-start)/start*100,
    maxDD: res.maxDD,
    trades: res.trades.length,
    wins: wins.length,
    winRate: res.trades.length ? wins.length/res.trades.length*100 : 0,
    avgWin: wins.length ? netW/wins.length : 0,
    avgLoss: losses.length ? netL/losses.length : 0,
    pfGross: grossL>0 ? grossW/grossL : (wins.length?Infinity:0),
    pfNet: netL>0 ? netW/netL : (wins.length?Infinity:0),
    fees: res.totalFees,
  };
}

function printSideBySide(name, baseStats, optStats) {
  const fmt = (v, dp=2) => typeof v === 'number' ? (isFinite(v) ? v.toFixed(dp) : '∞') : v;
  const ret = (s) => `${s.ret>=0?'+':''}${s.ret.toFixed(1)}%`;
  console.log(`\n  ── ${name} ──`);
  console.log(`  ${"Metric".padEnd(22)} ${"Current sizing".padStart(18)} ${"Option 1 sizing".padStart(18)}`);
  console.log(`  ${"".padEnd(22,"─")} ${"".padStart(18,"─")} ${"".padStart(18,"─")}`);
  console.log(`  ${"End balance".padEnd(22)} ${("$"+baseStats.end.toFixed(0)).padStart(18)} ${("$"+optStats.end.toFixed(0)).padStart(18)}`);
  console.log(`  ${"Return".padEnd(22)} ${ret(baseStats).padStart(18)} ${ret(optStats).padStart(18)}`);
  console.log(`  ${"Max drawdown".padEnd(22)} ${(baseStats.maxDD.toFixed(1)+"%").padStart(18)} ${(optStats.maxDD.toFixed(1)+"%").padStart(18)}`);
  console.log(`  ${"Trades".padEnd(22)} ${String(baseStats.trades).padStart(18)} ${String(optStats.trades).padStart(18)}`);
  console.log(`  ${"Win rate".padEnd(22)} ${(baseStats.winRate.toFixed(1)+"%").padStart(18)} ${(optStats.winRate.toFixed(1)+"%").padStart(18)}`);
  console.log(`  ${"Avg win".padEnd(22)} ${("+$"+baseStats.avgWin.toFixed(2)).padStart(18)} ${("+$"+optStats.avgWin.toFixed(2)).padStart(18)}`);
  console.log(`  ${"Avg loss".padEnd(22)} ${("-$"+baseStats.avgLoss.toFixed(2)).padStart(18)} ${("-$"+optStats.avgLoss.toFixed(2)).padStart(18)}`);
  console.log(`  ${"Profit factor (gross)".padEnd(22)} ${fmt(baseStats.pfGross).padStart(18)} ${fmt(optStats.pfGross).padStart(18)}`);
  console.log(`  ${"Profit factor (net)".padEnd(22)} ${fmt(baseStats.pfNet).padStart(18)} ${fmt(optStats.pfNet).padStart(18)}`);
  console.log(`  ${"Total fees paid".padEnd(22)} ${("$"+baseStats.fees.toFixed(0)).padStart(18)} ${("$"+optStats.fees.toFixed(0)).padStart(18)}`);
}

async function main() {
  const t0 = Date.now();
  const startDate = new Date(START_150*1000).toISOString().slice(0,10);
  const endDate   = new Date().toISOString().slice(0,10);

  console.log("╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  REAL-FEE BACKTEST — MEXC Taker 0.02% × 2 = 0.04% round-trip      ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`  Period: ${startDate} → ${endDate}`);
  console.log(`  Fees:   0.04% round-trip (MEXC futures taker, market orders)`);
  console.log(`  Note:   If you switch to limit orders, fees become $0 (maker = 0.00%)`);
  console.log(`  Compares: Current bot sizing (× leverage) vs Option 1 (no × leverage)`);

  console.log("\n[1/3] Fetching v09 data…");
  const v09Data = {};
  const v09FetchStart = NOW_SEC - (DAYS + V09.warmupDays) * 86400;
  for (const sym of V09_PAIRS) {
    process.stdout.write(`  ${sym}…`);
    v09Data[sym] = await fetchAllBars(sym, "Hour4", 4*3600, v09FetchStart, NOW_SEC);
    process.stdout.write(`\r  ${sym.padEnd(20)} ${v09Data[sym].length} bars ✓\n`);
    await sleep(150);
  }
  const v09Ind = {};
  for (const sym of V09_PAIRS) {
    const bars = v09Data[sym]; if (bars.length < 210) continue;
    const closes = bars.map(b=>b.c), vols=bars.map(b=>b.v);
    v09Ind[sym] = { bars, closes, vols, e21: emaSeries(closes,21), e50: emaSeries(closes,50), e200: emaSeries(closes,200), rsi: rsiSmoothed(closes,14), macd: macdSeries(closes), vsma: smaSeries(vols,20) };
  }

  console.log("\n[2/3] Fetching DT data…");
  const dtData = {};
  for (const sym of DT_PAIRS) {
    process.stdout.write(`  ${sym}…`);
    dtData[sym] = await fetchAllBars(sym, "Min15", 15*60, START_150 - 80*15*60, NOW_SEC);
    process.stdout.write(`\r  ${sym.padEnd(20)} ${dtData[sym].length} bars ✓\n`);
    await sleep(150);
  }
  const dtInd = {};
  for (const sym of DT_PAIRS) {
    const bars = dtData[sym]; if (bars.length < 80) continue;
    const closes = bars.map(b=>b.c), vols = bars.map(b=>b.v);
    dtInd[sym] = { bars, closes, vols, e21: emaSeries(closes,21), e50: emaSeries(closes,50), rsi: rsiSmoothed(closes,14), vsma: smaSeries(vols,20), adx: adxSeries(bars,14), bias: dtSessionBias(bars) };
  }

  console.log("\n[3/3] Fetching ORB data…");
  const orbData = {};
  for (const sym of ORB_SYMBOLS) {
    process.stdout.write(`  ${sym}…`);
    const bars = await fetchAllBars(sym, "Min5", 5*60, START_150 - 21*86400, NOW_SEC);
    orbData[sym] = bars.filter(b => isRTHBar(b.t) && isWeekdayMs(b.t));
    process.stdout.write(`\r  ${sym.padEnd(24)} ${orbData[sym].length} RTH bars ✓\n`);
    await sleep(200);
  }

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Running simulations with REAL MEXC fees (0.04% round-trip)…");
  console.log("══════════════════════════════════════════════════════════════");
  process.stdout.write("  v09 (current)…"); const v09Base = simulateV09(v09Ind, false); console.log(` $${v09Base.balance.toFixed(0)}`);
  process.stdout.write("  v09 (option 1)…"); const v09Opt = simulateV09(v09Ind, true); console.log(` $${v09Opt.balance.toFixed(0)}`);
  process.stdout.write("  DT  (current)…"); const dtBase = simulateDT(dtInd, false); console.log(` $${dtBase.balance.toFixed(0)}`);
  process.stdout.write("  DT  (option 1)…"); const dtOpt = simulateDT(dtInd, true); console.log(` $${dtOpt.balance.toFixed(0)}`);
  process.stdout.write("  ORB (current)…"); const orbBase = simulateORB(orbData, false); console.log(` $${orbBase.balance.toFixed(0)}`);
  process.stdout.write("  ORB (option 1)…"); const orbOpt = simulateORB(orbData, true); console.log(` $${orbOpt.balance.toFixed(0)}`);

  const sV09b = statify(V09.startBalance, v09Base);
  const sV09o = statify(V09.startBalance, v09Opt);
  const sDTb  = statify(DT.startBalance, dtBase);
  const sDTo  = statify(DT.startBalance, dtOpt);
  const sORBb = statify(ORB.totalBalance, orbBase);
  const sORBo = statify(ORB.totalBalance, orbOpt);

  console.log("\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  SIDE-BY-SIDE: CURRENT SIZING vs OPTION 1 (MEXC real fees)         ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  printSideBySide("v09 (4H crypto, 1.5x leverage)", sV09b, sV09o);
  printSideBySide("DT (15min crypto, 5x leverage)", sDTb, sDTo);
  printSideBySide("ORB (5min stocks, 5x leverage)", sORBb, sORBo);

  // Portfolio totals
  const totalStart = V09.startBalance + DT.startBalance + ORB.totalBalance;
  const totalBase  = v09Base.balance + dtBase.balance + orbBase.balance;
  const totalOpt   = v09Opt.balance + dtOpt.balance + orbOpt.balance;
  const totalBaseFees = v09Base.totalFees + dtBase.totalFees + orbBase.totalFees;
  const totalOptFees  = v09Opt.totalFees + dtOpt.totalFees + orbOpt.totalFees;

  console.log("\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  PORTFOLIO TOTAL                                                   ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`  ${"Metric".padEnd(22)} ${"Current sizing".padStart(18)} ${"Option 1 sizing".padStart(18)}`);
  console.log(`  ${"".padEnd(22,"─")} ${"".padStart(18,"─")} ${"".padStart(18,"─")}`);
  console.log(`  ${"Start capital".padEnd(22)} ${("$"+totalStart.toLocaleString()).padStart(18)} ${("$"+totalStart.toLocaleString()).padStart(18)}`);
  console.log(`  ${"End balance".padEnd(22)} ${("$"+totalBase.toFixed(0)).padStart(18)} ${("$"+totalOpt.toFixed(0)).padStart(18)}`);
  console.log(`  ${"Return".padEnd(22)} ${(((totalBase-totalStart)/totalStart*100).toFixed(1)+"%").padStart(18)} ${(((totalOpt-totalStart)/totalStart*100).toFixed(1)+"%").padStart(18)}`);
  console.log(`  ${"Total fees".padEnd(22)} ${("$"+totalBaseFees.toFixed(0)).padStart(18)} ${("$"+totalOptFees.toFixed(0)).padStart(18)}`);

  // Maker scenario
  console.log("\n  💡 If switched to LIMIT (maker) orders, fees → $0 → returns would be:");
  console.log(`     Current sizing portfolio: \$${(totalBase + totalBaseFees).toFixed(0)} (${(((totalBase+totalBaseFees)-totalStart)/totalStart*100).toFixed(1)}%)`);
  console.log(`     Option 1 sizing portfolio: \$${(totalOpt + totalOptFees).toFixed(0)} (${(((totalOpt+totalOptFees)-totalStart)/totalStart*100).toFixed(1)}%)`);

  const mins = ((Date.now()-t0)/60000).toFixed(1);
  console.log(`\n  Backtest time: ${mins} min\n`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
