/**
 * backtest_portfolio_6mo.js — 6-month portfolio backtest: v09 + DT
 *
 * Setup:
 *   Total capital:  $20,000 USDT
 *   v09 allocation: $11,000  (4H crypto, 30 pairs, current strategy with fixes)
 *   DT allocation:  $9,000   (15min, 6 large-caps, OPTIMIZED config)
 *
 * v09 config (live bot's current state after fixes):
 *   - 4H bars on 30 isolation-scored mid-caps
 *   - 1.5× leverage (margin only — Option 1 sizing)
 *   - 0.8% risk per trade, SL 6.5%, TP 23%, trailing 19%
 *   - Rebound LONG removed (confirmed dead)
 *
 * DT config (OPTIMIZED from sweep — to be deployed):
 *   - 15min bars on current 6 large-caps (BTC, BNB, XRP, SUI, LTC, AVAX)
 *   - 5× leverage (margin only — Option 1 sizing)
 *   - 0.5% risk per trade, R:R=2.0, Hold=18 bars, ADX≥15
 *   - Maker orders OFF (taker market orders — proven better)
 *
 * Fees: 0.02% × 2 = 0.04% round-trip (MEXC taker)
 *
 * Output: week-by-week P&L (gross + net), cumulative, per strategy + portfolio total
 *
 * Run: node backtest_portfolio_6mo.js
 */

import "dotenv/config";

const MEXC_BASE  = "https://futures.mexc.com";
const DAYS       = 180;
const NOW_SEC    = Math.floor(Date.now() / 1000);
const START      = NOW_SEC - DAYS * 86400;
const FEE_PCT    = 0.0004; // 0.02% × 2

// ── Capital allocation ──────────────────────────────────────────────────────
const V09_BALANCE = 11000;
const DT_BALANCE  = 9000;
const TOTAL_START = V09_BALANCE + DT_BALANCE;  // $20,000

// ── v09 config ──────────────────────────────────────────────────────────────
const V09_PAIRS = [
  "KAIA_USDT","S_USDT","FILECOIN_USDT","AR_USDT","PLUME_USDT","FIDA_USDT","GMT_USDT","ENA_USDT","TIA_USDT","TURBO_USDT",
  "WIF_USDT","SHIB_USDT","BCH_USDT","VET_USDT","ONDO_USDT","THETA_USDT","HBAR_USDT","RUNE_USDT","IOTA_USDT","JUP_USDT",
  "FLUX_USDT","W_USDT","CATI_USDT","ZKSYNC_USDT","KAITO_USDT","WLD_USDT","AIXBT_USDT","LA_USDT","JASMY_USDT","HOME_USDT",
];
const V09 = { riskPct: 0.008, minRisk: 2, leverage: 1.5, slPct: 0.065, tpPct: 0.23, trailPct: 0.19, rsiOverbought: 80, brsiMin: 54, brsiMax: 65, lookback: 30, maxPositions: 10, warmupDays: 92 };

// ── DT config (OPTIMIZED) ───────────────────────────────────────────────────
const DT_PAIRS       = ["BTC_USDT", "BNB_USDT", "XRP_USDT", "SUI_USDT", "LTC_USDT", "AVAX_USDT"];
const DT_EMA50_PAIRS = new Set(["BTC_USDT", "SUI_USDT"]);
const DT = { riskPct: 0.005, leverage: 5, rrRatio: 2.0, maxHold: 18, maxSLPct: 0.012, adxMin: 15, maxPositions: 6 };

// ── Helpers ──────────────────────────────────────────────────────────────────
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
  while(cur<endSec){const end=Math.min(cur+chunk,endSec);const batch=await fetchChunk(symbol,intervalStr,cur,end);if(!batch.length){emptyRuns++;if(emptyRuns>=5)break;cur=end+barSecs;await sleep(120);continue;}emptyRuns=0;bars.push(...batch);cur=Math.floor(batch[batch.length-1].t/1000)+barSecs;await sleep(150);}
  const seen=new Set();return bars.filter(b=>{if(seen.has(b.t))return false;seen.add(b.t);return true;}).sort((a,b)=>a.t-b.t);
}
function ema(v,p){const k=2/(p+1),o=[v[0]];for(let i=1;i<v.length;i++)o.push(v[i]*k+o[i-1]*(1-k));return o;}
function sma(v,p){return v.map((_,i)=>i<p-1?null:v.slice(i-p+1,i+1).reduce((a,b)=>a+b,0)/p);}
function rsi(c,p=14){const o=new Array(c.length).fill(null);let g=0,l=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];d>0?g+=d:l-=d;}o[p]=l===0?100:100-100/(1+g/l);for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];if(d>0){g=(g*(p-1)+d)/p;l=l*(p-1)/p;}else{g=g*(p-1)/p;l=(l*(p-1)-d)/p;}o[i]=l===0?100:100-100/(1+g/l);}return o;}
function macd(c,f=12,s=26,sig=9){const fa=ema(c,f),sl=ema(c,s);const line=c.map((_,i)=>fa[i]-sl[i]);const signal=[line[0]];const k=2/(sig+1);for(let i=1;i<c.length;i++)signal.push(line[i]*k+signal[i-1]*(1-k));return{line,signal,hist:line.map((v,i)=>v-signal[i])};}
function adx(b,p=14){const n=b.length,o=new Array(n).fill(null),tr=[],pdm=[],ndm=[];for(let i=1;i<n;i++){const h=b[i].h,l=b[i].l,pc=b[i-1].c,ph=b[i-1].h,pl=b[i-1].l;tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));const up=h-ph,dn=pl-l;pdm.push(up>dn&&up>0?up:0);ndm.push(dn>up&&dn>0?dn:0);}if(tr.length<p*2)return o;let smTR=tr.slice(0,p).reduce((a,b)=>a+b,0),smP=pdm.slice(0,p).reduce((a,b)=>a+b,0),smN=ndm.slice(0,p).reduce((a,b)=>a+b,0);const dx=[],cDX=()=>{const pp=smTR?100*smP/smTR:0,nn=smTR?100*smN/smTR:0;return(pp+nn)?100*Math.abs(pp-nn)/(pp+nn):0;};dx.push(cDX());for(let i=p;i<tr.length;i++){smTR=smTR-smTR/p+tr[i];smP=smP-smP/p+pdm[i];smN=smN-smN/p+ndm[i];dx.push(cDX());}if(dx.length<p)return o;let v=dx.slice(0,p).reduce((a,b)=>a+b,0)/p;o[2*p-1]=v;for(let j=p;j<dx.length;j++){v=(v*(p-1)+dx[j])/p;o[j+p]=v;}return o;}
function dtSessionBias(bars){const bias=new Array(bars.length).fill(null);let oH=-Infinity,oL=Infinity,bld=false,conf=null,cur=null;for(let j=0;j<bars.length;j++){const h=new Date(bars[j].t).getUTCHours(),m=new Date(bars[j].t).getUTCMinutes();if([1,8,13].includes(h)&&m===0){bld=true;oH=bars[j].h;oL=bars[j].l;conf=null;cur=null;}else if(bld){oH=Math.max(oH,bars[j].h);oL=Math.min(oL,bars[j].l);conf={h:oH,l:oL};bld=false;}if(conf&&cur===null){if(bars[j].c>conf.h)cur="LONG";else if(bars[j].c<conf.l)cur="SHORT";}bias[j]=conf?cur:null;}return bias;}

// ── ISO week key ────────────────────────────────────────────────────────────
function weekKey(ts) {
  const d = new Date(ts);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThu = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstThuDayNr = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstThuDayNr + 3);
  const weekNum = 1 + Math.round((target - firstThu) / (7*86400000));
  return `${target.getUTCFullYear()}-W${String(weekNum).padStart(2,"0")}`;
}
function weekStartDate(wk) {
  const [yr, w] = wk.split("-W");
  const jan4 = new Date(Date.UTC(parseInt(yr), 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const week1Mon = new Date(jan4); week1Mon.setUTCDate(jan4.getUTCDate() - jan4Day);
  const monday = new Date(week1Mon); monday.setUTCDate(week1Mon.getUTCDate() + (parseInt(w)-1)*7);
  return monday.toISOString().slice(0,10);
}

// ─── v09 SIMULATOR (Option 1 sizing, no Rebound LONG) ──────────────────────

function v09Regime(i,closes,e21,e50,e200){if(!e200[i]||!e50[i]||!e21[i])return"neutral";const c=closes[i];let s=0;if(c>e200[i])s++;else s--;if(c>e50[i])s++;else s--;if(c>e21[i])s++;else s--;if(e21[i]>e50[i])s++;else s--;if(e50[i]>e200[i])s++;else s--;return s>=4?"bull":s<=-4?"bear":"neutral";}
function v09Risk(reg,dir,bal){const b=Math.max(bal*V09.riskPct,V09.minRisk);if(reg==="neutral")return b*0.75;const w=(reg==="bull"&&dir==="LONG")||(reg==="bear"&&dir==="SHORT");return w?b:b*0.5;}

function simulateV09(indicators) {
  let balance = V09_BALANCE, peak = balance, maxDD = 0;
  const positions = []; const trades = [];
  const allTs = new Set();
  for (const sym of V09_PAIRS) { const ind = indicators[sym]; if (!ind) continue; for (const b of ind.bars) if (b.t/1000 >= START) allTs.add(b.t); }
  const sortedTs = [...allTs].sort((a,b)=>a-b);

  // Build ts→idx map per symbol
  const tsMap = {};
  for (const sym of V09_PAIRS) { const ind = indicators[sym]; if (!ind) continue; tsMap[sym] = new Map(); for (let i = 0; i < ind.bars.length; i++) tsMap[sym].set(ind.bars[i].t, i); }

  function calcBullPct(ts) {
    let bulls=0,total=0;
    for (const sym of V09_PAIRS) { const ind = indicators[sym]; if (!ind) continue; const bi = tsMap[sym].get(ts); if (bi === undefined) continue; const r = v09Regime(bi, ind.closes, ind.e21, ind.e50, ind.e200); if (r==="bull") bulls++; total++; }
    return total ? (bulls/total)*100 : 0;
  }

  for (const ts of sortedTs) {
    // EXITS
    for (let p = positions.length-1; p >= 0; p--) {
      const pos = positions[p]; const ind = indicators[pos.sym]; if (!ind) continue;
      const bi = tsMap[pos.sym].get(ts); if (bi === undefined) continue;
      const bar = ind.bars[bi]; const isL = pos.dir==="LONG";
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
        const grossPnl = raw;  // Option 1: no × leverage
        const fee = pos.size * FEE_PCT;
        const netPnl = grossPnl - fee;
        balance += netPnl;
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak * 100; if (dd>maxDD) maxDD=dd;
        trades.push({ gross: grossPnl, fee, net: netPnl, exitTs: ts });
        positions.splice(p, 1);
      }
    }
    // ENTRIES
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
        // Breakout LONG
        const highN = Math.max(...ind.closes.slice(Math.max(0,i-V09.lookback),i));
        const trendUp = ind.e21[i]>ind.e50[i] && ind.e21[i]>ind.e21[i-1] && ind.e21[i-1]>ind.e21[i-3];
        const lBreak = c>highN && trendUp && rNow>=V09.brsiMin && rNow<=V09.brsiMax && vol>ind.vsma[i]*1.5;
        // Breakdown SHORT
        const wasOB = [1,2,3,4,5].some(k=>ind.rsi[i-k]!=null&&ind.rsi[i-k]>=65);
        const rsiBrk = rPrv>=58 && rNow<58, macdBrk = ind.macd.hist[i-1]>=0 && ind.macd.hist[i]<0;
        const sBreak = wasOB && (rsiBrk||macdBrk) && c<ind.e21[i] && rNow>35 && vol>ind.vsma[i]*1.2;
        // SHORT rebound (LONG rebound REMOVED)
        const wasOVB = [1,2,3].some(k=>ind.rsi[i-k]!=null&&ind.rsi[i-k]>=V09.rsiOverbought);
        const rsiTurnD = rPrv>=70 && rNow<70;
        const sRebound = wasOVB && rsiTurnD && reg!=="bull" && c<ind.e21[i]*1.08 && vol>ind.vsma[i]*1.0 && !sBreak;

        if (!lBreak && !sBreak && !sRebound) continue;
        let dir, isRebound;
        if (lBreak)        { dir="LONG";  isRebound=false; }
        else if (sBreak)   { dir="SHORT"; isRebound=false; }
        else               { dir="SHORT"; isRebound=true;  }
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
    trades.push({ gross: grossPnl, fee, net: netPnl, exitTs: lastBar.t });
  }
  return { balance, peak, maxDD, trades };
}

// ─── DT SIMULATOR (OPTIMIZED config) ──────────────────────────────────────────

function simulateDT(indicators) {
  let balance = DT_BALANCE, peak = balance, maxDD = 0;
  const positions = []; const trades = [];
  const allTs = new Set();
  for (const sym of DT_PAIRS) { const ind = indicators[sym]; if (!ind) continue; for (const b of ind.bars) if (b.t/1000 >= START) allTs.add(b.t); }
  const sortedTs = [...allTs].sort((a,b)=>a-b);

  const tsMap = {};
  for (const sym of DT_PAIRS) { const ind = indicators[sym]; if (!ind) continue; tsMap[sym] = new Map(); for (let i = 0; i < ind.bars.length; i++) tsMap[sym].set(ind.bars[i].t, i); }

  for (const ts of sortedTs) {
    // EXITS
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
        if (balance>peak) peak = balance;
        const dd = (peak-balance)/peak*100; if (dd>maxDD) maxDD=dd;
        trades.push({ gross: grossPnl, fee, net: netPnl, exitTs: ts });
        positions.splice(i, 1);
      }
    }
    // ENTRIES
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
    trades.push({ gross: grossPnl, fee, net: netPnl, exitTs: lastBar.t });
  }
  return { balance, peak, maxDD, trades };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const startDate = new Date(START*1000).toISOString().slice(0,10);
  const endDate = new Date().toISOString().slice(0,10);

  console.log("╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  6-MONTH PORTFOLIO BACKTEST — v09 + DT                             ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`  Period:    ${startDate} → ${endDate}  (${DAYS} days)`);
  console.log(`  Capital:   $${TOTAL_START.toLocaleString()} total  |  v09 $${V09_BALANCE.toLocaleString()}  |  DT $${DT_BALANCE.toLocaleString()}`);
  console.log(`  Fees:      0.04% round-trip (MEXC taker)`);
  console.log(`  v09:       30 isolation-scored alts, 4H, current strategy (Option 1 sizing, no Rebound LONG)`);
  console.log(`  DT:        6 large-caps, 15min, OPTIMIZED (R:R=2, Hold=18, Risk=0.5%, ADX=15, taker)`);

  console.log("\n[1/2] Fetching v09 4H data (30 pairs)…");
  const v09Data = {};
  const v09FetchStart = NOW_SEC - (DAYS + V09.warmupDays) * 86400;
  for (const sym of V09_PAIRS) {
    process.stdout.write(`  ${sym}…`);
    v09Data[sym] = await fetchAllBars(sym, "Hour4", 4*3600, v09FetchStart, NOW_SEC);
    process.stdout.write(`\r  ${sym.padEnd(20)} ${v09Data[sym].length} bars ✓\n`);
    await sleep(130);
  }
  const v09Ind = {};
  for (const sym of V09_PAIRS) {
    const bars = v09Data[sym]; if (bars.length < 210) continue;
    const closes = bars.map(b=>b.c), vols=bars.map(b=>b.v);
    v09Ind[sym] = { bars, closes, vols, e21: ema(closes,21), e50: ema(closes,50), e200: ema(closes,200), rsi: rsi(closes,14), macd: macd(closes), vsma: sma(vols,20) };
  }

  console.log("\n[2/2] Fetching DT 15min data (6 pairs)…");
  const dtData = {};
  for (const sym of DT_PAIRS) {
    process.stdout.write(`  ${sym}…`);
    dtData[sym] = await fetchAllBars(sym, "Min15", 15*60, START - 80*15*60, NOW_SEC);
    process.stdout.write(`\r  ${sym.padEnd(20)} ${dtData[sym].length} bars ✓\n`);
    await sleep(130);
  }
  const dtInd = {};
  for (const sym of DT_PAIRS) {
    const bars = dtData[sym]; if (bars.length < 80) continue;
    const closes = bars.map(b=>b.c), vols = bars.map(b=>b.v);
    dtInd[sym] = { bars, closes, vols, e21: ema(closes,21), e50: ema(closes,50), rsi: rsi(closes,14), vsma: sma(vols,20), adx: adx(bars,14), bias: dtSessionBias(bars) };
  }

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Running simulations…");
  console.log("══════════════════════════════════════════════════════════════");
  process.stdout.write("  v09…"); const v09Res = simulateV09(v09Ind);
  console.log(` $${v09Res.balance.toFixed(0)} | ${v09Res.trades.length} trades`);
  process.stdout.write("  DT…"); const dtRes = simulateDT(dtInd);
  console.log(` $${dtRes.balance.toFixed(0)} | ${dtRes.trades.length} trades`);

  // ── Group by week ─────────────────────────────────────────────────────────
  function bucket(trades) {
    const wks = {};
    for (const t of trades) {
      const wk = weekKey(t.exitTs);
      if (!wks[wk]) wks[wk] = { gross: 0, fee: 0, net: 0, trades: 0 };
      wks[wk].gross += t.gross; wks[wk].fee += t.fee; wks[wk].net += t.net; wks[wk].trades += 1;
    }
    return wks;
  }
  const v09Wks = bucket(v09Res.trades);
  const dtWks  = bucket(dtRes.trades);
  const allWks = new Set([...Object.keys(v09Wks), ...Object.keys(dtWks)]);
  const sorted = [...allWks].sort();

  console.log("\n\n╔════════════════════════════════════════════════════════════════════════════════════════════════════════════╗");
  console.log("║  WEEK-BY-WEEK P&L (GROSS + FEES + NET)                                                                    ║");
  console.log("╚════════════════════════════════════════════════════════════════════════════════════════════════════════════╝");
  console.log(`\n  ${"Week".padEnd(11)} ${"Date".padEnd(11)} │ ${"v09 Gross".padStart(10)} ${"Fee".padStart(7)} ${"Net".padStart(10)} │ ${"DT Gross".padStart(10)} ${"Fee".padStart(7)} ${"Net".padStart(10)} │ ${"TOTAL NET".padStart(11)} ${"Cum.".padStart(11)}`);
  console.log(`  ${"─".repeat(11)} ${"─".repeat(11)} ┼ ${"─".repeat(10)} ${"─".repeat(7)} ${"─".repeat(10)} ┼ ${"─".repeat(10)} ${"─".repeat(7)} ${"─".repeat(10)} ┼ ${"─".repeat(11)} ${"─".repeat(11)}`);
  let cumNet = 0;
  const fmt = n => n === 0 ? "—" : `${n>=0?'+':''}$${n.toFixed(0)}`;
  for (const wk of sorted) {
    const v = v09Wks[wk] || { gross:0, fee:0, net:0 };
    const d = dtWks[wk]  || { gross:0, fee:0, net:0 };
    const totalNet = v.net + d.net;
    cumNet += totalNet;
    console.log(`  ${wk.padEnd(11)} ${weekStartDate(wk).padEnd(11)} │ ${fmt(v.gross).padStart(10)} ${("$"+v.fee.toFixed(0)).padStart(7)} ${fmt(v.net).padStart(10)} │ ${fmt(d.gross).padStart(10)} ${("$"+d.fee.toFixed(0)).padStart(7)} ${fmt(d.net).padStart(10)} │ ${fmt(totalNet).padStart(11)} ${fmt(cumNet).padStart(11)}`);
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  const v09Gross = Object.values(v09Wks).reduce((s,w)=>s+w.gross,0);
  const v09Fee   = Object.values(v09Wks).reduce((s,w)=>s+w.fee,0);
  const v09Net   = Object.values(v09Wks).reduce((s,w)=>s+w.net,0);
  const dtGross  = Object.values(dtWks).reduce((s,w)=>s+w.gross,0);
  const dtFee    = Object.values(dtWks).reduce((s,w)=>s+w.fee,0);
  const dtNet    = Object.values(dtWks).reduce((s,w)=>s+w.net,0);
  const totalGross = v09Gross + dtGross;
  const totalFee   = v09Fee + dtFee;
  const totalNet   = v09Net + dtNet;
  console.log(`  ${"─".repeat(11)} ${"─".repeat(11)} ┼ ${"─".repeat(10)} ${"─".repeat(7)} ${"─".repeat(10)} ┼ ${"─".repeat(10)} ${"─".repeat(7)} ${"─".repeat(10)} ┼ ${"─".repeat(11)} ${"─".repeat(11)}`);
  console.log(`  ${"TOTAL".padEnd(23)} │ ${fmt(v09Gross).padStart(10)} ${("$"+v09Fee.toFixed(0)).padStart(7)} ${fmt(v09Net).padStart(10)} │ ${fmt(dtGross).padStart(10)} ${("$"+dtFee.toFixed(0)).padStart(7)} ${fmt(dtNet).padStart(10)} │ ${fmt(totalNet).padStart(11)}`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  PORTFOLIO SUMMARY                                                  ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`\n  ── v09 (4H crypto) ──`);
  console.log(`     Start:        $${V09_BALANCE.toLocaleString()}`);
  console.log(`     End balance:  $${v09Res.balance.toFixed(0)}`);
  const v09Ret = (v09Res.balance - V09_BALANCE) / V09_BALANCE * 100;
  console.log(`     Return:       ${v09Ret>=0?'+':''}${v09Ret.toFixed(1)}%`);
  console.log(`     Gross P&L:    ${fmt(v09Gross)}`);
  console.log(`     Fees paid:    $${v09Fee.toFixed(0)}`);
  console.log(`     Net P&L:      ${fmt(v09Net)}`);
  console.log(`     Max DD:       ${v09Res.maxDD.toFixed(1)}%`);
  console.log(`     Trades:       ${v09Res.trades.length}`);

  console.log(`\n  ── DT (15min crypto, OPTIMIZED) ──`);
  console.log(`     Start:        $${DT_BALANCE.toLocaleString()}`);
  console.log(`     End balance:  $${dtRes.balance.toFixed(0)}`);
  const dtRet = (dtRes.balance - DT_BALANCE) / DT_BALANCE * 100;
  console.log(`     Return:       ${dtRet>=0?'+':''}${dtRet.toFixed(1)}%`);
  console.log(`     Gross P&L:    ${fmt(dtGross)}`);
  console.log(`     Fees paid:    $${dtFee.toFixed(0)}`);
  console.log(`     Net P&L:      ${fmt(dtNet)}`);
  console.log(`     Max DD:       ${dtRes.maxDD.toFixed(1)}%`);
  console.log(`     Trades:       ${dtRes.trades.length}`);

  console.log(`\n  ── PORTFOLIO TOTAL ──`);
  const portfolioEnd = v09Res.balance + dtRes.balance;
  const portRet = (portfolioEnd - TOTAL_START) / TOTAL_START * 100;
  console.log(`     Start:        $${TOTAL_START.toLocaleString()}`);
  console.log(`     End balance:  $${portfolioEnd.toFixed(0)}`);
  console.log(`     Return:       ${portRet>=0?'+':''}${portRet.toFixed(1)}%`);
  console.log(`     Gross P&L:    ${fmt(totalGross)}`);
  console.log(`     Fees paid:    $${totalFee.toFixed(0)}`);
  console.log(`     Net P&L:      ${fmt(totalNet)}`);
  console.log(`     Annualized:   ~${(portRet * 2).toFixed(0)}%`);

  // Week stats
  const weekNets = sorted.map(wk => {
    const v = v09Wks[wk]?.net ?? 0, d = dtWks[wk]?.net ?? 0;
    return v + d;
  });
  const winWks = weekNets.filter(n=>n>0).length;
  const lossWks = weekNets.filter(n=>n<0).length;
  console.log(`\n  ── Week consistency ──`);
  console.log(`     Total weeks:   ${sorted.length}`);
  console.log(`     Winning weeks: ${winWks}  (${(winWks/sorted.length*100).toFixed(0)}%)`);
  console.log(`     Losing weeks:  ${lossWks}  (${(lossWks/sorted.length*100).toFixed(0)}%)`);
  console.log(`     Best week:     ${fmt(Math.max(...weekNets))}`);
  console.log(`     Worst week:    ${fmt(Math.min(...weekNets))}`);
  console.log(`     Avg per week:  ${fmt(totalNet/sorted.length)}`);

  const mins = ((Date.now()-t0)/60000).toFixed(1);
  console.log(`\n  Backtest time: ${mins} min\n`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
