/**
 * backtest_session3.js — DT Bot: Fibonacci Golden Pocket Entry Filter
 *
 * Session 3 enhancement: Only allow DT entries when current price is in the
 * 0.5–0.618 Fibonacci retracement zone of the most recent impulse move.
 *
 * Algorithm:
 *   1. Look back LOOKBACK bars on the 15-min chart
 *   2. Find swing high and swing low in that window
 *   3. Determine impulse direction (whichever extreme came LAST)
 *   4. Require impulse size >= MIN_IMPULSE_PCT
 *   5. Compute 0.5 and 0.618 retracement levels of the impulse
 *   6. Filter rule:
 *      LONG  signal → impulse was UP, current price in golden pocket
 *      SHORT signal → impulse was DOWN, current price in golden pocket
 *
 * Tested params:
 *   LOOKBACK = 30 bars (7.5 hours of 15-min context)
 *   MIN_IMPULSE_PCT = 1.5% (filter noise on BTC, more aggressive for alts)
 *
 * Run: node backtest_session3.js
 */

import "dotenv/config";

const MEXC_BASE  = "https://futures.mexc.com";
const DAYS       = 150;
const NOW_SEC    = Math.floor(Date.now() / 1000);
const START_SEC  = NOW_SEC - DAYS * 86400;

const DT_PAIRS       = ["BTC_USDT", "BNB_USDT", "XRP_USDT", "SUI_USDT", "LTC_USDT", "AVAX_USDT"];
const EMA50_PAIRS    = new Set(["BTC_USDT", "SUI_USDT"]);

const DT_PORTFOLIO   = parseFloat(process.env.DT_PORTFOLIO_USD || "8750");
const DT_RISK_PCT    = parseFloat(process.env.DT_RISK_PCT      || "0.008");
const DT_LEVERAGE    = parseFloat(process.env.DT_LEVERAGE      || "5");
const DT_MAX_SL_PCT  = 0.012;
const DT_RR          = 1.3;
const DT_MAX_BARS    = 12;

// Fibonacci filter parameters
const FIB_LOOKBACK         = 30;     // 30 × 15min = 7.5h impulse window
const FIB_MIN_IMPULSE_PCT  = 0.015;  // 1.5% minimum impulse
const FIB_ZONE_LOW         = 0.50;   // golden pocket lower bound
const FIB_ZONE_HIGH        = 0.618;  // golden pocket upper bound

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Indicators (same as live bot) ─────────────────────────────────────────────

function ema(values, period) {
  const k = 2 / (period + 1), out = new Array(values.length).fill(null);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) out[i] = values[i] * k + out[i-1] * (1-k);
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i]-closes[i-1]; d>0?g+=d:l-=d; }
  out[period] = l===0?100:100-100/(1+g/l);
  for (let i = period+1; i < closes.length; i++) {
    const d = closes[i]-closes[i-1];
    if (d>0){g=(g*(period-1)+d)/period;l=l*(period-1)/period;}
    else{g=g*(period-1)/period;l=(l*(period-1)-d)/period;}
    out[i]=l===0?100:100-100/(1+g/l);
  }
  return out;
}

function sma(values, period) {
  return values.map((_,i)=>i<period-1?null:values.slice(i-period+1,i+1).reduce((a,b)=>a+b,0)/period);
}

function adx(candles, period = 14) {
  const n=candles.length, out=new Array(n).fill(null);
  const tr=[],pdm=[],ndm=[];
  for(let i=1;i<n;i++){
    const h=candles[i].h,l=candles[i].l,pc=candles[i-1].c,ph=candles[i-1].h,pl=candles[i-1].l;
    tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
    const up=h-ph,dn=pl-l;
    pdm.push(up>dn&&up>0?up:0); ndm.push(dn>up&&dn>0?dn:0);
  }
  if(tr.length<period*2)return out;
  let smTR=tr.slice(0,period).reduce((a,b)=>a+b,0),smP=pdm.slice(0,period).reduce((a,b)=>a+b,0),smN=ndm.slice(0,period).reduce((a,b)=>a+b,0);
  const dx=[]; const calcDX=()=>{const p=smTR>0?100*smP/smTR:0,nn=smTR>0?100*smN/smTR:0;return(p+nn)>0?100*Math.abs(p-nn)/(p+nn):0;};
  dx.push(calcDX());
  for(let i=period;i<tr.length;i++){smTR=smTR-smTR/period+tr[i];smP=smP-smP/period+pdm[i];smN=smN-smN/period+ndm[i];dx.push(calcDX());}
  if(dx.length<period)return out;
  let adxVal=dx.slice(0,period).reduce((a,b)=>a+b,0)/period;
  out[2*period-1]=adxVal;
  for(let j=period;j<dx.length;j++){adxVal=(adxVal*(period-1)+dx[j])/period;out[j+period]=adxVal;}
  return out;
}

// ── Session / ORB helpers ────────────────────────────────────────────────────

function inSession(tMs) { const h=new Date(tMs).getUTCHours(); return h>=1&&h<22; }

const ORB_OPENS = new Set([1,8,13]);

function sessionORBBias(candles) {
  const out=new Array(candles.length).fill(null);
  let building=false,orbHigh=-Infinity,orbLow=Infinity,confirmed=null,bias=null;
  for(let j=0;j<candles.length;j++){
    const c=candles[j],h=new Date(c.t).getUTCHours(),m=new Date(c.t).getUTCMinutes();
    if(ORB_OPENS.has(h)&&m===0){building=true;orbHigh=c.h;orbLow=c.l;confirmed=null;bias=null;}
    else if(building){orbHigh=Math.max(orbHigh,c.h);orbLow=Math.min(orbLow,c.l);confirmed={high:orbHigh,low:orbLow};building=false;}
    if(confirmed&&bias===null){if(c.c>confirmed.high)bias='LONG';else if(c.c<confirmed.low)bias='SHORT';}
    out[j]=confirmed?bias:null;
  }
  return out;
}

// ── Fibonacci Golden Pocket Detector ─────────────────────────────────────────
//
// For the most recent FIB_LOOKBACK bars before bar i:
//   - Find swing high (idx of highest high) and swing low (idx of lowest low)
//   - Impulse direction = whichever extreme came LAST (the most recent one)
//   - If swingHigh idx > swingLow idx → impulse is UP (price moved low → high recently)
//   - If swingLow idx > swingHigh idx → impulse is DOWN (price moved high → low recently)
//   - Compute fib zone based on impulse direction
//   - Return { direction: 'UP'|'DOWN', impulsePct, zoneLow, zoneHigh, currentPrice, inZone }

function detectFibZone(candles, i) {
  const start = Math.max(0, i - FIB_LOOKBACK);
  const window = candles.slice(start, i + 1);
  if (window.length < 10) return null;

  // Find swing high and swing low (use wicks, per the strategy)
  let highIdx = 0, lowIdx = 0;
  let highVal = window[0].h, lowVal = window[0].l;
  for (let j = 1; j < window.length; j++) {
    if (window[j].h > highVal) { highVal = window[j].h; highIdx = j; }
    if (window[j].l < lowVal)  { lowVal  = window[j].l; lowIdx  = j; }
  }

  const range = highVal - lowVal;
  if (range === 0) return null;

  const impulsePct = range / lowVal;
  if (impulsePct < FIB_MIN_IMPULSE_PCT) return null; // impulse too small — choppy market

  // Determine impulse direction by which extreme came LAST
  // If high came after low → upward impulse (we're now pulling back to buy)
  // If low came after high → downward impulse (we're now pulling back to sell)
  const direction = highIdx > lowIdx ? 'UP' : 'DOWN';

  // Compute fib zone
  // For UP impulse: retracement levels are below the high
  //   0.5 retracement   = high - 0.50 × range
  //   0.618 retracement = high - 0.618 × range
  //   Golden pocket is BETWEEN these two (price has pulled back into it)
  // For DOWN impulse: retracement levels are above the low
  //   0.5 retracement   = low + 0.50 × range
  //   0.618 retracement = low + 0.618 × range

  let zoneLow, zoneHigh; // zoneLow always < zoneHigh
  if (direction === 'UP') {
    const level618 = highVal - FIB_ZONE_HIGH * range; // deeper retrace, lower price
    const level500 = highVal - FIB_ZONE_LOW  * range; // shallower retrace, higher price
    zoneLow  = level618;
    zoneHigh = level500;
  } else {
    const level500 = lowVal + FIB_ZONE_LOW  * range; // shallower retrace, lower price
    const level618 = lowVal + FIB_ZONE_HIGH * range; // deeper retrace, higher price
    zoneLow  = level500;
    zoneHigh = level618;
  }

  const currentPrice = candles[i].c;
  const inZone = currentPrice >= zoneLow && currentPrice <= zoneHigh;

  return { direction, impulsePct, zoneLow, zoneHigh, currentPrice, inZone, highVal, lowVal };
}

// ── DT signal generator (same as live bot) ───────────────────────────────────

function dtSignal(symbol, candles, i) {
  if (i < 70 || i < 2) return null;

  const closes = candles.map(c => c.c);
  const vols   = candles.map(c => c.v);

  const e21  = ema(closes, 21);
  const e50  = ema(closes, 50);
  const rsi_ = rsi(closes, 14);
  const vsma = sma(vols, 20);
  const adx_ = adx(candles.slice(0, i+1), 14);
  const bias_= sessionORBBias(candles.slice(0, i+1));

  const c    = candles[i];
  const p    = candles[i-1];
  const adxI = adx_.length - 1;
  const biasI= bias_.length - 1;

  if (!rsi_[i] || !vsma[i]) return null;
  if (!inSession(c.t)) return null;
  if (!adx_[adxI] || adx_[adxI] < 20) return null;

  const entryHour = new Date(c.t).getUTCHours();
  if (entryHour >= 1 && entryHour < 8) return null;

  const bias = bias_[biasI];
  if (!bias) return null;

  const r      = rsi_[i];
  const volOk  = c.v > vsma[i] * 1.2;
  const tb     = 4;
  const e50Up  = e50[i] > e50[i-tb];
  const e50Dn  = e50[i] < e50[i-tb];
  const longRsi  = r >= 40 && r < 65;
  const shortRsi = r > 35 && r <= 60;

  if (bias === 'LONG') {
    if (e50Up && longRsi && volOk && p.c < e21[i-1] && c.c > e21[i]) {
      const swingLow = Math.min(...candles.slice(Math.max(0,i-3),i+1).map(x=>x.l));
      const risk = c.c - swingLow;
      if (risk > 0 && risk/c.c < DT_MAX_SL_PCT)
        return { direction:"LONG", signal:"EMA21", entry:c.c, sl:swingLow, tp:c.c+risk*DT_RR, barTime:c.t };
    }
    if (EMA50_PAIRS.has(symbol) && e50Up && r>=38 && r<62 && volOk && p.c<e50[i-1] && c.c>e50[i]) {
      const swingLow = Math.min(...candles.slice(Math.max(0,i-4),i+1).map(x=>x.l));
      const risk = c.c - swingLow;
      if (risk > 0 && risk/c.c < 0.018)
        return { direction:"LONG", signal:"EMA50", entry:c.c, sl:swingLow, tp:c.c+risk*DT_RR, barTime:c.t };
    }
  }

  if (bias === 'SHORT') {
    if (e50Dn && shortRsi && volOk && p.c>e21[i-1] && c.c<e21[i]) {
      const swingHigh = Math.max(...candles.slice(Math.max(0,i-3),i+1).map(x=>x.h));
      const risk = swingHigh - c.c;
      if (risk > 0 && risk/c.c < DT_MAX_SL_PCT)
        return { direction:"SHORT", signal:"EMA21", entry:c.c, sl:swingHigh, tp:c.c-risk*DT_RR, barTime:c.t };
    }
    if (EMA50_PAIRS.has(symbol) && e50Dn && r>38 && r<=62 && volOk && p.c>e50[i-1] && c.c<e50[i]) {
      const swingHigh = Math.max(...candles.slice(Math.max(0,i-4),i+1).map(x=>x.h));
      const risk = swingHigh - c.c;
      if (risk > 0 && risk/c.c < 0.018)
        return { direction:"SHORT", signal:"EMA50", entry:c.c, sl:swingHigh, tp:c.c-risk*DT_RR, barTime:c.t };
    }
  }

  return null;
}

// ── DT Simulation ────────────────────────────────────────────────────────────

function simulateDT(allBars15m, useFib) {
  const allEvents = [];
  for (const sym of DT_PAIRS) {
    const bars = allBars15m[sym];
    if (!bars) continue;
    for (const b of bars) allEvents.push({ ...b, sym });
  }
  allEvents.sort((a,b) => a.t - b.t || a.sym.localeCompare(b.sym));

  const symBars     = {};
  const symPos      = {};
  const symLastTime = {};
  for (const sym of DT_PAIRS) { symBars[sym]=[]; symPos[sym]=null; symLastTime[sym]=0; }

  let balance = DT_PORTFOLIO, peak = DT_PORTFOLIO, maxDD = 0;
  let trades = 0, wins = 0, totalWin = 0, totalLoss = 0;
  let blocked_noImpulse = 0, blocked_wrongDir = 0, blocked_outOfZone = 0;

  for (const ev of allEvents) {
    const sym = ev.sym;
    symBars[sym].push(ev);
    const bars = symBars[sym];
    const n    = bars.length;
    if (n < 3) continue;

    // ── Exit check ──────────────────────────────────────────────────────────
    const pos = symPos[sym];
    if (pos) {
      const c = ev;
      const isLong  = pos.direction === "LONG";
      const hitTP   = isLong ? c.h >= pos.tp  : c.l <= pos.tp;
      const hitSL   = isLong ? c.l <= pos.sl  : c.h >= pos.sl;
      const barsHeld= n - 1 - pos.openIdx;
      const timeExit= barsHeld >= DT_MAX_BARS;

      let exitPrice = null;
      if      (hitSL && hitTP) exitPrice = pos.sl;
      else if (hitSL)          exitPrice = pos.sl;
      else if (hitTP)          exitPrice = pos.tp;
      else if (timeExit)       exitPrice = c.c;

      if (exitPrice !== null) {
        const priceDiff = isLong ? exitPrice - pos.entry : pos.entry - exitPrice;
        const pnl       = (priceDiff / pos.entry) * pos.sizeUSD;
        balance += pnl;
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak * 100;
        if (dd > maxDD) maxDD = dd;
        trades++;
        if (pnl >= 0) { wins++; totalWin += pnl; } else { totalLoss += Math.abs(pnl); }
        symPos[sym] = null;
      }
    }

    // ── Entry check ─────────────────────────────────────────────────────────
    if (!symPos[sym] && n >= 72) {
      const sig = dtSignal(sym, bars, n - 2);
      if (sig && sig.barTime > symLastTime[sym]) {

        // Fibonacci Golden Pocket filter
        if (useFib) {
          const fib = detectFibZone(bars, n - 2);
          if (!fib) { blocked_noImpulse++; continue; }

          // Direction must match
          if (sig.direction === "LONG" && fib.direction !== "UP")   { blocked_wrongDir++; continue; }
          if (sig.direction === "SHORT"&& fib.direction !== "DOWN") { blocked_wrongDir++; continue; }

          // Price must be in the 0.5–0.618 golden pocket zone
          if (!fib.inZone) { blocked_outOfZone++; continue; }
        }

        const riskUSD = balance * DT_RISK_PCT;
        const slDist  = Math.abs(sig.entry - sig.sl);
        const sizeUSD = (riskUSD / slDist) * sig.entry * DT_LEVERAGE;

        symPos[sym]      = { ...sig, sizeUSD, riskUSD, openIdx: n - 1 };
        symLastTime[sym] = sig.barTime;
      }
    }
  }

  for (const sym of DT_PAIRS) {
    const pos = symPos[sym], bars = symBars[sym];
    if (!pos || bars.length === 0) continue;
    const c = bars[bars.length-1];
    const isLong = pos.direction === "LONG";
    const priceDiff = isLong ? c.c - pos.entry : pos.entry - c.c;
    const pnl = (priceDiff / pos.entry) * pos.sizeUSD;
    balance += pnl;
    trades++;
    if (pnl >= 0) { wins++; totalWin += pnl; } else { totalLoss += Math.abs(pnl); }
  }

  const retPct  = ((balance - DT_PORTFOLIO) / DT_PORTFOLIO * 100).toFixed(1);
  const winRate = trades > 0 ? (wins / trades * 100).toFixed(1) : "0.0";
  const avgWin  = wins > 0            ? (totalWin  / wins).toFixed(0)           : "0";
  const avgLoss = (trades - wins) > 0 ? (totalLoss / (trades - wins)).toFixed(0): "0";
  const pf      = totalLoss > 0       ? (totalWin  / totalLoss).toFixed(2)       : "∞";

  return {
    endBal: balance, retPct, winRate, avgWin: `$${avgWin}`, avgLoss: `-$${avgLoss}`,
    pf, trades, wins, maxDD: maxDD.toFixed(1),
    blocked: blocked_noImpulse + blocked_wrongDir + blocked_outOfZone,
    blockedReasons: { noImpulse: blocked_noImpulse, wrongDir: blocked_wrongDir, outOfZone: blocked_outOfZone },
  };
}

// ── Comparison output ─────────────────────────────────────────────────────────

function printRow(label, orig, enh, higherIsBetter = true) {
  const origV = parseFloat(orig);
  const enhV  = parseFloat(enh);
  let arrow = "";
  if (!isNaN(origV) && !isNaN(enhV)) {
    if (enhV > origV) arrow = higherIsBetter ? " ↑ better" : " ↑ worse";
    if (enhV < origV) arrow = higherIsBetter ? " ↓ worse"  : " ↓ better";
  }
  const origStr = String(orig).padStart(16);
  const enhStr  = String(enh).padStart(16);
  console.log(`  ${label.padEnd(22)} ${origStr}  ${enhStr}  ${arrow}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();

  console.log("╔══════════════════════════════════════════╗");
  console.log("║  SESSION 3: DT + FIB GOLDEN POCKET FILTER║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`  Period: ${new Date(START_SEC*1000).toISOString().slice(0,10)} → ${new Date(NOW_SEC*1000).toISOString().slice(0,10)}`);
  console.log(`  Filter: Only enter when price is in 0.5–0.618 retracement of recent ≥1.5% impulse`);
  console.log(`  Lookback: ${FIB_LOOKBACK} bars (${FIB_LOOKBACK * 15 / 60}h)\n`);

  console.log("[1/1] Fetching DT 15min bars (6 pairs)…");
  const bars15 = {};
  for (const sym of DT_PAIRS) {
    process.stdout.write(`  ${sym}… `);
    bars15[sym] = await fetchAllBars(sym, "Min15", 900, START_SEC, NOW_SEC);
    console.log(`${bars15[sym].length} bars ✓`);
  }

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  RUNNING SIMULATIONS…");
  console.log("══════════════════════════════════════════════════════════════\n");

  process.stdout.write("  DT Original…\n");
  const orig = simulateDT(bars15, false);
  console.log(`  Done: $${orig.endBal.toFixed(0)} | ${orig.trades} trades\n`);

  process.stdout.write("  DT Enhanced (Fib Golden Pocket)…\n");
  const enh = simulateDT(bars15, true);
  console.log(`  Done: $${enh.endBal.toFixed(0)} | ${enh.trades} trades (${enh.blocked} blocked)\n`);

  console.log("──────────────────────────────────────────────────────────────");
  console.log("  DT CRYPTO (15min) — Original vs Fib Golden Pocket Enhanced");
  console.log("──────────────────────────────────────────────────────────────");
  console.log(`  ${"".padEnd(22)} ${"Original".padStart(16)}  ${"Enhanced".padStart(16)}`);
  console.log("  " + "─".repeat(58));
  printRow("End balance",  `$${orig.endBal.toFixed(0)}`, `$${enh.endBal.toFixed(0)}`);
  printRow("Return",       `${orig.retPct}%`,             `${enh.retPct}%`);
  printRow("Max drawdown", `${orig.maxDD}%`,              `${enh.maxDD}%`,  false);
  printRow("Trades",       orig.trades,                   enh.trades);
  printRow("Win rate",     `${orig.winRate}%`,            `${enh.winRate}%`);
  printRow("Avg win",      orig.avgWin,                   enh.avgWin);
  printRow("Avg loss",     orig.avgLoss,                  enh.avgLoss,     false);
  printRow("Profit factor",orig.pf,                       enh.pf);

  console.log("\n  Fib filter block breakdown:");
  console.log(`    No qualifying impulse (<1.5%):  ${enh.blockedReasons.noImpulse}`);
  console.log(`    Impulse direction wrong:        ${enh.blockedReasons.wrongDir}`);
  console.log(`    Price outside 0.5–0.618 zone:   ${enh.blockedReasons.outOfZone}`);
  console.log(`    Total blocked:                  ${enh.blocked}`);

  const origRet = parseFloat(orig.retPct), enhRet = parseFloat(enh.retPct);
  const origDD  = parseFloat(orig.maxDD),  enhDD  = parseFloat(enh.maxDD);
  const origPF  = parseFloat(orig.pf),     enhPF  = parseFloat(enh.pf);

  const retWins = enhRet > origRet;
  const ddWins  = enhDD  < origDD;
  const pfWins  = enhPF  > origPF;
  const score   = [retWins, ddWins, pfWins].filter(Boolean).length;

  let verdict;
  if (score === 3)      verdict = "✅ ENHANCED WINS — all 3 metrics improved";
  else if (score === 2) verdict = "⚠️  REVIEW — 2/3 metrics improved";
  else                  verdict = "❌ ORIGINAL WINS — filter does not help";

  console.log(`\n  Verdict: ${verdict}`);
  console.log(`  Score:   Return ${retWins?"✅":"❌"} | MaxDD ${ddWins?"✅":"❌"} | ProfitFactor ${pfWins?"✅":"❌"}`);

  if (score >= 2) {
    console.log("\n  💡 NEXT STEP: Build bot_daytrading_enhanced.js with Fib filter");
    console.log("     (separate file — do not modify live Railway bot)");
  }

  const mins = ((Date.now()-t0)/60000).toFixed(1);
  console.log(`\n  Backtest time: ${mins} min`);
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
