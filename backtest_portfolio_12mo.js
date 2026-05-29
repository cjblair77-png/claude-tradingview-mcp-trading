/**
 * backtest_portfolio_12mo.js — Full portfolio backtest: v09 + DT + Golden Pocket
 *
 * Tests all three validated strategies running together over 12 months on $25k.
 * Validates the diversification thesis: do losing weeks on one strategy get
 * offset by winning weeks on another?
 *
 * Capital allocation:
 *   v09 (Path A):     $12,500 (50%) — 4H trend, 30 mid-cap alts
 *   DT (optimized):   $7,500  (30%) — 15min momentum, 6 large-cap crypto
 *   Golden Pocket:    $5,000  (20%) — 15min Fib retracement, 7 validated pairs
 *
 * Run: node backtest_portfolio_12mo.js
 */

import "dotenv/config";

const MEXC_BASE  = "https://futures.mexc.com";
const DAYS       = 365;
const NOW_SEC    = Math.floor(Date.now() / 1000);
const START      = NOW_SEC - DAYS * 86400;
const FEE_PCT    = 0.0004;

// Capital
const V09_BAL = 12500;
const DT_BAL  = 7500;
const GP_BAL  = 5000;
const TOTAL_START = V09_BAL + DT_BAL + GP_BAL; // $25,000

// ── v09 ──
const V09_PAIRS = [
  "KAIA_USDT","S_USDT","FILECOIN_USDT","AR_USDT","PLUME_USDT","FIDA_USDT","GMT_USDT","ENA_USDT","TIA_USDT","TURBO_USDT",
  "WIF_USDT","SHIB_USDT","BCH_USDT","VET_USDT","ONDO_USDT","THETA_USDT","HBAR_USDT","RUNE_USDT","IOTA_USDT","JUP_USDT",
  "FLUX_USDT","W_USDT","CATI_USDT","ZKSYNC_USDT","KAITO_USDT","WLD_USDT","AIXBT_USDT","LA_USDT","JASMY_USDT","HOME_USDT",
];
const V09 = { riskPct: 0.016, minRisk: 2, leverage: 1.5, slPct: 0.04, tpPct: 0.35, trailPct: 0.16, rsiOverbought: 80, brsiMin: 48, brsiMax: 65, lookback: 15, maxPositions: 10, warmupDays: 92 };

// ── DT (optimized) ──
const DT_PAIRS = ["BTC_USDT","BNB_USDT","XRP_USDT","SUI_USDT","LTC_USDT","AVAX_USDT"];
const DT_EMA50_PAIRS = new Set(["BTC_USDT","SUI_USDT"]);
const DT = { riskPct: 0.010, leverage: 5, rrRatio: 2.0, maxHold: 18, maxSLPct: 0.012, adxMin: 15, maxPositions: 6 };

// ── Golden Pocket (validated 7-pair universe from walk-forward) ──
const GP_PAIRS = ["RUNE_USDT", "AR_USDT", "ENA_USDT", "TIA_USDT", "SUI_USDT", "AIXBT_USDT", "KAIA_USDT"];
const GP = {
  riskPct: 0.005, leverage: 5, rrRatio: 1.6, maxHold: 192, pendingMax: 96, maxPositions: 4,
  impulseLookback: 6, impulseMinPct: 0.025, structureLookback: 20,
  fibEntry: 0.618, fibInvalidate: 0.786, slBufferPct: 0.005,
  sessionStartH: 13, sessionEndH: 18, htfEMAfast: 21, htfEMAslow: 50,
};

// ── Helpers ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function fetchChunk(symbol, intervalStr, startSec, endSec) {
  const url = `${MEXC_BASE}/api/v1/contract/kline/${symbol}?interval=${intervalStr}&start=${startSec}&end=${endSec}`;
  try { const res = await fetch(url, { signal: AbortSignal.timeout(20000) }); if (!res.ok) return [];
    const json = await res.json(); if (!json.data?.time?.length) return [];
    const { time, open, close, high, low, vol } = json.data;
    return time.map((t,i) => ({ t: t*1000, o:+open[i], c:+close[i], h:+high[i], l:+low[i], v:+vol[i] })).sort((a,b)=>a.t-b.t);
  } catch { return []; }
}
async function fetchAllBars(symbol, intervalStr, barSecs, startSec, endSec) {
  const bars=[]; const chunk=1800*barSecs; let cur=startSec, emptyRuns=0;
  while(cur<endSec){const end=Math.min(cur+chunk,endSec);const batch=await fetchChunk(symbol,intervalStr,cur,end);if(!batch.length){emptyRuns++;if(emptyRuns>=15)break;cur=end+barSecs;await sleep(120);continue;}emptyRuns=0;bars.push(...batch);cur=Math.floor(batch[batch.length-1].t/1000)+barSecs;await sleep(100);}
  const seen=new Set();return bars.filter(b=>{if(seen.has(b.t))return false;seen.add(b.t);return true;}).sort((a,b)=>a.t-b.t);
}
function ema(v,p){const k=2/(p+1),o=[v[0]];for(let i=1;i<v.length;i++)o.push(v[i]*k+o[i-1]*(1-k));return o;}
function sma(v,p){return v.map((_,i)=>i<p-1?null:v.slice(i-p+1,i+1).reduce((a,b)=>a+b,0)/p);}
function rsi(c,p=14){const o=new Array(c.length).fill(null);let g=0,l=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];d>0?g+=d:l-=d;}o[p]=l===0?100:100-100/(1+g/l);for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];if(d>0){g=(g*(p-1)+d)/p;l=l*(p-1)/p;}else{g=g*(p-1)/p;l=(l*(p-1)-d)/p;}o[i]=l===0?100:100-100/(1+g/l);}return o;}
function macd(c,f=12,s=26,sig=9){const fa=ema(c,f),sl=ema(c,s);const line=c.map((_,i)=>fa[i]-sl[i]);const signal=[line[0]];const k=2/(sig+1);for(let i=1;i<c.length;i++)signal.push(line[i]*k+signal[i-1]*(1-k));return{line,signal,hist:line.map((v,i)=>v-signal[i])};}
function adx(b,p=14){const n=b.length,o=new Array(n).fill(null),tr=[],pdm=[],ndm=[];for(let i=1;i<n;i++){const h=b[i].h,l=b[i].l,pc=b[i-1].c,ph=b[i-1].h,pl=b[i-1].l;tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));const up=h-ph,dn=pl-l;pdm.push(up>dn&&up>0?up:0);ndm.push(dn>up&&dn>0?dn:0);}if(tr.length<p*2)return o;let smTR=tr.slice(0,p).reduce((a,b)=>a+b,0),smP=pdm.slice(0,p).reduce((a,b)=>a+b,0),smN=ndm.slice(0,p).reduce((a,b)=>a+b,0);const dx=[],cDX=()=>{const pp=smTR?100*smP/smTR:0,nn=smTR?100*smN/smTR:0;return(pp+nn)?100*Math.abs(pp-nn)/(pp+nn):0;};dx.push(cDX());for(let i=p;i<tr.length;i++){smTR=smTR-smTR/p+tr[i];smP=smP-smP/p+pdm[i];smN=smN-smN/p+ndm[i];dx.push(cDX());}if(dx.length<p)return o;let v=dx.slice(0,p).reduce((a,b)=>a+b,0)/p;o[2*p-1]=v;for(let j=p;j<dx.length;j++){v=(v*(p-1)+dx[j])/p;o[j+p]=v;}return o;}
function dtSessionBias(bars){const bias=new Array(bars.length).fill(null);let oH=-Infinity,oL=Infinity,bld=false,conf=null,cur=null;for(let j=0;j<bars.length;j++){const h=new Date(bars[j].t).getUTCHours(),m=new Date(bars[j].t).getUTCMinutes();if([1,8,13].includes(h)&&m===0){bld=true;oH=bars[j].h;oL=bars[j].l;conf=null;cur=null;}else if(bld){oH=Math.max(oH,bars[j].h);oL=Math.min(oL,bars[j].l);conf={h:oH,l:oL};bld=false;}if(conf&&cur===null){if(bars[j].c>conf.h)cur="LONG";else if(bars[j].c<conf.l)cur="SHORT";}bias[j]=conf?cur:null;}return bias;}

function weekKey(ts) {
  const d = new Date(ts);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThu = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstThuDayNr = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstThuDayNr + 3);
  return `${target.getUTCFullYear()}-W${String(1+Math.round((target-firstThu)/(7*86400000))).padStart(2,"0")}`;
}
function weekStartDate(wk) {
  const [yr, w] = wk.split("-W");
  const jan4 = new Date(Date.UTC(parseInt(yr), 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const w1Mon = new Date(jan4); w1Mon.setUTCDate(jan4.getUTCDate() - jan4Day);
  const monday = new Date(w1Mon); monday.setUTCDate(w1Mon.getUTCDate() + (parseInt(w)-1)*7);
  return monday.toISOString().slice(0,10);
}

// ─── v09 simulator (Path A) ─────────────────────────────────────────────────

function v09Regime(i,closes,e21,e50,e200){if(!e200[i]||!e50[i]||!e21[i])return"neutral";const c=closes[i];let s=0;if(c>e200[i])s++;else s--;if(c>e50[i])s++;else s--;if(c>e21[i])s++;else s--;if(e21[i]>e50[i])s++;else s--;if(e50[i]>e200[i])s++;else s--;return s>=4?"bull":s<=-4?"bear":"neutral";}
function v09Risk(reg,dir,bal){const b=Math.max(bal*V09.riskPct,V09.minRisk);if(reg==="neutral")return b*0.75;const w=(reg==="bull"&&dir==="LONG")||(reg==="bear"&&dir==="SHORT");return w?b:b*0.5;}

function simulateV09(indicators) {
  let balance = V09_BAL, peak = balance, maxDD = 0;
  const positions = []; const trades = [];
  const allTs = new Set();
  for (const sym of V09_PAIRS) { const ind = indicators[sym]; if (!ind) continue; for (const b of ind.bars) if (b.t/1000 >= START) allTs.add(b.t); }
  const sortedTs = [...allTs].sort((a,b)=>a-b);
  const tsMap = {};
  for (const sym of V09_PAIRS) { const ind = indicators[sym]; if (!ind) continue; tsMap[sym] = new Map(); for (let i = 0; i < ind.bars.length; i++) tsMap[sym].set(ind.bars[i].t, i); }
  function calcBullPct(ts) {
    let bulls=0,total=0;
    for (const sym of V09_PAIRS) { const ind = indicators[sym]; if (!ind) continue; const bi = tsMap[sym].get(ts); if (bi === undefined) continue; const r = v09Regime(bi, ind.closes, ind.e21, ind.e50, ind.e200); if (r==="bull") bulls++; total++; }
    return total ? (bulls/total)*100 : 0;
  }
  for (const ts of sortedTs) {
    for (let p = positions.length-1; p >= 0; p--) {
      const pos = positions[p]; const ind = indicators[pos.sym]; if (!ind) continue;
      const bi = tsMap[pos.sym].get(ts); if (bi === undefined) continue;
      const bar = ind.bars[bi]; const isL = pos.dir === "LONG";
      let exitReason=null, exitPrice=null;
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
        const grossPnl = raw;  // Option 1
        const fee = pos.size * FEE_PCT;
        const netPnl = grossPnl - fee;
        balance += netPnl;
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak * 100; if (dd>maxDD) maxDD=dd;
        trades.push({ gross: grossPnl, fee, net: netPnl, exitTs: ts, balance });
        positions.splice(p, 1);
      }
    }
    if (positions.length < V09.maxPositions) {
      const bullPct = calcBullPct(ts);
      const trailActive = bullPct >= 60;
      for (const sym of V09_PAIRS) {
        if (positions.some(p=>p.sym===sym)) continue;
        const ind = indicators[sym]; if (!ind) continue;
        const bi = tsMap[sym].get(ts); if (bi === undefined || bi < 1) continue;
        const i = bi - 1;
        if (i < 22 || !ind.rsi[i] || !ind.rsi[i-1] || !ind.vsma[i] || !ind.e200[i]) continue;
        const c = ind.closes[i], rNow = ind.rsi[i], rPrv = ind.rsi[i-1], vol = ind.vols[i], reg = v09Regime(i, ind.closes, ind.e21, ind.e50, ind.e200);
        const highN = Math.max(...ind.closes.slice(Math.max(0,i-V09.lookback),i));
        const trendUp = ind.e21[i]>ind.e50[i] && ind.e21[i]>ind.e21[i-1] && ind.e21[i-1]>ind.e21[i-3];
        const lBreak = c>highN && trendUp && rNow>=V09.brsiMin && rNow<=V09.brsiMax && vol>ind.vsma[i]*1.5;
        const wasOB = [1,2,3,4,5].some(k=>ind.rsi[i-k]!=null&&ind.rsi[i-k]>=65);
        const rsiBrk = rPrv>=58 && rNow<58, macdBrk = ind.macd.hist[i-1]>=0 && ind.macd.hist[i]<0;
        const sBreak = wasOB && (rsiBrk||macdBrk) && c<ind.e21[i] && rNow>35 && vol>ind.vsma[i]*1.2;
        const wasOVB = [1,2,3].some(k=>ind.rsi[i-k]!=null&&ind.rsi[i-k]>=V09.rsiOverbought);
        const rsiTurnD = rPrv>=70 && rNow<70;
        const sRebound = wasOVB && rsiTurnD && reg!=="bull" && c<ind.e21[i]*1.08 && vol>ind.vsma[i]*1.0 && !sBreak;
        if (!lBreak && !sBreak && !sRebound) continue;
        let dir, isRebound;
        if (lBreak) { dir="LONG"; isRebound=false; }
        else if (sBreak) { dir="SHORT"; isRebound=false; }
        else { dir="SHORT"; isRebound=true; }
        const riskUSD = v09Risk(reg, dir, balance);
        const slPct = isRebound ? 0.035 : V09.slPct;
        const tpPct = isRebound ? 0.22 : V09.tpPct;
        const noTrail = !trailActive || isRebound;
        const entryP = ind.bars[bi].o;
        const size = riskUSD / slPct;
        const isL = dir==="LONG";
        const sl = isL ? entryP*(1-slPct) : entryP*(1+slPct);
        const tp = isL ? entryP*(1+tpPct) : entryP*(1-tpPct);
        positions.push({ sym, dir, entryPrice: entryP, sl, tp, size, riskUSD, trailing: false, noTrail, trailHigh: isL?tp:Infinity, trailLow: isL?0:tp });
        if (positions.length >= V09.maxPositions) break;
      }
    }
  }
  for (const pos of positions) {
    const ind = indicators[pos.sym]; if (!ind) continue;
    const lastBar = ind.bars[ind.bars.length-1];
    const isL = pos.dir==="LONG";
    const raw = isL ? (lastBar.c-pos.entryPrice)/pos.entryPrice*pos.size : (pos.entryPrice-lastBar.c)/pos.entryPrice*pos.size;
    const grossPnl = raw;
    const fee = pos.size * FEE_PCT;
    const netPnl = grossPnl - fee;
    balance += netPnl;
    trades.push({ gross: grossPnl, fee, net: netPnl, exitTs: lastBar.t, balance });
  }
  return { balance, peak, maxDD, trades };
}

// ─── DT simulator (optimized) ──────────────────────────────────────────────

function simulateDT(indicators) {
  let balance = DT_BAL, peak = balance, maxDD = 0;
  const positions = []; const trades = [];
  const allTs = new Set();
  for (const sym of DT_PAIRS) { const ind = indicators[sym]; if (!ind) continue; for (const b of ind.bars) if (b.t/1000 >= START) allTs.add(b.t); }
  const sortedTs = [...allTs].sort((a,b)=>a-b);
  const tsMap = {};
  for (const sym of DT_PAIRS) { const ind = indicators[sym]; if (!ind) continue; tsMap[sym] = new Map(); for (let i = 0; i < ind.bars.length; i++) tsMap[sym].set(ind.bars[i].t, i); }
  for (const ts of sortedTs) {
    for (let i = positions.length-1; i >= 0; i--) {
      const pos = positions[i]; const ind = indicators[pos.sym]; if (!ind) continue;
      const bi = tsMap[pos.sym].get(ts); if (bi === undefined) continue;
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
        balance += netPnl;
        if (balance > peak) peak = balance;
        const dd = (peak-balance)/peak*100; if (dd>maxDD) maxDD=dd;
        trades.push({ gross: grossPnl, fee, net: netPnl, exitTs: ts, balance });
        positions.splice(i, 1);
      }
    }
    if (positions.length < DT.maxPositions) {
      for (const sym of DT_PAIRS) {
        if (positions.some(p=>p.sym===sym)) continue;
        const ind = indicators[sym]; if (!ind) continue;
        const bi = tsMap[sym].get(ts); if (bi === undefined || bi < 3) continue;
        const i = bi-1, prev = i-1;
        if (!ind.rsi[i]||!ind.vsma[i]||!ind.adx[i]||ind.adx[i]<DT.adxMin) continue;
        const eh = new Date(ind.bars[i].t).getUTCHours();
        if (eh>=1&&eh<8) continue;
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
        const slDist  = Math.abs(sig.entry - sig.sl);
        const sizeUSD = (riskUSD / slDist) * sig.entry;
        positions.push({ sym, dir:sig.dir, entry:sig.entry, sl:sig.sl, tp:sig.tp, sizeUSD, riskUSD, entryBarIdx:bi });
        if (positions.length>=DT.maxPositions) break;
      }
    }
  }
  for (const pos of positions) {
    const ind = indicators[pos.sym]; if (!ind) continue;
    const lastBar = ind.bars[ind.bars.length-1];
    const isL = pos.dir==="LONG";
    const grossPnl = ((isL?lastBar.c-pos.entry:pos.entry-lastBar.c)/pos.entry) * pos.sizeUSD;
    const fee = pos.sizeUSD * FEE_PCT;
    const netPnl = grossPnl - fee;
    balance += netPnl;
    trades.push({ gross: grossPnl, fee, net: netPnl, exitTs: lastBar.t, balance });
  }
  return { balance, peak, maxDD, trades };
}

// ─── Golden Pocket simulator ────────────────────────────────────────────────

function build1HTrend(bars15) {
  const hourly = {};
  for (const b of bars15) {
    const d = new Date(b.t);
    const k = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}`;
    if (!hourly[k]) hourly[k] = { t: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())).getTime(), c: b.c };
    else hourly[k].c = b.c;
  }
  const hours = Object.values(hourly).sort((a,b)=>a.t-b.t);
  const closes = hours.map(h=>h.c);
  const e21 = ema(closes, GP.htfEMAfast);
  const e50 = ema(closes, GP.htfEMAslow);
  return hours.map((h,i) => ({ t: h.t, trend: e21[i] != null && e50[i] != null ? (e21[i] > e50[i] ? "UP" : "DOWN") : "NEUTRAL" }));
}
function lookup1HTrend(trendArr, ts) {
  const oneHour = 3600 * 1000;
  let lo = 0, hi = trendArr.length-1, result = "NEUTRAL";
  while (lo <= hi) { const mid = (lo+hi)>>1; if (trendArr[mid].t + oneHour <= ts) { result = trendArr[mid].trend; lo = mid+1; } else hi = mid-1; }
  return result;
}
function inSessionGP(ts) {
  const h = new Date(ts).getUTCHours();
  return h >= GP.sessionStartH && h < GP.sessionEndH;
}
function detectImpulse(bars, i) {
  if (i < GP.impulseLookback + GP.structureLookback) return null;
  const window = bars.slice(i - GP.impulseLookback + 1, i + 1);
  const wH = Math.max(...window.map(b=>b.h));
  const wL = Math.min(...window.map(b=>b.l));
  if ((wH - wL) / wL < GP.impulseMinPct) return null;
  let highIdx = 0, lowIdx = 0; let hv = window[0].h, lv = window[0].l;
  for (let j = 1; j < window.length; j++) { if (window[j].h > hv) { hv = window[j].h; highIdx = j; } if (window[j].l < lv) { lv = window[j].l; lowIdx = j; } }
  const dir = highIdx > lowIdx ? "UP" : "DOWN";
  const priorStart = Math.max(0, i - GP.impulseLookback - GP.structureLookback);
  const priorBars = bars.slice(priorStart, i - GP.impulseLookback + 1);
  if (priorBars.length === 0) return null;
  const priorHigh = Math.max(...priorBars.map(b=>b.h));
  const priorLow  = Math.min(...priorBars.map(b=>b.l));
  if (dir === "UP" && wH <= priorHigh) return null;
  if (dir === "DOWN" && wL >= priorLow) return null;
  return { dir, start: dir === "UP" ? wL : wH, end: dir === "UP" ? wH : wL };
}
function computeFibLevels(impulse) {
  const range = Math.abs(impulse.end - impulse.start);
  let entry, sl, fibInvalid;
  if (impulse.dir === "UP") { entry = impulse.end - range * GP.fibEntry; sl = impulse.start * (1 - GP.slBufferPct); fibInvalid = impulse.end - range * GP.fibInvalidate; }
  else { entry = impulse.end + range * GP.fibEntry; sl = impulse.start * (1 + GP.slBufferPct); fibInvalid = impulse.end + range * GP.fibInvalidate; }
  const slDist = Math.abs(entry - sl);
  const tp = impulse.dir === "UP" ? entry + slDist * GP.rrRatio : entry - slDist * GP.rrRatio;
  return { entry, sl, tp, fibInvalid, slDist };
}

function simulateGP(indicators) {
  let balance = GP_BAL, peak = balance, maxDD = 0;
  const positions = []; const pending = []; const trades = [];
  const tsMap = {};
  for (const sym of GP_PAIRS) { const ind = indicators[sym]; if (!ind) continue; tsMap[sym] = new Map(); for (let i = 0; i < ind.bars.length; i++) tsMap[sym].set(ind.bars[i].t, i); }
  const allTs = new Set();
  for (const sym of GP_PAIRS) { const ind = indicators[sym]; if (!ind) continue; for (const b of ind.bars) if (b.t/1000 >= START) allTs.add(b.t); }
  const sortedTs = [...allTs].sort((a,b)=>a-b);
  for (const ts of sortedTs) {
    for (let p = positions.length-1; p >= 0; p--) {
      const pos = positions[p];
      const ind = indicators[pos.sym]; if (!ind) continue;
      const bi = tsMap[pos.sym].get(ts); if (bi === undefined) continue;
      const bar = ind.bars[bi];
      if (bar.t <= pos.fillTs) continue;
      const isL = pos.dir==="LONG"; const barsHeld = bi - pos.fillBarIdx;
      const hitSL = isL ? bar.l<=pos.sl : bar.h>=pos.sl;
      const hitTP = isL ? bar.h>=pos.tp : bar.l<=pos.tp;
      const timeExit = barsHeld >= GP.maxHold;
      let exitReason=null, exitPrice=null;
      if (hitSL&&hitTP) { exitReason="SL"; exitPrice=pos.sl; }
      else if (hitSL)   { exitReason="SL"; exitPrice=pos.sl; }
      else if (hitTP)   { exitReason="TP"; exitPrice=pos.tp; }
      else if (timeExit){ exitReason="TIME"; exitPrice=bar.c; }
      if (exitReason) {
        const grossPnl = ((isL?exitPrice-pos.entry:pos.entry-exitPrice)/pos.entry) * pos.sizeUSD;
        const fee = pos.sizeUSD * FEE_PCT;
        const netPnl = grossPnl - fee;
        balance += netPnl;
        if (balance>peak) peak = balance;
        const dd = (peak-balance)/peak*100; if (dd>maxDD) maxDD=dd;
        trades.push({ gross: grossPnl, fee, net: netPnl, exitTs: ts, balance });
        positions.splice(p, 1);
      }
    }
    for (let q = pending.length-1; q >= 0; q--) {
      const p = pending[q];
      const ind = indicators[p.sym]; if (!ind) continue;
      const bi = tsMap[p.sym].get(ts); if (bi === undefined) continue;
      const bar = ind.bars[bi];
      if (bar.t <= p.signalTs) continue;
      const invalidated = p.dir === "LONG" ? bar.l <= p.fibInvalid : bar.h >= p.fibInvalid;
      if (invalidated) { pending.splice(q, 1); continue; }
      const filled = p.dir === "LONG" ? bar.l <= p.entry : bar.h >= p.entry;
      if (filled) { positions.push({ ...p, fillBarIdx: bi, fillTs: bar.t }); pending.splice(q, 1); continue; }
      const ageBars = bi - p.signalBarIdx;
      if (ageBars >= GP.pendingMax) pending.splice(q, 1);
    }
    if (positions.length + pending.length >= GP.maxPositions) continue;
    if (!inSessionGP(ts)) continue;
    for (const sym of GP_PAIRS) {
      if (positions.some(p=>p.sym===sym)) continue;
      if (pending.some(p=>p.sym===sym)) continue;
      const ind = indicators[sym]; if (!ind) continue;
      const bi = tsMap[sym].get(ts); if (bi === undefined) continue;
      const bar = ind.bars[bi];
      const imp = detectImpulse(ind.bars, bi);
      if (!imp) continue;
      const htfTrend = lookup1HTrend(ind.trend, bar.t);
      if (imp.dir === "UP" && htfTrend !== "UP") continue;
      if (imp.dir === "DOWN" && htfTrend !== "DOWN") continue;
      const fib = computeFibLevels(imp);
      if (fib.slDist <= 0) continue;
      const riskUSD = balance * GP.riskPct;
      const sizeUSD = (riskUSD / fib.slDist) * fib.entry;
      pending.push({ sym, dir: imp.dir === "UP" ? "LONG" : "SHORT", entry: fib.entry, sl: fib.sl, tp: fib.tp, fibInvalid: fib.fibInvalid, sizeUSD, riskUSD, signalBarIdx: bi, signalTs: bar.t });
      if (positions.length + pending.length >= GP.maxPositions) break;
    }
  }
  for (const pos of positions) {
    const ind = indicators[pos.sym]; if (!ind) continue;
    const lastBar = ind.bars[ind.bars.length-1];
    const isL = pos.dir==="LONG";
    const grossPnl = ((isL?lastBar.c-pos.entry:pos.entry-lastBar.c)/pos.entry) * pos.sizeUSD;
    const fee = pos.sizeUSD * FEE_PCT;
    const netPnl = grossPnl - fee;
    balance += netPnl;
    trades.push({ gross: grossPnl, fee, net: netPnl, exitTs: lastBar.t, balance });
  }
  return { balance, peak, maxDD, trades };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const startDate = new Date(START*1000).toISOString().slice(0,10);
  const endDate = new Date().toISOString().slice(0,10);

  console.log("╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  12-MONTH PORTFOLIO BACKTEST — v09 + DT + Golden Pocket            ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`  Period:    ${startDate} → ${endDate}  (${DAYS} days)`);
  console.log(`  Capital:   $${TOTAL_START.toLocaleString()} total`);
  console.log(`             v09:  $${V09_BAL.toLocaleString()} (50%)  — 4H trend, 30 alts, 1.6% risk`);
  console.log(`             DT:   $${DT_BAL.toLocaleString()} (30%)  — 15min momentum, 6 pairs, 1.0% risk`);
  console.log(`             GP:   $${GP_BAL.toLocaleString()} (20%)  — 15min Fib, 7 pairs, 0.5% risk`);

  // ── Fetch v09 4H data
  console.log(`\n[1/3] Fetching v09 4H data (${V09_PAIRS.length} pairs, 13 months)…`);
  const v09Data = {};
  const v09FetchStart = NOW_SEC - (DAYS + V09.warmupDays) * 86400;
  for (const sym of V09_PAIRS) {
    process.stdout.write(`  ${sym}…`);
    v09Data[sym] = await fetchAllBars(sym, "Hour4", 4*3600, v09FetchStart, NOW_SEC);
    process.stdout.write(`\r  ${sym.padEnd(20)} ${v09Data[sym].length} bars ✓\n`);
    await sleep(100);
  }
  const v09Ind = {};
  for (const sym of V09_PAIRS) {
    const bars = v09Data[sym]; if (bars.length < 210) continue;
    const closes = bars.map(b=>b.c), vols=bars.map(b=>b.v);
    v09Ind[sym] = { bars, closes, vols, e21: ema(closes,21), e50: ema(closes,50), e200: ema(closes,200), rsi: rsi(closes,14), macd: macd(closes), vsma: sma(vols,20) };
  }

  // ── Fetch 15min data (unique union of DT + GP pairs)
  const all15MinPairs = [...new Set([...DT_PAIRS, ...GP_PAIRS])];
  console.log(`\n[2/3] Fetching 15min data (${all15MinPairs.length} unique pairs, 13 months)…`);
  const data15 = {};
  for (const sym of all15MinPairs) {
    process.stdout.write(`  ${sym}…`);
    data15[sym] = await fetchAllBars(sym, "Min15", 15*60, START - 30*86400, NOW_SEC);
    process.stdout.write(`\r  ${sym.padEnd(20)} ${data15[sym].length} bars ✓\n`);
    await sleep(100);
  }

  console.log(`\n[3/3] Computing indicators…`);
  const dtInd = {};
  for (const sym of DT_PAIRS) {
    const bars = data15[sym]; if (!bars || bars.length < 80) continue;
    const closes = bars.map(b=>b.c), vols = bars.map(b=>b.v);
    dtInd[sym] = { bars, closes, vols, e21: ema(closes,21), e50: ema(closes,50), rsi: rsi(closes,14), vsma: sma(vols,20), adx: adx(bars,14), bias: dtSessionBias(bars) };
  }
  const gpInd = {};
  for (const sym of GP_PAIRS) {
    const bars = data15[sym]; if (!bars || bars.length < 200) continue;
    gpInd[sym] = { bars, trend: build1HTrend(bars) };
  }

  // ── Run all 3 simulations
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Running 3 simulations independently…");
  console.log("══════════════════════════════════════════════════════════════");
  process.stdout.write("  v09…"); const v09R = simulateV09(v09Ind); console.log(` $${v09R.balance.toFixed(0)} (${v09R.trades.length} trades)`);
  process.stdout.write("  DT…"); const dtR = simulateDT(dtInd); console.log(` $${dtR.balance.toFixed(0)} (${dtR.trades.length} trades)`);
  process.stdout.write("  GP…"); const gpR = simulateGP(gpInd); console.log(` $${gpR.balance.toFixed(0)} (${gpR.trades.length} trades)`);

  // ── Aggregate by week
  function bucket(trades) {
    const w = {};
    for (const t of trades) { const wk = weekKey(t.exitTs); if (!w[wk]) w[wk] = { net: 0, trades: 0 }; w[wk].net += t.net; w[wk].trades += 1; }
    return w;
  }
  const v09W = bucket(v09R.trades);
  const dtW  = bucket(dtR.trades);
  const gpW  = bucket(gpR.trades);
  const allWeeks = [...new Set([...Object.keys(v09W), ...Object.keys(dtW), ...Object.keys(gpW)])].sort();

  // Combined equity curve & max DD
  let combinedPeak = TOTAL_START, combinedMaxDD = 0;
  let combinedBalance = TOTAL_START;
  const weeklyData = [];
  for (const wk of allWeeks) {
    const v = v09W[wk]?.net || 0;
    const d = dtW[wk]?.net || 0;
    const g = gpW[wk]?.net || 0;
    const totalNet = v + d + g;
    combinedBalance += totalNet;
    if (combinedBalance > combinedPeak) combinedPeak = combinedBalance;
    const ddPct = (combinedPeak - combinedBalance) / combinedPeak * 100;
    if (ddPct > combinedMaxDD) combinedMaxDD = ddPct;
    weeklyData.push({ wk, v, d, g, total: totalNet, balance: combinedBalance, dd: ddPct });
  }

  // ── Weekly table (showing key weeks: extreme + monthly samples)
  console.log("\n\n╔══════════════════════════════════════════════════════════════════════════════════════════════════╗");
  console.log("║  WEEKLY P&L BREAKDOWN                                                                             ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════════════════════════════╝");
  console.log(`\n  ${"Week".padEnd(11)} ${"Date".padEnd(11)} │ ${"v09".padStart(9)} ${"DT".padStart(9)} ${"GP".padStart(9)} │ ${"Total Net".padStart(11)} ${"Balance".padStart(11)} ${"DD".padStart(7)}`);
  console.log(`  ${"─".repeat(11)} ${"─".repeat(11)} ┼ ${"─".repeat(9)} ${"─".repeat(9)} ${"─".repeat(9)} ┼ ${"─".repeat(11)} ${"─".repeat(11)} ${"─".repeat(7)}`);
  const fmt = n => n === 0 ? "—" : `${n>=0?'+':''}$${n.toFixed(0)}`;
  for (const row of weeklyData) {
    console.log(`  ${row.wk.padEnd(11)} ${weekStartDate(row.wk).padEnd(11)} │ ${fmt(row.v).padStart(9)} ${fmt(row.d).padStart(9)} ${fmt(row.g).padStart(9)} │ ${fmt(row.total).padStart(11)} ${("$"+row.balance.toFixed(0)).padStart(11)} ${(row.dd.toFixed(1)+"%").padStart(7)}`);
  }

  // ── Strategy summary
  console.log("\n\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  PER-STRATEGY 12-MONTH RESULTS                                      ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  for (const [name, R, alloc] of [["v09 (4H crypto, 30 alts)", v09R, V09_BAL], ["DT  (15min, 6 large-caps)", dtR, DT_BAL], ["GP  (15min Fib, 7 pairs)", gpR, GP_BAL]]) {
    const ret = (R.balance - alloc) / alloc * 100;
    const wins = R.trades.filter(t=>t.net>0).length, losses = R.trades.filter(t=>t.net<0).length;
    const wr = R.trades.length ? wins/R.trades.length*100 : 0;
    const netW = R.trades.filter(t=>t.net>0).reduce((s,t)=>s+t.net,0);
    const netL = Math.abs(R.trades.filter(t=>t.net<0).reduce((s,t)=>s+t.net,0));
    const pf = netL > 0 ? netW/netL : Infinity;
    console.log(`\n  ── ${name} ──`);
    console.log(`     Start: $${alloc.toLocaleString()}  →  End: $${R.balance.toFixed(0)}  (${ret>=0?'+':''}${ret.toFixed(1)}%)`);
    console.log(`     Max DD: ${R.maxDD.toFixed(1)}%  |  PF: ${pf===Infinity?'∞':pf.toFixed(2)}  |  Trades: ${R.trades.length}  (W:${wins} / L:${losses})  WR: ${wr.toFixed(1)}%`);
  }

  // ── Portfolio summary
  console.log("\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  PORTFOLIO TOTAL                                                    ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  const totalEnd = v09R.balance + dtR.balance + gpR.balance;
  const portRet = (totalEnd - TOTAL_START) / TOTAL_START * 100;
  const grossWk = weeklyData.reduce((s,w)=>s+w.total,0);
  const winWks = weeklyData.filter(w=>w.total>0).length;
  const lossWks = weeklyData.filter(w=>w.total<0).length;
  const wkPnls = weeklyData.map(w=>w.total);
  console.log(`\n  Start:        $${TOTAL_START.toLocaleString()}`);
  console.log(`  End:          $${totalEnd.toFixed(0)}`);
  console.log(`  Return:       ${portRet>=0?'+':''}${portRet.toFixed(1)}%`);
  console.log(`  Max DD:       ${combinedMaxDD.toFixed(1)}%  ← portfolio-level (with diversification)`);
  console.log(`  Annualized:   ${portRet.toFixed(1)}%  (12-month run)`);
  console.log(`  Weekly avg:   ${(portRet/52).toFixed(2)}%  (${(grossWk/weeklyData.length>=0?'+':'')}$${(grossWk/weeklyData.length).toFixed(0)})`);
  console.log(`  Daily avg:    ${(portRet/365).toFixed(3)}%`);
  console.log(`\n  Weekly win rate: ${winWks}/${weeklyData.length}  (${(winWks/weeklyData.length*100).toFixed(0)}%)`);
  console.log(`  Best week:       ${fmt(Math.max(...wkPnls))}`);
  console.log(`  Worst week:      ${fmt(Math.min(...wkPnls))}`);

  // ── Diversification analysis: correlation between strategies
  console.log("\n  ── Diversification check (cross-strategy correlation) ──");
  // Compute correlation of v09 vs DT, v09 vs GP, DT vs GP from weekly P&L
  function correlate(a, b) {
    if (a.length !== b.length || a.length < 3) return 0;
    const meanA = a.reduce((s,x)=>s+x,0)/a.length;
    const meanB = b.reduce((s,x)=>s+x,0)/b.length;
    let num = 0, denA = 0, denB = 0;
    for (let i = 0; i < a.length; i++) {
      const dA = a[i] - meanA, dB = b[i] - meanB;
      num += dA * dB;
      denA += dA*dA; denB += dB*dB;
    }
    return denA*denB === 0 ? 0 : num / Math.sqrt(denA * denB);
  }
  const v09Wks = weeklyData.map(w => w.v);
  const dtWks  = weeklyData.map(w => w.d);
  const gpWks  = weeklyData.map(w => w.g);
  console.log(`     v09 vs DT:   ${correlate(v09Wks, dtWks).toFixed(2)}  (${Math.abs(correlate(v09Wks, dtWks)) < 0.3 ? 'good diversification' : Math.abs(correlate(v09Wks, dtWks)) < 0.6 ? 'moderate' : 'highly correlated'})`);
  console.log(`     v09 vs GP:   ${correlate(v09Wks, gpWks).toFixed(2)}  (${Math.abs(correlate(v09Wks, gpWks)) < 0.3 ? 'good diversification' : Math.abs(correlate(v09Wks, gpWks)) < 0.6 ? 'moderate' : 'highly correlated'})`);
  console.log(`     DT vs GP:    ${correlate(dtWks, gpWks).toFixed(2)}  (${Math.abs(correlate(dtWks, gpWks)) < 0.3 ? 'good diversification' : Math.abs(correlate(dtWks, gpWks)) < 0.6 ? 'moderate' : 'highly correlated'})`);

  console.log("\n  ── Diversification check (week-by-week offset) ──");
  let v09SaveDT = 0, gpSaveV09 = 0, anyPositive = 0;
  for (const w of weeklyData) {
    if (w.v + w.d + w.g > 0) anyPositive++;
    if (w.d < 0 && w.v > Math.abs(w.d)) v09SaveDT++;
    if (w.v < 0 && (w.g + w.d) > Math.abs(w.v)) gpSaveV09++;
  }
  console.log(`     Weeks where ANY strategy was positive:   ${anyPositive}/${weeklyData.length} (${(anyPositive/weeklyData.length*100).toFixed(0)}%)`);
  console.log(`     Weeks where v09 saved a losing DT week:  ${v09SaveDT}`);
  console.log(`     Weeks where DT+GP saved a losing v09 wk: ${gpSaveV09}`);

  const mins = ((Date.now()-t0)/60000).toFixed(1);
  console.log(`\n  Total time: ${mins} min\n`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
