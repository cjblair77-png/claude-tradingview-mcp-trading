/**
 * backtest_weekly.js — Week-by-week P&L breakdown for all 3 strategies
 *
 * Same baseline logic as backtest_all.js (the live bots' parameters),
 * PLUS realistic MEXC taker fees: 0.06% × 2 (open + close) = 0.12% per round-trip.
 *
 * Output: weekly table showing per-strategy and portfolio P&L by ISO week.
 *
 * Run: node backtest_weekly.js
 */

import "dotenv/config";

const MEXC_BASE = "https://futures.mexc.com";
const DAYS      = 150;
const NOW_SEC   = Math.floor(Date.now() / 1000);
const START_150 = NOW_SEC - DAYS * 86400;
const FEE_PCT   = 0.0012; // 0.06% × 2

// ── Data fetching ─────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchChunk(symbol, intervalStr, startSec, endSec) {
  const url = `${MEXC_BASE}/api/v1/contract/kline/${symbol}?interval=${intervalStr}&start=${startSec}&end=${endSec}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
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
    const end = Math.min(cur + chunk, endSec);
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

// ── Indicators (same as backtest_all.js) ────────────────────────────────────

function emaSeries(vals, p) {
  const k=2/(p+1), out=[vals[0]];
  for(let i=1;i<vals.length;i++) out.push(vals[i]*k+out[i-1]*(1-k));
  return out;
}
function smaSeries(vals,p){return vals.map((_,i)=>i<p-1?null:vals.slice(i-p+1,i+1).reduce((a,b)=>a+b,0)/p);}
function rsiSmoothed(closes, period=14) {
  const out=new Array(closes.length).fill(null); let g=0,l=0;
  for(let i=1;i<=period;i++){const d=closes[i]-closes[i-1];d>0?g+=d:l-=d;}
  out[period]=l===0?100:100-100/(1+g/l);
  for(let i=period+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    if(d>0){g=(g*(period-1)+d)/period;l=l*(period-1)/period;}
    else{g=g*(period-1)/period;l=(l*(period-1)-d)/period;}
    out[i]=l===0?100:100-100/(1+g/l);
  }
  return out;
}
function macdSeries(closes,f=12,s=26,sig=9){
  const fast=emaSeries(closes,f),slow=emaSeries(closes,s);
  const line=closes.map((_,i)=>fast[i]-slow[i]); const signal=[line[0]]; const k=2/(sig+1);
  for(let i=1;i<closes.length;i++) signal.push(line[i]*k+signal[i-1]*(1-k));
  return{line,signal,hist:line.map((v,i)=>v-signal[i])};
}
function adxSeries(bars,period=14){
  const n=bars.length,out=new Array(n).fill(null),tr=[],pdm=[],ndm=[];
  for(let i=1;i<n;i++){
    const h=bars[i].h,l=bars[i].l,pc=bars[i-1].c,ph=bars[i-1].h,pl=bars[i-1].l;
    tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
    const up=h-ph,dn=pl-l; pdm.push(up>dn&&up>0?up:0); ndm.push(dn>up&&dn>0?dn:0);
  }
  if(tr.length<period*2)return out;
  let smTR=tr.slice(0,period).reduce((a,b)=>a+b,0),smP=pdm.slice(0,period).reduce((a,b)=>a+b,0),smN=ndm.slice(0,period).reduce((a,b)=>a+b,0);
  const dx=[],cDX=()=>{const p=smTR?100*smP/smTR:0,nn=smTR?100*smN/smTR:0;return(p+nn)?100*Math.abs(p-nn)/(p+nn):0;};
  dx.push(cDX());
  for(let i=period;i<tr.length;i++){smTR=smTR-smTR/period+tr[i];smP=smP-smP/period+pdm[i];smN=smN-smN/period+ndm[i];dx.push(cDX());}
  if(dx.length<period)return out;
  let adxVal=dx.slice(0,period).reduce((a,b)=>a+b,0)/period; out[2*period-1]=adxVal;
  for(let j=period;j<dx.length;j++){adxVal=(adxVal*(period-1)+dx[j])/period;out[j+period]=adxVal;}
  return out;
}

// ── Strategy configs ────────────────────────────────────────────────────────

const V09_PAIRS = ["KAIA_USDT","S_USDT","FILECOIN_USDT","AR_USDT","PLUME_USDT","FIDA_USDT","GMT_USDT","ENA_USDT","TIA_USDT","TURBO_USDT","WIF_USDT","SHIB_USDT","BCH_USDT","VET_USDT","ONDO_USDT","THETA_USDT","HBAR_USDT","RUNE_USDT","IOTA_USDT","JUP_USDT","FLUX_USDT","W_USDT","CATI_USDT","ZKSYNC_USDT","KAITO_USDT","WLD_USDT","AIXBT_USDT","LA_USDT","JASMY_USDT","HOME_USDT"];
const V09 = { startBalance:10000, riskPct:0.008, minRisk:2, leverage:1.5, slPct:0.065, tpPct:0.23, trailPct:0.19, rebSlPct:0.035, rebTpPct:0.22, rsiOverbought:80, brsiMin:54, brsiMax:65, lookback:30, maxPositions:10, warmupDays:92 };

const DT_PAIRS = ["BTC_USDT","BNB_USDT","XRP_USDT","SUI_USDT","LTC_USDT","AVAX_USDT"];
const DT_EMA50_PAIRS = new Set(["BTC_USDT","SUI_USDT"]);
const DT = { startBalance:8750, riskPct:0.008, leverage:5, rrRatio:1.3, maxHold:12, maxSLPct:0.012, maxPositions:6 };

const ORB_SYMBOLS = ["CSCOSTOCK_USDT","NFLXSTOCK_USDT","AVGOSTOCK_USDT","JPMSTOCK_USDT","MRVLSTOCK_USDT","MSFTSTOCK_USDT","ASMLSTOCK_USDT","PLTRSTOCK_USDT","ARMSTOCK_USDT","WMTSTOCK_USDT"];
const ORB = { totalBalance:6250, riskPct:0.01, leverage:5, rrRatio:1.5, orbBars:6, eodH:19, eodM:55, volSessionsMA:20 };
const PER_SYM = ORB.totalBalance / ORB_SYMBOLS.length;

// ── v09 signal helpers ──────────────────────────────────────────────────────

function v09Regime(i,closes,e21,e50,e200){
  if(!e200[i]||!e50[i]||!e21[i])return"neutral";
  const c=closes[i];let score=0;
  if(c>e200[i])score++;else score--;if(c>e50[i])score++;else score--;
  if(c>e21[i])score++;else score--;if(e21[i]>e50[i])score++;else score--;
  if(e50[i]>e200[i])score++;else score--;
  return score>=4?"bull":score<=-4?"bear":"neutral";
}
function v09Risk(reg,dir,balance){
  const base=Math.max(balance*V09.riskPct,V09.minRisk);
  if(reg==="neutral")return base*0.75;
  const wt=(reg==="bull"&&dir==="LONG")||(reg==="bear"&&dir==="SHORT");
  return wt?base:base*0.5;
}
function v09Signal(i,closes,vols,e21,e50,e200,rsi,mc,vsma){
  if(i<22||!rsi[i]||!rsi[i-1]||!vsma[i]||!e200[i])return null;
  const c=closes[i],rNow=rsi[i],rPrv=rsi[i-1],vol=vols[i],reg=v09Regime(i,closes,e21,e50,e200);
  const highN=Math.max(...closes.slice(Math.max(0,i-V09.lookback),i));
  const trendUp=e21[i]>e50[i]&&e21[i]>e21[i-1]&&e21[i-1]>e21[i-3];
  const lBreak=c>highN&&trendUp&&rNow>=V09.brsiMin&&rNow<=V09.brsiMax&&vol>vsma[i]*1.5;
  const wasOB=[1,2,3,4,5].some(k=>rsi[i-k]!=null&&rsi[i-k]>=65);
  const rsiBrk=rPrv>=58&&rNow<58, macdBrk=mc.hist[i-1]>=0&&mc.hist[i]<0;
  const sBreak=wasOB&&(rsiBrk||macdBrk)&&c<e21[i]&&rNow>35&&vol>vsma[i]*1.2;
  // LONG REBOUND removed — confirmed dead in 150-day backtest
  const wasOVB=[1,2,3].some(k=>rsi[i-k]!=null&&rsi[i-k]>=V09.rsiOverbought);
  const rsiTurnD=rPrv>=70&&rNow<70;
  const sRebound=wasOVB&&rsiTurnD&&reg!=="bull"&&c<e21[i]*1.08&&vol>vsma[i]*1.0&&!sBreak;
  return{lBreak,sBreak,sRebound,reg};
}

// ── DT session ORB bias ─────────────────────────────────────────────────────

function dtSessionBias(bars) {
  const bias = new Array(bars.length).fill(null);
  let orbH=-Infinity, orbL=Infinity, building=false, confirmed=null, curBias=null;
  for (let j=0; j<bars.length; j++) {
    const h = new Date(bars[j].t).getUTCHours(), m = new Date(bars[j].t).getUTCMinutes();
    if ([1,8,13].includes(h) && m===0) {
      building=true; orbH=bars[j].h; orbL=bars[j].l; confirmed=null; curBias=null;
    } else if (building) {
      orbH=Math.max(orbH, bars[j].h); orbL=Math.min(orbL, bars[j].l); confirmed={h:orbH,l:orbL}; building=false;
    }
    if (confirmed && curBias===null) {
      if (bars[j].c > confirmed.h) curBias="LONG";
      else if (bars[j].c < confirmed.l) curBias="SHORT";
    }
    bias[j] = confirmed ? curBias : null;
  }
  return bias;
}

// ── ORB session helpers ─────────────────────────────────────────────────────

function isRTHBar(ms){const h=new Date(ms).getUTCHours(),m=new Date(ms).getUTCMinutes(),mins=h*60+m;return mins>=13*60+30&&mins<20*60;}
function isOpenBar(ms){const d=new Date(ms);return d.getUTCHours()===13&&d.getUTCMinutes()===30;}
function isEODBar(ms){const d=new Date(ms),h=d.getUTCHours(),m=d.getUTCMinutes();return h>19||(h===19&&m>=55);}
function isWeekdayMs(ms){const d=new Date(ms).getUTCDay();return d>=1&&d<=5;}
function dayKeyUTC(ms){return new Date(ms).toISOString().slice(0,10);}

// ── Week key: ISO week (Monday-based) — "2026-W22" format ───────────────────

function weekKey(ts) {
  const d = new Date(ts);
  // ISO 8601: shift to Thursday of the same week, year of Thursday = ISO year
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7; // Mon=0
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThu = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstThuDayNr = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstThuDayNr + 3);
  const weekNum = 1 + Math.round((target - firstThu) / (7*86400000));
  return `${target.getUTCFullYear()}-W${String(weekNum).padStart(2,"0")}`;
}

function weekStartDate(weekKey) {
  // For display: get the Monday date of the ISO week
  const [yr, wkStr] = weekKey.split("-W");
  const week = parseInt(wkStr);
  const jan4 = new Date(Date.UTC(parseInt(yr), 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const week1Mon = new Date(jan4); week1Mon.setUTCDate(jan4.getUTCDate() - jan4Day);
  const monday = new Date(week1Mon); monday.setUTCDate(week1Mon.getUTCDate() + (week-1)*7);
  return monday.toISOString().slice(0,10);
}

// ─────────────────────────────────────────────────────────────────────────────
// SIMULATIONS (record per-trade with timestamp + net P&L after fees)
// ─────────────────────────────────────────────────────────────────────────────

function simulateV09(indicators) {
  let balance = V09.startBalance;
  const positions = []; const trades = [];

  const allTs = new Set();
  for (const sym of V09_PAIRS) {
    const ind = indicators[sym]; if (!ind) continue;
    for (const b of ind.bars) if (b.t/1000 >= START_150) allTs.add(b.t);
  }
  const sortedTs = [...allTs].sort((a,b)=>a-b);

  function calcBullPct(barIdx) {
    let bulls=0, total=0;
    for (const sym of V09_PAIRS) {
      const ind = indicators[sym]; if (!ind) continue;
      if (barIdx >= ind.closes.length) continue;
      const r = v09Regime(barIdx, ind.closes, ind.e21, ind.e50, ind.e200);
      if (r === "bull") bulls++; total++;
    }
    return total ? (bulls/total)*100 : 0;
  }

  for (const ts of sortedTs) {
    // EXITS
    for (let p = positions.length-1; p >= 0; p--) {
      const pos = positions[p];
      const ind = indicators[pos.sym]; if (!ind) continue;
      const bi = ind.bars.findIndex(b => b.t === ts);
      if (bi < 0) continue;
      const bar = ind.bars[bi];
      const isL = pos.dir === "LONG";

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
        else if (hitTP) {
          pos.trailing=true;
          pos.trailHigh=isL?pos.tp:Infinity; pos.trailLow=isL?0:pos.tp;
          pos.sl = isL ? pos.tp*(1-V09.trailPct) : pos.tp*(1+V09.trailPct);
        }
      }

      if (exitReason) {
        const raw = isL ? (exitPrice-pos.entryPrice)/pos.entryPrice*pos.size
                        : (pos.entryPrice-exitPrice)/pos.entryPrice*pos.size;
        const grossPnl = raw * V09.leverage;
        const fee = pos.size * FEE_PCT;
        const netPnl = grossPnl - fee;
        balance += netPnl;
        trades.push({ sym:pos.sym, dir:pos.dir, gross:grossPnl, fee, net:netPnl, exitTs:ts });
        positions.splice(p, 1);
      }
    }

    // ENTRIES
    if (positions.length < V09.maxPositions) {
      const bullPct = calcBullPct((()=>{const ind=indicators[V09_PAIRS[0]]; return ind?ind.bars.findIndex(b=>b.t===ts):0;})());
      const trailActive = bullPct >= 60;

      for (const sym of V09_PAIRS) {
        if (positions.some(p=>p.sym===sym)) continue;
        const ind = indicators[sym]; if (!ind) continue;
        const bi  = ind.bars.findIndex(b=>b.t===ts);
        if (bi < 1) continue;
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

        positions.push({ sym, dir, entryPrice:entryP, sl, tp, size, riskUSD, trailing:false, noTrail,
                         trailHigh:isL?tp:Infinity, trailLow:isL?0:tp });
        if (positions.length >= V09.maxPositions) break;
      }
    }
  }

  // Force-close
  for (const pos of positions) {
    const ind = indicators[pos.sym]; if (!ind) continue;
    const lastBar = ind.bars[ind.bars.length-1];
    const exitP = lastBar.c;
    const isL = pos.dir==="LONG";
    const raw = isL ? (exitP-pos.entryPrice)/pos.entryPrice*pos.size
                    : (pos.entryPrice-exitP)/pos.entryPrice*pos.size;
    const grossPnl = raw * V09.leverage;
    const fee = pos.size * FEE_PCT;
    const netPnl = grossPnl - fee;
    balance += netPnl;
    trades.push({ sym:pos.sym, dir:pos.dir, gross:grossPnl, fee, net:netPnl, exitTs:lastBar.t });
  }

  return { balance, trades };
}

function simulateDT(indicators) {
  let balance = DT.startBalance;
  const positions = []; const trades = [];

  const allTs = new Set();
  for (const sym of DT_PAIRS) {
    const ind = indicators[sym]; if (!ind) continue;
    for (const b of ind.bars) if (b.t/1000 >= START_150) allTs.add(b.t);
  }
  const sortedTs = [...allTs].sort((a,b)=>a-b);

  for (const ts of sortedTs) {
    // EXITS
    for (let p = positions.length-1; p >= 0; p--) {
      const pos = positions[p];
      const ind = indicators[pos.sym]; if (!ind) continue;
      const bi = ind.bars.findIndex(b=>b.t===ts);
      if (bi < 0) continue;
      const bar = ind.bars[bi];
      const isL = pos.dir==="LONG";
      const barsHeld = bi - pos.entryBarIdx;
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
        trades.push({ sym:pos.sym, dir:pos.dir, gross:grossPnl, fee, net:netPnl, exitTs:ts });
        positions.splice(p, 1);
      }
    }

    // ENTRIES
    if (positions.length < DT.maxPositions) {
      for (const sym of DT_PAIRS) {
        if (positions.some(p=>p.sym===sym)) continue;
        const ind = indicators[sym]; if (!ind) continue;
        const bi = ind.bars.findIndex(b=>b.t===ts);
        if (bi < 3) continue;
        const i = bi-1, prev = i-1;
        if (!ind.rsi[i]||!ind.vsma[i]||!ind.adx[i]||ind.adx[i]<20) continue;
        const entryHour = new Date(ind.bars[i].t).getUTCHours();
        if (entryHour>=1&&entryHour<8) continue;
        const bias = ind.bias[i];
        if (!bias) continue;

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
        const sizeUSD = (riskUSD / slDist) * sig.entry * DT.leverage;
        positions.push({ sym, dir:sig.dir, entry:sig.entry, sl:sig.sl, tp:sig.tp, sizeUSD, riskUSD, entryBarIdx:bi });
        if (positions.length >= DT.maxPositions) break;
      }
    }
  }

  // Force-close
  for (const pos of positions) {
    const ind = indicators[pos.sym]; if (!ind) continue;
    const lastBar = ind.bars[ind.bars.length-1];
    const exitP = lastBar.c;
    const isL = pos.dir==="LONG";
    const grossPnl = ((isL?exitP-pos.entry:pos.entry-exitP)/pos.entry) * pos.sizeUSD;
    const fee = pos.sizeUSD * FEE_PCT;
    const netPnl = grossPnl - fee;
    balance += netPnl;
    trades.push({ sym:pos.sym, dir:pos.dir, gross:grossPnl, fee, net:netPnl, exitTs:lastBar.t });
  }

  return { balance, trades };
}

function simulateORB(symData) {
  let totalBalance = 0;
  const allTrades = [];

  for (const sym of ORB_SYMBOLS) {
    const bars = symData[sym];
    if (!bars || bars.length < 50) { totalBalance += PER_SYM; continue; }
    let balance = PER_SYM;
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
      const orRange = orHigh - orLow;
      if (orRange <= 0) continue;

      const postOrb = rthBars.slice(ORB.orbBars);
      let traded = false, position = null;

      for (const bar of postOrb) {
        if (isEODBar(bar.t)) {
          if (position) {
            const isL = position.dir==="LONG";
            const exitP = bar.c;
            const grossPnl = ((isL?exitP-position.entry:position.entry-exitP)/position.entry)*position.sizeUSD;
            const fee = position.sizeUSD * FEE_PCT;
            const netPnl = grossPnl - fee;
            balance += netPnl;
            allTrades.push({ sym, dir:position.dir, gross:grossPnl, fee, net:netPnl, exitTs:bar.t });
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
            balance += netPnl;
            allTrades.push({ sym, dir:position.dir, gross:grossPnl, fee, net:netPnl, exitTs:bar.t });
            position = null;
          }
          continue;
        }

        if (traded) continue;
        if (new Date(bar.t).getUTCHours() >= 17) continue;
        const volOk = prevSessionAvgVol===null || bar.v > prevSessionAvgVol;
        if (bar.c > orHigh && volOk) {
          const entry=bar.c, sl=orLow, tp=entry+orRange*ORB.rrRatio, slDist=entry-sl;
          const riskUSD=balance*ORB.riskPct, sizeUSD=(riskUSD/slDist)*entry*ORB.leverage;
          position={dir:"LONG",entry,sl,tp,sizeUSD,riskUSD}; traded=true;
        } else if (bar.c < orLow && volOk) {
          const entry=bar.c, sl=orHigh, tp=entry-orRange*ORB.rrRatio, slDist=sl-entry;
          const riskUSD=balance*ORB.riskPct, sizeUSD=(riskUSD/slDist)*entry*ORB.leverage;
          position={dir:"SHORT",entry,sl,tp,sizeUSD,riskUSD}; traded=true;
        }
      }

      const dayAvgVol = dayBars.reduce((s,b)=>s+b.v,0)/dayBars.length;
      sessionVols.push(dayAvgVol);
      if (sessionVols.length > ORB.volSessionsMA) sessionVols.shift();
    }
    totalBalance += balance;
  }

  return { balance: totalBalance, trades: allTrades };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const endDate   = new Date().toISOString().slice(0,10);
  const startDate = new Date(START_150*1000).toISOString().slice(0,10);

  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║  HERMES WEEKLY P&L BACKTEST (BASELINE + REAL FEES)            ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log(`  Period: ${startDate} → ${endDate}`);
  console.log(`  Fees:   0.06% × 2 = ${(FEE_PCT*100).toFixed(2)}% per round-trip (MEXC taker)`);
  console.log(`  Start:  v09 $${V09.startBalance.toLocaleString()}  |  DT $${DT.startBalance.toLocaleString()}  |  ORB $${ORB.totalBalance.toLocaleString()}  |  Total $${(V09.startBalance+DT.startBalance+ORB.totalBalance).toLocaleString()}`);

  console.log("\n[1/3] Fetching v09 4H data (30 pairs)…");
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
    v09Ind[sym] = { bars, closes, vols,
      e21: emaSeries(closes,21), e50: emaSeries(closes,50), e200: emaSeries(closes,200),
      rsi: rsiSmoothed(closes,14), macd: macdSeries(closes), vsma: smaSeries(vols,20) };
  }

  console.log("\n[2/3] Fetching DT 15min data (6 pairs)…");
  const dtData = {};
  const dtFetchStart = START_150 - 80*15*60;
  for (const sym of DT_PAIRS) {
    process.stdout.write(`  ${sym}…`);
    dtData[sym] = await fetchAllBars(sym, "Min15", 15*60, dtFetchStart, NOW_SEC);
    process.stdout.write(`\r  ${sym.padEnd(20)} ${dtData[sym].length} bars ✓\n`);
    await sleep(150);
  }
  const dtInd = {};
  for (const sym of DT_PAIRS) {
    const bars = dtData[sym]; if (bars.length < 80) continue;
    const closes = bars.map(b=>b.c), vols = bars.map(b=>b.v);
    dtInd[sym] = { bars, closes, vols,
      e21: emaSeries(closes,21), e50: emaSeries(closes,50),
      rsi: rsiSmoothed(closes,14), vsma: smaSeries(vols,20),
      adx: adxSeries(bars,14), bias: dtSessionBias(bars) };
  }

  console.log("\n[3/3] Fetching ORB 5min data (10 stocks)…");
  const orbData = {};
  const orbFetchStart = START_150 - 21*86400;
  for (const sym of ORB_SYMBOLS) {
    process.stdout.write(`  ${sym}…`);
    const bars = await fetchAllBars(sym, "Min5", 5*60, orbFetchStart, NOW_SEC);
    orbData[sym] = bars.filter(b => isRTHBar(b.t) && isWeekdayMs(b.t));
    process.stdout.write(`\r  ${sym.padEnd(24)} ${orbData[sym].length} RTH bars ✓\n`);
    await sleep(200);
  }

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Running simulations with realistic fees applied…");
  console.log("══════════════════════════════════════════════════════════════");

  process.stdout.write("  v09…");
  const v09Res = simulateV09(v09Ind);
  console.log(` $${v09Res.balance.toFixed(0)} | ${v09Res.trades.length} trades`);

  process.stdout.write("  DT…");
  const dtRes = simulateDT(dtInd);
  console.log(` $${dtRes.balance.toFixed(0)} | ${dtRes.trades.length} trades`);

  process.stdout.write("  ORB…");
  const orbRes = simulateORB(orbData);
  console.log(` $${orbRes.balance.toFixed(0)} | ${orbRes.trades.length} trades`);

  // ── Group trades by week ─────────────────────────────────────────────────
  function bucketByWeek(trades, label) {
    const byWeek = {};
    for (const t of trades) {
      const wk = weekKey(t.exitTs);
      if (!byWeek[wk]) byWeek[wk] = { wk, gross:0, fee:0, net:0, trades:0, wins:0 };
      byWeek[wk].gross   += t.gross;
      byWeek[wk].fee     += t.fee;
      byWeek[wk].net     += t.net;
      byWeek[wk].trades  += 1;
      if (t.net > 0) byWeek[wk].wins += 1;
    }
    return byWeek;
  }

  const v09Weeks = bucketByWeek(v09Res.trades, "v09");
  const dtWeeks  = bucketByWeek(dtRes.trades,  "DT");
  const orbWeeks = bucketByWeek(orbRes.trades, "ORB");

  // Union of all week keys, sorted
  const allWeeks = new Set([...Object.keys(v09Weeks), ...Object.keys(dtWeeks), ...Object.keys(orbWeeks)]);
  const sortedWeeks = [...allWeeks].sort();

  // ── Print weekly table ───────────────────────────────────────────────────
  console.log("\n\n╔════════════════════════════════════════════════════════════════════════════════════════════╗");
  console.log("║   WEEK-BY-WEEK P&L (NET OF FEES)                                                          ║");
  console.log("╚════════════════════════════════════════════════════════════════════════════════════════════╝");
  console.log(`\n  ${"Week".padEnd(12)} ${"Start".padEnd(10)}  ${"v09".padStart(10)}  ${"DT".padStart(10)}  ${"ORB".padStart(10)}  ${"Total".padStart(10)}  ${"Cum.".padStart(10)}`);
  console.log(`  ${"".padEnd(12,"─")} ${"".padEnd(10,"─")}  ${"".padStart(10,"─")}  ${"".padStart(10,"─")}  ${"".padStart(10,"─")}  ${"".padStart(10,"─")}  ${"".padStart(10,"─")}`);

  let cumTotal = 0;
  const fmtPnl = (n) => {
    if (n === 0) return "—";
    const s = n >= 0 ? "+" : "";
    return `${s}$${n.toFixed(0)}`;
  };

  for (const wk of sortedWeeks) {
    const v = v09Weeks[wk]?.net ?? 0;
    const d = dtWeeks[wk]?.net  ?? 0;
    const o = orbWeeks[wk]?.net ?? 0;
    const total = v + d + o;
    cumTotal += total;
    const monday = weekStartDate(wk);
    console.log(`  ${wk.padEnd(12)} ${monday.padEnd(10)}  ${fmtPnl(v).padStart(10)}  ${fmtPnl(d).padStart(10)}  ${fmtPnl(o).padStart(10)}  ${fmtPnl(total).padStart(10)}  ${fmtPnl(cumTotal).padStart(10)}`);
  }

  // ── Summary totals ───────────────────────────────────────────────────────
  console.log(`  ${"".padEnd(12,"─")} ${"".padEnd(10,"─")}  ${"".padStart(10,"─")}  ${"".padStart(10,"─")}  ${"".padStart(10,"─")}  ${"".padStart(10,"─")}  ${"".padStart(10,"─")}`);
  const totalV09 = Object.values(v09Weeks).reduce((s,w)=>s+w.net,0);
  const totalDT  = Object.values(dtWeeks ).reduce((s,w)=>s+w.net,0);
  const totalORB = Object.values(orbWeeks).reduce((s,w)=>s+w.net,0);
  const grand    = totalV09 + totalDT + totalORB;
  console.log(`  ${"TOTAL".padEnd(12)} ${"".padEnd(10)}  ${fmtPnl(totalV09).padStart(10)}  ${fmtPnl(totalDT).padStart(10)}  ${fmtPnl(totalORB).padStart(10)}  ${fmtPnl(grand).padStart(10)}`);

  // ── Fees breakdown ──────────────────────────────────────────────────────
  const totalFeesV09 = Object.values(v09Weeks).reduce((s,w)=>s+w.fee,0);
  const totalFeesDT  = Object.values(dtWeeks ).reduce((s,w)=>s+w.fee,0);
  const totalFeesORB = Object.values(orbWeeks).reduce((s,w)=>s+w.fee,0);
  const totalFees    = totalFeesV09 + totalFeesDT + totalFeesORB;
  console.log(`\n  Fees:    v09 $${totalFeesV09.toFixed(0)} | DT $${totalFeesDT.toFixed(0)} | ORB $${totalFeesORB.toFixed(0)} | Total $${totalFees.toFixed(0)}`);
  console.log(`  Trades:  v09 ${v09Res.trades.length} | DT ${dtRes.trades.length} | ORB ${orbRes.trades.length} | Total ${v09Res.trades.length+dtRes.trades.length+orbRes.trades.length}`);

  // ── Final balances ──────────────────────────────────────────────────────
  const totalStart = V09.startBalance + DT.startBalance + ORB.totalBalance;
  const totalEnd   = v09Res.balance + dtRes.balance + orbRes.balance;
  console.log(`\n  Final balances:`);
  console.log(`    v09: $${V09.startBalance.toLocaleString()} → $${v09Res.balance.toFixed(0)}  (${((v09Res.balance-V09.startBalance)/V09.startBalance*100).toFixed(1)}%)`);
  console.log(`    DT:  $${DT.startBalance.toLocaleString()} → $${dtRes.balance.toFixed(0)}  (${((dtRes.balance-DT.startBalance)/DT.startBalance*100).toFixed(1)}%)`);
  console.log(`    ORB: $${ORB.totalBalance.toLocaleString()} → $${orbRes.balance.toFixed(0)}  (${((orbRes.balance-ORB.totalBalance)/ORB.totalBalance*100).toFixed(1)}%)`);
  console.log(`    ──────────────────────────────────`);
  console.log(`    Portfolio: $${totalStart.toLocaleString()} → $${totalEnd.toFixed(0)}  (${((totalEnd-totalStart)/totalStart*100).toFixed(1)}%)`);

  // ── Week summary stats ──────────────────────────────────────────────────
  const weekNets = sortedWeeks.map(wk => {
    const v = v09Weeks[wk]?.net ?? 0, d = dtWeeks[wk]?.net ?? 0, o = orbWeeks[wk]?.net ?? 0;
    return v + d + o;
  });
  const winWeeks = weekNets.filter(n => n > 0).length;
  const lossWeeks= weekNets.filter(n => n < 0).length;
  const bestWk   = Math.max(...weekNets);
  const worstWk  = Math.min(...weekNets);

  console.log(`\n  Week stats:`);
  console.log(`    Winning weeks: ${winWeeks} / ${sortedWeeks.length}  (${(winWeeks/sortedWeeks.length*100).toFixed(0)}%)`);
  console.log(`    Losing weeks:  ${lossWeeks} / ${sortedWeeks.length}  (${(lossWeeks/sortedWeeks.length*100).toFixed(0)}%)`);
  console.log(`    Best week:     ${fmtPnl(bestWk)}`);
  console.log(`    Worst week:    ${fmtPnl(worstWk)}`);
  console.log(`    Avg per week:  ${fmtPnl(grand/sortedWeeks.length)}`);

  const mins = ((Date.now()-t0)/60000).toFixed(1);
  console.log(`\n  Backtest time: ${mins} min\n`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
