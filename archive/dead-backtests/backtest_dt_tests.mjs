/**
 * backtest_dt_tests.mjs — DT strategy improvement tests
 *
 * Tests three improvements vs baseline:
 *   1. SESSION FILTER  — which sessions are profitable? (Asia / London / NY)
 *   2. TRAILING STOP   — trail SL along EMA21 instead of fixed SL
 *   3. MAX HOLD SWEEP  — optimal hold bar count (4 / 6 / 8 / 10 / 12)
 *
 * One fetch, one precompute, many parameterized simulations.
 *
 * Run: node backtest_dt_tests.mjs [DAYS] [START_BAL]
 *   eg: node backtest_dt_tests.mjs 365 5000
 */

const DAYS      = parseInt(process.argv[2]  || "365");
const START_BAL = parseFloat(process.argv[3] || "5000");

const RISK_PCT    = 0.008;
const LEVERAGE    = 5;
const MAX_POS     = 6;         // 6 pairs
const MAX_SL_PCT  = 0.012;
const RR          = 1.3;
const EMA50_PAIRS = new Set(["BTCUSDT", "SUIUSDT"]);
const PAIRS       = ["BTCUSDT", "BNBUSDT", "XRPUSDT", "SUIUSDT", "LTCUSDT", "AVAXUSDT"];

// ─── Fetch ────────────────────────────────────────────────────────────────────

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
        time: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
      })));
      endTime = raw[0][0] - 1;
    } catch { break; }
    if (b < batches - 1) await new Promise(r => setTimeout(r, 150));
  }
  const seen = new Set();
  return all.filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
            .sort((a, b) => a.time - b.time);
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function ema(vals, p) {
  const k = 2 / (p + 1), out = new Array(vals.length).fill(null);
  let s = vals[0];
  for (let i = 0; i < vals.length; i++) { s = i === 0 ? vals[0] : vals[i] * k + s * (1 - k); out[i] = s; }
  return out;
}

function sma(vals, p) {
  const out = new Array(vals.length).fill(null);
  for (let i = p - 1; i < vals.length; i++) {
    out[i] = vals.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p;
  }
  return out;
}

function rsi14(vals) {
  const out = new Array(vals.length).fill(null);
  if (vals.length < 15) return out;
  let ag = 0, al = 0;
  for (let i = 1; i <= 14; i++) {
    const d = vals[i] - vals[i - 1];
    if (d > 0) ag += d; else al -= d;
  }
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
    tr  = tr  - tr  / period + ctr;
    pdm = pdm - pdm / period + cpdm;
    ndm = ndm - ndm / period + cndm;
    const pdi = tr > 0 ? pdm / tr * 100 : 0;
    const ndi = tr > 0 ? ndm / tr * 100 : 0;
    const dx  = (pdi + ndi) > 0 ? Math.abs(pdi - ndi) / (pdi + ndi) * 100 : 0;
    dxArr.push({ i, dx });
    if (dxArr.length === period) {
      adxVal = dxArr.reduce((s, x) => s + x.dx, 0) / period;
      out[i] = adxVal;
    } else if (dxArr.length > period) {
      adxVal = (adxVal * (period - 1) + dx) / period;
      out[i] = adxVal;
    }
  }
  return out;
}

// ─── Session helpers ──────────────────────────────────────────────────────────

function inSession(ts) {
  const h = new Date(ts).getUTCHours();
  return h >= 1 && h < 22;
}

// Returns which session a timestamp belongs to (based on UTC hour)
function getSession(ts) {
  const h = new Date(ts).getUTCHours();
  if (h >= 1 && h < 8)  return "ASIA";
  if (h >= 8 && h < 13) return "LONDON";
  if (h >= 13 && h < 22) return "NY";
  return null;
}

const SESSION_OPENS = new Set([1, 8, 13]);

function sessionORBCalc(candles) {
  const orbs = new Array(candles.length).fill(null);
  let building = false, orbHigh = -Infinity, orbLow = Infinity;
  let confirmedORB = null, sessionBias = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const d = new Date(c.time);
    const h = d.getUTCHours(), m = d.getUTCMinutes();
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

// ─── Precompute ───────────────────────────────────────────────────────────────

function precompute(symbol, candles) {
  const closes = candles.map(c => c.close);
  const vols   = candles.map(c => c.volume);
  return {
    symbol, candles,
    e21:  ema(closes, 21),
    e50:  ema(closes, 50),
    rsiV: rsi14(closes),
    vsma: sma(vols, 20),
    adx:  adxCalc(candles),
    orbs: sessionORBCalc(candles),
  };
}

// ─── Signal ───────────────────────────────────────────────────────────────────
// allowedSessions: null (all) | Set of "ASIA" | "LONDON" | "NY"

function signal(pre, i, allowedSessions = null) {
  if (i < 70) return null;
  const { symbol, candles, e21, e50, rsiV, vsma, adx, orbs } = pre;
  const c = candles[i], p = candles[i - 1], r = rsiV[i];
  if (!r || !vsma[i]) return null;
  if (!inSession(c.time)) return null;
  if (!adx[i] || adx[i] < 20) return null;

  // Session filter: skip if this bar's session not in allowedSessions
  if (allowedSessions !== null) {
    const sess = getSession(c.time);
    if (!sess || !allowedSessions.has(sess)) return null;
  }

  const orb = orbs[i];
  if (!orb || !orb.bias) return null;
  const aboveORB = orb.bias === 'LONG';
  const belowORB = orb.bias === 'SHORT';

  const volOk = c.volume > vsma[i] * 1.2;
  const tb = 4;
  if (i < tb) return null;
  const e50Up = e50[i] > e50[i - tb];
  const e50Dn = e50[i] < e50[i - tb];

  if (aboveORB) {
    if (e50Up && r >= 40 && r < 65 && volOk && p.close < e21[i - 1] && c.close > e21[i]) {
      const sl   = Math.min(...candles.slice(Math.max(0, i - 3), i + 1).map(x => x.low));
      const risk = c.close - sl;
      if (risk > 0 && risk / c.close < MAX_SL_PCT)
        return { dir: "LONG", signal: "EMA21", entry: c.close, sl, tp: c.close + risk * RR };
    }
    if (EMA50_PAIRS.has(symbol) && e50Up && r >= 38 && r < 62 && volOk && p.close < e50[i - 1] && c.close > e50[i]) {
      const sl   = Math.min(...candles.slice(Math.max(0, i - 4), i + 1).map(x => x.low));
      const risk = c.close - sl;
      if (risk > 0 && risk / c.close < 0.018)
        return { dir: "LONG", signal: "EMA50", entry: c.close, sl, tp: c.close + risk * RR };
    }
  }

  if (belowORB) {
    if (e50Dn && r > 35 && r <= 60 && volOk && p.close > e21[i - 1] && c.close < e21[i]) {
      const sl   = Math.max(...candles.slice(Math.max(0, i - 3), i + 1).map(x => x.high));
      const risk = sl - c.close;
      if (risk > 0 && risk / c.close < MAX_SL_PCT)
        return { dir: "SHORT", signal: "EMA21", entry: c.close, sl, tp: c.close - risk * RR };
    }
    if (EMA50_PAIRS.has(symbol) && e50Dn && r > 38 && r <= 62 && volOk && p.close > e50[i - 1] && c.close < e50[i]) {
      const sl   = Math.max(...candles.slice(Math.max(0, i - 4), i + 1).map(x => x.high));
      const risk = sl - c.close;
      if (risk > 0 && risk / c.close < 0.018)
        return { dir: "SHORT", signal: "EMA50", entry: c.close, sl, tp: c.close - risk * RR };
    }
  }

  return null;
}

// ─── Simulation ───────────────────────────────────────────────────────────────
// opts: { maxHold, trailMode, allowedSessions }
//   trailMode: 'FIXED' | 'TRAIL_EMA' | 'TRAIL_EMA_TP'
//   allowedSessions: null | Set<string>

function simulate(allCandles, allPre, opts = {}) {
  const {
    maxHold        = 8,
    trailMode      = 'FIXED',
    allowedSessions = null,
  } = opts;

  const allTimes = new Set();
  for (const bars of Object.values(allCandles)) for (const c of bars) allTimes.add(c.time);
  const timeline = [...allTimes].sort((a, b) => a - b);
  const cutoff = timeline[timeline.length - 1] - DAYS * 86400000;

  const byTime = {}, byIdx = {};
  for (const [sym, bars] of Object.entries(allCandles)) {
    byTime[sym] = {}; byIdx[sym] = {};
    bars.forEach((c, i) => { byTime[sym][c.time] = c; byIdx[sym][c.time] = i; });
  }

  let balance = START_BAL, peak = START_BAL, maxDD = 0;
  const openPositions = {};
  const trades = [];

  for (const t of timeline) {
    if (t < cutoff) continue;

    for (const sym of PAIRS) {
      const i = byIdx[sym][t];
      if (i === undefined) continue;
      const c = byTime[sym][t];
      const pre = allPre[sym];

      // ── Trailing SL update (before exit check) ─────────────────────────────
      if (openPositions[sym] && trailMode !== 'FIXED') {
        const pos = openPositions[sym];
        const e21Val = pre.e21[i];
        if (e21Val !== null) {
          if (pos.dir === "LONG") {
            // Trail: move SL up to EMA21 if EMA21 > current SL (only after entry candle)
            if (i > pos.entryBarIdx && e21Val > pos.sl) pos.sl = e21Val;
          } else {
            // Trail: move SL down to EMA21 if EMA21 < current SL
            if (i > pos.entryBarIdx && e21Val < pos.sl) pos.sl = e21Val;
          }
        }
      }

      // ── Check exits ───────────────────────────────────────────────────────
      if (openPositions[sym]) {
        const pos = openPositions[sym];
        const isLong = pos.dir === "LONG";
        let closed = false, exitReason = "", exitPrice = 0;

        if (isLong) {
          if (c.low  <= pos.sl) { exitPrice = pos.sl;  exitReason = "SL"; closed = true; }
          else if (trailMode !== 'TRAIL_EMA' && c.high >= pos.tp) { exitPrice = pos.tp; exitReason = "TP"; closed = true; }
        } else {
          if (c.high >= pos.sl) { exitPrice = pos.sl;  exitReason = "SL"; closed = true; }
          else if (trailMode !== 'TRAIL_EMA' && c.low  <= pos.tp) { exitPrice = pos.tp; exitReason = "TP"; closed = true; }
        }
        if (!closed && i - pos.entryBarIdx >= maxHold) {
          exitPrice = c.close; exitReason = "TIME"; closed = true;
        }

        if (closed) {
          const movePct = isLong ? (exitPrice - pos.entry) / pos.entry
                                 : (pos.entry - exitPrice) / pos.entry;
          // Always use origSL for risk sizing (position size is fixed at entry)
          const origSlPct = isLong ? (pos.entry - pos.origSL) / pos.entry
                                   : (pos.origSL - pos.entry) / pos.entry;
          const pnl = (movePct / origSlPct) * pos.riskUSD * LEVERAGE;
          balance += pnl;
          if (balance > peak) peak = balance;
          const dd = (peak - balance) / peak * 100;
          if (dd > maxDD) maxDD = dd;
          trades.push({
            sym, dir: pos.dir, sig: pos.signal,
            entryTime: pos.entryTime, exitTime: c.time,
            exitReason, pnl, riskUSD: pos.riskUSD,
            session: getSession(pos.entryTime),
          });
          delete openPositions[sym];
        }
      }

      // ── Check entries ─────────────────────────────────────────────────────
      if (!openPositions[sym] && Object.keys(openPositions).length < MAX_POS) {
        const sig = signal(pre, i, allowedSessions);
        if (sig) {
          const riskUSD = balance * RISK_PCT;
          openPositions[sym] = {
            ...sig, sym, riskUSD,
            origSL: sig.sl,   // preserve original SL for sizing
            entryTime: c.time, entryBarIdx: i,
          };
        }
      }
    }
  }

  // Close open positions at last price
  for (const [sym, pos] of Object.entries(openPositions)) {
    const bars = allCandles[sym];
    const lastC = bars[bars.length - 1];
    const exitPrice = lastC.close;
    const isLong = pos.dir === "LONG";
    const movePct = isLong ? (exitPrice - pos.entry) / pos.entry
                           : (pos.entry - exitPrice) / pos.entry;
    const origSlPct = isLong ? (pos.entry - pos.origSL) / pos.entry
                             : (pos.origSL - pos.entry) / pos.entry;
    const pnl = (movePct / origSlPct) * pos.riskUSD * LEVERAGE;
    balance += pnl;
    trades.push({
      sym, dir: pos.dir, sig: pos.signal,
      entryTime: pos.entryTime, exitTime: lastC.time,
      exitReason: "OPEN", pnl, riskUSD: pos.riskUSD,
      session: getSession(pos.entryTime),
    });
  }

  return { trades, finalBalance: balance, maxDD };
}

// ─── Quick summary ────────────────────────────────────────────────────────────

function summary(label, trades, finalBalance, maxDD) {
  const totalW  = trades.filter(t => t.pnl >= 0).length;
  const gross_w = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gross_l = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const pf      = gross_l > 0 ? (gross_w / gross_l).toFixed(2) : "∞";
  const wr      = trades.length ? (totalW / trades.length * 100).toFixed(1) : "0.0";
  const ret     = ((finalBalance - START_BAL) / START_BAL * 100).toFixed(1);
  const tpCount = trades.filter(t => t.exitReason === "TP").length;
  const slCount = trades.filter(t => t.exitReason === "SL").length;
  const tmCount = trades.filter(t => t.exitReason === "TIME").length;
  return {
    label,
    trades: trades.length, wr, pf, ret,
    finalBalance, maxDD: maxDD.toFixed(1),
    tpCount, slCount, tmCount,
  };
}

function printSummaryRow(s) {
  const pnl = s.finalBalance - START_BAL;
  const sign = pnl >= 0 ? "+" : "";
  console.log(
    `  ${String(s.label).padEnd(24)}` +
    ` ${String(s.trades).padStart(5)} trades` +
    `  WR ${String(s.wr).padStart(5)}%` +
    `  PF ${String(s.pf).padStart(5)}` +
    `  Ret ${(sign+s.ret+"%").padStart(8)}` +
    `  DD ${String(s.maxDD).padStart(5)}%` +
    `  TP:${s.tpCount} SL:${s.slCount} TIME:${s.tmCount}`
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\n${"═".repeat(110)}`);
  console.log(`  DT Improvement Tests — ${DAYS}d, $${START_BAL.toLocaleString()} start`);
  console.log(`${"═".repeat(110)}\n`);

  // ── Fetch ─────────────────────────────────────────────────────────────────
  console.log(`Fetching 15m candles for ${DAYS} days...`);
  const allCandles = {};
  for (const sym of PAIRS) {
    process.stdout.write(`  ${sym.padEnd(10)}`);
    allCandles[sym] = await fetchCandles(sym, DAYS);
    console.log(`${allCandles[sym].length} bars`);
  }

  // ── Precompute ────────────────────────────────────────────────────────────
  console.log("\nPrecomputing indicators...");
  const allPre = {};
  for (const sym of PAIRS) {
    allPre[sym] = precompute(sym, allCandles[sym]);
    console.log(`  ${sym.padEnd(10)} OK`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 1: SESSION FILTER
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n${"═".repeat(110)}`);
  console.log("  TEST 1: SESSION FILTER — which sessions drive returns?");
  console.log(`${"═".repeat(110)}`);
  console.log("  (Each variant only allows entries during the specified session windows)\n");

  const sessionTests = [
    { label: "ALL (baseline)",    sessions: null },
    { label: "ASIA only",         sessions: new Set(["ASIA"]) },
    { label: "LONDON only",       sessions: new Set(["LONDON"]) },
    { label: "NY only",           sessions: new Set(["NY"]) },
    { label: "LONDON + NY",       sessions: new Set(["LONDON","NY"]) },
    { label: "ASIA + LONDON",     sessions: new Set(["ASIA","LONDON"]) },
  ];

  const sessionResults = [];
  for (const test of sessionTests) {
    process.stdout.write(`  Running ${test.label.padEnd(20)}... `);
    const { trades, finalBalance, maxDD } = simulate(allCandles, allPre, {
      maxHold: 8, trailMode: 'FIXED', allowedSessions: test.sessions
    });
    const s = summary(test.label, trades, finalBalance, maxDD);
    sessionResults.push(s);
    process.stdout.write(`done (${trades.length} trades)\n`);
  }

  console.log();
  for (const s of sessionResults) printSummaryRow(s);

  // Per-session P&L breakdown from baseline
  const baselineTrades = (() => {
    const { trades } = simulate(allCandles, allPre, { maxHold: 8, trailMode: 'FIXED' });
    return trades;
  })();
  console.log("\n  Per-session breakdown (from baseline):");
  for (const sess of ["ASIA", "LONDON", "NY"]) {
    const st = baselineTrades.filter(t => t.session === sess);
    const sw = st.filter(t => t.pnl >= 0).length;
    const sPnl = st.reduce((a, t) => a + t.pnl, 0);
    const sgw = st.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
    const sgl = Math.abs(st.filter(t => t.pnl < 0).reduce((a, t) => a + t.pnl, 0));
    const spf = sgl > 0 ? (sgw/sgl).toFixed(2) : "∞";
    console.log(`    ${sess.padEnd(8)} ${st.length} trades  WR ${st.length ? (sw/st.length*100).toFixed(1) : "0.0"}%  PF ${spf}  P&L ${sPnl >= 0 ? "+" : ""}$${sPnl.toFixed(2)}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 2: TRAILING STOP
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n\n${"═".repeat(110)}`);
  console.log("  TEST 2: TRAILING STOP — trail SL along EMA21");
  console.log(`${"═".repeat(110)}`);
  console.log("  FIXED:         Original SL + fixed TP (baseline)");
  console.log("  TRAIL_EMA:     SL trails EMA21, no TP ceiling (exit on SL or TIME only)");
  console.log("  TRAIL_EMA_TP:  SL trails EMA21, TP ceiling kept\n");

  const trailTests = [
    { label: "FIXED (baseline)",  trailMode: 'FIXED',        maxHold: 8 },
    { label: "TRAIL_EMA",         trailMode: 'TRAIL_EMA',    maxHold: 8 },
    { label: "TRAIL_EMA_TP",      trailMode: 'TRAIL_EMA_TP', maxHold: 8 },
    { label: "TRAIL_EMA MH=12",   trailMode: 'TRAIL_EMA',    maxHold: 12 },
    { label: "TRAIL_EMA MH=16",   trailMode: 'TRAIL_EMA',    maxHold: 16 },
  ];

  const trailResults = [];
  for (const test of trailTests) {
    process.stdout.write(`  Running ${test.label.padEnd(22)}... `);
    const { trades, finalBalance, maxDD } = simulate(allCandles, allPre, {
      maxHold: test.maxHold, trailMode: test.trailMode
    });
    const s = summary(test.label, trades, finalBalance, maxDD);
    trailResults.push(s);
    process.stdout.write(`done (${trades.length} trades)\n`);
  }

  console.log();
  for (const s of trailResults) printSummaryRow(s);

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 3: MAX HOLD SWEEP
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n\n${"═".repeat(110)}`);
  console.log("  TEST 3: MAX HOLD SWEEP — optimal hold bar count");
  console.log(`${"═".repeat(110)}`);
  console.log("  (Each bar = 15 minutes; 8 bars = 2h, 12 bars = 3h, etc.)\n");

  const holdTests = [4, 6, 8, 10, 12, 16, 24];
  const holdResults = [];
  for (const mh of holdTests) {
    const label = `MAX_HOLD = ${mh} bars (${mh*15}m)`;
    process.stdout.write(`  Running ${label.padEnd(26)}... `);
    const { trades, finalBalance, maxDD } = simulate(allCandles, allPre, {
      maxHold: mh, trailMode: 'FIXED'
    });
    const s = summary(label, trades, finalBalance, maxDD);
    holdResults.push({ ...s, mh });
    process.stdout.write(`done (${trades.length} trades)\n`);
  }

  console.log();
  for (const s of holdResults) printSummaryRow(s);

  // Find best hold
  const bestHold = holdResults.reduce((a, b) => parseFloat(a.ret) > parseFloat(b.ret) ? a : b);
  console.log(`\n  → Best MAX_HOLD by return: ${bestHold.label} (${bestHold.ret}%)`);

  // TIME exit analysis for each hold
  console.log("\n  TIME exit P&L by hold length (fixed mode):");
  for (const s of holdResults) {
    const { trades: tr } = simulate(allCandles, allPre, { maxHold: s.mh, trailMode: 'FIXED' });
    const timeTrades = tr.filter(t => t.exitReason === "TIME");
    const timePnl = timeTrades.reduce((a, t) => a + t.pnl, 0);
    const timeWR  = timeTrades.length ? (timeTrades.filter(t => t.pnl >= 0).length / timeTrades.length * 100).toFixed(1) : "0.0";
    console.log(`    MH=${String(s.mh).padStart(2)}  TIME exits: ${String(timeTrades.length).padStart(3)}  WR: ${timeWR}%  P&L: ${timePnl >= 0 ? "+" : ""}$${timePnl.toFixed(2)}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // COMBINED BEST
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n\n${"═".repeat(110)}`);
  console.log("  COMBINED: Best session + best trail + best hold");
  console.log(`${"═".repeat(110)}\n`);

  // Try top session combos × trail modes × best hold
  const combinedTests = [
    { label: "Baseline",                       sessions: null,                     trailMode: 'FIXED',        maxHold: 8 },
    { label: "Best hold only",                 sessions: null,                     trailMode: 'FIXED',        maxHold: bestHold.mh },
    { label: "LONDON+NY only",                 sessions: new Set(["LONDON","NY"]), trailMode: 'FIXED',        maxHold: 8 },
    { label: "LONDON+NY + best hold",          sessions: new Set(["LONDON","NY"]), trailMode: 'FIXED',        maxHold: bestHold.mh },
    { label: "LONDON+NY + TRAIL_EMA_TP",       sessions: new Set(["LONDON","NY"]), trailMode: 'TRAIL_EMA_TP', maxHold: 12 },
    { label: "LONDON+NY + TRAIL_EMA MH=12",   sessions: new Set(["LONDON","NY"]), trailMode: 'TRAIL_EMA',    maxHold: 12 },
    { label: "All sess + TRAIL_EMA MH=12",     sessions: null,                     trailMode: 'TRAIL_EMA',    maxHold: 12 },
    { label: "NY only + TRAIL_EMA MH=12",      sessions: new Set(["NY"]),          trailMode: 'TRAIL_EMA',    maxHold: 12 },
  ];

  for (const test of combinedTests) {
    process.stdout.write(`  ${test.label.padEnd(34)}... `);
    const { trades, finalBalance, maxDD } = simulate(allCandles, allPre, test);
    const s = summary(test.label, trades, finalBalance, maxDD);
    process.stdout.write(`done\n`);
    printSummaryRow(s);
  }

  console.log(`\n${"═".repeat(110)}`);
  console.log("  Done.");
  console.log(`${"═".repeat(110)}\n`);
})();
