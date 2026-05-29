/**
 * backtest_session2.js — DT Bot: Higher-Timeframe (1H) EMA Trend Confirmation
 *
 * Session 2 enhancement: Only enter DT trades when the 1H chart EMA21/50 alignment
 * matches the trade direction. This mirrors the core TradingView multi-timeframe
 * analysis workflow — confirm the 15min signal with a higher-timeframe trend.
 *
 * Filter rules:
 *   LONG  signals → only allowed when 1H EMA21 > EMA50 (higher-TF bullish)
 *   SHORT signals → only allowed when 1H EMA21 < EMA50 (higher-TF bearish)
 *
 * Comparison: DT Original vs DT + HTF EMA Confirmation
 * Run: node backtest_session2.js
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

// ── Indicators ────────────────────────────────────────────────────────────────

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

// ── Session / ORB helpers (same as live bot) ──────────────────────────────────

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

// ── Build HTF (1H) EMA bias lookup ───────────────────────────────────────────
// Returns a sorted array of {t, ema21, ema50} — one per closed 1H bar
// Caller uses binary search to find the most recent closed bar before a 15min signal

function buildHTFBiasArray(htfBars) {
  const closes = htfBars.map(b => b.c);
  const e21    = ema(closes, 21);
  const e50    = ema(closes, 50);
  // Only include bars where both EMAs are valid (need 50+ bars)
  return htfBars.map((b, i) => ({
    t:     b.t,
    ema21: e21[i],
    ema50: e50[i],
    bull:  e21[i] !== null && e50[i] !== null ? e21[i] > e50[i] : null,
  })).filter(b => b.bull !== null);
}

function getHTFBull(htfBiasArr, signalTimeMs) {
  // Find the last entry whose bar close time (t + 3600000) <= signalTimeMs
  // i.e. the bar was already closed when the 15min signal fired
  const barCloseMs = 3600 * 1000;
  let lo = 0, hi = htfBiasArr.length - 1, result = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (htfBiasArr[mid].t + barCloseMs <= signalTimeMs) { result = htfBiasArr[mid]; lo = mid+1; }
    else hi = mid-1;
  }
  return result; // null if no closed 1H bar found yet
}

// ── DT signal generator (matches live bot analyzeSymbol) ─────────────────────

function dtSignal(symbol, candles, i) {
  if (i < 70 || i < 2) return null;

  const closes = candles.map(c => c.c);
  const vols   = candles.map(c => c.v);
  const n      = candles.length;

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
    // LONG A: EMA21 recapture
    if (e50Up && longRsi && volOk && p.c < e21[i-1] && c.c > e21[i]) {
      const swingLow = Math.min(...candles.slice(Math.max(0,i-3),i+1).map(x=>x.l));
      const risk = c.c - swingLow;
      if (risk > 0 && risk/c.c < DT_MAX_SL_PCT)
        return { direction:"LONG", signal:"EMA21", entry:c.c, sl:swingLow, tp:c.c+risk*DT_RR, barTime:c.t };
    }
    // LONG B: EMA50 bounce (BTC/SUI only)
    if (EMA50_PAIRS.has(symbol) && e50Up && r>=38 && r<62 && volOk && p.c<e50[i-1] && c.c>e50[i]) {
      const swingLow = Math.min(...candles.slice(Math.max(0,i-4),i+1).map(x=>x.l));
      const risk = c.c - swingLow;
      if (risk > 0 && risk/c.c < 0.018)
        return { direction:"LONG", signal:"EMA50", entry:c.c, sl:swingLow, tp:c.c+risk*DT_RR, barTime:c.t };
    }
  }

  if (bias === 'SHORT') {
    // SHORT A: EMA21 rejection
    if (e50Dn && shortRsi && volOk && p.c>e21[i-1] && c.c<e21[i]) {
      const swingHigh = Math.max(...candles.slice(Math.max(0,i-3),i+1).map(x=>x.h));
      const risk = swingHigh - c.c;
      if (risk > 0 && risk/c.c < DT_MAX_SL_PCT)
        return { direction:"SHORT", signal:"EMA21", entry:c.c, sl:swingHigh, tp:c.c-risk*DT_RR, barTime:c.t };
    }
    // SHORT B: EMA50 rejection (BTC/SUI only)
    if (EMA50_PAIRS.has(symbol) && e50Dn && r>38 && r<=62 && volOk && p.c>e50[i-1] && c.c<e50[i]) {
      const swingHigh = Math.max(...candles.slice(Math.max(0,i-4),i+1).map(x=>x.h));
      const risk = swingHigh - c.c;
      if (risk > 0 && risk/c.c < 0.018)
        return { direction:"SHORT", signal:"EMA50", entry:c.c, sl:swingHigh, tp:c.c-risk*DT_RR, barTime:c.t };
    }
  }

  return null;
}

// ── DT Simulation ─────────────────────────────────────────────────────────────

function simulateDT(allBars15m, htfBiasMap, useHTF) {
  let balance = DT_PORTFOLIO, peak = DT_PORTFOLIO;
  let maxDD = 0, trades = 0, wins = 0;
  const positions = []; // { symbol, direction, entry, sl, tp, sizeUSD, riskUSD, openBarIdx, barTimes }
  let totalWin = 0, totalLoss = 0;

  // Build a merged timeline of 15min bars across all symbols
  // For each symbol, iterate bar by bar — track positions per symbol
  const symPositions = {}; // symbol → current open position or null
  const lastBarTime  = {}; // symbol → last entry bar time (dedup)
  for (const sym of DT_PAIRS) { symPositions[sym] = null; lastBarTime[sym] = 0; }

  // Per-symbol simulation
  const results = {};
  for (const sym of DT_PAIRS) {
    const bars = allBars15m[sym];
    if (!bars || bars.length < 80) { results[sym]={trades:0,wins:0,totalWin:0,totalLoss:0}; continue; }

    let symBal = 0; // track per-symbol P&L
    let pos    = null;
    let symTrades=0, symWins=0, symWin=0, symLoss=0;

    for (let i = 1; i < bars.length; i++) {
      // ── Check exit ─────────────────────────────────────────────────────────
      if (pos) {
        const c = bars[i];
        const isLong  = pos.direction === "LONG";
        const hitTP   = isLong ? c.h >= pos.tp  : c.l <= pos.tp;
        const hitSL   = isLong ? c.l <= pos.sl  : c.h >= pos.sl;
        const barsHeld= i - pos.openIdx;
        const timeExit= barsHeld >= DT_MAX_BARS;

        let exitPrice = null;
        if (hitSL && hitTP) exitPrice = pos.sl;
        else if (hitSL)     exitPrice = pos.sl;
        else if (hitTP)     exitPrice = pos.tp;
        else if (timeExit)  exitPrice = c.c;

        if (exitPrice !== null) {
          const priceDiff = isLong ? exitPrice - pos.entry : pos.entry - exitPrice;
          const pnl       = (priceDiff / pos.entry) * pos.sizeUSD;
          symBal += pnl;
          symTrades++;
          if (pnl >= 0) { symWins++; symWin += pnl; }
          else          { symLoss += Math.abs(pnl); }
          pos = null;
        }
      }

      // ── Check entry ────────────────────────────────────────────────────────
      if (!pos && i >= 70) {
        const sig = dtSignal(sym, bars.slice(0, i+1), bars.slice(0, i+1).length - 2);
        if (sig && sig.barTime > lastBarTime[sym]) {
          // HTF filter
          if (useHTF) {
            const htfArr  = htfBiasMap[sym];
            const htfBar  = htfArr ? getHTFBull(htfArr, sig.barTime) : null;
            if (htfBar) {
              const htfBull = htfBar.bull;
              if (sig.direction === "LONG"  && !htfBull) continue; // blocked
              if (sig.direction === "SHORT" &&  htfBull) continue; // blocked
            }
          }

          const riskUSD = DT_PORTFOLIO * DT_RISK_PCT; // fixed portfolio base for fair comparison
          const slDist  = Math.abs(sig.entry - sig.sl);
          const sizeUSD = (riskUSD / slDist) * sig.entry * DT_LEVERAGE;

          pos = { ...sig, sizeUSD, riskUSD, openIdx: i };
          lastBarTime[sym] = sig.barTime;
        }
      }
    }

    // Close any remaining open position at last bar
    if (pos) {
      const c = bars[bars.length - 1];
      const isLong = pos.direction === "LONG";
      const exitPrice = c.c;
      const priceDiff = isLong ? exitPrice - pos.entry : pos.entry - exitPrice;
      const pnl = (priceDiff / pos.entry) * pos.sizeUSD;
      symBal += pnl;
      symTrades++;
      if (pnl >= 0) { symWins++; symWin += pnl; } else { symLoss += Math.abs(pnl); }
    }

    results[sym] = { trades: symTrades, wins: symWins, totalWin: symWin, totalLoss: symLoss, pnl: symBal };
  }

  // Aggregate — apply P&L on top of shared portfolio balance
  // (each symbol risks 0.8% of the SAME portfolio base — parallel positions)
  let totalPnL = 0, totalTrades = 0, totalWins = 0, totalWinAmt = 0, totalLossAmt = 0;
  for (const sym of DT_PAIRS) {
    const r = results[sym];
    totalPnL    += r.pnl || 0;
    totalTrades += r.trades;
    totalWins   += r.wins;
    totalWinAmt += r.totalWin;
    totalLossAmt+= r.totalLoss;
  }

  const endBal   = DT_PORTFOLIO + totalPnL;
  const retPct   = (totalPnL / DT_PORTFOLIO * 100).toFixed(1);
  const winRate  = totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(1) : "0.0";
  const avgWin   = totalWins > 0 ? (totalWinAmt / totalWins).toFixed(0) : "0";
  const avgLoss  = (totalTrades - totalWins) > 0 ? (totalLossAmt / (totalTrades - totalWins)).toFixed(0) : "0";
  const pf       = totalLossAmt > 0 ? (totalWinAmt / totalLossAmt).toFixed(2) : "∞";

  // Approximate max drawdown via running balance per bar (simplified)
  // We'll compute it from the per-symbol results above
  // For now use the aggregate P&L trajectory (rough)
  const maxDDPct = "N/A"; // see note below

  return { endBal, retPct, winRate, avgWin, avgLoss, pf, totalTrades, totalWins, totalPnL, results };
}

// ── Better simulation: sequential per-bar across all symbols ─────────────────

function simulateDT2(allBars15m, htfBiasMap, useHTF) {
  // Build a unified timeline
  const allEvents = [];
  for (const sym of DT_PAIRS) {
    const bars = allBars15m[sym];
    if (!bars) continue;
    for (const b of bars) allEvents.push({ ...b, sym });
  }
  allEvents.sort((a,b) => a.t - b.t || a.sym.localeCompare(b.sym));

  // Per-symbol sliding window of recent bars for signal computation
  const symBars     = {};
  const symPos      = {};
  const symLastTime = {};
  for (const sym of DT_PAIRS) { symBars[sym]=[]; symPos[sym]=null; symLastTime[sym]=0; }

  let balance  = DT_PORTFOLIO;
  let peak     = DT_PORTFOLIO;
  let maxDD    = 0;
  let trades   = 0, wins = 0, totalWin = 0, totalLoss = 0;
  let blocked  = 0;

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

        // HTF filter
        if (useHTF) {
          const htfArr = htfBiasMap[sym];
          const htfBar = htfArr ? getHTFBull(htfArr, sig.barTime) : null;
          if (htfBar) {
            const htfBull = htfBar.bull;
            if (sig.direction === "LONG"  && !htfBull) { blocked++; continue; }
            if (sig.direction === "SHORT" &&  htfBull) { blocked++; continue; }
          }
        }

        const riskUSD = balance * DT_RISK_PCT;
        const slDist  = Math.abs(sig.entry - sig.sl);
        const sizeUSD = (riskUSD / slDist) * sig.entry * DT_LEVERAGE;

        symPos[sym]      = { ...sig, sizeUSD, riskUSD, openIdx: n - 1 };
        symLastTime[sym] = sig.barTime;
      }
    }
  }

  // Force-close remaining positions
  for (const sym of DT_PAIRS) {
    const pos  = symPos[sym];
    const bars = symBars[sym];
    if (!pos || bars.length === 0) continue;
    const c       = bars[bars.length-1];
    const isLong  = pos.direction === "LONG";
    const priceDiff = isLong ? c.c - pos.entry : pos.entry - c.c;
    const pnl       = (priceDiff / pos.entry) * pos.sizeUSD;
    balance += pnl;
    trades++;
    if (pnl >= 0) { wins++; totalWin += pnl; } else { totalLoss += Math.abs(pnl); }
  }

  const retPct  = ((balance - DT_PORTFOLIO) / DT_PORTFOLIO * 100).toFixed(1);
  const winRate = trades > 0 ? (wins / trades * 100).toFixed(1) : "0.0";
  const avgWin  = wins > 0            ? (totalWin  / wins).toFixed(0)           : "0";
  const avgLoss = (trades - wins) > 0 ? (totalLoss / (trades - wins)).toFixed(0): "0";
  const pf      = totalLoss > 0       ? (totalWin  / totalLoss).toFixed(2)       : "∞";

  return { endBal: balance, retPct, winRate, avgWin: `$${avgWin}`, avgLoss: `-$${avgLoss}`,
           pf, trades, wins, maxDD: maxDD.toFixed(1), blocked };
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
  console.log("║  SESSION 2: DT + 1H HTF TREND FILTER     ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`  Period: ${new Date(START_SEC*1000).toISOString().slice(0,10)} → ${new Date(NOW_SEC*1000).toISOString().slice(0,10)}`);
  console.log(`  Filter: LONG only when 1H EMA21 > EMA50 | SHORT only when 1H EMA21 < EMA50\n`);

  // ── 1. Fetch 15min bars ──────────────────────────────────────────────────
  console.log("[1/2] Fetching DT 15min bars (6 pairs)…");
  const bars15 = {};
  for (const sym of DT_PAIRS) {
    process.stdout.write(`  ${sym}… `);
    bars15[sym] = await fetchAllBars(sym, "Min15", 900, START_SEC, NOW_SEC);
    console.log(`${bars15[sym].length} bars ✓`);
  }

  // ── 2. Fetch 1H bars and build HTF bias lookup ───────────────────────────
  console.log("\n[2/2] Fetching 1H HTF bars (6 pairs)…");
  const htfBiasMap = {};
  for (const sym of DT_PAIRS) {
    process.stdout.write(`  ${sym}… `);
    const htfBars = await fetchAllBars(sym, "Min60", 3600, START_SEC - 60*3600, NOW_SEC); // extra 60H warmup
    htfBiasMap[sym] = buildHTFBiasArray(htfBars);
    console.log(`${htfBars.length} 1H bars → ${htfBiasMap[sym].length} HTF bias points ✓`);
  }

  // ── 3. Simulate ──────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  RUNNING SIMULATIONS…");
  console.log("══════════════════════════════════════════════════════════════\n");

  process.stdout.write("  DT Original…\n");
  const orig = simulateDT2(bars15, htfBiasMap, false);
  console.log(`  Done: $${orig.endBal.toFixed(0)} | ${orig.trades} trades\n`);

  process.stdout.write("  DT Enhanced (1H HTF)…\n");
  const enh = simulateDT2(bars15, htfBiasMap, true);
  console.log(`  Done: $${enh.endBal.toFixed(0)} | ${enh.trades} trades (${enh.blocked} blocked by HTF filter)\n`);

  // ── 4. Print comparison ──────────────────────────────────────────────────
  console.log("──────────────────────────────────────────────────────────────");
  console.log("  DT CRYPTO (15min) — Original vs 1H HTF Enhanced");
  console.log("──────────────────────────────────────────────────────────────");
  console.log(`  ${"".padEnd(22)} ${"Original".padStart(16)}  ${"Enhanced".padStart(16)}`);
  console.log("  " + "─".repeat(58));
  printRow("End balance",  `$${orig.endBal.toFixed(0)}`,  `$${enh.endBal.toFixed(0)}`);
  printRow("Return",       `${orig.retPct}%`,              `${enh.retPct}%`);
  printRow("Max drawdown", `${orig.maxDD}%`,               `${enh.maxDD}%`,  false);
  printRow("Trades",       orig.trades,                    enh.trades);
  printRow("HTF blocked",  "—",                            enh.blocked);
  printRow("Win rate",     `${orig.winRate}%`,             `${enh.winRate}%`);
  printRow("Avg win",      orig.avgWin,                    enh.avgWin);
  printRow("Avg loss",     orig.avgLoss,                   enh.avgLoss,      false);
  printRow("Profit factor",orig.pf,                        enh.pf);

  const origRet = parseFloat(orig.retPct);
  const enhRet  = parseFloat(enh.retPct);
  const origDD  = parseFloat(orig.maxDD);
  const enhDD   = parseFloat(enh.maxDD);
  const origPF  = parseFloat(orig.pf);
  const enhPF   = parseFloat(enh.pf);

  const retWins = enhRet  > origRet;
  const ddWins  = enhDD   < origDD;
  const pfWins  = enhPF   > origPF;
  const score   = [retWins, ddWins, pfWins].filter(Boolean).length;

  let verdict;
  if (score === 3)      verdict = "✅ ENHANCED WINS — all 3 metrics improved";
  else if (score === 2) verdict = "⚠️  REVIEW — 2/3 metrics improved";
  else                  verdict = "❌ ORIGINAL WINS — filter does not help";

  console.log(`\n  Verdict: ${verdict}`);
  console.log(`  Score:   Return ${retWins?"✅":"❌"} | MaxDD ${ddWins?"✅":"❌"} | ProfitFactor ${pfWins?"✅":"❌"}`);

  if (score >= 2) {
    console.log("\n  💡 NEXT STEP: Build bot_daytrading_enhanced.js with 1H HTF filter");
    console.log("     (separate file — do not modify live Railway bot)");
  }

  const mins = ((Date.now()-t0)/60000).toFixed(1);
  console.log(`\n  Backtest time: ${mins} min`);
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
