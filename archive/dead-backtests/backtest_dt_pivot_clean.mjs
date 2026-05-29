/**
 * backtest_dt_pivot_clean.mjs
 *
 * DT baseline vs DT + pivot filter — using the exact same signal logic
 * as backtest_dt_daily.mjs (unchanged). The only addition is:
 *
 *   PIVOT FILTER: at signal time, EMA21 must be within ±0.4% of any of
 *   the daily classic pivot levels (PP, R1, S1) derived from the previous
 *   UTC day's high/low/close on the 15m data.
 *
 *   Rationale: EMA21 is the level being recaptured/rejected. If it also
 *   coincides with an institutional pivot level, both systems agree on
 *   where S/R sits — higher-conviction entry.
 *
 * Changes from backtest_dt_daily.mjs:
 *   + buildPivotArray()          — derives daily pivots from 15m bars
 *   + pivots array in precompute()
 *   + usePivotFilter param in signal() — one extra check, nothing else moved
 *   + simulate() accepts usePivotFilter flag
 *   + runs twice, prints side-by-side comparison
 *
 * Run: node backtest_dt_pivot_clean.mjs [DAYS] [START_BAL]
 */

const DAYS      = parseInt(process.argv[2]  || "365");
const START_BAL = parseFloat(process.argv[3] || "5000");

const RISK_PCT    = 0.008;
const LEVERAGE    = 5;
const MAX_POS     = 6;
const MAX_SL_PCT  = 0.012;
const RR          = 1.3;
const MAX_HOLD    = 8;
const EMA50_PAIRS = new Set(["BTCUSDT", "SUIUSDT"]);
const PAIRS       = ["BTCUSDT", "BNBUSDT", "XRPUSDT", "SUIUSDT", "LTCUSDT", "AVAXUSDT"];

// Pivot filter tolerance: EMA21 within ±X% of a pivot level
const PIVOT_TOL   = 0.004;  // 0.4%

// ─── Fetch (unchanged) ────────────────────────────────────────────────────────

async function fetchCandles(symbol, days) {
  const needed = (days + 5) * 96 + 200;
  const batches = Math.ceil(needed / 1000);
  const all = [];
  let endTime = Date.now();
  for (let b = 0; b < batches; b++) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=1000&endTime=${endTime}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const raw = await res.json();
      if (!Array.isArray(raw) || raw.length === 0) break;
      all.unshift(...raw.map(k => ({
        time:   parseInt(k[0]),
        open:   parseFloat(k[1]),
        high:   parseFloat(k[2]),
        low:    parseFloat(k[3]),
        close:  parseFloat(k[4]),
        volume: parseFloat(k[5]),
      })));
      endTime = raw[0][0] - 1;
    } catch { break; }
    if (b < batches - 1) await new Promise(r => setTimeout(r, 150));
  }
  const seen = new Set();
  return all.filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
            .sort((a, b) => a.time - b.time);
}

// ─── Indicators (unchanged) ───────────────────────────────────────────────────

function ema(vals, p) {
  const k = 2 / (p + 1), out = new Array(vals.length).fill(null);
  let s = vals[0];
  for (let i = 0; i < vals.length; i++) { s = i === 0 ? vals[0] : vals[i] * k + s * (1 - k); out[i] = s; }
  return out;
}
function sma(vals, p) {
  const out = new Array(vals.length).fill(null);
  for (let i = p - 1; i < vals.length; i++)
    out[i] = vals.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p;
  return out;
}
function rsi14(vals) {
  const out = new Array(vals.length).fill(null);
  if (vals.length < 15) return out;
  let ag = 0, al = 0;
  for (let i = 1; i <= 14; i++) { const d = vals[i] - vals[i - 1]; if (d > 0) ag += d; else al -= d; }
  ag /= 14; al /= 14;
  out[14] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = 15; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1];
    ag = (ag * 13 + Math.max(d, 0)) / 14;
    al = (al * 13 + Math.max(-d, 0)) / 14;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
function adxCalc(candles, period = 14) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < period * 2) return out;
  let tr = 0, pdm = 0, ndm = 0;
  for (let i = 1; i <= period; i++) {
    const c = candles[i], p = candles[i - 1];
    tr  += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    pdm += Math.max(c.high - p.high, 0) > Math.max(p.low - c.low, 0) ? Math.max(c.high - p.high, 0) : 0;
    ndm += Math.max(p.low - c.low, 0) > Math.max(c.high - p.high, 0) ? Math.max(p.low - c.low, 0) : 0;
  }
  let adxVal = 0;
  const dxArr = [];
  for (let i = period + 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const ctr  = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const cpdm = Math.max(c.high - p.high, 0) > Math.max(p.low - c.low, 0) ? Math.max(c.high - p.high, 0) : 0;
    const cndm = Math.max(p.low - c.low, 0) > Math.max(c.high - p.high, 0) ? Math.max(p.low - c.low, 0) : 0;
    tr = tr - tr/period + ctr; pdm = pdm - pdm/period + cpdm; ndm = ndm - ndm/period + cndm;
    const pdi = tr > 0 ? pdm/tr*100 : 0, ndi = tr > 0 ? ndm/tr*100 : 0;
    const dx = (pdi+ndi) > 0 ? Math.abs(pdi-ndi)/(pdi+ndi)*100 : 0;
    dxArr.push({ i, dx });
    if (dxArr.length === period) { adxVal = dxArr.reduce((s,x)=>s+x.dx,0)/period; out[i] = adxVal; }
    else if (dxArr.length > period) { adxVal = (adxVal*(period-1)+dx)/period; out[i] = adxVal; }
  }
  return out;
}

// ─── Session ORB (unchanged) ──────────────────────────────────────────────────

function inSession(ts) { const h = new Date(ts).getUTCHours(); return h >= 1 && h < 22; }

const SESSION_OPENS = new Set([1, 8, 13]);

function sessionORBCalc(candles) {
  const orbs = new Array(candles.length).fill(null);
  let building = false, orbHigh = -Infinity, orbLow = Infinity;
  let confirmedORB = null, sessionBias = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const h = new Date(c.time).getUTCHours(), m = new Date(c.time).getUTCMinutes();
    if (SESSION_OPENS.has(h) && m === 0) {
      building = true; orbHigh = c.high; orbLow = c.low; confirmedORB = null; sessionBias = null;
    } else if (building) {
      orbHigh = Math.max(orbHigh, c.high); orbLow = Math.min(orbLow, c.low);
      confirmedORB = { high: orbHigh, low: orbLow }; building = false;
    }
    if (confirmedORB && sessionBias === null) {
      if (c.close > confirmedORB.high) sessionBias = 'LONG';
      else if (c.close < confirmedORB.low) sessionBias = 'SHORT';
    }
    orbs[i] = confirmedORB ? { ...confirmedORB, bias: sessionBias } : null;
  }
  return orbs;
}

// ─── PIVOT ADDITION ───────────────────────────────────────────────────────────
// Derive daily classic pivots (PP, R1, S1) from previous UTC day's OHLC.
// One pivot object per 15m candle — pivots update at UTC midnight.

function buildPivotArray(candles) {
  // Step 1: aggregate 15m candles into daily OHLC by UTC date
  const daily = {};
  for (const c of candles) {
    const day = new Date(c.time).toISOString().slice(0, 10);
    if (!daily[day]) daily[day] = { H: -Infinity, L: Infinity, C: 0 };
    daily[day].H = Math.max(daily[day].H, c.high);
    daily[day].L = Math.min(daily[day].L, c.low);
    daily[day].C = c.close; // last 15m bar of day = day close
  }
  const sortedDays = Object.keys(daily).sort();

  // Step 2: for each 15m candle, look up previous day and compute pivots
  return candles.map(c => {
    const day = new Date(c.time).toISOString().slice(0, 10);
    const idx = sortedDays.indexOf(day);
    if (idx < 1) return null;
    const prev = daily[sortedDays[idx - 1]];
    if (!prev || prev.H === -Infinity) return null;
    const pp = (prev.H + prev.L + prev.C) / 3;
    return {
      pp,
      r1: 2 * pp - prev.L,
      s1: 2 * pp - prev.H,
    };
  });
}

// ─── Precompute (one new line: pivots) ───────────────────────────────────────

function precompute(symbol, candles) {
  const closes = candles.map(c => c.close);
  const vols   = candles.map(c => c.volume);
  return {
    symbol, candles,
    e21:    ema(closes, 21),
    e50:    ema(closes, 50),
    rsiV:   rsi14(closes),
    vsma:   sma(vols, 20),
    adx:    adxCalc(candles),
    orbs:   sessionORBCalc(candles),
    pivots: buildPivotArray(candles),   // ← only addition to precompute
  };
}

// ─── Signal (one extra check when usePivotFilter=true) ───────────────────────

function signal(pre, i, usePivotFilter = false) {
  if (i < 70) return null;
  const { symbol, candles, e21, e50, rsiV, vsma, adx, orbs, pivots } = pre;
  const c = candles[i], p = candles[i - 1], r = rsiV[i];
  if (!r || !vsma[i]) return null;
  if (!inSession(c.time)) return null;
  if (!adx[i] || adx[i] < 20) return null;

  const orb = orbs[i];
  if (!orb || !orb.bias) return null;
  const aboveORB = orb.bias === 'LONG';
  const belowORB = orb.bias === 'SHORT';

  const volOk = c.volume > vsma[i] * 1.2;
  const tb = 4;
  if (i < tb) return null;
  const e50Up = e50[i] > e50[i - tb];
  const e50Dn = e50[i] < e50[i - tb];

  // ── PIVOT FILTER (new — only when enabled) ───────────────────────────────
  // EMA21 (the level being recaptured/rejected) must sit within ±PIVOT_TOL
  // of PP, R1, or S1 from the previous UTC day. If the filter is off, this
  // block is skipped entirely and nothing else changes.
  if (usePivotFilter) {
    const piv = pivots[i];
    if (!piv) return null;
    const e = e21[i];
    const nearPivot = [piv.pp, piv.r1, piv.s1].some(
      lvl => Math.abs(e - lvl) / lvl <= PIVOT_TOL
    );
    if (!nearPivot) return null;
  }

  // ── LONG signals (unchanged) ─────────────────────────────────────────────
  if (aboveORB) {
    if (e50Up && r >= 40 && r < 65 && volOk && p.close < e21[i-1] && c.close > e21[i]) {
      const sl   = Math.min(...candles.slice(Math.max(0, i-3), i+1).map(x => x.low));
      const risk = c.close - sl;
      if (risk > 0 && risk / c.close < MAX_SL_PCT)
        return { dir: "LONG", signal: "EMA21", entry: c.close, sl, tp: c.close + risk * RR };
    }
    if (EMA50_PAIRS.has(symbol) && e50Up && r >= 38 && r < 62 && volOk && p.close < e50[i-1] && c.close > e50[i]) {
      const sl   = Math.min(...candles.slice(Math.max(0, i-4), i+1).map(x => x.low));
      const risk = c.close - sl;
      if (risk > 0 && risk / c.close < 0.018)
        return { dir: "LONG", signal: "EMA50", entry: c.close, sl, tp: c.close + risk * RR };
    }
  }

  // ── SHORT signals (unchanged) ────────────────────────────────────────────
  if (belowORB) {
    if (e50Dn && r > 35 && r <= 60 && volOk && p.close > e21[i-1] && c.close < e21[i]) {
      const sl   = Math.max(...candles.slice(Math.max(0, i-3), i+1).map(x => x.high));
      const risk = sl - c.close;
      if (risk > 0 && risk / c.close < MAX_SL_PCT)
        return { dir: "SHORT", signal: "EMA21", entry: c.close, sl, tp: c.close - risk * RR };
    }
    if (EMA50_PAIRS.has(symbol) && e50Dn && r > 38 && r <= 62 && volOk && p.close > e50[i-1] && c.close < e50[i]) {
      const sl   = Math.max(...candles.slice(Math.max(0, i-4), i+1).map(x => x.high));
      const risk = sl - c.close;
      if (risk > 0 && risk / c.close < 0.018)
        return { dir: "SHORT", signal: "EMA50", entry: c.close, sl, tp: c.close - risk * RR };
    }
  }

  return null;
}

// ─── Simulation (accepts usePivotFilter flag) ─────────────────────────────────

function simulate(allCandles, allPre, usePivotFilter = false) {
  const allTimes = new Set();
  for (const bars of Object.values(allCandles)) for (const c of bars) allTimes.add(c.time);
  const timeline = [...allTimes].sort((a, b) => a - b);
  const cutoff   = timeline[timeline.length - 1] - DAYS * 86400000;

  const byTime = {}, byIdx = {};
  for (const [sym, bars] of Object.entries(allCandles)) {
    byTime[sym] = {}; byIdx[sym] = {};
    bars.forEach((c, i) => { byTime[sym][c.time] = c; byIdx[sym][c.time] = i; });
  }

  let balance = START_BAL, peak = START_BAL, maxDD = 0;
  const openPositions = {};
  const trades = [];
  const monthMap = {};
  let pivotFiltered = 0;

  function getDay(ts) {
    const d = new Date(ts);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  }

  for (const t of timeline) {
    if (t < cutoff) continue;
    const mk = new Date(t).toISOString().slice(0, 7);
    if (!monthMap[mk]) monthMap[mk] = { pnl: 0, trades: 0, wins: 0 };

    for (const sym of PAIRS) {
      const i = byIdx[sym][t];
      if (i === undefined) continue;
      const c   = byTime[sym][t];
      const pre = allPre[sym];

      // ── Exit ──────────────────────────────────────────────────────────────
      if (openPositions[sym]) {
        const pos    = openPositions[sym];
        const isLong = pos.dir === "LONG";
        let closed = false, exitPrice = 0;

        if (isLong) {
          if (c.low  <= pos.sl) { exitPrice = pos.sl;  closed = true; }
          else if (c.high >= pos.tp) { exitPrice = pos.tp; closed = true; }
        } else {
          if (c.high >= pos.sl) { exitPrice = pos.sl;  closed = true; }
          else if (c.low  <= pos.tp) { exitPrice = pos.tp; closed = true; }
        }
        if (!closed && i - pos.entryBarIdx >= MAX_HOLD) { exitPrice = c.close; closed = true; }

        if (closed) {
          const movePct = isLong ? (exitPrice - pos.entry)/pos.entry : (pos.entry - exitPrice)/pos.entry;
          const slPct   = isLong ? (pos.entry - pos.sl)/pos.entry   : (pos.sl - pos.entry)/pos.entry;
          const pnl     = (movePct / slPct) * pos.riskUSD * LEVERAGE;
          balance += pnl;
          if (balance > peak) peak = balance;
          const dd = (peak - balance) / peak * 100;
          if (dd > maxDD) maxDD = dd;
          trades.push({ sym, dir: pos.dir, sig: pos.signal, pnl });
          monthMap[mk].pnl    += pnl;
          monthMap[mk].trades++;
          monthMap[mk].wins   += pnl >= 0 ? 1 : 0;
          delete openPositions[sym];
        }
      }

      // ── Entry ─────────────────────────────────────────────────────────────
      if (!openPositions[sym] && Object.keys(openPositions).length < MAX_POS) {
        // Count filtered signals for reporting
        const baseSignal = signal(pre, i, false);
        if (baseSignal) {
          if (usePivotFilter) {
            const filtSignal = signal(pre, i, true);
            if (!filtSignal) { pivotFiltered++; continue; }
          }
          const riskUSD = balance * RISK_PCT;
          openPositions[sym] = { ...baseSignal, sym, riskUSD, entryTime: c.time, entryBarIdx: i };
        }
      }
    }
  }

  // Close open positions at last price
  for (const [sym, pos] of Object.entries(openPositions)) {
    const bars = allCandles[sym];
    const lastC = bars[bars.length - 1];
    const isLong = pos.dir === "LONG";
    const movePct = isLong ? (lastC.close - pos.entry)/pos.entry : (pos.entry - lastC.close)/pos.entry;
    const slPct   = isLong ? (pos.entry - pos.sl)/pos.entry      : (pos.sl - pos.entry)/pos.entry;
    const pnl = (movePct / slPct) * pos.riskUSD * LEVERAGE;
    balance += pnl;
    const mk = new Date(lastC.time).toISOString().slice(0, 7);
    if (monthMap[mk]) { monthMap[mk].pnl += pnl; monthMap[mk].trades++; monthMap[mk].wins += pnl>=0?1:0; }
    trades.push({ sym, dir: pos.dir, sig: pos.signal, pnl });
  }

  const wins   = trades.filter(t => t.pnl >= 0).length;
  const wr     = trades.length ? wins/trades.length*100 : 0;
  const pnl    = balance - START_BAL;
  const ret    = pnl/START_BAL*100;
  const gw     = trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
  const gl     = Math.abs(trades.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0));
  const pf     = gl ? gw/gl : gw>0 ? Infinity : 0;

  return { balance, pnl, ret, trades: trades.length, wins, wr, pf, maxDD, monthMap, pivotFiltered };
}

// ─── Print comparison ─────────────────────────────────────────────────────────

function printComparison(base, filt) {
  const bar = '═'.repeat(76);
  const $ = n => (n>=0?'+$':'-$')+Math.abs(n).toFixed(0);
  const pc = n => (n>=0?'+':'')+n.toFixed(1)+'%';
  const col = 22;
  const h = s => String(s).padEnd(col);

  console.log(`\n${bar}`);
  console.log(`  DT BASELINE  vs  DT + PIVOT FILTER  |  ${DAYS}d  |  $${START_BAL.toLocaleString()}`);
  console.log(`  Pairs: ${PAIRS.join(' · ')}`);
  console.log(`  Pivot filter: EMA21 within ±${(PIVOT_TOL*100).toFixed(1)}% of daily PP / R1 / S1`);
  console.log(bar);

  const arrow = (a, b, lowerBetter=false) => {
    const na=parseFloat(a), nb=parseFloat(b);
    if (isNaN(na)||isNaN(nb)) return '';
    if (lowerBetter) return nb<na-0.1?'  ✅':nb>na+0.1?'  ❌':'  →';
    return nb>na+0.1?'  ✅':nb<na-0.1?'  ❌':'  →';
  };

  const rows = [
    ['Final balance',  `$${base.balance.toFixed(0)}`,   `$${filt.balance.toFixed(0)}`],
    ['Return',        pc(base.ret),                     pc(filt.ret)],
    ['P&L',           $(base.pnl),                      $(filt.pnl)],
    ['Total trades',  String(base.trades),               String(filt.trades)],
    ['Filtered out',  '-',                               String(filt.pivotFiltered)],
    ['Fill rate',     '100%',                            (filt.trades/(base.trades+filt.pivotFiltered)*100).toFixed(0)+'%'],
    ['Win rate',      base.wr.toFixed(1)+'%',           filt.wr.toFixed(1)+'%'],
    ['Profit factor', base.pf.toFixed(2),               filt.pf.toFixed(2)],
    ['Max drawdown',  base.maxDD.toFixed(1)+'%',        filt.maxDD.toFixed(1)+'%'],
  ];

  console.log(`\n  ${'Metric'.padEnd(26)}${h('DT Baseline')}${h('DT + Pivot Filter')}`);
  console.log(`  ${'─'.repeat(70)}`);
  for (const [label, a, b] of rows) {
    const isDD = label.includes('drawdown');
    const arr  = label === 'Filtered out' || label === 'Fill rate' ? '' : arrow(a, b, isDD);
    console.log(`  ${label.padEnd(26)}${h(a)}${h(b)}${arr}`);
  }

  // Monthly
  console.log(`\n  MONTHLY P&L`);
  console.log(`  ${'Month'.padEnd(10)}${'Baseline'.padEnd(14)}${'+ Pivot'.padEnd(14)}${'Diff'.padEnd(12)}${'Better?'}`);
  console.log(`  ${'─'.repeat(58)}`);
  const months = new Set([...Object.keys(base.monthMap), ...Object.keys(filt.monthMap)]);
  let bTot=0, fTot=0, filtWins=0, filtTotal=0;
  for (const ym of [...months].sort()) {
    const bp = base.monthMap[ym]?.pnl || 0;
    const fp = filt.monthMap[ym]?.pnl || 0;
    bTot+=bp; fTot+=fp;
    const diff = fp - bp;
    const icon = diff > 50 ? '✅' : diff < -50 ? '❌' : '→';
    if (diff > 50) filtWins++;
    filtTotal++;
    console.log(`  ${ym.padEnd(10)}${$(bp).padEnd(14)}${$(fp).padEnd(14)}${$(diff).padEnd(12)}${icon}`);
  }
  console.log(`  ${'─'.repeat(58)}`);
  console.log(`  ${'TOTAL'.padEnd(10)}${$(bTot).padEnd(14)}${$(fTot).padEnd(14)}${$(fTot-bTot).padEnd(12)}${fTot>bTot?'✅':'❌'}`);

  // Signal type breakdown
  console.log(`\n  NOTE: Signal breakdown available — run backtest_dt_daily.mjs for full detail`);

  // Verdict
  console.log(`\n${bar}`);
  const better = filt.pnl > base.pnl;
  const wrGain = filt.wr - base.wr;
  const pfGain = filt.pf - base.pf;
  const ddGain = base.maxDD - filt.maxDD;

  console.log(`  VERDICT: Pivot filter ${better ? '✅ IMPROVES' : '❌ HURTS'} DT`);
  console.log(`  P&L delta   : ${$(filt.pnl - base.pnl)}`);
  console.log(`  WR delta    : ${wrGain>=0?'+':''}${wrGain.toFixed(1)}%  (${base.wr.toFixed(1)}% → ${filt.wr.toFixed(1)}%)`);
  console.log(`  PF delta    : ${pfGain>=0?'+':''}${pfGain.toFixed(2)}  (${base.pf.toFixed(2)} → ${filt.pf.toFixed(2)})`);
  console.log(`  DD delta    : ${ddGain>=0?'-':'+'} ${Math.abs(ddGain).toFixed(1)}%  (${base.maxDD.toFixed(1)}% → ${filt.maxDD.toFixed(1)}%)`);
  console.log(`  Trades kept : ${filt.trades} of ${base.trades + filt.pivotFiltered} (${(filt.trades/(base.trades+filt.pivotFiltered)*100).toFixed(0)}%)`);
  console.log(`  Months won  : ${filtWins}/${filtTotal} months improved with pivot filter`);
  console.log(bar + '\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\nFetching 15m candles for ${DAYS} days (+ warmup)...`);
  const allCandles = {};
  for (const sym of PAIRS) {
    process.stdout.write(`  ${sym.padEnd(12)}`);
    allCandles[sym] = await fetchCandles(sym, DAYS);
    console.log(`${allCandles[sym].length} bars`);
  }

  console.log('\nPre-computing indicators + pivots...');
  const allPre = {};
  for (const sym of PAIRS) {
    allPre[sym] = precompute(sym, allCandles[sym]);
    const sigCount = allCandles[sym].filter((_,i) => signal(allPre[sym], i, false) !== null).length;
    const filtCount = allCandles[sym].filter((_,i) => signal(allPre[sym], i, true)  !== null).length;
    console.log(`  ${sym.padEnd(12)} ${sigCount} base signals → ${filtCount} pass pivot filter (${(filtCount/sigCount*100||0).toFixed(0)}%)`);
  }

  console.log('\nRunning baseline simulation...');
  const base = simulate(allCandles, allPre, false);

  console.log('Running pivot-filtered simulation...');
  const filt = simulate(allCandles, allPre, true);

  printComparison(base, filt);
})();
