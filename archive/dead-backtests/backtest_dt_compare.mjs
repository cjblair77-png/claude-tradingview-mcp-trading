/**
 * backtest_dt_compare.mjs — Old DT vs New DT head-to-head
 *
 * OLD: maxHold=8 bars (2h), all sessions (Asia + London + NY)
 * NEW: maxHold=12 bars (3h), no Asia (London + NY only, 08:00-22:00 UTC)
 *
 * Full month-by-month P&L with running balance for both variants.
 *
 * Run: node backtest_dt_compare.mjs [DAYS] [START_BAL]
 *      node backtest_dt_compare.mjs 365 5000
 */

const DAYS      = parseInt(process.argv[2]  || "365");
const START_BAL = parseFloat(process.argv[3] || "5000");

const RISK_PCT   = 0.008;
const LEVERAGE   = 5;
const MAX_POS    = 6;
const MAX_SL_PCT = 0.012;
const RR         = 1.3;
const EMA50_PAIRS = new Set(["BTCUSDT", "SUIUSDT"]);
const PAIRS       = ["BTCUSDT", "BNBUSDT", "XRPUSDT", "SUIUSDT", "LTCUSDT", "AVAXUSDT"];

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchCandles(symbol, days) {
  const needed  = (days + 5) * 96 + 200;
  const batches = Math.ceil(needed / 1000);
  const all     = [];
  let endTime   = Date.now();
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
  for (let i = p - 1; i < vals.length; i++)
    out[i] = vals.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p;
  return out;
}
function rsi14(vals) {
  const out = new Array(vals.length).fill(null);
  if (vals.length < 15) return out;
  let ag = 0, al = 0;
  for (let i = 1; i <= 14; i++) { const d = vals[i] - vals[i-1]; d > 0 ? ag += d : al -= d; }
  ag /= 14; al /= 14;
  out[14] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = 15; i < vals.length; i++) {
    const d = vals[i] - vals[i-1];
    ag = (ag * 13 + Math.max(d, 0)) / 14;
    al = (al * 13 + Math.max(-d, 0)) / 14;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
function adxCalc(candles, period = 14) {
  const n = candles.length, out = new Array(n).fill(null);
  if (n < period * 2) return out;
  let tr = 0, pdm = 0, ndm = 0;
  for (let i = 1; i <= period; i++) {
    const c = candles[i], p = candles[i-1];
    tr  += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    pdm += Math.max(c.high - p.high, 0) > Math.max(p.low - c.low, 0) ? Math.max(c.high - p.high, 0) : 0;
    ndm += Math.max(p.low - c.low, 0) > Math.max(c.high - p.high, 0) ? Math.max(p.low - c.low, 0) : 0;
  }
  let adxVal = 0; const dxArr = [];
  for (let i = period + 1; i < n; i++) {
    const c = candles[i], p = candles[i-1];
    const ctr  = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const cpdm = Math.max(c.high - p.high, 0) > Math.max(p.low - c.low, 0) ? Math.max(c.high - p.high, 0) : 0;
    const cndm = Math.max(p.low - c.low, 0) > Math.max(c.high - p.high, 0) ? Math.max(p.low - c.low, 0) : 0;
    tr = tr - tr/period + ctr; pdm = pdm - pdm/period + cpdm; ndm = ndm - ndm/period + cndm;
    const pdi = tr > 0 ? pdm/tr*100 : 0, ndi = tr > 0 ? ndm/tr*100 : 0;
    const dx  = (pdi + ndi) > 0 ? Math.abs(pdi - ndi) / (pdi + ndi) * 100 : 0;
    dxArr.push({ i, dx });
    if (dxArr.length === period) { adxVal = dxArr.reduce((s,x) => s+x.dx, 0)/period; out[i] = adxVal; }
    else if (dxArr.length > period) { adxVal = (adxVal*(period-1)+dx)/period; out[i] = adxVal; }
  }
  return out;
}

// ─── Session helpers ──────────────────────────────────────────────────────────

function inSession(ts) { const h = new Date(ts).getUTCHours(); return h >= 1 && h < 22; }

const SESSION_OPENS = new Set([1, 8, 13]);

function sessionORBCalc(candles) {
  const orbs = new Array(candles.length).fill(null);
  let building = false, orbHigh = -Infinity, orbLow = Infinity, confirmedORB = null, sessionBias = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i], d = new Date(c.time), h = d.getUTCHours(), m = d.getUTCMinutes();
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
  const closes = candles.map(c => c.close), vols = candles.map(c => c.volume);
  return { symbol, candles, e21: ema(closes, 21), e50: ema(closes, 50),
           rsiV: rsi14(closes), vsma: sma(vols, 20), adx: adxCalc(candles),
           orbs: sessionORBCalc(candles) };
}

// ─── Signal ───────────────────────────────────────────────────────────────────
// blockAsia: if true, skip entries during 01:00–07:59 UTC

function signal(pre, i, blockAsia = false) {
  if (i < 70) return null;
  const { symbol, candles, e21, e50, rsiV, vsma, adx, orbs } = pre;
  const c = candles[i], p = candles[i-1], r = rsiV[i];
  if (!r || !vsma[i]) return null;
  if (!inSession(c.time)) return null;
  if (!adx[i] || adx[i] < 20) return null;

  // Asia block
  if (blockAsia) {
    const h = new Date(c.time).getUTCHours();
    if (h >= 1 && h < 8) return null;
  }

  const orb = orbs[i];
  if (!orb || !orb.bias) return null;
  const aboveORB = orb.bias === 'LONG', belowORB = orb.bias === 'SHORT';
  const volOk = c.volume > vsma[i] * 1.2;
  const tb = 4;
  if (i < tb) return null;
  const e50Up = e50[i] > e50[i-tb], e50Dn = e50[i] < e50[i-tb];

  if (aboveORB) {
    if (e50Up && r >= 40 && r < 65 && volOk && p.close < e21[i-1] && c.close > e21[i]) {
      const sl = Math.min(...candles.slice(Math.max(0, i-3), i+1).map(x => x.low));
      const risk = c.close - sl;
      if (risk > 0 && risk/c.close < MAX_SL_PCT)
        return { dir: "LONG", signal: "EMA21", entry: c.close, sl, tp: c.close + risk*RR };
    }
    if (EMA50_PAIRS.has(symbol) && e50Up && r >= 38 && r < 62 && volOk && p.close < e50[i-1] && c.close > e50[i]) {
      const sl = Math.min(...candles.slice(Math.max(0, i-4), i+1).map(x => x.low));
      const risk = c.close - sl;
      if (risk > 0 && risk/c.close < 0.018)
        return { dir: "LONG", signal: "EMA50", entry: c.close, sl, tp: c.close + risk*RR };
    }
  }
  if (belowORB) {
    if (e50Dn && r > 35 && r <= 60 && volOk && p.close > e21[i-1] && c.close < e21[i]) {
      const sl = Math.max(...candles.slice(Math.max(0, i-3), i+1).map(x => x.high));
      const risk = sl - c.close;
      if (risk > 0 && risk/c.close < MAX_SL_PCT)
        return { dir: "SHORT", signal: "EMA21", entry: c.close, sl, tp: c.close - risk*RR };
    }
    if (EMA50_PAIRS.has(symbol) && e50Dn && r > 38 && r <= 62 && volOk && p.close > e50[i-1] && c.close < e50[i]) {
      const sl = Math.max(...candles.slice(Math.max(0, i-4), i+1).map(x => x.high));
      const risk = sl - c.close;
      if (risk > 0 && risk/c.close < 0.018)
        return { dir: "SHORT", signal: "EMA50", entry: c.close, sl, tp: c.close - risk*RR };
    }
  }
  return null;
}

// ─── Simulation ───────────────────────────────────────────────────────────────

function simulate(allCandles, allPre, opts = {}) {
  const { maxHold = 8, blockAsia = false } = opts;

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
  const monthlyData = {};   // "YYYY-MM" → { pnl, trades, wins, balStart, balEnd }

  function ym(ts) { return new Date(ts).toISOString().slice(0, 7); }
  function ensureMonth(m, bal) {
    if (!monthlyData[m]) monthlyData[m] = { pnl: 0, trades: 0, wins: 0, losses: 0, balStart: bal, balEnd: bal };
  }

  for (const t of timeline) {
    if (t < cutoff) continue;

    for (const sym of PAIRS) {
      const i = byIdx[sym][t];
      if (i === undefined) continue;
      const c = byTime[sym][t];
      const pre = allPre[sym];

      // Exit check
      if (openPositions[sym]) {
        const pos    = openPositions[sym];
        const isLong = pos.dir === "LONG";
        let closed = false, exitReason = "", exitPrice = 0;

        if (isLong) {
          if (c.low  <= pos.sl) { exitPrice = pos.sl;  exitReason = "SL"; closed = true; }
          else if (c.high >= pos.tp) { exitPrice = pos.tp; exitReason = "TP"; closed = true; }
        } else {
          if (c.high >= pos.sl) { exitPrice = pos.sl;  exitReason = "SL"; closed = true; }
          else if (c.low  <= pos.tp) { exitPrice = pos.tp; exitReason = "TP"; closed = true; }
        }
        if (!closed && i - pos.entryBarIdx >= maxHold) {
          exitPrice = c.close; exitReason = "TIME"; closed = true;
        }

        if (closed) {
          const movePct = isLong ? (exitPrice - pos.entry)/pos.entry : (pos.entry - exitPrice)/pos.entry;
          const slPct   = isLong ? (pos.entry - pos.sl)/pos.entry   : (pos.sl - pos.entry)/pos.entry;
          const pnl     = (movePct / slPct) * pos.riskUSD * LEVERAGE;
          balance      += pnl;
          if (balance > peak) peak = balance;
          const dd = (peak - balance) / peak * 100;
          if (dd > maxDD) maxDD = dd;

          const m = ym(c.time);
          ensureMonth(m, balance);
          monthlyData[m].pnl    += pnl;
          monthlyData[m].trades++;
          monthlyData[m].balEnd  = balance;
          if (pnl >= 0) monthlyData[m].wins++; else monthlyData[m].losses++;

          trades.push({ sym, dir: pos.dir, sig: pos.signal, entryTime: pos.entryTime,
                        exitTime: c.time, exitReason, pnl, riskUSD: pos.riskUSD });
          delete openPositions[sym];
        }
      }

      // Entry check
      if (!openPositions[sym] && Object.keys(openPositions).length < MAX_POS) {
        const sig = signal(pre, i, blockAsia);
        if (sig) {
          const riskUSD = balance * RISK_PCT;
          openPositions[sym] = { ...sig, sym, riskUSD, entryTime: c.time, entryBarIdx: i };
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
    const movePct = isLong ? (exitPrice - pos.entry)/pos.entry : (pos.entry - exitPrice)/pos.entry;
    const slPct   = isLong ? (pos.entry - pos.sl)/pos.entry   : (pos.sl - pos.entry)/pos.entry;
    const pnl     = (movePct / slPct) * pos.riskUSD * LEVERAGE;
    balance      += pnl;
    const m = ym(lastC.time);
    ensureMonth(m, balance);
    monthlyData[m].pnl    += pnl;
    monthlyData[m].trades++;
    monthlyData[m].balEnd  = balance;
    if (pnl >= 0) monthlyData[m].wins++; else monthlyData[m].losses++;
    trades.push({ sym, dir: pos.dir, sig: pos.signal, entryTime: pos.entryTime,
                  exitTime: lastC.time, exitReason: "OPEN", pnl, riskUSD: pos.riskUSD });
  }

  // Fill balStart for each month correctly (carry forward from previous month)
  const months = Object.keys(monthlyData).sort();
  let prevBal = START_BAL;
  for (const m of months) {
    monthlyData[m].balStart = prevBal;
    prevBal = monthlyData[m].balEnd;
  }

  return { trades, monthlyData, finalBalance: balance, maxDD };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmtMonth(ym) {
  const [yr, mo] = ym.split("-");
  return `${MONTH_NAMES[parseInt(mo)-1]} ${yr}`;
}
function fmtUSD(n) {
  return (n >= 0 ? "+$" : "-$") + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function fmtBal(n) {
  return "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function fmtPct(n) { return (n >= 0 ? "+" : "") + n.toFixed(1) + "%"; }

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const BAR = "═".repeat(120);

  console.log(`\n${BAR}`);
  console.log(`  DT Bot — Old vs New  |  ${DAYS}-day backtest  |  $${START_BAL.toLocaleString()} start`);
  console.log(`  OLD: maxHold 8 bars (2h)  ·  All sessions (Asia + London + NY)`);
  console.log(`  NEW: maxHold 12 bars (3h) ·  London + NY only (Asia blocked 01:00–08:00 UTC)`);
  console.log(`${BAR}\n`);

  // Fetch
  console.log(`Fetching 15m candles for ${DAYS} days...`);
  const allCandles = {};
  for (const sym of PAIRS) {
    process.stdout.write(`  ${sym.padEnd(10)}`);
    allCandles[sym] = await fetchCandles(sym, DAYS);
    console.log(`${allCandles[sym].length} bars`);
  }

  // Precompute
  console.log("\nPrecomputing indicators...");
  const allPre = {};
  for (const sym of PAIRS) { allPre[sym] = precompute(sym, allCandles[sym]); }
  console.log("  Done.\n");

  // Run both
  process.stdout.write("Running OLD (MH=8, all sessions)...  ");
  const OLD = simulate(allCandles, allPre, { maxHold: 8,  blockAsia: false });
  console.log(`${OLD.trades.length} trades  →  ${fmtBal(OLD.finalBalance)} (${fmtPct((OLD.finalBalance-START_BAL)/START_BAL*100)})`);

  process.stdout.write("Running NEW (MH=12, no Asia)...       ");
  const NEW = simulate(allCandles, allPre, { maxHold: 12, blockAsia: true  });
  console.log(`${NEW.trades.length} trades  →  ${fmtBal(NEW.finalBalance)} (${fmtPct((NEW.finalBalance-START_BAL)/START_BAL*100)})`);

  // ── Summary comparison ────────────────────────────────────────────────────
  console.log(`\n${BAR}`);
  console.log("  SUMMARY COMPARISON");
  console.log(`${BAR}`);

  function stats(sim) {
    const { trades, finalBalance, maxDD } = sim;
    const wins    = trades.filter(t => t.pnl >= 0).length;
    const gw      = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const gl      = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    const pf      = gl > 0 ? gw/gl : Infinity;
    const wr      = trades.length ? wins/trades.length*100 : 0;
    const ret     = (finalBalance - START_BAL)/START_BAL*100;
    const tpC     = trades.filter(t => t.exitReason === "TP").length;
    const slC     = trades.filter(t => t.exitReason === "SL").length;
    const tmC     = trades.filter(t => t.exitReason === "TIME").length;
    return { trades: trades.length, wins, wr, pf, ret, finalBalance, maxDD, tpC, slC, tmC };
  }

  const sO = stats(OLD), sN = stats(NEW);
  const col = 22;
  const h   = s => String(s).padEnd(col);
  console.log(`\n  ${"Metric".padEnd(28)} ${h("OLD (2h, all sessions)")} ${h("NEW (3h, no Asia)")}`);
  console.log(`  ${"─".repeat(74)}`);

  const rows = [
    ["Final balance",     fmtBal(sO.finalBalance),             fmtBal(sN.finalBalance)],
    ["Total return",      fmtPct(sO.ret),                      fmtPct(sN.ret)],
    ["P&L",               fmtUSD(sO.finalBalance - START_BAL), fmtUSD(sN.finalBalance - START_BAL)],
    ["Total trades",      String(sO.trades),                    String(sN.trades)],
    ["Win rate",          sO.wr.toFixed(1)+"%",                 sN.wr.toFixed(1)+"%"],
    ["Profit factor",     sO.pf.toFixed(2),                     sN.pf.toFixed(2)],
    ["Max drawdown",      sO.maxDD.toFixed(1)+"%",              sN.maxDD.toFixed(1)+"%"],
    ["TP exits",          String(sO.tpC),                       String(sN.tpC)],
    ["SL exits",          String(sO.slC),                       String(sN.slC)],
    ["TIME exits",        String(sO.tmC),                       String(sN.tmC)],
  ];
  for (const [label, a, b] of rows) {
    const vA = parseFloat(a.replace(/[+$,%]/g,"")), vB = parseFloat(b.replace(/[+$,%]/g,""));
    const labelIsGoodWhenHigher = !label.includes("drawdown") && !label.includes("SL");
    let arrow = "";
    if (!isNaN(vA) && !isNaN(vB) && Math.abs(vB - vA) > 0.05) {
      arrow = (labelIsGoodWhenHigher ? vB > vA : vB < vA) ? "  ✅" : "  ❌";
    }
    console.log(`  ${label.padEnd(28)} ${h(a)} ${h(b)}${arrow}`);
  }

  // ── Month-by-month table ──────────────────────────────────────────────────
  console.log(`\n\n${BAR}`);
  console.log("  MONTH-BY-MONTH BREAKDOWN");
  console.log(`${BAR}`);

  const allMonths = [...new Set([
    ...Object.keys(OLD.monthlyData),
    ...Object.keys(NEW.monthlyData),
  ])].sort();

  // Header
  const HDR = `  ${"Month".padEnd(12)}`
    + `${"Tr".padStart(4)}${"W".padStart(3)}${"L".padStart(3)}`
    + `${"P&L".padStart(11)}${"Month%".padStart(8)}${"Balance".padStart(13)}${"CumRet%".padStart(9)}`
    + `  │  `
    + `${"Tr".padStart(4)}${"W".padStart(3)}${"L".padStart(3)}`
    + `${"P&L".padStart(11)}${"Month%".padStart(8)}${"Balance".padStart(13)}${"CumRet%".padStart(9)}`
    + `  │  Diff`;
  console.log(`\n  ${"".padEnd(12)}${"──── OLD (2h · all sessions) ────────────────────────".padEnd(51)}  │  ${"──── NEW (3h · no Asia) ──────────────────────────────".padEnd(51)}  │`);
  console.log(HDR);
  console.log(`  ${"─".repeat(115)}`);

  let oldBal = START_BAL, newBal = START_BAL;
  let totalOldPnl = 0, totalNewPnl = 0;

  for (const m of allMonths) {
    const O = OLD.monthlyData[m] || { pnl: 0, trades: 0, wins: 0, losses: 0, balStart: oldBal, balEnd: oldBal };
    const N = NEW.monthlyData[m] || { pnl: 0, trades: 0, wins: 0, losses: 0, balStart: newBal, balEnd: newBal };

    oldBal = O.balEnd ?? oldBal;
    newBal = N.balEnd ?? newBal;
    totalOldPnl += O.pnl;
    totalNewPnl += N.pnl;

    const oPct  = O.balStart > 0 ? (O.pnl / O.balStart * 100) : 0;
    const nPct  = N.balStart > 0 ? (N.pnl / N.balStart * 100) : 0;
    const oCum  = (O.balEnd - START_BAL) / START_BAL * 100;
    const nCum  = (N.balEnd - START_BAL) / START_BAL * 100;
    const diff  = N.pnl - O.pnl;
    const diffIcon = diff > 50 ? " ✅" : diff < -50 ? " ❌" : "  →";

    const trStr = (d, ot) => ot === 0 ? "   -" : String(d).padStart(4);
    const pStr  = p => (p >= 0 ? "+" : "") + "$" + Math.abs(p).toFixed(0);

    console.log(
      `  ${fmtMonth(m).padEnd(12)}`
      + `${trStr(O.trades, O.trades).padStart(4)}${String(O.wins).padStart(3)}${String(O.losses).padStart(3)}`
      + `${pStr(O.pnl).padStart(11)}${fmtPct(oPct).padStart(8)}${fmtBal(O.balEnd).padStart(13)}${fmtPct(oCum).padStart(9)}`
      + `  │  `
      + `${trStr(N.trades, N.trades).padStart(4)}${String(N.wins).padStart(3)}${String(N.losses).padStart(3)}`
      + `${pStr(N.pnl).padStart(11)}${fmtPct(nPct).padStart(8)}${fmtBal(N.balEnd).padStart(13)}${fmtPct(nCum).padStart(9)}`
      + `  │  ${pStr(diff)}${diffIcon}`
    );
  }

  // Totals row
  console.log(`  ${"─".repeat(115)}`);
  const oTot = OLD.finalBalance - START_BAL, nTot = NEW.finalBalance - START_BAL;
  const oPct = oTot/START_BAL*100, nPct = nTot/START_BAL*100;
  console.log(
    `  ${"TOTAL".padEnd(12)}`
    + `${String(sO.trades).padStart(4)}${String(sO.wins).padStart(3)}${String(OLD.trades.filter(t=>t.pnl<0).length).padStart(3)}`
    + `${fmtUSD(oTot).padStart(11)}${fmtPct(oPct).padStart(8)}${fmtBal(OLD.finalBalance).padStart(13)}${fmtPct(oPct).padStart(9)}`
    + `  │  `
    + `${String(sN.trades).padStart(4)}${String(sN.wins).padStart(3)}${String(NEW.trades.filter(t=>t.pnl<0).length).padStart(3)}`
    + `${fmtUSD(nTot).padStart(11)}${fmtPct(nPct).padStart(8)}${fmtBal(NEW.finalBalance).padStart(13)}${fmtPct(nPct).padStart(9)}`
    + `  │  ${fmtUSD(nTot - oTot)}${nTot > oTot ? " ✅" : " ❌"}`
  );

  // ── Per-pair breakdown ────────────────────────────────────────────────────
  console.log(`\n\n${BAR}`);
  console.log("  PER-PAIR BREAKDOWN");
  console.log(`${BAR}`);
  console.log(`\n  ${"Pair".padEnd(10)} ${"OLD Tr".padStart(7)} ${"OLD WR".padStart(7)} ${"OLD P&L".padStart(10)} │ ${"NEW Tr".padStart(7)} ${"NEW WR".padStart(7)} ${"NEW P&L".padStart(10)} │ Diff`);
  console.log(`  ${"─".repeat(80)}`);

  for (const sym of PAIRS) {
    const oT = OLD.trades.filter(t => t.sym === sym);
    const nT = NEW.trades.filter(t => t.sym === sym);
    const oW = oT.filter(t => t.pnl >= 0).length;
    const nW = nT.filter(t => t.pnl >= 0).length;
    const oPnl = oT.reduce((s, t) => s + t.pnl, 0);
    const nPnl = nT.reduce((s, t) => s + t.pnl, 0);
    const oWR  = oT.length ? (oW/oT.length*100).toFixed(0)+"%" : "-";
    const nWR  = nT.length ? (nW/nT.length*100).toFixed(0)+"%" : "-";
    const diff = nPnl - oPnl;
    const icon = diff > 50 ? " ✅" : diff < -50 ? " ❌" : "  →";
    console.log(
      `  ${sym.replace("USDT","").padEnd(10)}`
      + ` ${String(oT.length).padStart(7)} ${oWR.padStart(7)} ${fmtUSD(oPnl).padStart(10)}`
      + ` │ ${String(nT.length).padStart(7)} ${nWR.padStart(7)} ${fmtUSD(nPnl).padStart(10)}`
      + ` │ ${fmtUSD(diff)}${icon}`
    );
  }

  // ── Exit type breakdown ───────────────────────────────────────────────────
  console.log(`\n\n${BAR}`);
  console.log("  EXIT TYPE BREAKDOWN");
  console.log(`${BAR}`);
  console.log(`\n  ${"Exit".padEnd(8)} ${"OLD Tr".padStart(7)} ${"OLD WR".padStart(7)} ${"OLD P&L".padStart(12)} │ ${"NEW Tr".padStart(7)} ${"NEW WR".padStart(7)} ${"NEW P&L".padStart(12)}`);
  console.log(`  ${"─".repeat(70)}`);
  for (const reason of ["TP","SL","TIME","OPEN"]) {
    const oT = OLD.trades.filter(t => t.exitReason === reason);
    const nT = NEW.trades.filter(t => t.exitReason === reason);
    if (oT.length === 0 && nT.length === 0) continue;
    const oW = oT.filter(t => t.pnl >= 0).length, nW = nT.filter(t => t.pnl >= 0).length;
    const oPnl = oT.reduce((s,t) => s+t.pnl, 0), nPnl = nT.reduce((s,t) => s+t.pnl, 0);
    const oWR  = oT.length ? (oW/oT.length*100).toFixed(0)+"%" : "-";
    const nWR  = nT.length ? (nW/nT.length*100).toFixed(0)+"%" : "-";
    console.log(
      `  ${reason.padEnd(8)}`
      + ` ${String(oT.length).padStart(7)} ${oWR.padStart(7)} ${fmtUSD(oPnl).padStart(12)}`
      + ` │ ${String(nT.length).padStart(7)} ${nWR.padStart(7)} ${fmtUSD(nPnl).padStart(12)}`
    );
  }

  console.log(`\n${BAR}\n`);
})();
