/**
 * backtest_all.js — 150-Day unified backtest for all three strategies
 *
 * Strategies:
 *   1. v09 crypto (4H, 30 pairs, $10K, 0.8% risk, 1.5× leverage)
 *   2. DT crypto  (15min, 6 pairs, $8.75K, 0.8% risk, 5× leverage)
 *   3. ORB stocks (5min RTH, 10 symbols, $6.25K, 1% risk, 5× leverage)
 *
 * P&L model (matching the live bots exactly):
 *   P&L = (priceDiff / entry) × sizeUSD
 *   where sizeUSD = (riskUSD / slDist) × entry × leverage  [DT, ORB]
 *   or    pnl     = priceChange% × (riskUSD/slPct) × leverage  [v09]
 *   ⇒ At SL, loss = riskUSD × leverage (for all three strategies)
 *
 * Run: node backtest_all.js
 */

import "dotenv/config";

const MEXC_BASE  = "https://futures.mexc.com";
const DAYS       = 150;
const NOW_SEC    = Math.floor(Date.now() / 1000);
const START_150  = NOW_SEC - DAYS * 86400;

// ──────────────────────────────────────────────────────────────────────────────
// DATA FETCHING (with pagination)
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
      t: t * 1000, o: +open[i], c: +close[i], h: +high[i], l: +low[i], v: +vol[i],
    })).sort((a, b) => a.t - b.t);
  } catch { return []; }
}

async function fetchAllBars(symbol, intervalStr, barSecs, startSec, endSec, label = "") {
  const bars      = [];
  const chunk     = 1800 * barSecs; // ~1800 bars per request
  let   cur       = startSec;
  let   page      = 0;
  let   emptyRuns = 0;
  while (cur < endSec) {
    page++;
    const end = Math.min(cur + chunk, endSec);
    if (label) process.stdout.write(`\r  ${label} (chunk ${page})…         `);
    const batch = await fetchChunk(symbol, intervalStr, cur, end);
    if (!batch.length) {
      // Symbol may not have existed yet — skip forward and try next chunk
      emptyRuns++;
      if (emptyRuns >= 5) break;  // give up after 5 consecutive empty chunks
      cur = end + barSecs;
      await sleep(120);
      continue;
    }
    emptyRuns = 0;
    bars.push(...batch);
    cur = Math.floor(batch[batch.length - 1].t / 1000) + barSecs;
    await sleep(180);
  }
  if (label) process.stdout.write("\r");
  const seen = new Set();
  return bars.filter(b => { if (seen.has(b.t)) return false; seen.add(b.t); return true; })
             .sort((a, b) => a.t - b.t);
}

// ──────────────────────────────────────────────────────────────────────────────
// SHARED INDICATORS
// ──────────────────────────────────────────────────────────────────────────────

function emaSeries(vals, p) {
  const k = 2 / (p + 1), out = [vals[0]];
  for (let i = 1; i < vals.length; i++) out.push(vals[i] * k + out[i-1] * (1-k));
  return out;
}
function smaSeries(vals, p) {
  return vals.map((_, i) =>
    i < p-1 ? null : vals.slice(i-p+1, i+1).reduce((a,b)=>a+b,0)/p);
}
function rsiSmoothed(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d=closes[i]-closes[i-1]; d>0?g+=d:l-=d; }
  out[period] = l===0?100:100-100/(1+g/l);
  for (let i = period+1; i < closes.length; i++) {
    const d=closes[i]-closes[i-1];
    if(d>0){g=(g*(period-1)+d)/period;l=l*(period-1)/period;}
    else   {g=g*(period-1)/period;l=(l*(period-1)-d)/period;}
    out[i]=l===0?100:100-100/(1+g/l);
  }
  return out;
}
function macdSeries(closes, f=12, s=26, sig=9) {
  const fast=emaSeries(closes,f),slow=emaSeries(closes,s);
  const line=closes.map((_,i)=>fast[i]-slow[i]);
  const signal=[line[0]];const k=2/(sig+1);
  for(let i=1;i<closes.length;i++) signal.push(line[i]*k+signal[i-1]*(1-k));
  return{line,signal,hist:line.map((v,i)=>v-signal[i])};
}
function adxSeries(bars, period=14) {
  const n=bars.length,out=new Array(n).fill(null),tr=[],pdm=[],ndm=[];
  for(let i=1;i<n;i++){
    const h=bars[i].h,l=bars[i].l,pc=bars[i-1].c,ph=bars[i-1].h,pl=bars[i-1].l;
    tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
    const up=h-ph,dn=pl-l;
    pdm.push(up>dn&&up>0?up:0); ndm.push(dn>up&&dn>0?dn:0);
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
// STRATEGY 1: V09 CRYPTO (4H)
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
  startBalance:    10000,
  riskPct:         0.008,
  minRisk:         2,
  leverage:        1.5,
  slPct:           0.065,
  tpPct:           0.23,
  trailPct:        0.19,
  rebSlPct:        0.035,
  rebTpPct:        0.22,
  rsiOversold:     20,
  rsiOverbought:   80,
  brsiMin:         54,
  brsiMax:         65,
  lookback:        30,
  maxPositions:    10,
  warmupDays:      92,   // enough for EMA200
};

function v09Regime(i, closes, e21, e50, e200) {
  if (!e200[i]||!e50[i]||!e21[i]) return "neutral";
  const c=closes[i]; let score=0;
  if(c>e200[i])score++;else score--;if(c>e50[i])score++;else score--;
  if(c>e21[i])score++;else score--;if(e21[i]>e50[i])score++;else score--;
  if(e50[i]>e200[i])score++;else score--;
  return score>=4?"bull":score<=-4?"bear":"neutral";
}
function v09Risk(reg, dir, balance) {
  const base = Math.max(balance * V09.riskPct, V09.minRisk);
  if (reg==="neutral") return base*0.75;
  const wt = (reg==="bull"&&dir==="LONG")||(reg==="bear"&&dir==="SHORT");
  return wt ? base : base*0.5;
}
function v09Signal(i, closes, vols, e21, e50, e200, rsi, mc, vsma) {
  if (i < 22 || !rsi[i] || !rsi[i-1] || !vsma[i] || !e200[i]) return null;
  const c=closes[i],rNow=rsi[i],rPrv=rsi[i-1],vol=vols[i],reg=v09Regime(i,closes,e21,e50,e200);

  // Breakout LONG
  const highN  = Math.max(...closes.slice(Math.max(0,i-V09.lookback),i));
  const trendUp= e21[i]>e50[i]&&e21[i]>e21[i-1]&&e21[i-1]>e21[i-3];
  const lBreak = c>highN && trendUp && rNow>=V09.brsiMin && rNow<=V09.brsiMax && vol>vsma[i]*1.5;

  // Breakdown SHORT
  const wasOB  =[1,2,3,4,5].some(k=>rsi[i-k]!=null&&rsi[i-k]>=65);
  const rsiBrk = rPrv>=58&&rNow<58;
  const macdBrk= mc.hist[i-1]>=0&&mc.hist[i]<0;
  const sBreak = wasOB&&(rsiBrk||macdBrk)&&c<e21[i]&&rNow>35&&vol>vsma[i]*1.2;

  // Rebound LONG (oversold)
  const wasOS   =[1,2,3].some(k=>rsi[i-k]!=null&&rsi[i-k]<=V09.rsiOversold);
  const rsiTurnU= rPrv<=30&&rNow>30;
  const lRebound= wasOS&&rsiTurnU&&reg==="bull"&&c>e21[i]*0.92&&vol>vsma[i]*1.0&&!lBreak;

  // Rebound SHORT (overbought)
  const wasOVB  =[1,2,3].some(k=>rsi[i-k]!=null&&rsi[i-k]>=V09.rsiOverbought);
  const rsiTurnD= rPrv>=70&&rNow<70;
  const sRebound= wasOVB&&rsiTurnD&&reg!=="bull"&&c<e21[i]*1.08&&vol>vsma[i]*1.0&&!sBreak;

  return { lBreak, sBreak, lRebound, sRebound, reg };
}

async function runV09() {
  console.log("\n══════════════════════════════════════════");
  console.log("  STRATEGY 1 — v09 CRYPTO (4H, 30 pairs)");
  console.log("══════════════════════════════════════════");
  console.log(`  Portfolio: $${V09.startBalance.toLocaleString()} | Risk: ${V09.riskPct*100}% | Leverage: ${V09.leverage}x`);
  console.log(`  SL: ${V09.slPct*100}% | TP: ${V09.tpPct*100}% | Trail: ${V09.trailPct*100}% (auto mode)`);
  console.log(`  Fetching ${DAYS + V09.warmupDays} days of 4H data for ${V09_PAIRS.length} pairs…`);

  // --- Fetch data ---
  const barSec = 4*3600;
  const fetchStart = NOW_SEC - (DAYS + V09.warmupDays) * 86400;
  const V09_INTERVAL = "Hour4";  // MEXC uses Hour4 not Min240 for 4H bars
  const pairData = {};

  for (const sym of V09_PAIRS) {
    process.stdout.write(`  Loading ${sym}…`);
    const bars = await fetchAllBars(sym, V09_INTERVAL, barSec, fetchStart, NOW_SEC);
    pairData[sym] = bars;
    process.stdout.write(`\r  ${sym.padEnd(20)} ${bars.length} bars ✓\n`);
    await sleep(150);
  }

  // --- Determine trading bar indices (last 150 days) ---
  const tradeStart = START_150;

  // --- Pre-compute indicators per symbol ---
  const indicators = {};
  for (const sym of V09_PAIRS) {
    const bars   = pairData[sym];
    if (bars.length < 210) { console.log(`  ⚠️  ${sym}: insufficient data (${bars.length} bars), skipping`); continue; }
    const closes = bars.map(b=>b.c);
    const vols   = bars.map(b=>b.v);
    indicators[sym] = {
      bars,
      closes,
      vols,
      e21:  emaSeries(closes, 21),
      e50:  emaSeries(closes, 50),
      e200: emaSeries(closes, 200),
      rsi:  rsiSmoothed(closes, 14),
      macd: macdSeries(closes),
      vsma: smaSeries(vols, 20),
    };
  }

  // --- Simulation ---
  let balance    = V09.startBalance;
  let peak       = balance;
  let maxDD      = 0;
  const positions = [];  // { sym, dir, entryPrice, sl, tp, size, riskUSD, trailing, trailHigh, trailLow, noTrail }
  const trades    = [];

  // Determine bull pct for trail mode
  function calcBullPct(barIdx, symList) {
    let bulls = 0;
    for (const sym of symList) {
      const ind = indicators[sym]; if (!ind) continue;
      const i = barIdx;
      if (i >= ind.closes.length) continue;
      const r = v09Regime(i, ind.closes, ind.e21, ind.e50, ind.e200);
      if (r==="bull") bulls++;
    }
    return (bulls / symList.length) * 100;
  }

  // Get all unique 4H bar timestamps across all symbols, within trade window
  const allTimestamps = new Set();
  for (const sym of V09_PAIRS) {
    const ind = indicators[sym]; if (!ind) continue;
    for (const b of ind.bars) {
      if (b.t/1000 >= tradeStart) allTimestamps.add(b.t);
    }
  }
  const sortedTs = [...allTimestamps].sort((a,b)=>a-b);

  for (const ts of sortedTs) {
    // 1. Process exits for all open positions using the bar at this timestamp
    for (let p = positions.length-1; p >= 0; p--) {
      const pos = positions[p];
      const ind = indicators[pos.sym]; if (!ind) continue;
      const bi  = ind.bars.findIndex(b => b.t === ts);
      if (bi < 0) continue;
      const bar = ind.bars[bi];
      const isL = pos.dir==="LONG";

      let pnl = 0, exitReason = null, exitPrice = null;

      if (pos.trailing) {
        // Update trail
        if (isL && bar.h > pos.trailHigh) { pos.trailHigh=bar.h; pos.sl=bar.h*(1-V09.trailPct); }
        else if (!isL && bar.l < pos.trailLow) { pos.trailLow=bar.l; pos.sl=bar.l*(1+V09.trailPct); }
        const hitTrail = isL ? bar.l<=pos.sl : bar.h>=pos.sl;
        if (hitTrail) { exitReason="TRAIL_SL"; exitPrice=pos.sl; }
      } else {
        const hitSL = isL ? bar.l<=pos.sl : bar.h>=pos.sl;
        const hitTP = isL ? bar.h>=pos.tp : bar.l<=pos.tp;
        if (hitSL&&hitTP) { exitReason="SL"; exitPrice=pos.sl; }
        else if (hitSL) { exitReason="SL"; exitPrice=pos.sl; }
        else if (hitTP && pos.noTrail) { exitReason="TP"; exitPrice=pos.tp; }
        else if (hitTP) {
          pos.trailing=true;
          pos.trailHigh=isL?pos.tp:Infinity; pos.trailLow=isL?0:pos.tp;
          pos.sl=isL?pos.tp*(1-V09.trailPct):pos.tp*(1+V09.trailPct);
        }
      }

      if (exitReason) {
        const raw = isL ? (exitPrice-pos.entryPrice)/pos.entryPrice*pos.size
                       : (pos.entryPrice-exitPrice)/pos.entryPrice*pos.size;
        pnl = raw * V09.leverage;
        balance += pnl;
        if (balance > peak) peak = balance;
        const dd = (peak-balance)/peak*100; if (dd>maxDD) maxDD=dd;
        trades.push({ sym:pos.sym, dir:pos.dir, pnl, reason:exitReason, ts });
        positions.splice(p, 1);
      }
    }

    // 2. Bull pct for trail-mode decision
    // (Computed lazily here — approx based on current bar index)
    const bullPct = calcBullPct(
      // Use first symbol's index as proxy bar index
      (() => { const ind=indicators[V09_PAIRS[0]]; if(!ind) return 0; return ind.bars.findIndex(b=>b.t===ts); })(),
      V09_PAIRS
    );
    const trailActive = bullPct >= 60; // TRAIL_AUTO_BULL_PCT=60

    // 3. Check entries (only open bars in trade window)
    if (positions.length < V09.maxPositions) {
      for (const sym of V09_PAIRS) {
        if (positions.some(p=>p.sym===sym)) continue;
        const ind = indicators[sym]; if (!ind) continue;
        const bi  = ind.bars.findIndex(b => b.t === ts);
        if (bi < 1) continue;
        const i   = bi - 1; // signal bar = previous closed bar

        const sig = v09Signal(i, ind.closes, ind.vols, ind.e21, ind.e50, ind.e200, ind.rsi, ind.macd, ind.vsma);
        if (!sig) continue;

        const hasSig = sig.lBreak||sig.sBreak||sig.lRebound||sig.sRebound;
        if (!hasSig) continue;

        // Pick signal priority: breakout > rebound
        let dir, isRebound;
        if (sig.lBreak)  { dir="LONG";  isRebound=false; }
        else if (sig.sBreak)  { dir="SHORT"; isRebound=false; }
        else if (sig.lRebound){ dir="LONG";  isRebound=true;  }
        else                  { dir="SHORT"; isRebound=true;  }

        const riskUSD = v09Risk(sig.reg, dir, balance);
        const slPct   = isRebound ? V09.rebSlPct : V09.slPct;
        const tpPct   = isRebound ? V09.rebTpPct : V09.tpPct;
        const noTrail = !trailActive; // if not bull market, use hard TP
        const entryP  = ind.bars[bi].o; // enter at next bar open (conservative)
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

  // Force-close any open positions at last price
  for (const pos of positions) {
    const ind = indicators[pos.sym]; if (!ind) continue;
    const lastBar = ind.bars[ind.bars.length-1];
    const exitP = lastBar.c;
    const isL   = pos.dir==="LONG";
    const raw   = isL ? (exitP-pos.entryPrice)/pos.entryPrice*pos.size
                      : (pos.entryPrice-exitP)/pos.entryPrice*pos.size;
    const pnl   = raw * V09.leverage;
    balance += pnl;
    trades.push({ sym:pos.sym, dir:pos.dir, pnl, reason:"OPEN@END", ts:Date.now() });
  }

  const winTrades  = trades.filter(t=>t.pnl>0);
  const loseTrades = trades.filter(t=>t.pnl<0);
  const totalPnl   = trades.reduce((s,t)=>s+t.pnl,0);
  const winRate    = trades.length ? (winTrades.length/trades.length*100).toFixed(1) : "0";
  const avgWin     = winTrades.length  ? winTrades.reduce((s,t)=>s+t.pnl,0)/winTrades.length  : 0;
  const avgLoss    = loseTrades.length ? loseTrades.reduce((s,t)=>s+t.pnl,0)/loseTrades.length : 0;

  console.log(`\n  ── V09 Results (${DAYS} days) ──`);
  console.log(`  Start:       $${V09.startBalance.toLocaleString()}`);
  console.log(`  End:         $${balance.toFixed(2)}`);
  console.log(`  Return:      ${((balance-V09.startBalance)/V09.startBalance*100).toFixed(1)}%`);
  console.log(`  Peak:        $${peak.toFixed(2)}`);
  console.log(`  Max DD:      ${maxDD.toFixed(1)}%`);
  console.log(`  Trades:      ${trades.length}  (W:${winTrades.length} / L:${loseTrades.length})`);
  console.log(`  Win Rate:    ${winRate}%`);
  console.log(`  Avg Win:     $${avgWin.toFixed(2)}`);
  console.log(`  Avg Loss:    $${avgLoss.toFixed(2)}`);
  if (avgLoss!==0) console.log(`  Profit Fact: ${(winTrades.reduce((s,t)=>s+t.pnl,0)/Math.abs(loseTrades.reduce((s,t)=>s+t.pnl,0))).toFixed(2)}`);

  return { name:"v09", start:V09.startBalance, end:balance, pnl:totalPnl, trades:trades.length, winRate, maxDD };
}

// ──────────────────────────────────────────────────────────────────────────────
// STRATEGY 2: DT CRYPTO (15min)
// ──────────────────────────────────────────────────────────────────────────────

const DT_PAIRS = ["BTC_USDT","BNB_USDT","XRP_USDT","SUI_USDT","LTC_USDT","AVAX_USDT"];
const DT_EMA50_PAIRS = new Set(["BTC_USDT","SUI_USDT"]);

const DT = {
  startBalance: 8750,
  riskPct:      0.008,
  leverage:     5,
  rrRatio:      1.3,
  maxHold:      12, // bars
  maxSLPct:     0.012,
  maxPositions: 6,
};

// Session ORB bias (session opens at UTC hours 1, 8, 13)
function dtSessionBias(bars) {
  const bias = new Array(bars.length).fill(null);
  let orbH=-Infinity,orbL=Infinity,building=false,confirmed=null,curBias=null;
  for (let j=0;j<bars.length;j++) {
    const h=new Date(bars[j].t).getUTCHours(),m=new Date(bars[j].t).getUTCMinutes();
    if([1,8,13].includes(h)&&m===0) { building=true;orbH=bars[j].h;orbL=bars[j].l;confirmed=null;curBias=null; }
    else if(building) { orbH=Math.max(orbH,bars[j].h);orbL=Math.min(orbL,bars[j].l);confirmed={h:orbH,l:orbL};building=false; }
    if(confirmed&&curBias===null) {
      if(bars[j].c>confirmed.h) curBias="LONG";
      else if(bars[j].c<confirmed.l) curBias="SHORT";
    }
    bias[j]=confirmed?curBias:null;
  }
  return bias;
}

async function runDT() {
  console.log("\n══════════════════════════════════════════");
  console.log("  STRATEGY 2 — DT CRYPTO (15min, 6 pairs)");
  console.log("══════════════════════════════════════════");
  console.log(`  Portfolio: $${DT.startBalance.toLocaleString()} | Risk: ${DT.riskPct*100}% | Leverage: ${DT.leverage}x`);
  console.log(`  R:R: 1:${DT.rrRatio} | Max hold: ${DT.maxHold} bars (3h) | ADX > 20`);
  console.log(`  Fetching ${DAYS} days of 15min data for ${DT_PAIRS.length} pairs…`);

  const barSec = 15*60;
  const warmup = 80 * barSec; // 80 bars for indicator warmup
  const fetchStart = START_150 - warmup;

  const pairData = {};
  for (const sym of DT_PAIRS) {
    process.stdout.write(`  Loading ${sym}…`);
    const bars = await fetchAllBars(sym, "Min15", barSec, fetchStart, NOW_SEC, sym);
    pairData[sym] = bars;
    process.stdout.write(`\r  ${sym.padEnd(20)} ${bars.length} bars ✓\n`);
    await sleep(150);
  }

  // Pre-compute indicators
  const indicators = {};
  for (const sym of DT_PAIRS) {
    const bars   = pairData[sym];
    if (bars.length < 80) { console.log(`  ⚠️  ${sym}: insufficient data`); continue; }
    const closes = bars.map(b=>b.c), vols=bars.map(b=>b.v);
    indicators[sym] = {
      bars, closes, vols,
      e21:  emaSeries(closes, 21),
      e50:  emaSeries(closes, 50),
      rsi:  rsiSmoothed(closes, 14),
      vsma: smaSeries(vols, 20),
      adx:  adxSeries(bars, 14),
      bias: dtSessionBias(bars),
    };
  }

  // Simulation
  let balance = DT.startBalance, peak = balance, maxDD = 0;
  const positions = []; // { sym, dir, signal, entry, sl, tp, sizeUSD, riskUSD, entryBarIdx, entryTs }
  const trades    = [];

  // Collect all 15min timestamps in trading window
  const allTs = new Set();
  for (const sym of DT_PAIRS) {
    const ind = indicators[sym]; if (!ind) continue;
    for (const b of ind.bars) { if (b.t/1000 >= START_150) allTs.add(b.t); }
  }
  const sortedTs = [...allTs].sort((a,b)=>a-b);

  for (const ts of sortedTs) {
    // 1. Exit check
    for (let p = positions.length-1; p >= 0; p--) {
      const pos = positions[p];
      const ind = indicators[pos.sym]; if (!ind) continue;
      const bi  = ind.bars.findIndex(b=>b.t===ts);
      if (bi<0) continue;
      const bar  = ind.bars[bi];
      const isL  = pos.dir==="LONG";
      const barsHeld = bi - pos.entryBarIdx;
      const hitSL = isL ? bar.l<=pos.sl : bar.h>=pos.sl;
      const hitTP = isL ? bar.h>=pos.tp : bar.l<=pos.tp;
      const timeExit = barsHeld >= DT.maxHold;

      let exitReason=null, exitPrice=null;
      if(hitSL&&hitTP) { exitReason="SL"; exitPrice=pos.sl; }
      else if(hitSL)   { exitReason="SL"; exitPrice=pos.sl; }
      else if(hitTP)   { exitReason="TP"; exitPrice=pos.tp; }
      else if(timeExit){ exitReason="TIME"; exitPrice=bar.c; }

      if (exitReason) {
        const pnl = ((isL?exitPrice-pos.entry:pos.entry-exitPrice)/pos.entry) * pos.sizeUSD;
        balance += pnl;
        if(balance>peak)peak=balance;
        const dd=(peak-balance)/peak*100;if(dd>maxDD)maxDD=dd;
        trades.push({ sym:pos.sym, dir:pos.dir, pnl, reason:exitReason });
        positions.splice(p, 1);
      }
    }

    // 2. Entry check
    if (positions.length < DT.maxPositions) {
      for (const sym of DT_PAIRS) {
        if (positions.some(p=>p.sym===sym)) continue;
        const ind = indicators[sym]; if (!ind) continue;
        const bi  = ind.bars.findIndex(b=>b.t===ts);
        if (bi < 3) continue;
        const i = bi-1; // last closed bar (signal bar)
        const prev = i-1;

        if (!ind.rsi[i]||!ind.vsma[i]||!ind.adx[i]||ind.adx[i]<20) continue;
        const entryHour = new Date(ind.bars[i].t).getUTCHours();
        if (entryHour>=1&&entryHour<8) continue; // no Asia session

        const bias = ind.bias[i];
        if (!bias) continue;

        const c=ind.bars[i], p2=ind.bars[prev];
        const r=ind.rsi[i], volOk=c.v>ind.vsma[i]*1.2;
        const e50Up=ind.e50[i]>ind.e50[i-4], e50Dn=ind.e50[i]<ind.e50[i-4];
        const longRsi=r>=40&&r<65, shortRsi=r>35&&r<=60;

        let sig = null;
        if (bias==="LONG") {
          if(e50Up&&longRsi&&volOk&&p2.c<ind.e21[prev]&&c.c>ind.e21[i]) {
            const swL=Math.min(...ind.bars.slice(Math.max(0,i-3),i+1).map(x=>x.l));
            const risk=c.c-swL;
            if(risk>0&&risk/c.c<DT.maxSLPct) sig={dir:"LONG",entry:c.c,sl:swL,tp:c.c+risk*DT.rrRatio,signal:"EMA21"};
          }
          if(!sig&&DT_EMA50_PAIRS.has(sym)&&e50Up&&r>=38&&r<62&&volOk&&p2.c<ind.e50[prev]&&c.c>ind.e50[i]) {
            const swL=Math.min(...ind.bars.slice(Math.max(0,i-4),i+1).map(x=>x.l));
            const risk=c.c-swL;
            if(risk>0&&risk/c.c<0.018) sig={dir:"LONG",entry:c.c,sl:swL,tp:c.c+risk*DT.rrRatio,signal:"EMA50"};
          }
        }
        if (!sig&&bias==="SHORT") {
          if(e50Dn&&shortRsi&&volOk&&p2.c>ind.e21[prev]&&c.c<ind.e21[i]) {
            const swH=Math.max(...ind.bars.slice(Math.max(0,i-3),i+1).map(x=>x.h));
            const risk=swH-c.c;
            if(risk>0&&risk/c.c<DT.maxSLPct) sig={dir:"SHORT",entry:c.c,sl:swH,tp:c.c-risk*DT.rrRatio,signal:"EMA21"};
          }
          if(!sig&&DT_EMA50_PAIRS.has(sym)&&e50Dn&&r>38&&r<=62&&volOk&&p2.c>ind.e50[prev]&&c.c<ind.e50[i]) {
            const swH=Math.max(...ind.bars.slice(Math.max(0,i-4),i+1).map(x=>x.h));
            const risk=swH-c.c;
            if(risk>0&&risk/c.c<0.018) sig={dir:"SHORT",entry:c.c,sl:swH,tp:c.c-risk*DT.rrRatio,signal:"EMA50"};
          }
        }
        if (!sig) continue;

        const riskUSD = balance * DT.riskPct;
        const slDist  = Math.abs(sig.entry-sig.sl);
        const sizeUSD = (riskUSD/slDist)*sig.entry*DT.leverage;
        positions.push({ sym, dir:sig.dir, signal:sig.signal, entry:sig.entry, sl:sig.sl, tp:sig.tp,
                         sizeUSD, riskUSD, entryBarIdx:bi, entryTs:ts });
        if(positions.length>=DT.maxPositions) break;
      }
    }
  }

  // Close open positions at last price
  for (const pos of positions) {
    const ind = indicators[pos.sym]; if(!ind) continue;
    const exitP = ind.bars[ind.bars.length-1].c;
    const isL   = pos.dir==="LONG";
    const pnl   = ((isL?exitP-pos.entry:pos.entry-exitP)/pos.entry)*pos.sizeUSD;
    balance += pnl;
    trades.push({ sym:pos.sym, dir:pos.dir, pnl, reason:"OPEN@END" });
  }

  const winTrades  = trades.filter(t=>t.pnl>0);
  const loseTrades = trades.filter(t=>t.pnl<0);
  const totalPnl   = trades.reduce((s,t)=>s+t.pnl,0);
  const winRate    = trades.length?(winTrades.length/trades.length*100).toFixed(1):"0";
  const avgWin     = winTrades.length?winTrades.reduce((s,t)=>s+t.pnl,0)/winTrades.length:0;
  const avgLoss    = loseTrades.length?loseTrades.reduce((s,t)=>s+t.pnl,0)/loseTrades.length:0;

  console.log(`\n  ── DT Results (${DAYS} days) ──`);
  console.log(`  Start:       $${DT.startBalance.toLocaleString()}`);
  console.log(`  End:         $${balance.toFixed(2)}`);
  console.log(`  Return:      ${((balance-DT.startBalance)/DT.startBalance*100).toFixed(1)}%`);
  console.log(`  Peak:        $${peak.toFixed(2)}`);
  console.log(`  Max DD:      ${maxDD.toFixed(1)}%`);
  console.log(`  Trades:      ${trades.length}  (W:${winTrades.length} / L:${loseTrades.length})`);
  console.log(`  Win Rate:    ${winRate}%`);
  console.log(`  Avg Win:     $${avgWin.toFixed(2)}`);
  console.log(`  Avg Loss:    $${avgLoss.toFixed(2)}`);
  if(avgLoss!==0) console.log(`  Profit Fact: ${(winTrades.reduce((s,t)=>s+t.pnl,0)/Math.abs(loseTrades.reduce((s,t)=>s+t.pnl,0))).toFixed(2)}`);

  return { name:"DT", start:DT.startBalance, end:balance, pnl:totalPnl, trades:trades.length, winRate, maxDD };
}

// ──────────────────────────────────────────────────────────────────────────────
// STRATEGY 3: ORB STOCKS (5min RTH)
// ──────────────────────────────────────────────────────────────────────────────

const ORB_SYMBOLS = [
  "CSCOSTOCK_USDT","NFLXSTOCK_USDT","AVGOSTOCK_USDT","JPMSTOCK_USDT","MRVLSTOCK_USDT",
  "MSFTSTOCK_USDT","ASMLSTOCK_USDT","PLTRSTOCK_USDT","ARMSTOCK_USDT","WMTSTOCK_USDT",
];

const ORB = {
  totalBalance:  6250,
  riskPct:       0.01,
  leverage:      5,
  rrRatio:       1.5,
  orbBars:       6,    // 30 min / 5 min = 6 bars (skip 13:30 open bar)
  eodH:          19, eodM: 55,
  volSessionsMA: 20,
};

const PER_SYM = ORB.totalBalance / ORB_SYMBOLS.length; // $625 each

function isRTHBar(ms) {
  const h=new Date(ms).getUTCHours(),m=new Date(ms).getUTCMinutes();
  const mins=h*60+m;
  return mins>=13*60+30 && mins<20*60;
}
function isOpenBar(ms) {
  const d=new Date(ms); return d.getUTCHours()===13&&d.getUTCMinutes()===30;
}
function isEODBar(ms) {
  const d=new Date(ms),h=d.getUTCHours(),m=d.getUTCMinutes();
  return h>19||(h===19&&m>=55);
}
function dayKey(ms) { return new Date(ms).toISOString().slice(0,10); }
function isWeekdayMs(ms) { const d=new Date(ms).getUTCDay(); return d>=1&&d<=5; }

async function runORB() {
  console.log("\n══════════════════════════════════════════");
  console.log("  STRATEGY 3 — ORB STOCKS (5min RTH)");
  console.log("══════════════════════════════════════════");
  console.log(`  Portfolio: $${ORB.totalBalance.toLocaleString()} ($${PER_SYM}/symbol) | Risk: ${ORB.riskPct*100}% | Leverage: ${ORB.leverage}x`);
  console.log(`  OR window: 30min | TP: ${ORB.rrRatio}× OR range | SL: opposite OR side`);
  console.log(`  Fetching ${DAYS} days of 5min data for ${ORB_SYMBOLS.length} symbols…`);

  const barSec = 5*60;
  const fetchStart = START_150 - 21*86400; // 21 extra days for vol baseline warmup

  const symData = {};
  for (const sym of ORB_SYMBOLS) {
    process.stdout.write(`  Loading ${sym}…`);
    const bars = await fetchAllBars(sym, "Min5", barSec, fetchStart, NOW_SEC, sym);
    // Filter to RTH bars only
    const rthBars = bars.filter(b => isRTHBar(b.t) && isWeekdayMs(b.t));
    symData[sym] = rthBars;
    process.stdout.write(`\r  ${sym.padEnd(24)} ${rthBars.length} RTH bars ✓\n`);
    await sleep(200);
  }

  // Simulation per symbol (independent)
  const allResults = [];
  let totalBalance = 0;
  let grandTrades = 0, grandWins = 0, grandMaxDD = 0;

  for (const sym of ORB_SYMBOLS) {
    const bars = symData[sym];
    if (bars.length < 50) {
      console.log(`  ⚠️  ${sym}: only ${bars.length} RTH bars — skipping`);
      allResults.push({ sym, balance:PER_SYM, trades:0, winRate:"N/A" });
      totalBalance += PER_SYM;
      continue;
    }

    let balance = PER_SYM, peak = balance, maxDD = 0;
    const trades = [];

    // Group bars by day
    const days = {};
    for (const b of bars) {
      const k = dayKey(b.t);
      if (!days[k]) days[k] = [];
      days[k].push(b);
    }
    const dayKeys = Object.keys(days).sort();

    // Rolling vol baseline (rolling 20-session RTH avg volume)
    const sessionVols = [];

    for (const dk of dayKeys) {
      const dayBars = days[dk].sort((a,b)=>a.t-b.t);

      // Skip non-trading days (shouldn't happen, just in case)
      if (!dayBars.length) continue;

      // Update vol baseline with this session's data (before processing today)
      const prevSessionAvgVol = sessionVols.length > 0
        ? sessionVols.reduce((a,b)=>a+b,0)/sessionVols.length : null;

      // Separate open bar from rest
      const rthBars = dayBars.filter(b=>!isOpenBar(b.t));
      if (rthBars.length < ORB.orbBars) continue; // not enough bars to form OR

      // Opening range = first 6 RTH bars (13:35–14:00)
      const orbWindow = rthBars.slice(0, ORB.orbBars);
      const orHigh    = Math.max(...orbWindow.map(b=>b.h));
      const orLow     = Math.min(...orbWindow.map(b=>b.l));
      const orRange   = orHigh - orLow;
      if (orRange <= 0) continue;

      // Signal scan on bars after OR window
      const postOrb = rthBars.slice(ORB.orbBars);
      let traded = false, position = null;

      for (const bar of postOrb) {
        if (isEODBar(bar.t)) {
          // EOD force-close
          if (position) {
            const isL  = position.dir==="LONG";
            const exitP = bar.c;
            const pnl  = ((isL?exitP-position.entry:position.entry-exitP)/position.entry)*position.sizeUSD;
            balance += pnl;
            if(balance>peak)peak=balance;
            const dd=(peak-balance)/peak*100;if(dd>maxDD)maxDD=dd;
            trades.push({ pnl, reason:"EOD" });
            position = null;
          }
          break;
        }

        // Exit check for open position
        if (position) {
          const isL=position.dir==="LONG";
          const hitSL=isL?bar.l<=position.sl:bar.h>=position.sl;
          const hitTP=isL?bar.h>=position.tp:bar.l<=position.tp;
          let exitReason=null,exitP=null;
          if(hitSL&&hitTP){exitReason="SL";exitP=position.sl;}
          else if(hitSL)  {exitReason="SL";exitP=position.sl;}
          else if(hitTP)  {exitReason="TP";exitP=position.tp;}
          if(exitReason) {
            const isL2=position.dir==="LONG";
            const pnl=((isL2?exitP-position.entry:position.entry-exitP)/position.entry)*position.sizeUSD;
            balance+=pnl;
            if(balance>peak)peak=balance;
            const dd=(peak-balance)/peak*100;if(dd>maxDD)maxDD=dd;
            trades.push({pnl,reason:exitReason});
            position=null;
          }
          continue; // only 1 trade per day
        }

        if (traded) continue;

        // No new entries after 17:00 UTC — late-day drift avoidance
        if (new Date(bar.t).getUTCHours() >= 17) continue;

        const volOk = prevSessionAvgVol===null || bar.v > prevSessionAvgVol;

        // Signal
        if (bar.c > orHigh && volOk) {
          const entry  = bar.c;
          const sl     = orLow;
          const tp     = entry + orRange * ORB.rrRatio;
          const slDist = entry - sl;
          const riskUSD = balance * ORB.riskPct;
          const sizeUSD = (riskUSD/slDist)*entry*ORB.leverage;
          position = { dir:"LONG", entry, sl, tp, sizeUSD, riskUSD };
          traded = true;
        } else if (bar.c < orLow && volOk) {
          const entry  = bar.c;
          const sl     = orHigh;
          const tp     = entry - orRange * ORB.rrRatio;
          const slDist = sl - entry;
          const riskUSD = balance * ORB.riskPct;
          const sizeUSD = (riskUSD/slDist)*entry*ORB.leverage;
          position = { dir:"SHORT", entry, sl, tp, sizeUSD, riskUSD };
          traded = true;
        }
      }

      // Update vol baseline at end of day
      const dayAvgVol = dayBars.reduce((s,b)=>s+b.v,0)/dayBars.length;
      sessionVols.push(dayAvgVol);
      if (sessionVols.length > ORB.volSessionsMA) sessionVols.shift();
    }

    const wins  = trades.filter(t=>t.pnl>0).length;
    const losses = trades.filter(t=>t.pnl<0).length;
    const wr    = trades.length?(wins/trades.length*100).toFixed(0)+"%":"N/A";
    const coin  = sym.replace("STOCK_USDT","");
    console.log(`  ${coin.padEnd(8)} $${PER_SYM}→$${balance.toFixed(0)} (${((balance-PER_SYM)/PER_SYM*100).toFixed(1)}%)  T:${trades.length} W:${wins} L:${losses} WR:${wr}  MaxDD:${maxDD.toFixed(1)}%`);
    allResults.push({ sym, balance, trades:trades.length, winRate:wr, maxDD });
    totalBalance += balance;
    grandTrades  += trades.length;
    grandWins    += wins;
    if (maxDD > grandMaxDD) grandMaxDD = maxDD;
  }

  const totalPnl = totalBalance - ORB.totalBalance;
  const winRate  = grandTrades?(grandWins/grandTrades*100).toFixed(1):"0";

  console.log(`\n  ── ORB Results (${DAYS} days) ──`);
  console.log(`  Start:       $${ORB.totalBalance.toLocaleString()}`);
  console.log(`  End:         $${totalBalance.toFixed(2)}`);
  console.log(`  Return:      ${(totalPnl/ORB.totalBalance*100).toFixed(1)}%`);
  console.log(`  Max Symbol DD: ${grandMaxDD.toFixed(1)}%`);
  console.log(`  Total Trades: ${grandTrades}  Win Rate: ${winRate}%`);

  return { name:"ORB", start:ORB.totalBalance, end:totalBalance, pnl:totalPnl, trades:grandTrades, winRate, maxDD:grandMaxDD };
}

// ──────────────────────────────────────────────────────────────────────────────
// MAIN
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const endDate   = new Date().toISOString().slice(0,10);
  const startDate = new Date(START_150*1000).toISOString().slice(0,10);

  console.log("╔══════════════════════════════════════════╗");
  console.log("║   HERMES 150-DAY BACKTEST REPORT         ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`  Period:  ${startDate} → ${endDate}`);
  console.log(`  Total Capital: $25,000  (v09 $10K | DT $8.75K | ORB $6.25K)`);

  const r1 = await runV09();
  const r2 = await runDT();
  const r3 = await runORB();

  const totalStart = r1.start + r2.start + r3.start;
  const totalEnd   = r1.end   + r2.end   + r3.end;
  const totalPnl   = totalEnd - totalStart;
  const elapsed    = ((Date.now()-t0)/1000/60).toFixed(1);

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║   PORTFOLIO SUMMARY — ALL THREE STRATEGIES               ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  Strategy     Start       End         Return   Trades   ║`);
  console.log(`╠══════════════════════════════════════════════════════════╣`);

  const fmt = (n,w=10)=>String(n).padStart(w);
  for (const r of [r1,r2,r3]) {
    const ret = ((r.end-r.start)/r.start*100).toFixed(1)+"%";
    console.log(`║  ${r.name.padEnd(12)} $${fmt(r.start.toLocaleString(),8)}  $${String(r.end.toFixed(0)).padStart(8)}  ${ret.padStart(7)}  ${String(r.trades).padStart(6)}   ║`);
  }
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  const totRet = (totalPnl/totalStart*100).toFixed(1)+"%";
  console.log(`║  TOTAL        $${fmt("25,000",8)}  $${String(totalEnd.toFixed(0)).padStart(8)}  ${totRet.padStart(7)}  ${String(r1.trades+r2.trades+r3.trades).padStart(6)}   ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);
  console.log(`\n  Portfolio P&L:  ${totalPnl>=0?"+":""}$${totalPnl.toFixed(2)}`);
  console.log(`  Max DrawDown:   v09 ${r1.maxDD.toFixed(1)}%  |  DT ${r2.maxDD.toFixed(1)}%  |  ORB ${r3.maxDD.toFixed(1)}%`);
  console.log(`  Backtest time:  ${elapsed} min`);
  console.log();
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
