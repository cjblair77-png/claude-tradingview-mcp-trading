/**
 * backtest_dt_universe.js — DT on different pair universes (6 months)
 *
 * Hypothesis: BTC/BNB/LTC are too low-volatility for 15-min DT.
 * Test the same DT strategy on:
 *   1. BASELINE: current 6 pairs (BTC, BNB, XRP, SUI, LTC, AVAX)
 *   2. MID-CAP ROTATION: 6 mid-caps (SUI, AVAX, ENA, TIA, ONDO, WIF)
 *   3. HIGH-VOL FOCUS: 6 high-volatility small/mid caps (ENA, TIA, ONDO, WIF, AIXBT, WLD)
 *   4. V09 TOP-30: all 30 isolation-scored alts from v09's curated universe
 *
 * Uses optimized DT config from earlier sweeps:
 *   R:R=2.0, Hold=18 bars, Risk=0.5%, ADX=15
 *   Max positions = 10 (was 6) for top-30 universe
 *
 * Run: node backtest_dt_universe.js
 */

import "dotenv/config";

const MEXC_BASE  = "https://futures.mexc.com";
const DAYS       = 180;
const NOW_SEC    = Math.floor(Date.now() / 1000);
const START      = NOW_SEC - DAYS * 86400;
const FEE_PCT    = 0.0004;

// ── Universes ────────────────────────────────────────────────────────────────

const BASELINE = ["BTC_USDT", "BNB_USDT", "XRP_USDT", "SUI_USDT", "LTC_USDT", "AVAX_USDT"];
const MID_CAP  = ["SUI_USDT", "AVAX_USDT", "ENA_USDT", "TIA_USDT", "ONDO_USDT", "WIF_USDT"];
const HIGH_VOL = ["ENA_USDT", "TIA_USDT", "ONDO_USDT", "WIF_USDT", "AIXBT_USDT", "WLD_USDT"];
const TOP_30   = [
  "KAIA_USDT","S_USDT","FILECOIN_USDT","AR_USDT","PLUME_USDT","FIDA_USDT","GMT_USDT","ENA_USDT","TIA_USDT","TURBO_USDT",
  "WIF_USDT","SHIB_USDT","BCH_USDT","VET_USDT","ONDO_USDT","THETA_USDT","HBAR_USDT","RUNE_USDT","IOTA_USDT","JUP_USDT",
  "FLUX_USDT","W_USDT","CATI_USDT","ZKSYNC_USDT","KAITO_USDT","WLD_USDT","AIXBT_USDT","LA_USDT","JASMY_USDT","HOME_USDT",
];

// Union of all pairs (for the fetch)
const ALL_PAIRS = [...new Set([...BASELINE, ...MID_CAP, ...HIGH_VOL, ...TOP_30])];

// ── DT config — using OPTIMIZED params from previous sweeps ──────────────────
const DT = {
  startBalance: 8750,
  riskPct:      0.005,   // 0.5% (conservative-optimal from 12-month sweep)
  leverage:     5,
  rrRatio:      2.0,     // optimized
  maxHold:      18,      // optimized (4.5h)
  maxSLPct:     0.012,
  adxMin:       15,      // optimized (was 20)
  defaultMaxPositions: 6,
  top30MaxPositions:   10, // allow more parallel with 30 pairs
};

// EMA50 bounce signal — only for BTC and SUI when in universe
const EMA50_PAIRS = new Set(["BTC_USDT", "SUI_USDT"]);

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
function adx(b,p=14){const n=b.length,o=new Array(n).fill(null),tr=[],pdm=[],ndm=[];for(let i=1;i<n;i++){const h=b[i].h,l=b[i].l,pc=b[i-1].c,ph=b[i-1].h,pl=b[i-1].l;tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));const up=h-ph,dn=pl-l;pdm.push(up>dn&&up>0?up:0);ndm.push(dn>up&&dn>0?dn:0);}if(tr.length<p*2)return o;let smTR=tr.slice(0,p).reduce((a,b)=>a+b,0),smP=pdm.slice(0,p).reduce((a,b)=>a+b,0),smN=ndm.slice(0,p).reduce((a,b)=>a+b,0);const dx=[],cDX=()=>{const pp=smTR?100*smP/smTR:0,nn=smTR?100*smN/smTR:0;return(pp+nn)?100*Math.abs(pp-nn)/(pp+nn):0;};dx.push(cDX());for(let i=p;i<tr.length;i++){smTR=smTR-smTR/p+tr[i];smP=smP-smP/p+pdm[i];smN=smN-smN/p+ndm[i];dx.push(cDX());}if(dx.length<p)return o;let v=dx.slice(0,p).reduce((a,b)=>a+b,0)/p;o[2*p-1]=v;for(let j=p;j<dx.length;j++){v=(v*(p-1)+dx[j])/p;o[j+p]=v;}return o;}
function dtSessionBias(bars){const bias=new Array(bars.length).fill(null);let oH=-Infinity,oL=Infinity,bld=false,conf=null,cur=null;for(let j=0;j<bars.length;j++){const h=new Date(bars[j].t).getUTCHours(),m=new Date(bars[j].t).getUTCMinutes();if([1,8,13].includes(h)&&m===0){bld=true;oH=bars[j].h;oL=bars[j].l;conf=null;cur=null;}else if(bld){oH=Math.max(oH,bars[j].h);oL=Math.min(oL,bars[j].l);conf={h:oH,l:oL};bld=false;}if(conf&&cur===null){if(bars[j].c>conf.h)cur="LONG";else if(bars[j].c<conf.l)cur="SHORT";}bias[j]=conf?cur:null;}return bias;}

// Compute average daily range % (volatility check for diagnostic)
function avgDailyRangePct(bars) {
  if (bars.length < 96) return 0;
  // Group by day, calculate (max high - min low) / avg close per day
  const days = {};
  for (const b of bars) {
    const dk = new Date(b.t).toISOString().slice(0,10);
    if (!days[dk]) days[dk] = { high: -Infinity, low: Infinity, closes: [] };
    days[dk].high = Math.max(days[dk].high, b.h);
    days[dk].low  = Math.min(days[dk].low,  b.l);
    days[dk].closes.push(b.c);
  }
  const dayKeys = Object.keys(days).sort();
  let totalRange = 0, count = 0;
  for (const k of dayKeys) {
    const d = days[k];
    const avgClose = d.closes.reduce((a,b)=>a+b,0)/d.closes.length;
    if (avgClose > 0) { totalRange += (d.high - d.low) / avgClose; count++; }
  }
  return count > 0 ? (totalRange / count) * 100 : 0;
}

// ── Simulator ───────────────────────────────────────────────────────────────

function simulate(indicators, pairs, maxPositions) {
  let balance = DT.startBalance, peak = balance, maxDD = 0;
  const positions = []; const trades = []; let totalFees = 0;

  // Pre-compute timestamp → bar index map per symbol (huge speedup vs findIndex)
  const tsMap = {};
  for (const sym of pairs) {
    const ind = indicators[sym]; if (!ind) continue;
    tsMap[sym] = new Map();
    for (let i = 0; i < ind.bars.length; i++) tsMap[sym].set(ind.bars[i].t, i);
  }

  const allTs = new Set();
  for (const sym of pairs) { const ind = indicators[sym]; if (!ind) continue; for (const b of ind.bars) if (b.t/1000 >= START) allTs.add(b.t); }
  const sortedTs = [...allTs].sort((a,b)=>a-b);

  for (const ts of sortedTs) {
    // Exits
    for (let i = positions.length-1; i >= 0; i--) {
      const pos = positions[i];
      const ind = indicators[pos.sym]; if (!ind) continue;
      const bi = tsMap[pos.sym].get(ts); if (bi === undefined) continue;
      const bar = ind.bars[bi];
      const isL = pos.dir==="LONG"; const barsHeld = bi - pos.entryBarIdx;
      const hitSL = isL ? bar.l<=pos.sl : bar.h>=pos.sl;
      const hitTP = isL ? bar.h>=pos.tp : bar.l<=pos.tp;
      const timeExit = barsHeld >= DT.maxHold;
      let exitReason = null, exitPrice = null;
      if (hitSL&&hitTP) { exitReason="SL"; exitPrice=pos.sl; }
      else if (hitSL)   { exitReason="SL"; exitPrice=pos.sl; }
      else if (hitTP)   { exitReason="TP"; exitPrice=pos.tp; }
      else if (timeExit){ exitReason="TIME"; exitPrice=bar.c; }
      if (exitReason) {
        const grossPnl = ((isL?exitPrice-pos.entry:pos.entry-exitPrice)/pos.entry) * pos.sizeUSD;
        const fee = pos.sizeUSD * FEE_PCT;
        const netPnl = grossPnl - fee;
        balance += netPnl; totalFees += fee;
        if (balance>peak) peak = balance;
        const dd = (peak-balance)/peak*100; if (dd>maxDD) maxDD=dd;
        trades.push({ sym: pos.sym, gross: grossPnl, fee, net: netPnl, reason: exitReason });
        positions.splice(i, 1);
      }
    }
    // Entries
    if (positions.length < maxPositions) {
      for (const sym of pairs) {
        if (positions.some(p=>p.sym===sym)) continue;
        const ind = indicators[sym]; if (!ind) continue;
        const bi = tsMap[sym].get(ts); if (bi === undefined || bi < 3) continue;
        const i = bi-1, prev = i-1;
        if (!ind.rsi[i]||!ind.vsma[i]||!ind.adx[i]||ind.adx[i]<DT.adxMin) continue;
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
          if (!sig&&EMA50_PAIRS.has(sym)&&e50Up&&r>=38&&r<62&&volOk&&p2.c<ind.e50[prev]&&c.c>ind.e50[i]) {
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
          if (!sig&&EMA50_PAIRS.has(sym)&&e50Dn&&r>38&&r<=62&&volOk&&p2.c>ind.e50[prev]&&c.c<ind.e50[i]) {
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
        if (positions.length>=maxPositions) break;
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
    balance += netPnl; totalFees += fee;
    trades.push({ sym: pos.sym, gross: grossPnl, fee, net: netPnl, reason: "OPEN@END" });
  }
  const wins = trades.filter(t=>t.net>0); const losses = trades.filter(t=>t.net<0);
  const winRate = trades.length ? wins.length/trades.length*100 : 0;
  const netW = wins.reduce((s,t)=>s+t.net,0); const netL = Math.abs(losses.reduce((s,t)=>s+t.net,0));
  const pf = netL>0 ? netW/netL : (wins.length?Infinity:0);
  const ret = (balance - DT.startBalance) / DT.startBalance * 100;
  return { balance, ret, maxDD, trades: trades.length, winRate, pf, totalFees, tradesByPair: trades };
}

async function main() {
  const t0 = Date.now();
  const startDate = new Date(START*1000).toISOString().slice(0,10);
  const endDate   = new Date().toISOString().slice(0,10);

  console.log("╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  DT UNIVERSE COMPARISON — 6 months                                 ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`  Period:  ${startDate} → ${endDate}  (${DAYS} days)`);
  console.log(`  Config:  R:R=${DT.rrRatio}, Hold=${DT.maxHold}, Risk=${(DT.riskPct*100).toFixed(1)}%, ADX=${DT.adxMin}, MaxSL=${(DT.maxSLPct*100).toFixed(1)}%`);
  console.log(`  Universes: BASELINE(${BASELINE.length}) vs MID-CAP(${MID_CAP.length}) vs HIGH-VOL(${HIGH_VOL.length}) vs TOP-30(${TOP_30.length})`);
  console.log(`  Total unique pairs to fetch: ${ALL_PAIRS.length}`);

  console.log(`\n[1/1] Fetching ${ALL_PAIRS.length} pairs of 15min data…`);
  const data = {};
  let fetched = 0;
  for (const sym of ALL_PAIRS) {
    process.stdout.write(`  [${++fetched}/${ALL_PAIRS.length}] ${sym}…`);
    data[sym] = await fetchAllBars(sym, "Min15", 15*60, START - 80*15*60, NOW_SEC);
    process.stdout.write(`\r  [${fetched}/${ALL_PAIRS.length}] ${sym.padEnd(20)} ${String(data[sym].length).padStart(6)} bars ✓\n`);
    await sleep(120);
  }

  console.log("\n  Computing indicators + volatility profile…");
  const ind = {};
  for (const sym of ALL_PAIRS) {
    const bars = data[sym]; if (bars.length < 80) continue;
    const closes = bars.map(b=>b.c), vols = bars.map(b=>b.v);
    ind[sym] = { bars, closes, vols, e21: ema(closes,21), e50: ema(closes,50), rsi: rsi(closes,14), vsma: sma(vols,20), adx: adx(bars,14), bias: dtSessionBias(bars), avgDR: avgDailyRangePct(bars) };
  }

  // ── Show volatility profile per universe ──────────────────────────────────
  console.log("\n  Average daily range % per pair (volatility check):");
  for (const sym of ALL_PAIRS) {
    if (!ind[sym]) continue;
    const dr = ind[sym].avgDR.toFixed(2);
    const flag = ind[sym].avgDR > 6 ? "🔥 HIGH" : ind[sym].avgDR > 4 ? "✓ Med" : "⚪ Low";
    process.stdout.write(`  ${sym.padEnd(18)} ${dr.padStart(5)}%  ${flag}\n`);
  }

  // ── Run simulations ────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Running simulations on 4 universes…");
  console.log("══════════════════════════════════════════════════════════════");

  process.stdout.write("  Baseline (6 large-cap)…"); const rBase = simulate(ind, BASELINE, DT.defaultMaxPositions);
  console.log(` $${rBase.balance.toFixed(0)}  (${rBase.trades} trades)`);

  process.stdout.write("  Mid-cap rotation (6)…"); const rMid = simulate(ind, MID_CAP, DT.defaultMaxPositions);
  console.log(` $${rMid.balance.toFixed(0)}  (${rMid.trades} trades)`);

  process.stdout.write("  High-vol focus (6)…"); const rHv = simulate(ind, HIGH_VOL, DT.defaultMaxPositions);
  console.log(` $${rHv.balance.toFixed(0)}  (${rHv.trades} trades)`);

  process.stdout.write("  v09 top-30 (30 pairs, max 10 pos)…"); const r30 = simulate(ind, TOP_30, DT.top30MaxPositions);
  console.log(` $${r30.balance.toFixed(0)}  (${r30.trades} trades)`);

  // ── Report ────────────────────────────────────────────────────────────────
  const print = (name, r) => {
    const wins = r.tradesByPair.filter(t=>t.net>0).length;
    const losses = r.tradesByPair.filter(t=>t.net<0).length;
    console.log(`\n  ── ${name} ──`);
    console.log(`     End balance:  $${r.balance.toFixed(0)}`);
    console.log(`     Return:       ${r.ret>=0?'+':''}${r.ret.toFixed(1)}%`);
    console.log(`     Max DD:       ${r.maxDD.toFixed(1)}%`);
    console.log(`     Trades:       ${r.trades}  (W:${wins} / L:${losses})`);
    console.log(`     Win rate:     ${r.winRate.toFixed(1)}%`);
    console.log(`     Profit factor:${r.pf===Infinity?'∞':r.pf.toFixed(2)}`);
    console.log(`     Total fees:   $${r.totalFees.toFixed(0)}`);
  };

  console.log("\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  RESULTS                                                            ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  print("Baseline — current 6 large-caps", rBase);
  print("Mid-cap rotation — 6 mid-caps", rMid);
  print("High-vol focus — 6 high-vol", rHv);
  print("v09 Top-30 — all 30 isolation-scored alts", r30);

  // ── Summary table ─────────────────────────────────────────────────────────
  console.log("\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  HEAD-TO-HEAD                                                       ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`  ${"Universe".padEnd(28)} ${"Return".padStart(10)} ${"MaxDD".padStart(8)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"Trades".padStart(7)}`);
  console.log(`  ${"─".repeat(28)} ${"─".repeat(10)} ${"─".repeat(8)} ${"─".repeat(6)} ${"─".repeat(6)} ${"─".repeat(7)}`);
  for (const [name, r] of [["Baseline (6 large-cap)", rBase], ["Mid-cap rotation (6)", rMid], ["High-vol focus (6)", rHv], ["v09 Top-30 (30 pairs)", r30]]) {
    const retStr = `${r.ret>=0?'+':''}${r.ret.toFixed(1)}%`;
    console.log(`  ${name.padEnd(28)} ${retStr.padStart(10)} ${(r.maxDD.toFixed(1)+'%').padStart(8)} ${(r.pf===Infinity?'∞':r.pf.toFixed(2)).padStart(6)} ${r.winRate.toFixed(1).padStart(6)} ${String(r.trades).padStart(7)}`);
  }

  // Per-pair P&L breakdown for top-30
  console.log("\n  📊 Top-30 per-pair P&L:");
  const pairPnl = {};
  for (const t of r30.tradesByPair) { if (!pairPnl[t.sym]) pairPnl[t.sym] = { trades: 0, pnl: 0, wins: 0 }; pairPnl[t.sym].trades++; pairPnl[t.sym].pnl += t.net; if (t.net > 0) pairPnl[t.sym].wins++; }
  const sortedByPnl = Object.entries(pairPnl).sort((a,b) => b[1].pnl - a[1].pnl);
  for (const [sym, s] of sortedByPnl) {
    const wr = s.trades > 0 ? (s.wins/s.trades*100).toFixed(0) : "—";
    const flag = s.pnl > 0 ? "✅" : "❌";
    console.log(`     ${flag} ${sym.padEnd(18)} ${(s.pnl>=0?'+':'')+'$'+s.pnl.toFixed(2)}  ${s.trades} trades, ${wr}% WR`);
  }

  const mins = ((Date.now()-t0)/60000).toFixed(1);
  console.log(`\n  Total time: ${mins} min\n`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
