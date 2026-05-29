/**
 * backtest_dt_daily.mjs — DT strategy only, 52-week daily + weekly breakdown
 *
 * DT: BTC BNB XRP SUI · 15m candles · 5x leverage · 0.8% risk · max 4 positions
 * Signal: EMA21 recapture/rejection + EMA50 bounce (BTC/SUI only)
 *         Short-term momentum filter: EMA50 direction over 4 bars (1hr) — no macro filters
 *
 * Run: node backtest_dt_daily.mjs [DAYS] [START_BAL]
 *   eg: node backtest_dt_daily.mjs 365 5000
 */

const DAYS      = parseInt(process.argv[2]  || "365");
const START_BAL = parseFloat(process.argv[3] || "5000");

const RISK_PCT    = 0.008;
const LEVERAGE    = 5;
const MAX_POS     = 4;
const MAX_SL_PCT  = 0.012;
const RR          = 1.3;
const MAX_HOLD    = 8;
const EMA50_PAIRS = new Set(["BTCUSDT", "SUIUSDT"]);
const PAIRS       = ["BTCUSDT", "BNBUSDT", "XRPUSDT", "SUIUSDT", "LTCUSDT", "AVAXUSDT"];

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchCandles(symbol, days) {
  const msPerBar = 15 * 60 * 1000;
  const needed   = (days + 5) * 96 + 200;  // extra warmup bars
  const batches  = Math.ceil(needed / 1000);
  const all      = [];
  let endTime    = Date.now();
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

// ─── Session filter ───────────────────────────────────────────────────────────

function inSession(ts) {
  const h = new Date(ts).getUTCHours();
  return h >= 1 && h < 22;
}

// ─── Session ORB (Opening Range Breakout) ─────────────────────────────────────
// Three session opens per UTC day: Asia 01:00, London 08:00, US 13:00
// ORB = high/low of the first 2 candles (30 min) after each session open.
//
// Session bias = direction of the FIRST ORB break in that session:
//   First close above ORB high → bias LONG  for remainder of session
//   First close below ORB low  → bias SHORT for remainder of session
//   Neither broken yet          → bias null, skip (ranging/choppy open)
//
// This avoids the EMA21-inside-ORB false-filter bug: we don't care where
// EMA21 is relative to the ORB high; we only care which way the session broke.

const SESSION_OPENS = new Set([1, 8, 13]); // UTC hours

function sessionORBCalc(candles) {
  const orbs = new Array(candles.length).fill(null);
  let building     = false;
  let orbHigh      = -Infinity;
  let orbLow       = Infinity;
  let confirmedORB = null;
  let sessionBias  = null;   // 'LONG' | 'SHORT' | null

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const d = new Date(c.time);
    const h = d.getUTCHours(), m = d.getUTCMinutes();

    if (SESSION_OPENS.has(h) && m === 0) {
      // First candle of new session — start building ORB, reset bias
      building     = true;
      orbHigh      = c.high;
      orbLow       = c.low;
      confirmedORB = null;
      sessionBias  = null;
    } else if (building) {
      // Second candle — ORB is now locked in
      orbHigh      = Math.max(orbHigh, c.high);
      orbLow       = Math.min(orbLow,  c.low);
      confirmedORB = { high: orbHigh, low: orbLow };
      building     = false;
    }

    // Track the FIRST ORB break — this sets session bias permanently
    if (confirmedORB && sessionBias === null) {
      if (c.close > confirmedORB.high) sessionBias = 'LONG';
      else if (c.close < confirmedORB.low) sessionBias = 'SHORT';
    }

    orbs[i] = confirmedORB ? { ...confirmedORB, bias: sessionBias } : null;
  }
  return orbs;
}

// ─── Signal precompute ────────────────────────────────────────────────────────

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

function signal(pre, i) {
  if (i < 70) return null;
  const { symbol, candles, e21, e50, rsiV, vsma, adx, orbs } = pre;
  const c = candles[i], p = candles[i - 1], r = rsiV[i];
  if (!r || !vsma[i]) return null;
  if (!inSession(c.time)) return null;
  if (!adx[i] || adx[i] < 20) return null;

  // ── Session ORB filter ───────────────────────────────────────────────────
  // Use the FIRST ORB break as the session bias — not current price vs ORB.
  // If the session broke up first → long-only. Broke down first → short-only.
  // Not broken either way yet → ranging open, skip.
  const orb = orbs[i];
  if (!orb || !orb.bias) return null;   // No ORB or session still inside range
  const aboveORB = orb.bias === 'LONG';
  const belowORB = orb.bias === 'SHORT';

  const volOk = c.volume > vsma[i] * 1.2;
  const tb = 4;
  if (i < tb) return null;
  const e50Up = e50[i] > e50[i - tb];
  const e50Dn = e50[i] < e50[i - tb];

  // LONG signals: only when price has broken ABOVE the session ORB high
  if (aboveORB) {
    // LONG A: EMA21 recapture — pullback to EMA21 then recapture, in ORB bull territory
    if (e50Up && r >= 40 && r < 65 && volOk && p.close < e21[i - 1] && c.close > e21[i]) {
      const sl   = Math.min(...candles.slice(Math.max(0, i - 3), i + 1).map(x => x.low));
      const risk = c.close - sl;
      if (risk > 0 && risk / c.close < MAX_SL_PCT)
        return { dir: "LONG", signal: "EMA21", entry: c.close, sl, tp: c.close + risk * RR };
    }
    // LONG B: EMA50 bounce (BTC/SUI only) — EMA50 as support, in ORB bull territory
    if (EMA50_PAIRS.has(symbol) && e50Up && r >= 38 && r < 62 && volOk && p.close < e50[i - 1] && c.close > e50[i]) {
      const sl   = Math.min(...candles.slice(Math.max(0, i - 4), i + 1).map(x => x.low));
      const risk = c.close - sl;
      if (risk > 0 && risk / c.close < 0.018)
        return { dir: "LONG", signal: "EMA50", entry: c.close, sl, tp: c.close + risk * RR };
    }
  }

  // SHORT signals: only when price has broken BELOW the session ORB low
  if (belowORB) {
    // SHORT A: EMA21 rejection — rally to EMA21 then rejection, in ORB bear territory
    if (e50Dn && r > 35 && r <= 60 && volOk && p.close > e21[i - 1] && c.close < e21[i]) {
      const sl   = Math.max(...candles.slice(Math.max(0, i - 3), i + 1).map(x => x.high));
      const risk = sl - c.close;
      if (risk > 0 && risk / c.close < MAX_SL_PCT)
        return { dir: "SHORT", signal: "EMA21", entry: c.close, sl, tp: c.close - risk * RR };
    }
    // SHORT B: EMA50 rejection (BTC/SUI only) — EMA50 as resistance, in ORB bear territory
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

function simulate(allCandles, allPre) {
  // Build unified 15m timeline
  const allTimes = new Set();
  for (const bars of Object.values(allCandles)) for (const c of bars) allTimes.add(c.time);
  const timeline = [...allTimes].sort((a, b) => a - b);

  // Cutoff: only trade the last DAYS worth of bars
  const cutoff = timeline[timeline.length - 1] - DAYS * 86400000;

  // Index by time
  const byTime = {}, byIdx = {};
  for (const [sym, bars] of Object.entries(allCandles)) {
    byTime[sym] = {}; byIdx[sym] = {};
    bars.forEach((c, i) => { byTime[sym][c.time] = c; byIdx[sym][c.time] = i; });
  }

  let balance = START_BAL, peak = START_BAL, maxDD = 0;
  const openPositions = {};  // sym → position
  const trades = [];         // all closed trades

  // Daily buckets: date string → { trades, pnl, wins, losses, balStart, balEnd }
  const dailyData = {};

  function getDay(ts) {
    const d = new Date(ts);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  }

  function ensureDay(dateStr, bal) {
    if (!dailyData[dateStr]) dailyData[dateStr] = { trades: 0, wins: 0, losses: 0, pnl: 0, balStart: bal, balEnd: bal };
  }

  for (const t of timeline) {
    if (t < cutoff) continue;
    const dateStr = getDay(t);

    for (const sym of PAIRS) {
      const i = byIdx[sym][t];
      if (i === undefined) continue;
      const c = byTime[sym][t];
      const pre = allPre[sym];

      // ── Check exits ──────────────────────────────────────────────────────
      if (openPositions[sym]) {
        const pos = openPositions[sym];
        const isLong = pos.dir === "LONG";
        let closed = false, exitReason = "", exitPrice = 0;

        if (isLong) {
          if (c.low  <= pos.sl) { exitPrice = pos.sl;  exitReason = "SL"; closed = true; }
          else if (c.high >= pos.tp) { exitPrice = pos.tp; exitReason = "TP"; closed = true; }
        } else {
          if (c.high >= pos.sl) { exitPrice = pos.sl;  exitReason = "SL"; closed = true; }
          else if (c.low  <= pos.tp) { exitPrice = pos.tp; exitReason = "TP"; closed = true; }
        }
        if (!closed && i - pos.entryBarIdx >= MAX_HOLD) {
          exitPrice = c.close; exitReason = "TIME"; closed = true;
        }

        if (closed) {
          const movePct  = isLong ? (exitPrice - pos.entry) / pos.entry
                                  : (pos.entry - exitPrice) / pos.entry;
          const slPct    = isLong ? (pos.entry - pos.sl) / pos.entry
                                  : (pos.sl - pos.entry) / pos.entry;
          const pnl      = (movePct / slPct) * pos.riskUSD * LEVERAGE;
          balance       += pnl;
          if (balance > peak) peak = balance;
          const dd = (peak - balance) / peak * 100;
          if (dd > maxDD) maxDD = dd;

          const exitDay = getDay(c.time);
          ensureDay(exitDay, balance);
          dailyData[exitDay].trades++;
          dailyData[exitDay].pnl += pnl;
          dailyData[exitDay].balEnd = balance;
          if (pnl >= 0) dailyData[exitDay].wins++; else dailyData[exitDay].losses++;

          trades.push({ sym, dir: pos.dir, sig: pos.signal, entryTime: pos.entryTime,
                        exitTime: c.time, exitReason, pnl, riskUSD: pos.riskUSD });
          delete openPositions[sym];
        }
      }

      // ── Check entries ─────────────────────────────────────────────────────
      if (!openPositions[sym] && Object.keys(openPositions).length < MAX_POS) {
        const sig = signal(pre, i);
        if (sig) {
          const riskUSD = balance * RISK_PCT;
          openPositions[sym] = {
            ...sig, sym, riskUSD, entryTime: c.time, entryBarIdx: i,
          };
        }
      }
    }
  }

  // Close any still-open positions at last price
  for (const [sym, pos] of Object.entries(openPositions)) {
    const bars = allCandles[sym];
    const lastC = bars[bars.length - 1];
    const exitPrice = lastC.close;
    const isLong = pos.dir === "LONG";
    const movePct = isLong ? (exitPrice - pos.entry) / pos.entry
                           : (pos.entry - exitPrice) / pos.entry;
    const slPct   = isLong ? (pos.entry - pos.sl) / pos.entry
                           : (pos.sl - pos.entry) / pos.entry;
    const pnl = (movePct / slPct) * pos.riskUSD * LEVERAGE;
    balance += pnl;
    const exitDay = getDay(lastC.time);
    ensureDay(exitDay, balance);
    dailyData[exitDay].trades++;
    dailyData[exitDay].pnl += pnl;
    dailyData[exitDay].balEnd = balance;
    if (pnl >= 0) dailyData[exitDay].wins++; else dailyData[exitDay].losses++;
    trades.push({ sym, dir: pos.dir, sig: pos.signal, entryTime: pos.entryTime,
                  exitTime: lastC.time, exitReason: "OPEN", pnl, riskUSD: pos.riskUSD });
  }

  return { trades, dailyData, finalBalance: balance, maxDD };
}

// ─── Print report ─────────────────────────────────────────────────────────────

function printReport(trades, dailyData, finalBalance, maxDD) {
  const days = Object.keys(dailyData).sort();
  if (days.length === 0) { console.log("No trades."); return; }

  const totalPnl  = finalBalance - START_BAL;
  const totalRet  = (totalPnl / START_BAL * 100).toFixed(1);
  const totalW    = trades.filter(t => t.pnl >= 0).length;
  const totalL    = trades.filter(t => t.pnl <  0).length;
  const wr        = trades.length ? (totalW / trades.length * 100).toFixed(1) : "0.0";
  const gross_w   = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gross_l   = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const pf        = gross_l > 0 ? (gross_w / gross_l).toFixed(2) : "∞";

  const W = (n, w) => String(n).padStart(w);
  const F = (n, w, d=2) => n.toFixed(d).padStart(w);
  const S = (s, w) => String(s).padEnd(w);

  console.log("═".repeat(108));
  console.log("  DT Strategy — 52-Week Daily Breakdown");
  console.log(`  BTC · BNB · XRP · SUI  ·  5× leverage  ·  0.8% risk/trade  ·  $${START_BAL.toLocaleString()} start`);
  console.log("═".repeat(108));
  console.log(`  Start: $${START_BAL.toLocaleString()}   →   End: $${finalBalance.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}   |   Total: ${totalRet}%   |   Max DD: ${maxDD.toFixed(1)}%`);
  console.log(`  Trades: ${trades.length}   Win Rate: ${wr}%  (${totalW}W / ${totalL}L)   Profit Factor: ${pf}`);
  console.log("═".repeat(108));

  // Header
  const hdr = `  ${"Week".padEnd(6)} ${"Date".padEnd(12)} ${"Tr".padStart(3)} ${"W".padStart(3)} ${"L".padStart(3)} ` +
              `${"P&L $".padStart(10)} ${"Day %".padStart(7)} ${"Balance".padStart(12)} ${"Cum Ret%".padStart(9)}`;
  console.log(hdr);
  console.log("  " + "─".repeat(104));

  // Track week state
  let weekNum = 1, weekStart = days[0], weekTr = 0, weekW = 0, weekL = 0, weekPnl = 0;
  let weekBalStart = START_BAL;
  let runningBalance = START_BAL;

  // Fill missing days (zero-trade days) in date range
  const start = new Date(days[0] + "T00:00:00Z");
  const end   = new Date(days[days.length - 1] + "T00:00:00Z");
  const allDays = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    allDays.push(d.toISOString().slice(0, 10));
  }

  // Pre-pass: fill balStart/balEnd for zero-trade days
  let prevBal = START_BAL;
  for (const day of allDays) {
    if (!dailyData[day]) {
      dailyData[day] = { trades: 0, wins: 0, losses: 0, pnl: 0, balStart: prevBal, balEnd: prevBal };
    } else {
      dailyData[day].balStart = prevBal;
      prevBal = dailyData[day].balEnd;
    }
    prevBal = dailyData[day].balEnd;
  }

  // Get start-of-week dates (Monday-aligned weeks)
  function weekKey(dateStr) {
    const d = new Date(dateStr + "T00:00:00Z");
    const day = d.getUTCDay();               // 0=Sun … 6=Sat
    const mon = new Date(d);
    mon.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
    return mon.toISOString().slice(0, 10);
  }

  let currentWeekKey = weekKey(allDays[0]);
  let weekMap = {};  // weekKey → { tr, w, l, pnl, balStart }
  let weekBalances = {};

  for (const day of allDays) {
    const wk = weekKey(day);
    if (!weekMap[wk]) weekMap[wk] = { tr: 0, w: 0, l: 0, pnl: 0, balStart: dailyData[day].balStart };
    weekMap[wk].tr  += dailyData[day].trades;
    weekMap[wk].w   += dailyData[day].wins;
    weekMap[wk].l   += dailyData[day].losses;
    weekMap[wk].pnl += dailyData[day].pnl;
    weekMap[wk].balEnd = dailyData[day].balEnd;
  }

  const weekKeys = [...new Set(allDays.map(weekKey))].sort();
  let wNum = 1;

  for (const wk of weekKeys) {
    const wData = weekMap[wk];
    const wDays = allDays.filter(d => weekKey(d) === wk);
    const wPct  = (wData.pnl / wData.balStart * 100).toFixed(2);
    const wEnd  = wData.balEnd ?? wData.balStart;
    const wCum  = ((wEnd - START_BAL) / START_BAL * 100).toFixed(1);

    // Print week header
    const sign = wData.pnl >= 0 ? "+" : "";
    console.log(`\n  ${"Wk" + String(wNum).padStart(2,"0")}   ${S(wk, 12)} ${W(wData.tr,3)} ${W(wData.w,3)} ${W(wData.l,3)} ` +
                `${(sign+wData.pnl.toFixed(2)).padStart(10)} ${(sign+wPct+"%").padStart(7)} ${"$"+wEnd.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,",").padStart(11)} ${(sign+wCum+"%").padStart(9)}`);
    console.log("  " + "─".repeat(104));

    // Print each day of the week
    for (const day of wDays) {
      const dd    = dailyData[day];
      const dayPnl  = dd.pnl;
      const dayPct  = dd.balStart > 0 ? (dayPnl / dd.balStart * 100).toFixed(2) : "0.00";
      const cumRet  = ((dd.balEnd - START_BAL) / START_BAL * 100).toFixed(1);
      const dayOfW  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(day+"T00:00:00Z").getUTCDay()];
      const sign    = dayPnl >= 0 ? "+" : "";
      const trStr   = dd.trades === 0 ? "  -" : W(dd.trades, 3);
      const wStr    = dd.trades === 0 ? "  -" : W(dd.wins,  3);
      const lStr    = dd.trades === 0 ? "  -" : W(dd.losses, 3);
      const pnlStr  = dd.trades === 0 ? "         -" : (sign + dayPnl.toFixed(2)).padStart(10);
      const pctStr  = dd.trades === 0 ? "      -" : (sign + dayPct + "%").padStart(7);
      const balStr  = ("$" + dd.balEnd.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")).padStart(12);
      const cumStr  = (sign + cumRet + "%").padStart(9);
      console.log(`         ${S(day+" "+dayOfW, 12)} ${trStr} ${wStr} ${lStr} ${pnlStr} ${pctStr} ${balStr} ${cumStr}`);
    }

    wNum++;
  }

  // ── Monthly summary ───────────────────────────────────────────────────────
  console.log("\n\n" + "═".repeat(108));
  console.log("  Monthly Summary");
  console.log("═".repeat(108));
  console.log(`  ${"Month".padEnd(10)} ${"Trades".padStart(7)} ${"W".padStart(5)} ${"L".padStart(5)} ${"WR%".padStart(6)} ${"P&L $".padStart(12)} ${"Month%".padStart(8)} ${"Balance".padStart(14)} ${"Cum Ret%".padStart(10)}`);
  console.log("  " + "─".repeat(104));

  const monthMap = {};
  for (const day of allDays) {
    const mk = day.slice(0, 7);
    if (!monthMap[mk]) monthMap[mk] = { tr: 0, w: 0, l: 0, pnl: 0, balStart: dailyData[day].balStart };
    monthMap[mk].tr  += dailyData[day].trades;
    monthMap[mk].w   += dailyData[day].wins;
    monthMap[mk].l   += dailyData[day].losses;
    monthMap[mk].pnl += dailyData[day].pnl;
    monthMap[mk].balEnd = dailyData[day].balEnd;
  }
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  for (const mk of Object.keys(monthMap).sort()) {
    const m   = monthMap[mk];
    const wr  = m.tr ? (m.w / m.tr * 100).toFixed(0) : "0";
    const mPct = m.balStart > 0 ? (m.pnl / m.balStart * 100).toFixed(1) : "0.0";
    const cumRet = ((m.balEnd - START_BAL) / START_BAL * 100).toFixed(1);
    const [yr, mo] = mk.split("-");
    const mName = `${MONTHS[parseInt(mo)-1]} ${yr}`;
    const sign = m.pnl >= 0 ? "+" : "";
    console.log(`  ${S(mName, 10)} ${W(m.tr, 7)} ${W(m.w, 5)} ${W(m.l, 5)} ${(wr+"%").padStart(6)} ` +
                `${(sign+m.pnl.toFixed(2)).padStart(12)} ${(sign+mPct+"%").padStart(8)} ` +
                `${"$"+m.balEnd.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,",").padStart(13)} ${(sign+cumRet+"%").padStart(10)}`);
  }

  // ── Signal breakdown ──────────────────────────────────────────────────────
  console.log("\n\n" + "═".repeat(108));
  console.log("  Signal Breakdown");
  console.log("═".repeat(108));
  for (const sigType of ["EMA21","EMA50"]) {
    const sigTrades = trades.filter(t => t.sig === sigType);
    const sigW = sigTrades.filter(t => t.pnl >= 0).length;
    const sigPnl = sigTrades.reduce((s, t) => s + t.pnl, 0);
    console.log(`  ${sigType.padEnd(8)} ${sigTrades.length} trades  ${(sigW/sigTrades.length*100||0).toFixed(0)}% WR  P&L: ${sigPnl >= 0 ? "+" : ""}$${sigPnl.toFixed(2)}`);
  }
  for (const sym of PAIRS) {
    const symTrades = trades.filter(t => t.sym === sym);
    const symW   = symTrades.filter(t => t.pnl >= 0).length;
    const symPnl = symTrades.reduce((s, t) => s + t.pnl, 0);
    console.log(`  ${sym.replace("USDT","").padEnd(8)} ${symTrades.length} trades  ${(symW/symTrades.length*100||0).toFixed(0)}% WR  P&L: ${symPnl >= 0 ? "+" : ""}$${symPnl.toFixed(2)}`);
  }

  console.log("\n  Exit breakdown:");
  for (const reason of ["TP","SL","TIME","OPEN"]) {
    const rt = trades.filter(t => t.exitReason === reason);
    if (rt.length === 0) continue;
    const rPnl = rt.reduce((s, t) => s + t.pnl, 0);
    console.log(`    ${reason.padEnd(6)} ${rt.length} trades  P&L: ${rPnl >= 0 ? "+" : ""}$${rPnl.toFixed(2)}`);
  }

  console.log("\n" + "═".repeat(108));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\nFetching 15m candles for ${DAYS} days (+ warmup)...`);
  const allCandles = {};
  for (const sym of PAIRS) {
    process.stdout.write(`  ${sym.padEnd(10)}`);
    allCandles[sym] = await fetchCandles(sym, DAYS);
    console.log(`${allCandles[sym].length} bars`);
  }

  console.log("\nPre-computing indicators + signals...");
  const allPre = {};
  for (const sym of PAIRS) {
    allPre[sym] = precompute(sym, allCandles[sym]);
    const sigs = allCandles[sym].filter((_, i) => signal(allPre[sym], i) !== null);
    console.log(`  ${sym.padEnd(10)} ${sigs.length} signals`);
  }

  console.log("\nRunning simulation...\n");
  const { trades, dailyData, finalBalance, maxDD } = simulate(allCandles, allPre);

  printReport(trades, dailyData, finalBalance, maxDD);
})();
