/**
 * backtest_v09_short_walkforward.js — Walk-forward validation of the
 * bear-gated momentum-breakdown short.
 *
 * Fixed params (from single-window optimization):
 *   - break below 15-bar low + downtrend + RSI 35-52 + 1.5x vol
 *   - bear-regime gate (only short when v09 regime == "bear")
 *   - TP 10%, SL 4%
 *   - max 3 concurrent shorts (caps correlated squeeze risk)
 *
 * Tests these FIXED params across 4 non-overlapping ~3-month windows.
 * Robust if the standalone short shows edge (ret>0 AND PF>=1.1) in >=3 of 4.
 *
 * Run: node backtest_v09_short_walkforward.js
 */

import "dotenv/config";

const MEXC_BASE   = "https://futures.mexc.com";
const NOW_SEC     = Math.floor(Date.now()/1000);
const FEE_PCT     = 0.0004;
const START_BAL   = 12500;
const WARMUP_DAYS = 92;
const WINDOW_DAYS = 91;     // ~3 months
const N_WINDOWS   = 4;

const V09_PAIRS = [
  "KAIA_USDT","S_USDT","FILECOIN_USDT","AR_USDT","PLUME_USDT","FIDA_USDT","GMT_USDT","ENA_USDT","TIA_USDT","TURBO_USDT",
  "WIF_USDT","SHIB_USDT","BCH_USDT","VET_USDT","ONDO_USDT","THETA_USDT","HBAR_USDT","RUNE_USDT","IOTA_USDT","JUP_USDT",
  "FLUX_USDT","W_USDT","CATI_USDT","ZKSYNC_USDT","KAITO_USDT","WLD_USDT","AIXBT_USDT","LA_USDT","JASMY_USDT","HOME_USDT",
];

const P = {
  riskPct:0.016, minRisk:2, maxPositions:10, maxShorts:3,
  slPct:0.04, tpPct:0.10, trailPct:0.16,
  lookback:15, rsiMin:35, rsiMax:52, volMult:1.5,
};

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
async function fetchChunk(s,iv,a,b){const url=`${MEXC_BASE}/api/v1/contract/kline/${s}?interval=${iv}&start=${a}&end=${b}`;try{const r=await fetch(url,{signal:AbortSignal.timeout(20000)});if(!r.ok)return[];const j=await r.json();if(!j.data?.time?.length)return[];const{time,open,close,high,low,vol}=j.data;return time.map((t,i)=>({t:t*1000,o:+open[i],c:+close[i],h:+high[i],l:+low[i],v:+vol[i]})).sort((x,y)=>x.t-y.t);}catch{return[];}}
async function fetchAll(s,iv,bs,a,b){const out=[];const ch=1800*bs;let cur=a,empty=0;while(cur<b){const e=Math.min(cur+ch,b);const bt=await fetchChunk(s,iv,cur,e);if(!bt.length){empty++;if(empty>=5)break;cur=e+bs;await sleep(120);continue;}empty=0;out.push(...bt);cur=Math.floor(out[out.length-1].t/1000)+bs;await sleep(130);}const seen=new Set();return out.filter(x=>{if(seen.has(x.t))return false;seen.add(x.t);return true;}).sort((x,y)=>x.t-y.t);}
function ema(v,p){const k=2/(p+1),o=[v[0]];for(let i=1;i<v.length;i++)o.push(v[i]*k+o[i-1]*(1-k));return o;}
function sma(v,p){return v.map((_,i)=>i<p-1?null:v.slice(i-p+1,i+1).reduce((a,b)=>a+b,0)/p);}
function rsi(c,p=14){const o=new Array(c.length).fill(null);let g=0,l=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];d>0?g+=d:l-=d;}o[p]=l===0?100:100-100/(1+g/l);for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];if(d>0){g=(g*(p-1)+d)/p;l=l*(p-1)/p;}else{g=g*(p-1)/p;l=(l*(p-1)-d)/p;}o[i]=l===0?100:100-100/(1+g/l);}return o;}
function reg(i,c,e21,e50,e200){if(!e200[i]||!e50[i]||!e21[i])return"neutral";const x=c[i];let s=0;if(x>e200[i])s++;else s--;if(x>e50[i])s++;else s--;if(x>e21[i])s++;else s--;if(e21[i]>e50[i])s++;else s--;if(e50[i]>e200[i])s++;else s--;return s>=4?"bull":s<=-4?"bear":"neutral";}

// Standalone momentum-short sim over [winStart, winEnd] (sec). Indicators precomputed.
function simWindow(ind, winStart, winEnd){
  let bal=START_BAL, peak=bal, maxDD=0;
  const positions=[]; const trades=[];
  const allTs=new Set();
  for(const sym of V09_PAIRS){const d=ind[sym];if(!d)continue;for(const b of d.bars){const s=b.t/1000;if(s>=winStart&&s<=winEnd)allTs.add(b.t);}}
  const sortedTs=[...allTs].sort((a,b)=>a-b);
  const tsMap={};for(const sym of V09_PAIRS){const d=ind[sym];if(!d)continue;tsMap[sym]=new Map();for(let i=0;i<d.bars.length;i++)tsMap[sym].set(d.bars[i].t,i);}

  for(const ts of sortedTs){
    // exits
    for(let p=positions.length-1;p>=0;p--){
      const pos=positions[p];const d=ind[pos.sym];const bi=tsMap[pos.sym].get(ts);if(bi===undefined)continue;
      const bar=d.bars[bi];
      let er=null,ep=null;
      if(pos.trailing){if(bar.l<pos.trailLow){pos.trailLow=bar.l;pos.sl=bar.l*(1+P.trailPct);}if(bar.h>=pos.sl){er="TRAIL";ep=pos.sl;}}
      else{const hitSL=bar.h>=pos.sl,hitTP=bar.l<=pos.tp;if(hitSL){er="SL";ep=pos.sl;}else if(hitTP){er="TP";ep=pos.tp;}}
      if(er){const raw=(pos.entryPrice-ep)/pos.entryPrice*pos.size;const net=raw-pos.size*FEE_PCT;bal+=net;if(bal>peak)peak=bal;const dd=(peak-bal)/peak*100;if(dd>maxDD)maxDD=dd;trades.push({net});positions.splice(p,1);}
    }
    // entries (shorts only, bear-gated, capped)
    if(positions.length<P.maxPositions){
      const openShorts=positions.length; // all positions are shorts in this sim
      for(const sym of V09_PAIRS){
        if(openShorts>=P.maxShorts)break;
        if(positions.some(p=>p.sym===sym))continue;
        const d=ind[sym];if(!d)continue;const bi=tsMap[sym].get(ts);if(bi===undefined||bi<1)continue;const i=bi-1;
        if(i<22||!d.rsi[i]||!d.vsma[i]||!d.e200[i])continue;
        const c=d.closes[i],rNow=d.rsi[i],vol=d.vols[i],r=reg(i,d.closes,d.e21,d.e50,d.e200);
        if(r!=="bear")continue;
        const lowN=Math.min(...d.closes.slice(Math.max(0,i-P.lookback),i));
        const trendDown=d.e21[i]<d.e50[i]&&d.e21[i]<d.e21[i-1]&&d.e21[i-1]<d.e21[i-3];
        if(!(c<lowN&&trendDown&&rNow>=P.rsiMin&&rNow<=P.rsiMax&&vol>d.vsma[i]*P.volMult))continue;
        if(positions.filter(p=>p.dir==="SHORT").length>=P.maxShorts)continue;
        const base=Math.max(bal*P.riskPct,P.minRisk);const riskUSD=base; // bear+SHORT = with-trend, full risk
        const entryP=d.bars[bi].o;const size=riskUSD/P.slPct;
        positions.push({sym,dir:"SHORT",entryPrice:entryP,sl:entryP*(1+P.slPct),tp:entryP*(1-P.tpPct),size,trailing:false,trailLow:entryP});
      }
    }
  }
  // close leftovers at window end
  for(const pos of positions){const d=ind[pos.sym];const last=d.bars[d.bars.length-1];const raw=(pos.entryPrice-last.c)/pos.entryPrice*pos.size;bal+=raw-pos.size*FEE_PCT;trades.push({net:raw-pos.size*FEE_PCT});}
  const wins=trades.filter(t=>t.net>0),losses=trades.filter(t=>t.net<0);
  const wr=trades.length?wins.length/trades.length*100:0;
  const nW=wins.reduce((s,t)=>s+t.net,0),nL=Math.abs(losses.reduce((s,t)=>s+t.net,0));
  const pf=nL>0?nW/nL:(wins.length?Infinity:0);
  return {ret:(bal-START_BAL)/START_BAL*100,maxDD,trades:trades.length,wr,pf};
}

async function main(){
  const t0=Date.now();
  console.log("╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  WALK-FORWARD: bear-gated momentum short (max 3, TP 10%)          ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`  4 non-overlapping ${WINDOW_DAYS}-day windows | RSI ${P.rsiMin}-${P.rsiMax} | bear-gate ON\n`);

  // Fetch enough: warmup + 4 windows
  const totalDays = WARMUP_DAYS + N_WINDOWS*WINDOW_DAYS + 10;
  const fetchStart = NOW_SEC - totalDays*86400;
  console.log(`[1/2] Fetching 4H data (30 pairs, ~${Math.round(totalDays/30)} months)…`);
  const data={};
  for(const sym of V09_PAIRS){process.stdout.write(`  ${sym}…`);data[sym]=await fetchAll(sym,"Hour4",4*3600,fetchStart,NOW_SEC);process.stdout.write(`\r  ${sym.padEnd(18)} ${data[sym].length} bars ✓\n`);await sleep(110);}

  const ind={};
  for(const sym of V09_PAIRS){const bars=data[sym];if(bars.length<210)continue;const closes=bars.map(b=>b.c),vols=bars.map(b=>b.v);ind[sym]={bars,closes,vols,e21:ema(closes,21),e50:ema(closes,50),e200:ema(closes,200),rsi:rsi(closes,14),vsma:sma(vols,20)};}

  console.log("\n[2/2] Running 4 walk-forward windows…\n");
  const firstWinStart = NOW_SEC - (N_WINDOWS*WINDOW_DAYS)*86400;
  const results=[];
  console.log("  Window         Dates                    Ret      PF     WR    Trades  MaxDD");
  console.log("  ───────────────────────────────────────────────────────────────────────────");
  for(let w=0;w<N_WINDOWS;w++){
    const ws=firstWinStart+w*WINDOW_DAYS*86400;
    const we=ws+WINDOW_DAYS*86400;
    const r=simWindow(ind,ws,we);
    results.push(r);
    const d1=new Date(ws*1000).toISOString().slice(0,10),d2=new Date(we*1000).toISOString().slice(0,10);
    const pass=r.ret>0&&r.pf>=1.1;
    console.log(`  ${pass?'✅':'❌'} W${w+1}        ${d1}→${d2}   ${(r.ret>=0?'+':'')+r.ret.toFixed(1)+'%'}`.padEnd(54)+`${r.pf.toFixed(2)}   ${r.wr.toFixed(0)}%   ${String(r.trades).padStart(3)}    ${r.maxDD.toFixed(0)}%`);
  }

  const passes=results.filter(r=>r.ret>0&&r.pf>=1.1).length;
  const avgRet=results.reduce((s,r)=>s+r.ret,0)/results.length;
  const avgPF=results.filter(r=>isFinite(r.pf)).reduce((s,r)=>s+r.pf,0)/results.filter(r=>isFinite(r.pf)).length;
  const worstDD=Math.max(...results.map(r=>r.maxDD));

  console.log("\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  VERDICT                                                           ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`  Windows passed: ${passes}/4  |  Avg ret/window: ${avgRet>=0?'+':''}${avgRet.toFixed(1)}%  |  Avg PF: ${avgPF.toFixed(2)}  |  Worst DD: ${worstDD.toFixed(0)}%`);
  if(passes>=3) console.log(`  ✅ ROBUST — edge holds across windows. SAFE to deploy (paper first).`);
  else if(passes===2) console.log(`  🟡 MIXED — works in half the windows. Regime-dependent; deploy with caution or wait.`);
  else console.log(`  ❌ CURVE-FIT — edge only in 0-1 windows. DO NOT deploy. Stay bull-biased.`);
  console.log(`\n  Total time: ${((Date.now()-t0)/60000).toFixed(1)} min`);
}
main().catch(e=>{console.error("FATAL:",e);process.exit(1);});
