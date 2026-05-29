/**
 * backtest_enhanced.js — Side-by-side comparison of original vs enhanced strategies
 *
 * Enhanced filters:
 *   v09  + Fear & Greed Index  (Alternative.me — free, no key)
 *   DT   + MEXC Funding Rates  (built-in MEXC API, no extra key)
 *   ORB  — unchanged (Unusual Whales requires live validation, not backtest)
 *
 * Fear & Greed rules on v09:
 *   0–24  Extreme Fear  → block ALL longs, shorts allowed
 *   25–44 Fear          → longs at 50% risk, shorts normal
 *   45–74 Neutral/Greed → full risk both directions
 *   75–100 Extreme Greed → longs normal, block rebound shorts (market too extended)
 *
 * Funding rate rules on DT (per-symbol, 8h settlement):
 *   rate > +0.05% → market overcrowded LONG → block new LONG entries
 *   rate < -0.03% → market overcrowded SHORT → block new SHORT entries
 *   between        → no filter applied
 *
 * Run: node backtest_enhanced.js
 */

import "dotenv/config";

const MEXC_BASE = "https://futures.mexc.com";
const DAYS      = 150;
const NOW_SEC   = Math.floor(Date.now() / 1000);
const START_150 = NOW_SEC - DAYS * 86400;

// ──────────────────────────────────────────────────────────────────────────────
// DATA FETCHING
// ──────────────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchChunk(symbol, intervalStr, startSec, endSec) {
  const url = `${MEXC_BASE}/api/v1/contract/kline/${symbol}?interval=${intervalStr}&start=${startSec}&end=${endSec}`;
  try {
    const res  = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return [];
    const json = await res.json();
    if (!json.data?.time?.length) return [];
    const { time, open, close, high, low, vol } = json.data;
    return time.map((t, i) => ({
      t: t*1000, o: +open[i], c: +close[i], h: +high[i], l: +low[i], v: +vol[i],
    })).sort((a,b) => a.t - b.t);
  } catch { return []; }
}

async function fetchAllBars(symbol, intervalStr, barSecs, startSec, endSec) {
  const bars = []; const chunk = 1800 * barSecs;
  let cur = startSec, emptyRuns = 0;
  while (cur < endSec) {
    const end   = Math.min(cur + chunk, endSec);
    const batch = await fetchChunk(symbol, intervalStr, cur, end);
    if (!batch.length) { emptyRuns++; if (emptyRuns >= 5) break; cur = end + barSecs; await sleep(120); continue; }
    emptyRuns = 0; bars.push(...batch);
    cur = Math.floor(batch[batch.length-1].t/1000) + barSecs;
    await sleep(180);
  }
  const seen = new Set();
  return bars.filter(b => { if (seen.has(b.t)) return false; seen.add(b.t); return true; })
             .sort((a,b) => a.t - b.t);
}

// ── Fear & Greed (Alternative.me) ────────────────────────────────────────────

async function fetchFearGreed() {
  const res  = await fetch('https://api.alternative.me/fng/?limit=200&format=json', { signal: AbortSignal.timeout(10000) });
  const json = await res.json();
  // Returns newest first — build a map of dateKey → value
  const map = {};
  for (const d of json.data) {
    const key = new Date(d.timestamp * 1000).toISOString().slice(0, 10);
    map[key] = parseInt(d.value);
  }
  return map; // { "2026-05-27": 25, ... }
}

function fngLabel(v) {
  if (v <= 24) return "Extreme Fear";
  if (v <= 44) return "Fear";
  if (v <= 74) return "Neutral/Greed";
  return "Extreme Greed";
}

// F&G risk multiplier for v09 LONG entries
function fngLongMultiplier(fng) {
  if (fng <= 24) return 0;    // Extreme Fear → block longs
  if (fng <= 44) return 0.5;  // Fear         → half risk
  return 1;                   // Neutral/Greed/Extreme Greed → full risk
}

// F&G multiplier for v09 SHORT entries
function fngShortMultiplier(fng) {
  if (fng >= 75) return 0;   // Extreme Greed → block rebound shorts
  return 1;
}

// ── MEXC Funding Rates ────────────────────────────────────────────────────────

async function fetchFundingRateHistory(symbol) {
  // Fetch all pages (1619 records / 20 per page ≈ 81 pages)
  const allRates = [];
  let page = 1;
  while (true) {
    const res  = await fetch(`${MEXC_BASE}/api/v1/contract/funding_rate/history?symbol=${symbol}&page_num=${page}&page_size=100`, { signal: AbortSignal.timeout(15000) });
    const json = await res.json();
    if (!json.data?.resultList?.length) break;
    allRates.push(...json.data.resultList);
    if (page >= json.data.totalPage) break;
    page++;
    await sleep(150);
  }
  // Build map: settleTime (ms) → rate
  const map = {};
  for (const r of allRates) map[r.settleTime] = r.fundingRate;
  return map;
}

// Get the most recent funding rate at or before a given timestamp
function getFundingRateAt(rateMap, timestampMs) {
  // Funding settles at 00:00, 08:00, 16:00 UTC
  // Find the latest settle time ≤ timestampMs
  const settleInterval = 8 * 3600 * 1000;
  const rounded = Math.floor(timestampMs / settleInterval) * settleInterval;
  // Search backwards up to 3 settlement periods
  for (let offset = 0; offset <= 2; offset++) {
    const t = rounded - offset * settleInterval;
    if (rateMap[t] !== undefined) return rateMap[t];
  }
  return 0; // default neutral
}

// Funding rate thresholds
const FR_BLOCK_LONG  =  0.0005; // +0.05% per 8h → longs overcrowded
const FR_BLOCK_SHORT = -0.0003; // -0.03% per 8h → shorts overcrowded

// ──────────────────────────────────────────────────────────────────────────────
// INDICATORS (shared)
// ──────────────────────────────────────────────────────────────────────────────

function emaSeries(vals, p) {
  const k = 2/(p+1), out = [vals[0]];
  for (let i=1;i<vals.length;i++) out.push(vals[i]*k+out[i-1]*(1-k));
  return out;
}
function smaSeries(vals, p) {
  return vals.map((_,i) => i<p-1?null:vals.slice(i-p+1,i+1).reduce((a,b)=>a+b,0)/p);
}
function rsiSmoothed(closes, period=14) {
  const out = new Array(closes.length).fill(null);
  let g=0,l=0;
  for(let i=1;i<=period;i++){const d=closes[i]-closes[i-1];d>0?g+=d:l-=d;}
  out[period]=l===0?100:100-100/(1+g/l);
  for(let i=period+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    if(d>0){g=(g*(period-1)+d)/period;l=l*(period-1)/period;}
    else   {g=g*(period-1)/period;l=(l*(period-1)-d)/period;}
    out[i]=l===0?100:100-100/(1+g/l);
  }
  return out;
}
function macdSeries(closes,f=12,s=26,sig=9) {
  const fast=emaSeries(closes,f),slow=emaSeries(closes,s);
  const line=closes.map((_,i)=>fast[i]-slow[i]);
  const signal=[line[0]];const k=2/(sig+1);
  for(let i=1;i<closes.length;i++) signal.push(line[i]*k+signal[i-1]*(1-k));
  return{line,signal,hist:line.map((v,i)=>v-signal[i])};
}
function adxSeries(bars,period=14) {
  const n=bars.length,out=new Array(n).fill(null),tr=[],pdm=[],ndm=[];
  for(let i=1;i<n;i++){
    const h=bars[i].h,l=bars[i].l,pc=bars[i-1].c,ph=bars[i-1].h,pl=bars[i-1].l;
    tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
    const up=h-ph,dn=pl-l;
    pdm.push(up>dn&&up>0?up:0);ndm.push(dn>up&&dn>0?dn:0);
  }
  if(tr.length<period*2) return out;
  let smTR=tr.slice(0,period).reduce((a,b)=>a+b,0);
  let smP=pdm.slice(0,period).reduce((a,b)=>a+b,0);
  let smN=ndm.slice(0,period).reduce((a,b)=>a+b,0);
  const dx=[],cDX=()=>{const p=smTR?100*smP/smTR:0,nn=smTR?100*smN/smTR:0;return(p+nn)?100*Math.abs(p-nn)/(p+nn):0;};
  dx.push(cDX());
  for(let i=period;i<tr.length;i++){smTR=smTR-smTR/period+tr[i];smP=smP-smP/period+pdm[i];smN=smN-smN/period+ndm[i];dx.push(cDX());}
  if(dx.length<period) return out;
  let adxVal=dx.slice(0,period).reduce((a,b)=>a+b,0)/period;
  out[2*period-1]=adxVal;
  for(let j=period;j<dx.length;j++){adxVal=(adxVal*(period-1)+dx[j])/period;out[j+period]=adxVal;}
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// V09 CONFIG & SIGNAL
// ──────────────────────────────────────────────────────────────────────────────

const V09_PAIRS = [
  "KAIA_USDT","S_USDT","FILECOIN_USDT","AR_USDT","PLUME_USDT",
  "FIDA_USDT","GMT_USDT","ENA_USDT","TIA_USDT","TURBO_USDT",
  "WIF_USDT","SHIB_USDT","BCH_USDT","VET_USDT","ONDO_USDT",
  "THETA_USDT","HBAR_USDT","RUNE_USDT","IOTA_USDT","JUP_USDT",
  "FLUX_USDT","W_USDT","CATI_USDT","ZKSYNC_USDT","KAITO_USDT",
  "WLD_USDT","AIXBT_USDT","LA_USDT","JASMY_USDT","HOME_USDT",
];
const V09 = {
  startBalance:10000,riskPct:0.008,minRisk:2,leverage:1.5,
  slPct:0.065,tpPct:0.23,trailPct:0.19,rebSlPct:0.035,rebTpPct:0.22,
  rsiOversold:20,rsiOverbought:80,brsiMin:54,brsiMax:65,lookback:30,maxPositions:10,warmupDays:92,
};

function v09Regime(i,closes,e21,e50,e200) {
  if(!e200[i]||!e50[i]||!e21[i]) return "neutral";
  const c=closes[i];let score=0;
  if(c>e200[i])score++;else score--;if(c>e50[i])score++;else score--;
  if(c>e21[i])score++;else score--;if(e21[i]>e50[i])score++;else score--;
  if(e50[i]>e200[i])score++;else score--;
  return score>=4?"bull":score<=-4?"bear":"neutral";
}
function v09Risk(reg,dir,balance) {
  const base=Math.max(balance*V09.riskPct,V09.minRisk);
  if(reg==="neutral") return base*0.75;
  const wt=(reg==="bull"&&dir==="LONG")||(reg==="bear"&&dir==="SHORT");
  return wt?base:base*0.5;
}
function v09Signal(i,closes,vols,e21,e50,e200,rsi,mc,vsma) {
  if(i<22||!rsi[i]||!rsi[i-1]||!vsma[i]||!e200[i]) return null;
  const c=closes[i],rNow=rsi[i],rPrv=rsi[i-1],vol=vols[i],reg=v09Regime(i,closes,e21,e50,e200);
  const highN=Math.max(...closes.slice(Math.max(0,i-V09.lookback),i));
  const trendUp=e21[i]>e50[i]&&e21[i]>e21[i-1]&&e21[i-1]>e21[i-3];
  const lBreak=c>highN&&trendUp&&rNow>=V09.brsiMin&&rNow<=V09.brsiMax&&vol>vsma[i]*1.5;
  const wasOB=[1,2,3,4,5].some(k=>rsi[i-k]!=null&&rsi[i-k]>=65);
  const rsiBrk=rPrv>=58&&rNow<58;const macdBrk=mc.hist[i-1]>=0&&mc.hist[i]<0;
  const sBreak=wasOB&&(rsiBrk||macdBrk)&&c<e21[i]&&rNow>35&&vol>vsma[i]*1.2;
  const wasOS=[1,2,3].some(k=>rsi[i-k]!=null&&rsi[i-k]<=V09.rsiOversold);
  const rsiTurnU=rPrv<=30&&rNow>30;
  const lRebound=wasOS&&rsiTurnU&&reg==="bull"&&c>e21[i]*0.92&&vol>vsma[i]*1.0&&!lBreak;
  const wasOVB=[1,2,3].some(k=>rsi[i-k]!=null&&rsi[i-k]>=V09.rsiOverbought);
  const rsiTurnD=rPrv>=70&&rNow<70;
  const sRebound=wasOVB&&rsiTurnD&&reg!=="bull"&&c<e21[i]*1.08&&vol>vsma[i]*1.0&&!sBreak;
  return{lBreak,sBreak,lRebound,sRebound,reg};
}

// ──────────────────────────────────────────────────────────────────────────────
// DT CONFIG & SIGNAL
// ──────────────────────────────────────────────────────────────────────────────

const DT_PAIRS   = ["BTC_USDT","BNB_USDT","XRP_USDT","SUI_USDT","LTC_USDT","AVAX_USDT"];
const DT_EMA50_PAIRS = new Set(["BTC_USDT","SUI_USDT"]);
const DT = { startBalance:8750, riskPct:0.008, leverage:5, rrRatio:1.3, maxHold:12, maxSLPct:0.012, maxPositions:6 };

function dtSessionBias(bars) {
  const bias=new Array(bars.length).fill(null);
  let orbH=-Infinity,orbL=Infinity,building=false,confirmed=null,curBias=null;
  for(let j=0;j<bars.length;j++){
    const h=new Date(bars[j].t).getUTCHours(),m=new Date(bars[j].t).getUTCMinutes();
    if([1,8,13].includes(h)&&m===0){building=true;orbH=bars[j].h;orbL=bars[j].l;confirmed=null;curBias=null;}
    else if(building){orbH=Math.max(orbH,bars[j].h);orbL=Math.min(orbL,bars[j].l);confirmed={h:orbH,l:orbL};building=false;}
    if(confirmed&&curBias===null){
      if(bars[j].c>confirmed.h) curBias="LONG";
      else if(bars[j].c<confirmed.l) curBias="SHORT";
    }
    bias[j]=confirmed?curBias:null;
  }
  return bias;
}

// ──────────────────────────────────────────────────────────────────────────────
// SIMULATION ENGINE (shared for both original and enhanced)
// ──────────────────────────────────────────────────────────────────────────────

async function runV09Sim(label, indMap, fngMap) {
  const useFilter = !!fngMap;
  let balance=V09.startBalance,peak=balance,maxDD=0;
  const positions=[],trades=[];

  const allTs = new Set();
  for (const sym of V09_PAIRS) {
    const ind=indMap[sym];if(!ind) continue;
    for (const b of ind.bars) if(b.t/1000>=START_150) allTs.add(b.t);
  }
  const sortedTs=[...allTs].sort((a,b)=>a-b);

  const bullPctAt = (ts) => {
    let bulls=0, total=0;
    for (const sym of V09_PAIRS) {
      const ind=indMap[sym];if(!ind) continue;
      const bi=ind.bars.findIndex(b=>b.t===ts);if(bi<0) continue;
      const r=v09Regime(bi-1,ind.closes,ind.e21,ind.e50,ind.e200);
      total++;if(r==="bull") bulls++;
    }
    return total>0?bulls/total*100:50;
  };

  for (const ts of sortedTs) {
    // Exits
    for (let p=positions.length-1;p>=0;p--) {
      const pos=positions[p];
      const ind=indMap[pos.sym];if(!ind) continue;
      const bi=ind.bars.findIndex(b=>b.t===ts);if(bi<0) continue;
      const bar=ind.bars[bi],isL=pos.dir==="LONG";
      let pnl=0,exitReason=null,exitPrice=null;
      if(pos.trailing){
        if(isL&&bar.h>pos.trailHigh){pos.trailHigh=bar.h;pos.sl=bar.h*(1-V09.trailPct);}
        else if(!isL&&bar.l<pos.trailLow){pos.trailLow=bar.l;pos.sl=bar.l*(1+V09.trailPct);}
        if(isL?bar.l<=pos.sl:bar.h>=pos.sl){exitReason="TRAIL_SL";exitPrice=pos.sl;}
      } else {
        const hitSL=isL?bar.l<=pos.sl:bar.h>=pos.sl;
        const hitTP=isL?bar.h>=pos.tp:bar.l<=pos.tp;
        if(hitSL&&hitTP){exitReason="SL";exitPrice=pos.sl;}
        else if(hitSL){exitReason="SL";exitPrice=pos.sl;}
        else if(hitTP&&pos.noTrail){exitReason="TP";exitPrice=pos.tp;}
        else if(hitTP){pos.trailing=true;pos.trailHigh=isL?pos.tp:Infinity;pos.trailLow=isL?0:pos.tp;pos.sl=isL?pos.tp*(1-V09.trailPct):pos.tp*(1+V09.trailPct);}
      }
      if(exitReason){
        const raw=isL?(exitPrice-pos.entryPrice)/pos.entryPrice*pos.size:(pos.entryPrice-exitPrice)/pos.entryPrice*pos.size;
        pnl=raw*V09.leverage;balance+=pnl;
        if(balance>peak)peak=balance;const dd=(peak-balance)/peak*100;if(dd>maxDD)maxDD=dd;
        trades.push({sym:pos.sym,dir:pos.dir,pnl,reason:exitReason});positions.splice(p,1);
      }
    }

    // Entries
    if(positions.length<V09.maxPositions) {
      const bullPct=bullPctAt(ts);
      const trailActive=bullPct>=60;
      const dateKey=new Date(ts).toISOString().slice(0,10);
      const fng=fngMap?.[dateKey]??50; // default neutral if not available

      for (const sym of V09_PAIRS) {
        if(positions.some(p=>p.sym===sym)) continue;
        const ind=indMap[sym];if(!ind) continue;
        const bi=ind.bars.findIndex(b=>b.t===ts);if(bi<1) continue;
        const i=bi-1;
        const sig=v09Signal(i,ind.closes,ind.vols,ind.e21,ind.e50,ind.e200,ind.rsi,ind.macd,ind.vsma);
        if(!sig) continue;
        const hasSig=sig.lBreak||sig.sBreak||sig.lRebound||sig.sRebound;
        if(!hasSig) continue;

        let dir,isRebound;
        if(sig.lBreak){dir="LONG";isRebound=false;}
        else if(sig.sBreak){dir="SHORT";isRebound=false;}
        else if(sig.lRebound){dir="LONG";isRebound=true;}
        else{dir="SHORT";isRebound=true;}

        // ── Fear & Greed filter ──────────────────────────────────────────────
        if(useFilter) {
          if(dir==="LONG"  && fngLongMultiplier(fng)  === 0) continue;
          if(dir==="SHORT" && fngShortMultiplier(fng) === 0) continue;
        }

        let riskUSD=v09Risk(sig.reg,dir,balance);
        if(useFilter) {
          if(dir==="LONG")  riskUSD *= fngLongMultiplier(fng);
          if(dir==="SHORT") riskUSD *= fngShortMultiplier(fng);
        }

        const slPct=isRebound?V09.rebSlPct:V09.slPct;
        const tpPct=isRebound?V09.rebTpPct:V09.tpPct;
        const noTrail=!trailActive;
        const entryP=ind.bars[bi].o;
        const size=riskUSD/slPct;
        const isL=dir==="LONG";
        const sl=isL?entryP*(1-slPct):entryP*(1+slPct);
        const tp=isL?entryP*(1+tpPct):entryP*(1-tpPct);
        positions.push({sym,dir,entryPrice:entryP,sl,tp,size,riskUSD,trailing:false,noTrail,trailHigh:isL?tp:Infinity,trailLow:isL?0:tp});
        if(positions.length>=V09.maxPositions) break;
      }
    }
  }

  for(const pos of positions){
    const ind=indMap[pos.sym];if(!ind) continue;
    const lastBar=ind.bars[ind.bars.length-1];
    const isL=pos.dir==="LONG";
    const raw=isL?(lastBar.c-pos.entryPrice)/pos.entryPrice*pos.size:(pos.entryPrice-lastBar.c)/pos.entryPrice*pos.size;
    balance+=raw*V09.leverage;
    trades.push({sym:pos.sym,dir:pos.dir,pnl:raw*V09.leverage,reason:"OPEN@END"});
  }

  const wins=trades.filter(t=>t.pnl>0),losses=trades.filter(t=>t.pnl<0);
  return {label,start:V09.startBalance,end:balance,pnl:balance-V09.startBalance,
          trades:trades.length,wins:wins.length,losses:losses.length,
          winRate:trades.length?(wins.length/trades.length*100).toFixed(1):"0",
          maxDD,avgWin:wins.length?wins.reduce((s,t)=>s+t.pnl,0)/wins.length:0,
          avgLoss:losses.length?losses.reduce((s,t)=>s+t.pnl,0)/losses.length:0,
          pf:losses.length?Math.abs(wins.reduce((s,t)=>s+t.pnl,0)/losses.reduce((s,t)=>s+t.pnl,0)):Infinity};
}

async function runDTSim(label, dtIndMap, fundingMaps) {
  const useFilter = !!fundingMaps;
  let balance=DT.startBalance,peak=balance,maxDD=0;
  const positions=[],trades=[];

  const allTs=new Set();
  for(const sym of DT_PAIRS){const ind=dtIndMap[sym];if(!ind) continue;for(const b of ind.bars) if(b.t/1000>=START_150) allTs.add(b.t);}
  const sortedTs=[...allTs].sort((a,b)=>a-b);

  for(const ts of sortedTs){
    // Exits
    for(let p=positions.length-1;p>=0;p--){
      const pos=positions[p];const ind=dtIndMap[pos.sym];if(!ind) continue;
      const bi=ind.bars.findIndex(b=>b.t===ts);if(bi<0) continue;
      const bar=ind.bars[bi],isL=pos.dir==="LONG";
      const barsHeld=bi-pos.entryBarIdx;
      const hitSL=isL?bar.l<=pos.sl:bar.h>=pos.sl;
      const hitTP=isL?bar.h>=pos.tp:bar.l<=pos.tp;
      const timeExit=barsHeld>=DT.maxHold;
      let exitReason=null,exitPrice=null;
      if(hitSL&&hitTP){exitReason="SL";exitPrice=pos.sl;}
      else if(hitSL){exitReason="SL";exitPrice=pos.sl;}
      else if(hitTP){exitReason="TP";exitPrice=pos.tp;}
      else if(timeExit){exitReason="TIME";exitPrice=bar.c;}
      if(exitReason){
        const pnl=((isL?exitPrice-pos.entry:pos.entry-exitPrice)/pos.entry)*pos.sizeUSD;
        balance+=pnl;if(balance>peak)peak=balance;
        const dd=(peak-balance)/peak*100;if(dd>maxDD)maxDD=dd;
        trades.push({sym:pos.sym,dir:pos.dir,pnl,reason:exitReason});positions.splice(p,1);
      }
    }

    // Entries
    if(positions.length<DT.maxPositions){
      for(const sym of DT_PAIRS){
        if(positions.some(p=>p.sym===sym)) continue;
        const ind=dtIndMap[sym];if(!ind) continue;
        const bi=ind.bars.findIndex(b=>b.t===ts);if(bi<3) continue;
        const i=bi-1,prev=i-1;
        if(!ind.rsi[i]||!ind.vsma[i]||!ind.adx[i]||ind.adx[i]<20) continue;
        const entryHour=new Date(ind.bars[i].t).getUTCHours();
        if(entryHour>=1&&entryHour<8) continue;
        const bias=ind.bias[i];if(!bias) continue;
        const c=ind.bars[i],p2=ind.bars[prev],r=ind.rsi[i],volOk=c.v>ind.vsma[i]*1.2;
        const e50Up=ind.e50[i]>ind.e50[i-4],e50Dn=ind.e50[i]<ind.e50[i-4];
        const longRsi=r>=40&&r<65,shortRsi=r>35&&r<=60;
        let sig=null;
        if(bias==="LONG"){
          if(e50Up&&longRsi&&volOk&&p2.c<ind.e21[prev]&&c.c>ind.e21[i]){
            const swL=Math.min(...ind.bars.slice(Math.max(0,i-3),i+1).map(x=>x.l));
            const risk=c.c-swL;if(risk>0&&risk/c.c<DT.maxSLPct) sig={dir:"LONG",entry:c.c,sl:swL,tp:c.c+risk*DT.rrRatio,signal:"EMA21"};
          }
          if(!sig&&DT_EMA50_PAIRS.has(sym)&&e50Up&&r>=38&&r<62&&volOk&&p2.c<ind.e50[prev]&&c.c>ind.e50[i]){
            const swL=Math.min(...ind.bars.slice(Math.max(0,i-4),i+1).map(x=>x.l));
            const risk=c.c-swL;if(risk>0&&risk/c.c<0.018) sig={dir:"LONG",entry:c.c,sl:swL,tp:c.c+risk*DT.rrRatio,signal:"EMA50"};
          }
        }
        if(!sig&&bias==="SHORT"){
          if(e50Dn&&shortRsi&&volOk&&p2.c>ind.e21[prev]&&c.c<ind.e21[i]){
            const swH=Math.max(...ind.bars.slice(Math.max(0,i-3),i+1).map(x=>x.h));
            const risk=swH-c.c;if(risk>0&&risk/c.c<DT.maxSLPct) sig={dir:"SHORT",entry:c.c,sl:swH,tp:c.c-risk*DT.rrRatio,signal:"EMA21"};
          }
          if(!sig&&DT_EMA50_PAIRS.has(sym)&&e50Dn&&r>38&&r<=62&&volOk&&p2.c>ind.e50[prev]&&c.c<ind.e50[i]){
            const swH=Math.max(...ind.bars.slice(Math.max(0,i-4),i+1).map(x=>x.h));
            const risk=swH-c.c;if(risk>0&&risk/c.c<0.018) sig={dir:"SHORT",entry:c.c,sl:swH,tp:c.c-risk*DT.rrRatio,signal:"EMA50"};
          }
        }
        if(!sig) continue;

        // ── Funding rate filter ──────────────────────────────────────────────
        if(useFilter) {
          const frMap=fundingMaps[sym];
          if(frMap){
            const fr=getFundingRateAt(frMap,ts);
            if(sig.dir==="LONG"  && fr>FR_BLOCK_LONG)  continue; // longs overcrowded
            if(sig.dir==="SHORT" && fr<FR_BLOCK_SHORT) continue; // shorts overcrowded
          }
        }

        const riskUSD=balance*DT.riskPct;
        const slDist=Math.abs(sig.entry-sig.sl);
        const sizeUSD=(riskUSD/slDist)*sig.entry*DT.leverage;
        positions.push({sym,dir:sig.dir,signal:sig.signal,entry:sig.entry,sl:sig.sl,tp:sig.tp,sizeUSD,riskUSD,entryBarIdx:bi,entryTs:ts});
        if(positions.length>=DT.maxPositions) break;
      }
    }
  }

  for(const pos of positions){
    const ind=dtIndMap[pos.sym];if(!ind) continue;
    const exitP=ind.bars[ind.bars.length-1].c,isL=pos.dir==="LONG";
    const pnl=((isL?exitP-pos.entry:pos.entry-exitP)/pos.entry)*pos.sizeUSD;
    balance+=pnl;trades.push({sym:pos.sym,dir:pos.dir,pnl,reason:"OPEN@END"});
  }

  const wins=trades.filter(t=>t.pnl>0),losses=trades.filter(t=>t.pnl<0);
  return {label,start:DT.startBalance,end:balance,pnl:balance-DT.startBalance,
          trades:trades.length,wins:wins.length,losses:losses.length,
          winRate:trades.length?(wins.length/trades.length*100).toFixed(1):"0",
          maxDD,avgWin:wins.length?wins.reduce((s,t)=>s+t.pnl,0)/wins.length:0,
          avgLoss:losses.length?losses.reduce((s,t)=>s+t.pnl,0)/losses.length:0,
          pf:losses.length?Math.abs(wins.reduce((s,t)=>s+t.pnl,0)/losses.reduce((s,t)=>s+t.pnl,0)):Infinity};
}

// ──────────────────────────────────────────────────────────────────────────────
// PRINT COMPARISON
// ──────────────────────────────────────────────────────────────────────────────

function printComparison(strategy, orig, enhanced) {
  const retOrig = ((orig.end-orig.start)/orig.start*100).toFixed(1);
  const retEnh  = ((enhanced.end-enhanced.start)/enhanced.start*100).toFixed(1);
  const retDiff = (parseFloat(retEnh)-parseFloat(retOrig)).toFixed(1);
  const ddDiff  = (enhanced.maxDD - orig.maxDD).toFixed(1);
  const pfDiff  = (enhanced.pf - orig.pf).toFixed(2);
  const retSign = parseFloat(retDiff)>=0?"↑":"↓";
  const ddSign  = parseFloat(ddDiff)<=0?"↓ better":"↑ worse";

  console.log(`\n${"─".repeat(62)}`);
  console.log(`  ${strategy} — Original vs Enhanced`);
  console.log(`${"─".repeat(62)}`);
  console.log(`  ${"".padEnd(22)} ${"Original".padEnd(16)} ${"Enhanced".padEnd(16)} Change`);
  console.log(`  ${"─".repeat(58)}`);
  const row = (label, a, b, diff, suffix="") =>
    console.log(`  ${label.padEnd(22)} ${(a+suffix).padEnd(16)} ${(b+suffix).padEnd(16)} ${diff}`);
  row("End balance",    `$${orig.end.toFixed(0)}`,    `$${enhanced.end.toFixed(0)}`,    `${parseFloat(retDiff)>=0?"+":""}${retDiff}% ${retSign}`);
  row("Return",         `${retOrig}%`,                `${retEnh}%`,                     "");
  row("Max drawdown",   `${orig.maxDD.toFixed(1)}%`,  `${enhanced.maxDD.toFixed(1)}%`,  `${ddSign}`);
  row("Trades",         `${orig.trades}`,             `${enhanced.trades}`,             `${enhanced.trades-orig.trades>=0?"+":""}${enhanced.trades-orig.trades}`);
  row("Win rate",       `${orig.winRate}%`,           `${enhanced.winRate}%`,           `${(parseFloat(enhanced.winRate)-parseFloat(orig.winRate)).toFixed(1)}%`);
  row("Avg win",        `$${orig.avgWin.toFixed(0)}`, `$${enhanced.avgWin.toFixed(0)}`, "");
  row("Avg loss",       `$${orig.avgLoss.toFixed(0)}`,`$${enhanced.avgLoss.toFixed(0)}`,"");
  row("Profit factor",  `${orig.pf.toFixed(2)}`,      `${enhanced.pf.toFixed(2)}`,      `${parseFloat(pfDiff)>=0?"+":""}${pfDiff}`);

  const verdict = parseFloat(retDiff)>0 && enhanced.maxDD<=orig.maxDD*1.1 && enhanced.pf>=orig.pf
    ? "✅ ENHANCED WINS — deploy filter"
    : parseFloat(retDiff)>0 && enhanced.pf>=orig.pf
    ? "⚠️  ENHANCED BETTER RETURN but higher DD — review"
    : "❌ ORIGINAL WINS — skip filter";
  console.log(`\n  Verdict: ${verdict}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// MAIN
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  ENHANCED STRATEGY BACKTEST COMPARISON   ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`  Period: ${new Date(START_150*1000).toISOString().slice(0,10)} → ${new Date().toISOString().slice(0,10)}`);

  // ── 1. Fetch reference data ─────────────────────────────────────────────────
  console.log("\n[1/4] Fetching Fear & Greed history…");
  const fngMap = await fetchFearGreed();
  const fngDays = Object.keys(fngMap).length;
  console.log(`  ✓ ${fngDays} days  |  Today: ${fngMap[new Date().toISOString().slice(0,10)] ?? "N/A"} (${fngLabel(fngMap[new Date().toISOString().slice(0,10)] ?? 50)})`);

  console.log("\n[2/4] Fetching MEXC funding rate history for 6 DT pairs…");
  const fundingMaps = {};
  for (const sym of DT_PAIRS) {
    process.stdout.write(`  Loading ${sym}…`);
    fundingMaps[sym] = await fetchFundingRateHistory(sym);
    const count = Object.keys(fundingMaps[sym]).length;
    process.stdout.write(`\r  ${sym.padEnd(14)} ${count} settlement records ✓\n`);
  }

  // ── 2. Fetch price data ─────────────────────────────────────────────────────
  console.log("\n[3/4] Fetching v09 4H price data (30 pairs)…");
  const v09BarSec  = 4*3600;
  const v09Start   = NOW_SEC - (DAYS + 92) * 86400;
  const v09IndMap  = {};
  for (const sym of V09_PAIRS) {
    process.stdout.write(`  ${sym}…`);
    const bars = await fetchAllBars(sym, "Hour4", v09BarSec, v09Start, NOW_SEC);
    if (bars.length < 210) { process.stdout.write(`\r  ${sym.padEnd(20)} insufficient (${bars.length})\n`); continue; }
    const closes=bars.map(b=>b.c),vols=bars.map(b=>b.v);
    v09IndMap[sym]={bars,closes,vols,e21:emaSeries(closes,21),e50:emaSeries(closes,50),e200:emaSeries(closes,200),rsi:rsiSmoothed(closes,14),macd:macdSeries(closes),vsma:smaSeries(vols,20)};
    process.stdout.write(`\r  ${sym.padEnd(20)} ${bars.length} bars ✓\n`);
    await sleep(120);
  }

  console.log("\n[4/4] Fetching DT 15min price data (6 pairs)…");
  const dtBarSec = 15*60;
  const dtStart  = START_150 - 80*dtBarSec;
  const dtIndMap = {};
  for (const sym of DT_PAIRS) {
    process.stdout.write(`  ${sym}…`);
    const bars = await fetchAllBars(sym, "Min15", dtBarSec, dtStart, NOW_SEC);
    const closes=bars.map(b=>b.c),vols=bars.map(b=>b.v);
    dtIndMap[sym]={bars,closes,vols,e21:emaSeries(closes,21),e50:emaSeries(closes,50),rsi:rsiSmoothed(closes,14),vsma:smaSeries(vols,20),adx:adxSeries(bars,14),bias:dtSessionBias(bars)};
    process.stdout.write(`\r  ${sym.padEnd(14)} ${bars.length} bars ✓\n`);
    await sleep(120);
  }

  // ── 3. Run simulations ──────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  RUNNING SIMULATIONS…");
  console.log("══════════════════════════════════════════════════════════════");

  console.log("\n  v09 — Original…");
  const v09Orig = await runV09Sim("v09 Original", v09IndMap, null);
  console.log(`  Done: $${v09Orig.end.toFixed(0)} | ${v09Orig.trades} trades`);

  console.log("  v09 — Enhanced (F&G filter)…");
  const v09Enh  = await runV09Sim("v09 + Fear&Greed", v09IndMap, fngMap);
  console.log(`  Done: $${v09Enh.end.toFixed(0)} | ${v09Enh.trades} trades`);

  console.log("\n  DT — Original…");
  const dtOrig  = await runDTSim("DT Original", dtIndMap, null);
  console.log(`  Done: $${dtOrig.end.toFixed(0)} | ${dtOrig.trades} trades`);

  console.log("  DT — Enhanced (funding rate filter)…");
  const dtEnh   = await runDTSim("DT + Funding Rates", dtIndMap, fundingMaps);
  console.log(`  Done: $${dtEnh.end.toFixed(0)} | ${dtEnh.trades} trades`);

  // ── 4. Print results ────────────────────────────────────────────────────────
  printComparison("V09 CRYPTO (4H)", v09Orig, v09Enh);
  printComparison("DT CRYPTO (15min)", dtOrig, dtEnh);

  // Portfolio totals (ORB unchanged at $6,784)
  const ORB_END = 6940; // from last backtest run (1× vol + 17:00 cutoff)
  console.log(`\n${"═".repeat(62)}`);
  console.log("  FULL PORTFOLIO COMPARISON");
  console.log(`${"═".repeat(62)}`);
  console.log(`  ${"".padEnd(24)} ${"Original".padEnd(14)} ${"Enhanced".padEnd(14)}`);
  console.log(`  ${"─".repeat(56)}`);
  const totOrig = v09Orig.end + dtOrig.end + ORB_END;
  const totEnh  = v09Enh.end  + dtEnh.end  + ORB_END;
  console.log(`  ${"v09 Crypto".padEnd(24)} ${ ("$"+v09Orig.end.toFixed(0)).padEnd(14)} ${"$"+v09Enh.end.toFixed(0)}`);
  console.log(`  ${"DT Crypto".padEnd(24)} ${ ("$"+dtOrig.end.toFixed(0)).padEnd(14)} ${"$"+dtEnh.end.toFixed(0)}`);
  console.log(`  ${"ORB Stocks (unchanged)".padEnd(24)} ${ ("$"+ORB_END).padEnd(14)} ${"$"+ORB_END}`);
  console.log(`  ${"─".repeat(56)}`);
  console.log(`  ${"TOTAL".padEnd(24)} ${ ("$"+totOrig.toFixed(0)).padEnd(14)} ${"$"+totEnh.toFixed(0)}`);
  console.log(`  ${"Return".padEnd(24)} ${ (((totOrig-25000)/25000*100).toFixed(1)+"%").padEnd(14)} ${((totEnh-25000)/25000*100).toFixed(1)+"%"}`);
  console.log(`  ${"P&L".padEnd(24)} ${ ("$"+(totOrig-25000).toFixed(0)).padEnd(14)} ${"$"+(totEnh-25000).toFixed(0)}`);

  console.log(`\n  Backtest time: ${((Date.now()-t0)/1000/60).toFixed(1)} min\n`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
