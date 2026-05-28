/**
 * backtest_v09_bidirectional.js — Test adding MOMENTUM-BREAKDOWN shorts to v09
 *
 * Problem: v09 has two short signals but BOTH are mean-reversion (short
 * overbought tops). In a sustained bear dump, coins aren't overbought —
 * they're falling — so neither fires. We sit out downtrends entirely.
 *
 * Fix tested here: add a SHORT that MIRRORS the long breakout —
 *   price breaks BELOW N-bar low + downtrend (EMA21<EMA50, falling) +
 *   RSI weak band + volume spike. Captures high-beta midcap dumps.
 *
 * Compares, over 12 months on the 30-alt universe:
 *   A) BASELINE       — current v09 (long breakout + MR shorts)
 *   B) +MOMO SHORT    — baseline plus momentum-breakdown short
 *   C) MOMO SHORT ONLY (long off) — isolate the short's standalone edge
 *
 * Run: node backtest_v09_bidirectional.js
 */

import "dotenv/config";

const MEXC_BASE     = "https://futures.mexc.com";
const DAYS          = 365;
const NOW_SEC       = Math.floor(Date.now() / 1000);
const START         = NOW_SEC - DAYS * 86400;
const FEE_PCT       = 0.0004;
const START_BALANCE = 12500;
const WARMUP_DAYS   = 92;

const V09_PAIRS = [
  "KAIA_USDT","S_USDT","FILECOIN_USDT","AR_USDT","PLUME_USDT","FIDA_USDT","GMT_USDT","ENA_USDT","TIA_USDT","TURBO_USDT",
  "WIF_USDT","SHIB_USDT","BCH_USDT","VET_USDT","ONDO_USDT","THETA_USDT","HBAR_USDT","RUNE_USDT","IOTA_USDT","JUP_USDT",
  "FLUX_USDT","W_USDT","CATI_USDT","ZKSYNC_USDT","KAITO_USDT","WLD_USDT","AIXBT_USDT","LA_USDT","JASMY_USDT","HOME_USDT",
];

// Current live config (Path A / Phase 1)
const CFG = {
  riskPct: 0.016, minRisk: 2, leverage: 1.5, maxPositions: 10, warmupDays: WARMUP_DAYS,
  slPct: 0.04, tpPct: 0.35, trailPct: 0.16, trailBullPct: 60,
  rebSlPct: 0.035, rebTpPct: 0.22,
  brsiMin: 48, brsiMax: 65, lookback: 15,
  volMultBreak: 1.5, volMultShort: 1.2, volMultReb: 1.0, rsiOverbought: 80,
  // NEW momentum-breakdown short params (mirror of the long)
  momoShortRsiMin: 35, momoShortRsiMax: 52, momoShortVolMult: 1.5,
  momoShortSlPct: 0.04, momoShortTpPct: 0.35,
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
async function fetchChunk(symbol,intervalStr,startSec,endSec){
  const url=`${MEXC_BASE}/api/v1/contract/kline/${symbol}?interval=${intervalStr}&start=${startSec}&end=${endSec}`;
  try{const res=await fetch(url,{signal:AbortSignal.timeout(20000)});if(!res.ok)return[];
    const json=await res.json();if(!json.data?.time?.length)return[];
    const{time,open,close,high,low,vol}=json.data;
    return time.map((t,i)=>({t:t*1000,o:+open[i],c:+close[i],h:+high[i],l:+low[i],v:+vol[i]})).sort((a,b)=>a.t-b.t);
  }catch{return[];}
}
async function fetchAllBars(symbol,intervalStr,barSecs,startSec,endSec){
  const bars=[];const chunk=1800*barSecs;let cur=startSec,emptyRuns=0;
  while(cur<endSec){const end=Math.min(cur+chunk,endSec);const batch=await fetchChunk(symbol,intervalStr,cur,end);if(!batch.length){emptyRuns++;if(emptyRuns>=5)break;cur=end+barSecs;await sleep(120);continue;}emptyRuns=0;bars.push(...batch);cur=Math.floor(batch[batch.length-1].t/1000)+barSecs;await sleep(130);}
  const seen=new Set();return bars.filter(b=>{if(seen.has(b.t))return false;seen.add(b.t);return true;}).sort((a,b)=>a.t-b.t);
}
function ema(v,p){const k=2/(p+1),o=[v[0]];for(let i=1;i<v.length;i++)o.push(v[i]*k+o[i-1]*(1-k));return o;}
function sma(v,p){return v.map((_,i)=>i<p-1?null:v.slice(i-p+1,i+1).reduce((a,b)=>a+b,0)/p);}
function rsi(c,p=14){const o=new Array(c.length).fill(null);let g=0,l=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];d>0?g+=d:l-=d;}o[p]=l===0?100:100-100/(1+g/l);for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];if(d>0){g=(g*(p-1)+d)/p;l=l*(p-1)/p;}else{g=g*(p-1)/p;l=(l*(p-1)-d)/p;}o[i]=l===0?100:100-100/(1+g/l);}return o;}
function macd(c,f=12,s=26,sig=9){const fa=ema(c,f),sl=ema(c,s);const line=c.map((_,i)=>fa[i]-sl[i]);const signal=[line[0]];const k=2/(sig+1);for(let i=1;i<c.length;i++)signal.push(line[i]*k+signal[i-1]*(1-k));return{line,signal,hist:line.map((v,i)=>v-signal[i])};}

function v09Regime(i,closes,e21,e50,e200){if(!e200[i]||!e50[i]||!e21[i])return"neutral";const c=closes[i];let s=0;if(c>e200[i])s++;else s--;if(c>e50[i])s++;else s--;if(c>e21[i])s++;else s--;if(e21[i]>e50[i])s++;else s--;if(e50[i]>e200[i])s++;else s--;return s>=4?"bull":s<=-4?"bear":"neutral";}
function v09Risk(reg,dir,bal,riskPct,minRisk){const b=Math.max(bal*riskPct,minRisk);if(reg==="neutral")return b*0.75;const w=(reg==="bull"&&dir==="LONG")||(reg==="bear"&&dir==="SHORT");return w?b:b*0.5;}

// ── Simulator (mode flags toggle which signals are active) ────────────────────
function simulate(indicators, mode) {
  // mode: { longBreak, mrShorts, momoShort }
  let balance=START_BALANCE, peak=balance, maxDD=0;
  const positions=[]; const trades=[];
  const allTs=new Set();
  for(const sym of V09_PAIRS){const ind=indicators[sym];if(!ind)continue;for(const b of ind.bars)if(b.t/1000>=START)allTs.add(b.t);}
  const sortedTs=[...allTs].sort((a,b)=>a-b);
  const tsMap={};
  for(const sym of V09_PAIRS){const ind=indicators[sym];if(!ind)continue;tsMap[sym]=new Map();for(let i=0;i<ind.bars.length;i++)tsMap[sym].set(ind.bars[i].t,i);}
  function calcBullPct(ts){let bulls=0,total=0;for(const sym of V09_PAIRS){const ind=indicators[sym];if(!ind)continue;const bi=tsMap[sym].get(ts);if(bi===undefined)continue;const r=v09Regime(bi,ind.closes,ind.e21,ind.e50,ind.e200);if(r==="bull")bulls++;total++;}return total?(bulls/total)*100:0;}

  for(const ts of sortedTs){
    // EXITS
    for(let p=positions.length-1;p>=0;p--){
      const pos=positions[p];const ind=indicators[pos.sym];if(!ind)continue;
      const bi=tsMap[pos.sym].get(ts);if(bi===undefined)continue;
      const bar=ind.bars[bi];const isL=pos.dir==="LONG";
      let exitReason=null,exitPrice=null;
      if(pos.trailing){
        if(isL&&bar.h>pos.trailHigh){pos.trailHigh=bar.h;pos.sl=bar.h*(1-CFG.trailPct);}
        else if(!isL&&bar.l<pos.trailLow){pos.trailLow=bar.l;pos.sl=bar.l*(1+CFG.trailPct);}
        const hitTrail=isL?bar.l<=pos.sl:bar.h>=pos.sl;
        if(hitTrail){exitReason="TRAIL_SL";exitPrice=pos.sl;}
      }else{
        const hitSL=isL?bar.l<=pos.sl:bar.h>=pos.sl;
        const hitTP=isL?bar.h>=pos.tp:bar.l<=pos.tp;
        if(hitSL){exitReason="SL";exitPrice=pos.sl;}
        else if(hitTP&&pos.noTrail){exitReason="TP";exitPrice=pos.tp;}
        else if(hitTP){pos.trailing=true;pos.trailHigh=isL?pos.tp:Infinity;pos.trailLow=isL?0:pos.tp;pos.sl=isL?pos.tp*(1-CFG.trailPct):pos.tp*(1+CFG.trailPct);}
      }
      if(exitReason){
        const raw=isL?(exitPrice-pos.entryPrice)/pos.entryPrice*pos.size:(pos.entryPrice-exitPrice)/pos.entryPrice*pos.size;
        const fee=pos.size*FEE_PCT;const netPnl=raw-fee;
        balance+=netPnl;if(balance>peak)peak=balance;
        const dd=(peak-balance)/peak*100;if(dd>maxDD)maxDD=dd;
        trades.push({net:netPnl,dir:pos.dir,kind:pos.kind,reason:exitReason});
        positions.splice(p,1);
      }
    }
    // ENTRIES
    if(positions.length<CFG.maxPositions){
      const bullPct=calcBullPct(ts);
      const trailActive=bullPct>=CFG.trailBullPct;
      for(const sym of V09_PAIRS){
        if(positions.some(p=>p.sym===sym))continue;
        const openShorts=positions.filter(p=>p.dir==="SHORT").length;
        const ind=indicators[sym];if(!ind)continue;
        const bi=tsMap[sym].get(ts);if(bi===undefined||bi<1)continue;
        const i=bi-1;
        if(i<22||!ind.rsi[i]||!ind.rsi[i-1]||!ind.vsma[i]||!ind.e200[i])continue;
        const c=ind.closes[i],rNow=ind.rsi[i],rPrv=ind.rsi[i-1],vol=ind.vols[i],reg=v09Regime(i,ind.closes,ind.e21,ind.e50,ind.e200);

        // LONG breakout
        const highN=Math.max(...ind.closes.slice(Math.max(0,i-CFG.lookback),i));
        const trendUp=ind.e21[i]>ind.e50[i]&&ind.e21[i]>ind.e21[i-1]&&ind.e21[i-1]>ind.e21[i-3];
        const lBreak=mode.longBreak&&c>highN&&trendUp&&rNow>=CFG.brsiMin&&rNow<=CFG.brsiMax&&vol>ind.vsma[i]*CFG.volMultBreak;

        // MEAN-REVERSION shorts (existing)
        const wasOB=[1,2,3,4,5].some(k=>ind.rsi[i-k]!=null&&ind.rsi[i-k]>=65);
        const rsiBrk=rPrv>=58&&rNow<58,macdBrk=ind.macd.hist[i-1]>=0&&ind.macd.hist[i]<0;
        const sBreak=mode.mrShorts&&wasOB&&(rsiBrk||macdBrk)&&c<ind.e21[i]&&rNow>35&&vol>ind.vsma[i]*CFG.volMultShort;
        const wasOVB=[1,2,3].some(k=>ind.rsi[i-k]!=null&&ind.rsi[i-k]>=CFG.rsiOverbought);
        const rsiTurnD=rPrv>=70&&rNow<70;
        const sRebound=mode.mrShorts&&wasOVB&&rsiTurnD&&reg!=="bull"&&c<ind.e21[i]*1.08&&vol>ind.vsma[i]*CFG.volMultReb&&!sBreak;

        // NEW: MOMENTUM-BREAKDOWN short (mirror of long breakout)
        const lowN=Math.min(...ind.closes.slice(Math.max(0,i-CFG.lookback),i));
        const trendDown=ind.e21[i]<ind.e50[i]&&ind.e21[i]<ind.e21[i-1]&&ind.e21[i-1]<ind.e21[i-3];
        const bearGateOk=!mode.momoBearOnly||reg==="bear";
        const shortCapOk=!mode.maxShorts||openShorts<mode.maxShorts;
        const momoShort=mode.momoShort&&bearGateOk&&shortCapOk&&c<lowN&&trendDown&&rNow>=CFG.momoShortRsiMin&&rNow<=CFG.momoShortRsiMax&&vol>ind.vsma[i]*CFG.momoShortVolMult&&!sBreak&&!sRebound;

        if(!lBreak&&!sBreak&&!sRebound&&!momoShort)continue;
        let dir,kind,slPct,tpPct;
        if(lBreak){dir="LONG";kind="LONG_BREAK";slPct=CFG.slPct;tpPct=CFG.tpPct;}
        else if(momoShort){dir="SHORT";kind="MOMO_SHORT";slPct=CFG.momoShortSlPct;tpPct=CFG.momoShortTpPct;}
        else if(sBreak){dir="SHORT";kind="MR_SHORT";slPct=CFG.slPct;tpPct=CFG.tpPct;}
        else{dir="SHORT";kind="MR_REBOUND";slPct=CFG.rebSlPct;tpPct=CFG.rebTpPct;}

        const isRebound=kind==="MR_REBOUND";
        const riskUSD=v09Risk(reg,dir,balance,CFG.riskPct,CFG.minRisk);
        const noTrail=!trailActive||isRebound;
        const entryP=ind.bars[bi].o;
        const size=riskUSD/slPct;
        const isL=dir==="LONG";
        const sl=isL?entryP*(1-slPct):entryP*(1+slPct);
        const tp=isL?entryP*(1+tpPct):entryP*(1-tpPct);
        positions.push({sym,dir,kind,entryPrice:entryP,sl,tp,size,riskUSD,trailing:false,noTrail,trailHigh:isL?tp:Infinity,trailLow:isL?0:tp});
        if(positions.length>=CFG.maxPositions)break;
      }
    }
  }
  // Close remaining at last bar
  for(const pos of positions){
    const ind=indicators[pos.sym];if(!ind)continue;
    const lastBar=ind.bars[ind.bars.length-1];const isL=pos.dir==="LONG";
    const raw=isL?(lastBar.c-pos.entryPrice)/pos.entryPrice*pos.size:(pos.entryPrice-lastBar.c)/pos.entryPrice*pos.size;
    const fee=pos.size*FEE_PCT;const netPnl=raw-fee;balance+=netPnl;
    trades.push({net:netPnl,dir:pos.dir,kind:pos.kind,reason:"EOD"});
  }
  const wins=trades.filter(t=>t.net>0);const losses=trades.filter(t=>t.net<0);
  const winRate=trades.length?wins.length/trades.length*100:0;
  const netW=wins.reduce((s,t)=>s+t.net,0);const netL=Math.abs(losses.reduce((s,t)=>s+t.net,0));
  const pf=netL>0?netW/netL:(wins.length?Infinity:0);
  const ret=(balance-START_BALANCE)/START_BALANCE*100;
  // Per-kind breakdown
  const kinds={};
  for(const t of trades){const k=t.kind||"?";if(!kinds[k])kinds[k]={n:0,net:0,w:0};kinds[k].n++;kinds[k].net+=t.net;if(t.net>0)kinds[k].w++;}
  return {balance,ret,maxDD,trades:trades.length,winRate,pf,kinds};
}

function fmtKinds(kinds){
  return Object.entries(kinds).map(([k,v])=>`${k}: ${v.n}t ${v.net>=0?'+':''}$${Math.round(v.net)} (${Math.round(v.w/v.n*100)}%WR)`).join("\n       ");
}

async function main(){
  const t0=Date.now();
  const startDate=new Date(START*1000).toISOString().slice(0,10);
  const endDate=new Date().toISOString().slice(0,10);
  console.log("╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  v09 BIDIRECTIONAL TEST — adding momentum-breakdown shorts         ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`  Period:  ${startDate} → ${endDate}  (${DAYS} days)`);
  console.log(`  Capital: $${START_BALANCE.toLocaleString()}  |  30 alts, 4H, Option 1 sizing`);
  console.log(`  New short: break below ${CFG.lookback}-bar low + downtrend + RSI ${CFG.momoShortRsiMin}-${CFG.momoShortRsiMax} + ${CFG.momoShortVolMult}x vol\n`);

  console.log("[1/2] Fetching 4H data (30 pairs, ~15 months)…");
  const data={};
  const fetchStart=NOW_SEC-(DAYS+WARMUP_DAYS)*86400;
  for(const sym of V09_PAIRS){
    process.stdout.write(`  ${sym}…`);
    data[sym]=await fetchAllBars(sym,"Hour4",4*3600,fetchStart,NOW_SEC);
    process.stdout.write(`\r  ${sym.padEnd(18)} ${data[sym].length} bars ✓\n`);
    await sleep(120);
  }
  console.log("\n[2/2] Computing indicators + running 3 simulations…");
  const ind={};
  for(const sym of V09_PAIRS){
    const bars=data[sym];if(bars.length<210)continue;
    const closes=bars.map(b=>b.c),vols=bars.map(b=>b.v);
    ind[sym]={bars,closes,vols,e21:ema(closes,21),e50:ema(closes,50),e200:ema(closes,200),rsi:rsi(closes,14),macd:macd(closes),vsma:sma(vols,20)};
  }

  const A=simulate(ind,{longBreak:true, mrShorts:true,  momoShort:false}); // current
  const B=simulate(ind,{longBreak:true, mrShorts:true,  momoShort:true});  // +momo short (naive)
  const C=simulate(ind,{longBreak:false,mrShorts:false, momoShort:true});  // momo short ONLY

  // ── ITERATION 2: regime-gated + tighter TP variants ──────────────────────
  console.log("\n[iter2] Testing improved short: bear-regime gate + tighter TP…");
  const improved = [];
  for (const tp of [0.10, 0.12, 0.15, 0.20]) {
    CFG.momoShortTpPct = tp;
    const only = simulate(ind, {longBreak:false, mrShorts:false, momoShort:true, momoBearOnly:true});
    const combo = simulate(ind, {longBreak:true, mrShorts:true, momoShort:true, momoBearOnly:true});
    improved.push({ tp, only, combo });
  }

  const row=(name,r)=>{
    console.log(`\n  ── ${name} ──`);
    console.log(`     Return: ${r.ret>=0?'+':''}${r.ret.toFixed(1)}%  |  End: $${Math.round(r.balance).toLocaleString()}  |  MaxDD: ${r.maxDD.toFixed(1)}%`);
    console.log(`     Trades: ${r.trades}  |  WR: ${r.winRate.toFixed(1)}%  |  PF: ${r.pf.toFixed(2)}`);
    console.log(`     ${fmtKinds(r.kinds)}`);
  };

  console.log("\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  RESULTS                                                           ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  row("A) BASELINE (current v09)", A);
  row("B) BASELINE + MOMENTUM SHORT", B);
  row("C) MOMENTUM SHORT ONLY (long off)", C);

  console.log("\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  VERDICT                                                           ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  const deltaRet=B.ret-A.ret, deltaDD=B.maxDD-A.maxDD;
  console.log(`  Naive momentum shorts: ${deltaRet>=0?'+':''}${deltaRet.toFixed(1)}% return, ${deltaDD>=0?'+':''}${deltaDD.toFixed(1)}% max DD`);
  console.log(`  Naive standalone edge: ${C.ret>=0?'+':''}${C.ret.toFixed(1)}% (PF ${C.pf.toFixed(2)}) → ${C.pf>=1.1?'ok':'WEAK'}`);

  console.log("\n  ── ITERATION 2: bear-regime gate + tighter TP ──");
  console.log("  TP%   | STANDALONE (bear-gated)        | COMBINED w/ baseline");
  console.log("  ──────┼────────────────────────────────┼──────────────────────────────");
  let best=null;
  for(const r of improved){
    const o=r.only, cm=r.combo;
    const line=`  ${(r.tp*100).toFixed(0).padStart(3)}%  | ${(o.ret>=0?'+':'')+o.ret.toFixed(1)+'%'} ${o.trades}t PF${o.pf.toFixed(2)} DD${o.maxDD.toFixed(0)}%`.padEnd(50)+`| ${(cm.ret>=0?'+':'')+cm.ret.toFixed(1)+'%'} DD${cm.maxDD.toFixed(0)}% (Δret ${(cm.ret-A.ret>=0?'+':'')+(cm.ret-A.ret).toFixed(0)}%, ΔDD ${(cm.maxDD-A.maxDD>=0?'+':'')+(cm.maxDD-A.maxDD).toFixed(0)}%)`;
    console.log(line);
    if(o.pf>=1.15&&(cm.ret-A.ret)>0&&(cm.maxDD-A.maxDD)<6){ if(!best||o.pf>best.only.pf) best=r; }
  }
  // ── ITERATION 3: cap concurrent shorts (kill correlated pileup) ──────────
  console.log("\n[iter3] Capping concurrent shorts (TP 10%, bear-gated)…");
  CFG.momoShortTpPct = 0.10;
  console.log("  MaxShorts | STANDALONE                     | COMBINED w/ baseline");
  console.log("  ──────────┼────────────────────────────────┼──────────────────────────────");
  let best3=null;
  for(const ms of [2,3,4,5]){
    const o=simulate(ind,{longBreak:false,mrShorts:false,momoShort:true,momoBearOnly:true,maxShorts:ms});
    const cm=simulate(ind,{longBreak:true,mrShorts:true,momoShort:true,momoBearOnly:true,maxShorts:ms});
    console.log(`  ${String(ms).padStart(6)}    | ${(o.ret>=0?'+':'')+o.ret.toFixed(1)+'%'} ${o.trades}t PF${o.pf.toFixed(2)} DD${o.maxDD.toFixed(0)}%`.padEnd(50)+`| ${(cm.ret>=0?'+':'')+cm.ret.toFixed(1)+'%'} DD${cm.maxDD.toFixed(0)}% (Δret ${(cm.ret-A.ret>=0?'+':'')+(cm.ret-A.ret).toFixed(0)}%, ΔDD ${(cm.maxDD-A.maxDD>=0?'+':'')+(cm.maxDD-A.maxDD).toFixed(0)}%)`);
    if(o.pf>=1.2&&(cm.ret-A.ret)>0&&(cm.maxDD-A.maxDD)<6){if(!best3||o.pf>best3.o.pf)best3={ms,o,cm};}
  }

  console.log("\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  FINAL VERDICT                                                     ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  if(best3){
    console.log(`  ✅ PASS — bear-gated momentum short, TP 10%, max ${best3.ms} concurrent shorts`);
    console.log(`     Standalone: ${best3.o.ret>=0?'+':''}${best3.o.ret.toFixed(1)}% PF ${best3.o.pf.toFixed(2)} WR ${best3.o.winRate.toFixed(0)}% DD ${best3.o.maxDD.toFixed(0)}%`);
    console.log(`     Combined:   ${best3.cm.ret>=0?'+':''}${best3.cm.ret.toFixed(1)}% vs baseline +90.7%, DD ${best3.cm.maxDD.toFixed(0)}% vs 39.5%`);
    console.log(`     → NEXT: walk-forward validate across 4 windows before deploying`);
  } else if(best){
    console.log(`  ✅ PASS — bear-gated momentum short @ TP ${(best.tp*100).toFixed(0)}% has standalone edge`);
    console.log(`     Standalone: ${best.only.ret>=0?'+':''}${best.only.ret.toFixed(1)}% PF ${best.only.pf.toFixed(2)} WR ${best.only.winRate.toFixed(0)}% DD ${best.only.maxDD.toFixed(0)}%`);
    console.log(`     Combined:   ${best.combo.ret>=0?'+':''}${best.combo.ret.toFixed(1)}% (baseline +90.7%) DD ${best.combo.maxDD.toFixed(0)}%`);
    console.log(`     → NEXT: walk-forward validate across 4 windows before deploying`);
  } else {
    console.log(`  ❌ FAIL — even bear-gated + tight TP, the momentum short lacks standalone edge.`);
    console.log(`     Conclusion: alt momentum-shorting doesn't have a robust edge on this universe.`);
    console.log(`     The portfolio stays bull-biased by design — protects in bears, profits in bulls.`);
  }
  console.log(`\n  Total time: ${((Date.now()-t0)/60000).toFixed(1)} min`);
}

main().catch(e=>{console.error("FATAL:",e);process.exit(1);});
