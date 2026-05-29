/**
 * backtest_dt_maker.js — DT bot with maker orders + CURRENT sizing (chasing +88%)
 *
 * Tests two configurations side-by-side, both with full maker-order fill simulation:
 *   A. CURRENT sizing  (× leverage in sizeUSD) — aggressive, 4% real risk per trade
 *   B. OPTION 1 sizing (no leverage multiplier) — conservative, 0.8% real risk per trade
 *
 * Maker order mechanics (matches the live bot):
 *   - Place LIMIT at signal close ± 5bps (favorable side for maker status)
 *   - Wait up to 6 × 15min = 90min for the limit to fill
 *   - Fill = next bar's range crosses the limit price (paper simulation)
 *   - Fee = 0% on every fill (MEXC maker rate)
 *   - If not filled in 6 bars → cancel, no trade
 *
 * This is the *honest* backtest of the +88% scenario — it accounts for orders
 * that DON'T fill (price moves away from limit) and shows the realistic outcome.
 *
 * Run: node backtest_dt_maker.js
 */

import "dotenv/config";

const MEXC_BASE  = "https://futures.mexc.com";
const DAYS       = 150;
const NOW_SEC    = Math.floor(Date.now() / 1000);
const START_150  = NOW_SEC - DAYS * 86400;

// Maker mechanics
const MAKER_OFFSET_BPS = 5;     // 5 bps offset for guaranteed maker status
const PENDING_MAX_BARS = 6;     // 6 × 15min = 90min timeout
const MAKER_FEE        = 0.0000;
const TAKER_FEE        = 0.0002;

// DT config (matches live bot)
const DT_PAIRS       = ["BTC_USDT", "BNB_USDT", "XRP_USDT", "SUI_USDT", "LTC_USDT", "AVAX_USDT"];
const DT_EMA50_PAIRS = new Set(["BTC_USDT", "SUI_USDT"]);
const DT = { startBalance: 8750, riskPct: 0.008, leverage: 5, rrRatio: 1.3, maxHold: 12, maxSLPct: 0.012, maxPositions: 6 };

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function ema(values, period) { const k = 2/(period+1), out = [values[0]]; for (let i=1; i<values.length; i++) out.push(values[i]*k + out[i-1]*(1-k)); return out; }
function sma(values, period) { return values.map((_,i) => i<period-1 ? null : values.slice(i-period+1,i+1).reduce((a,b)=>a+b,0)/period); }
function rsi(closes, period=14) {
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
function adx(bars, period=14) {
  const n=bars.length,out=new Array(n).fill(null),tr=[],pdm=[],ndm=[];
  for(let i=1;i<n;i++){
    const h=bars[i].h,l=bars[i].l,pc=bars[i-1].c,ph=bars[i-1].h,pl=bars[i-1].l;
    tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
    const up=h-ph,dn=pl-l; pdm.push(up>dn&&up>0?up:0); ndm.push(dn>up&&dn>0?dn:0);
  }
  if(tr.length<period*2) return out;
  let smTR=tr.slice(0,period).reduce((a,b)=>a+b,0),smP=pdm.slice(0,period).reduce((a,b)=>a+b,0),smN=ndm.slice(0,period).reduce((a,b)=>a+b,0);
  const dx=[],cDX=()=>{const p=smTR?100*smP/smTR:0,nn=smTR?100*smN/smTR:0;return(p+nn)?100*Math.abs(p-nn)/(p+nn):0;};
  dx.push(cDX());
  for(let i=period;i<tr.length;i++){smTR=smTR-smTR/period+tr[i];smP=smP-smP/period+pdm[i];smN=smN-smN/period+ndm[i];dx.push(cDX());}
  if(dx.length<period) return out;
  let adxVal=dx.slice(0,period).reduce((a,b)=>a+b,0)/period; out[2*period-1]=adxVal;
  for(let j=period;j<dx.length;j++){adxVal=(adxVal*(period-1)+dx[j])/period;out[j+period]=adxVal;}
  return out;
}

function dtSessionBias(bars) {
  const bias = new Array(bars.length).fill(null);
  let orbH=-Infinity, orbL=Infinity, building=false, confirmed=null, curBias=null;
  for (let j=0; j<bars.length; j++) {
    const h = new Date(bars[j].t).getUTCHours(), m = new Date(bars[j].t).getUTCMinutes();
    if ([1,8,13].includes(h) && m===0) { building=true; orbH=bars[j].h; orbL=bars[j].l; confirmed=null; curBias=null; }
    else if (building) { orbH=Math.max(orbH,bars[j].h); orbL=Math.min(orbL,bars[j].l); confirmed={h:orbH,l:orbL}; building=false; }
    if (confirmed && curBias===null) { if (bars[j].c>confirmed.h) curBias="LONG"; else if (bars[j].c<confirmed.l) curBias="SHORT"; }
    bias[j] = confirmed ? curBias : null;
  }
  return bias;
}

// ── Simulator with full maker fill mechanics ────────────────────────────────

function simulateDTMaker(indicators, useCurrentSizing) {
  let balance = DT.startBalance, peak = balance, maxDD = 0;
  const positions = [];   // filled positions
  const pending = [];     // limit orders awaiting fill
  const trades = [];
  let signalsFired = 0, ordersPlaced = 0, ordersFilled = 0, ordersCancelled = 0;
  let totalFees = 0;

  // Unified timeline
  const allTs = new Set();
  for (const sym of DT_PAIRS) {
    const ind = indicators[sym]; if (!ind) continue;
    for (const b of ind.bars) if (b.t/1000 >= START_150) allTs.add(b.t);
  }
  const sortedTs = [...allTs].sort((a,b)=>a-b);

  for (const ts of sortedTs) {
    // ─── 1. Check pending fills ─────────────────────────────────────────────
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      const ind = indicators[p.symbol]; if (!ind) continue;
      const bi = ind.bars.findIndex(b => b.t === ts); if (bi < 0) continue;
      const bar = ind.bars[bi];
      if (bar.t <= p.signalBarTime) continue;

      // LONG limit at price below current: fills if low <= limit
      // SHORT limit at price above current: fills if high >= limit
      const filled = p.dir === "LONG" ? bar.l <= p.limitPrice : bar.h >= p.limitPrice;
      if (filled) {
        positions.push({
          symbol: p.symbol,
          dir: p.dir,
          entry: p.limitPrice,
          sl: p.sl,
          tp: p.tp,
          sizeUSD: p.sizeUSD,
          riskUSD: p.riskUSD,
          fillBarIdx: bi,
          fillBarTime: bar.t,
        });
        pending.splice(i, 1);
        ordersFilled++;
        continue;
      }
      const ageBars = bi - p.signalBarIdx;
      if (ageBars >= PENDING_MAX_BARS) {
        pending.splice(i, 1);
        ordersCancelled++;
      }
    }

    // ─── 2. Check exits on open positions ───────────────────────────────────
    for (let i = positions.length - 1; i >= 0; i--) {
      const pos = positions[i];
      const ind = indicators[pos.symbol]; if (!ind) continue;
      const bi = ind.bars.findIndex(b => b.t === ts); if (bi < 0) continue;
      const bar = ind.bars[bi];
      if (bar.t <= pos.fillBarTime) continue;

      const isL = pos.dir === "LONG";
      const barsHeld = bi - pos.fillBarIdx;
      const hitSL = isL ? bar.l <= pos.sl : bar.h >= pos.sl;
      const hitTP = isL ? bar.h >= pos.tp : bar.l <= pos.tp;
      const timeExit = barsHeld >= DT.maxHold;

      let exitPrice = null, exitReason = null;
      if (hitSL && hitTP) { exitPrice = pos.sl; exitReason = "SL"; }
      else if (hitSL)     { exitPrice = pos.sl; exitReason = "SL"; }
      else if (hitTP)     { exitPrice = pos.tp; exitReason = "TP"; }
      else if (timeExit)  { exitPrice = bar.c; exitReason = "TIME"; }

      if (exitPrice !== null) {
        const priceDiff = isL ? exitPrice - pos.entry : pos.entry - exitPrice;
        const grossPnl  = (priceDiff / pos.entry) * pos.sizeUSD;
        // Exits at SL/TP are MAKER (limit orders we already have resting on the book)
        // Time exits would be TAKER (market) — apply taker fee for those
        const fee = exitReason === "TIME" ? pos.sizeUSD * TAKER_FEE : pos.sizeUSD * MAKER_FEE;
        const netPnl = grossPnl - fee;
        totalFees += fee;
        balance += netPnl;
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak * 100;
        if (dd > maxDD) maxDD = dd;
        trades.push({ symbol: pos.symbol, dir: pos.dir, gross: grossPnl, fee, net: netPnl, exitReason });
        positions.splice(i, 1);
      }
    }

    // ─── 3. Generate new signals → place limit orders ───────────────────────
    if (positions.length + pending.length >= DT.maxPositions) continue;
    for (const sym of DT_PAIRS) {
      if (positions.some(p => p.symbol === sym)) continue;
      if (pending.some(p => p.symbol === sym)) continue;
      const ind = indicators[sym]; if (!ind) continue;
      const bi = ind.bars.findIndex(b => b.t === ts); if (bi < 3) continue;
      const i = bi - 1, prev = i - 1;

      if (!ind.rsi[i] || !ind.vsma[i] || !ind.adx[i] || ind.adx[i] < 20) continue;
      const entryHour = new Date(ind.bars[i].t).getUTCHours();
      if (entryHour >= 1 && entryHour < 8) continue;
      const bias = ind.bias[i]; if (!bias) continue;

      const c = ind.bars[i], p2 = ind.bars[prev];
      const r = ind.rsi[i], volOk = c.v > ind.vsma[i] * 1.2;
      const e50Up = ind.e50[i] > ind.e50[i-4], e50Dn = ind.e50[i] < ind.e50[i-4];
      const longRsi = r >= 40 && r < 65, shortRsi = r > 35 && r <= 60;

      let sig = null;
      if (bias === "LONG") {
        if (e50Up && longRsi && volOk && p2.c < ind.e21[prev] && c.c > ind.e21[i]) {
          const swL = Math.min(...ind.bars.slice(Math.max(0, i-3), i+1).map(x => x.l));
          const risk = c.c - swL;
          if (risk > 0 && risk/c.c < DT.maxSLPct) sig = { dir: "LONG", entry: c.c, sl: swL, tp: c.c + risk*DT.rrRatio };
        }
        if (!sig && DT_EMA50_PAIRS.has(sym) && e50Up && r>=38 && r<62 && volOk && p2.c<ind.e50[prev] && c.c>ind.e50[i]) {
          const swL = Math.min(...ind.bars.slice(Math.max(0, i-4), i+1).map(x => x.l));
          const risk = c.c - swL;
          if (risk > 0 && risk/c.c < 0.018) sig = { dir: "LONG", entry: c.c, sl: swL, tp: c.c + risk*DT.rrRatio };
        }
      }
      if (!sig && bias === "SHORT") {
        if (e50Dn && shortRsi && volOk && p2.c > ind.e21[prev] && c.c < ind.e21[i]) {
          const swH = Math.max(...ind.bars.slice(Math.max(0, i-3), i+1).map(x => x.h));
          const risk = swH - c.c;
          if (risk > 0 && risk/c.c < DT.maxSLPct) sig = { dir: "SHORT", entry: c.c, sl: swH, tp: c.c - risk*DT.rrRatio };
        }
        if (!sig && DT_EMA50_PAIRS.has(sym) && e50Dn && r>38 && r<=62 && volOk && p2.c>ind.e50[prev] && c.c<ind.e50[i]) {
          const swH = Math.max(...ind.bars.slice(Math.max(0, i-4), i+1).map(x => x.h));
          const risk = swH - c.c;
          if (risk > 0 && risk/c.c < 0.018) sig = { dir: "SHORT", entry: c.c, sl: swH, tp: c.c - risk*DT.rrRatio };
        }
      }
      if (!sig) continue;

      signalsFired++;
      // Limit price with 5bps offset for maker status
      const offset = MAKER_OFFSET_BPS / 10000;
      const limitPrice = sig.dir === "LONG" ? sig.entry * (1 - offset) : sig.entry * (1 + offset);

      // Recompute SL/TP from the limit entry (not signal entry) to preserve R:R
      const limitSL = sig.dir === "LONG"
        ? Math.min(sig.sl, limitPrice * (1 - DT.maxSLPct))
        : Math.max(sig.sl, limitPrice * (1 + DT.maxSLPct));
      const limitSLDist = Math.abs(limitPrice - limitSL);
      const limitTPDist = limitSLDist * DT.rrRatio;
      const limitTP = sig.dir === "LONG" ? limitPrice + limitTPDist : limitPrice - limitTPDist;

      const riskUSD = balance * DT.riskPct;
      // CURRENT sizing has × leverage. OPTION 1 sizing does not.
      const sizeUSD = useCurrentSizing
        ? (riskUSD / limitSLDist) * limitPrice * DT.leverage
        : (riskUSD / limitSLDist) * limitPrice;

      pending.push({
        symbol: sym, dir: sig.dir,
        limitPrice, sl: limitSL, tp: limitTP,
        sizeUSD, riskUSD,
        signalBarIdx: i, signalBarTime: c.t,
      });
      ordersPlaced++;
    }
  }

  // Force close remaining
  for (const pos of positions) {
    const ind = indicators[pos.symbol]; if (!ind) continue;
    const lastBar = ind.bars[ind.bars.length - 1];
    const isL = pos.dir === "LONG";
    const priceDiff = isL ? lastBar.c - pos.entry : pos.entry - lastBar.c;
    const grossPnl = (priceDiff / pos.entry) * pos.sizeUSD;
    balance += grossPnl;
    trades.push({ symbol: pos.symbol, dir: pos.dir, gross: grossPnl, fee: 0, net: grossPnl, exitReason: "OPEN@END" });
  }

  const wins = trades.filter(t => t.net > 0);
  const losses = trades.filter(t => t.net < 0);
  const winRate = trades.length ? wins.length/trades.length*100 : 0;
  const grossW = wins.reduce((s,t)=>s+t.gross,0);
  const grossL = Math.abs(losses.reduce((s,t)=>s+t.gross,0));
  const netW = wins.reduce((s,t)=>s+t.net,0);
  const netL = Math.abs(losses.reduce((s,t)=>s+t.net,0));
  const pfNet = netL > 0 ? netW/netL : (wins.length?Infinity:0);
  const pfGross = grossL > 0 ? grossW/grossL : (wins.length?Infinity:0);
  const fillRate = ordersPlaced ? ordersFilled/ordersPlaced*100 : 0;
  const avgWin = wins.length ? netW/wins.length : 0;
  const avgLoss = losses.length ? netL/losses.length : 0;

  return { balance, peak, maxDD, trades, totalFees, signalsFired, ordersPlaced, ordersFilled, ordersCancelled, fillRate, winRate, pfGross, pfNet, avgWin, avgLoss };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const startDate = new Date(START_150*1000).toISOString().slice(0,10);
  const endDate   = new Date().toISOString().slice(0,10);

  console.log("╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  DT MAKER BACKTEST — Chasing the +88% scenario                    ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`  Period:     ${startDate} → ${endDate}  |  6 DT pairs, 15min`);
  console.log(`  Maker spec: LIMIT at ±${MAKER_OFFSET_BPS}bps, ${PENDING_MAX_BARS}-bar timeout, 0% maker fee`);
  console.log(`  Time exits: charged as TAKER (0.02%) — forced market exit at max hold`);
  console.log(`  Compares:   Current sizing (4% real risk) vs Option 1 sizing (0.8% real risk)`);

  console.log("\n[1/1] Fetching DT 15min data…");
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
    dtInd[sym] = { bars, closes, vols, e21: ema(closes,21), e50: ema(closes,50), rsi: rsi(closes,14), vsma: sma(vols,20), adx: adx(bars,14), bias: dtSessionBias(bars) };
  }

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Running simulations…");
  console.log("══════════════════════════════════════════════════════════════");
  process.stdout.write("  Current sizing + maker… ");
  const cur = simulateDTMaker(dtInd, true);
  console.log(`$${cur.balance.toFixed(0)}`);
  process.stdout.write("  Option 1 sizing + maker… ");
  const opt = simulateDTMaker(dtInd, false);
  console.log(`$${opt.balance.toFixed(0)}`);

  const printResult = (label, r) => {
    const ret = (r.balance - DT.startBalance) / DT.startBalance * 100;
    console.log(`\n  ── ${label} ──`);
    console.log(`  End balance:         $${r.balance.toFixed(0)}`);
    console.log(`  Return:              ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%`);
    console.log(`  Max drawdown:        ${r.maxDD.toFixed(1)}%`);
    console.log(`  Signals fired:       ${r.signalsFired}`);
    console.log(`  Orders placed:       ${r.ordersPlaced}`);
    console.log(`  Filled:              ${r.ordersFilled}  (${r.fillRate.toFixed(1)}% fill rate)`);
    console.log(`  Cancelled (timeout): ${r.ordersCancelled}`);
    const wins = r.trades.filter(t=>t.net>0).length, losses = r.trades.filter(t=>t.net<0).length;
    console.log(`  Closed trades:       ${r.trades.length}  (W:${wins} / L:${losses})`);
    console.log(`  Win rate:            ${r.winRate.toFixed(1)}%`);
    console.log(`  Avg win:             +$${r.avgWin.toFixed(2)}`);
    console.log(`  Avg loss:            -$${r.avgLoss.toFixed(2)}`);
    console.log(`  Profit factor:       ${r.pfNet === Infinity ? '∞' : r.pfNet.toFixed(2)}`);
    console.log(`  Total fees:          $${r.totalFees.toFixed(2)}  (only time-exits = taker; rest is maker @ 0%)`);
  };

  console.log("\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  RESULTS                                                            ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  printResult("CURRENT SIZING + MAKER (the +88% chase)", cur);
  printResult("OPTION 1 SIZING + MAKER (currently deployed)", opt);

  // Comparison to baselines
  const curRet = (cur.balance-DT.startBalance)/DT.startBalance*100;
  const optRet = (opt.balance-DT.startBalance)/DT.startBalance*100;
  console.log("\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  COMPARISON TO BASELINE                                            ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`  Configuration                       Return     Max DD     PF`);
  console.log(`  ────────────────────────────────────────────────────────────`);
  console.log(`  Current sizing + taker (broken)      +1.9%     47.5%     1.00`);
  console.log(`  Option 1 sizing + taker (Phase A)    +4.4%     11.3%     1.05`);
  console.log(`  Option 1 sizing + maker (deployed)  ${(optRet>=0?'+':'')}${optRet.toFixed(1)}%${(' ').repeat(Math.max(0, 6-optRet.toFixed(1).length))}     ${opt.maxDD.toFixed(1)}%    ${opt.pfNet===Infinity?' ∞':opt.pfNet.toFixed(2)}`);
  console.log(`  Current sizing + maker (target)     ${(curRet>=0?'+':'')}${curRet.toFixed(1)}%${(' ').repeat(Math.max(0, 6-curRet.toFixed(1).length))}     ${cur.maxDD.toFixed(1)}%    ${cur.pfNet===Infinity?' ∞':cur.pfNet.toFixed(2)}`);

  console.log("\n  📋 VERDICT:");
  if (curRet > 50) {
    console.log(`     ✅ +88% scenario VALIDATED — current sizing + maker delivers strong returns`);
    console.log(`     Trade-off: ${cur.maxDD.toFixed(0)}% max DD. If acceptable, revert DT to current sizing.`);
  } else if (curRet > optRet + 10) {
    console.log(`     ⚠️  PARTIAL — current sizing significantly beats Option 1 but not at +88% level`);
    console.log(`     Likely cause: fill rate of ${cur.fillRate.toFixed(0)}% means some good trades are missed.`);
  } else if (curRet > optRet) {
    console.log(`     ⚠️  MARGINAL — current sizing slightly beats Option 1; not worth the DD trade-off`);
  } else {
    console.log(`     ❌ NO IMPROVEMENT — Option 1 + maker is at least as good as current + maker`);
    console.log(`     Recommendation: keep current Option 1 deployment.`);
  }

  const mins = ((Date.now()-t0)/60000).toFixed(1);
  console.log(`\n  Backtest time: ${mins} min\n`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
