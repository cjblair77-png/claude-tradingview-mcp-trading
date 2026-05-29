/**
 * backtest_pair_screen.mjs — Candidate pair screener for DT strategy
 *
 * Tests each pair INDEPENDENTLY (not as a shared-pool portfolio).
 * Each pair starts with $1,000, 0.8% risk, 5x leverage, 365 days.
 * Reports per-pair stats so we can rank candidates and choose the best to add.
 *
 * Signal logic: identical to bot_daytrading_v01.js (EMA21 + ORB bias + ADX + vol)
 *
 * Run: node backtest_pair_screen.mjs [DAYS] [START_BAL]
 *   eg: node backtest_pair_screen.mjs 365 1000
 */

const DAYS      = parseInt(process.argv[2]  || "365");
const START_BAL = parseFloat(process.argv[3] || "1000");

const RISK_PCT   = 0.008;
const LEVERAGE   = 5;
const MAX_SL_PCT = 0.012;
const RR         = 1.3;
const MAX_HOLD   = 8;

// ── Candidate pairs to screen ──────────────────────────────────────────────────
// Current live pairs marked ★ — include them as baseline for comparison
const CANDIDATES = [
  // ★ Current live pairs (baseline)
  "BTCUSDT",   // ★ live
  "ETHUSDT",   // was removed — re-test with ORB filter
  "BNBUSDT",   // ★ live
  "XRPUSDT",   // ★ live
  "SUIUSDT",   // ★ live (added after ETH removed)
  // Tier-1 liquid alts
  "SOLUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "ADAUSDT",
  "LINKUSDT",
  "DOTUSDT",
  // Mid-cap actives
  "NEARUSDT",
  "APTUSDT",
  "ARBUSDT",
  "INJUSDT",
  "OPUSDT",
  "LTCUSDT",
  "ATOMUSDT",
];

// EMA50 bounce/rejection only on pairs where EMA50 acts as clean S/R
// For screening we'll test with and without — default OFF for new pairs
const EMA50_PAIRS = new Set(["BTCUSDT", "SUIUSDT"]);

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchCandles(symbol, days) {
  const msPerBar = 15 * 60 * 1000;
  const needed   = (days + 5) * 96 + 200;
  const batches  = Math.ceil(needed / 1000);
  const all      = [];
  let endTime    = Date.now();
  for (let b = 0; b < batches; b++) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=1000&endTime=${endTime}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return null;
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
    } catch { return null; }
    if (b < batches - 1) await new Promise(r => setTimeout(r, 200));
  }
  if (!all.length) return null;
  const seen = new Set();
  return all.filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
            .sort((a, b) => a.time - b.time);
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function ema(vals, p) {
  const k = 2 / (p + 1);
  let s = vals[0];
  return vals.map((v, i) => { s = i === 0 ? v : v * k + s * (1 - k); return s; });
}

function sma(vals, p) {
  return vals.map((_, i) =>
    i < p - 1 ? null : vals.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p
  );
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
  let adxVal = 0;
  const dxArr = [];
  for (let i = period + 1; i < n; i++) {
    const c = candles[i], p = candles[i-1];
    const ctr  = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const cpdm = Math.max(c.high - p.high, 0) > Math.max(p.low - c.low, 0) ? Math.max(c.high - p.high, 0) : 0;
    const cndm = Math.max(p.low - c.low, 0) > Math.max(c.high - p.high, 0) ? Math.max(p.low - c.low, 0) : 0;
    tr  = tr  - tr  / period + ctr;
    pdm = pdm - pdm / period + cpdm;
    ndm = ndm - ndm / period + cndm;
    const pdi = tr > 0 ? pdm / tr * 100 : 0;
    const ndi = tr > 0 ? ndm / tr * 100 : 0;
    const dx  = (pdi + ndi) > 0 ? Math.abs(pdi - ndi) / (pdi + ndi) * 100 : 0;
    dxArr.push(dx);
    if (dxArr.length === period)       { adxVal = dxArr.reduce((s, x) => s + x, 0) / period; out[i] = adxVal; }
    else if (dxArr.length > period)    { adxVal = (adxVal * (period - 1) + dx) / period;      out[i] = adxVal; }
  }
  return out;
}

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
      if (c.close > confirmedORB.high)      sessionBias = 'LONG';
      else if (c.close < confirmedORB.low)  sessionBias = 'SHORT';
    }
    orbs[i] = confirmedORB ? { ...confirmedORB, bias: sessionBias } : null;
  }
  return orbs;
}

// ─── Per-pair backtest ────────────────────────────────────────────────────────

function backtestPair(symbol, candles) {
  const closes = candles.map(c => c.close);
  const vols   = candles.map(c => c.volume);
  const e21    = ema(closes, 21);
  const e50    = ema(closes, 50);
  const rsiV   = rsi14(closes);
  const vsma   = sma(vols, 20);
  const adx    = adxCalc(candles);
  const orbs   = sessionORBCalc(candles);
  const tb     = 4;

  // Cutoff: only trade in the last DAYS
  const cutoff = candles[candles.length - 1].time - DAYS * 86400000;

  let balance  = START_BAL, peak = START_BAL, maxDD = 0;
  let openPos  = null;  // one position at a time per pair
  const trades = [];

  for (let i = 70; i < candles.length; i++) {
    const c = candles[i];
    if (c.time < cutoff) continue;

    // ── Exit check ────────────────────────────────────────────────────────────
    if (openPos) {
      const isLong = openPos.dir === "LONG";
      const hitTP  = isLong ? c.high >= openPos.tp : c.low  <= openPos.tp;
      const hitSL  = isLong ? c.low  <= openPos.sl : c.high >= openPos.sl;
      const bars   = Math.round((c.time - openPos.entryTime) / (15 * 60 * 1000));
      const timeEx = bars >= MAX_HOLD;

      let exitReason = null, exitPrice = null;
      if      (hitSL && hitTP) { exitReason = "SL"; exitPrice = openPos.sl; }
      else if (hitSL)          { exitReason = "SL"; exitPrice = openPos.sl; }
      else if (hitTP)          { exitReason = "TP"; exitPrice = openPos.tp; }
      else if (timeEx)         { exitReason = "TIME"; exitPrice = c.close; }

      if (exitReason) {
        const movePct = isLong
          ? (exitPrice - openPos.entry) / openPos.entry
          : (openPos.entry - exitPrice) / openPos.entry;
        const slPct = Math.abs(openPos.entry - openPos.sl) / openPos.entry;
        const pnl   = slPct > 0 ? (movePct / slPct) * openPos.riskUSD * LEVERAGE : 0;
        balance += pnl;
        if (balance <= 0) balance = 0.01;
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak * 100;
        if (dd > maxDD) maxDD = dd;
        trades.push({ dir: openPos.dir, signal: openPos.signal, pnl, exitReason, time: c.time });
        openPos = null;
      }
    }

    // ── Entry check ───────────────────────────────────────────────────────────
    if (openPos) continue;
    if (!rsiV[i] || !vsma[i] || i < tb) continue;
    if (!inSession(c.time)) continue;
    if (!adx[i] || adx[i] < 20) continue;

    const orb = orbs[i];
    if (!orb || !orb.bias) continue;

    const p     = candles[i-1];
    const r     = rsiV[i];
    const volOk = c.volume > vsma[i] * 1.2;
    const e50Up = e50[i] > e50[i - tb];
    const e50Dn = e50[i] < e50[i - tb];

    let sig = null;

    if (orb.bias === 'LONG') {
      // LONG A: EMA21 recapture
      if (!sig && e50Up && r >= 40 && r < 65 && volOk && p.close < e21[i-1] && c.close > e21[i]) {
        const sl   = Math.min(...candles.slice(Math.max(0, i-3), i+1).map(x => x.low));
        const risk = c.close - sl;
        if (risk > 0 && risk / c.close < MAX_SL_PCT)
          sig = { dir: "LONG", signal: "EMA21", entry: c.close, sl, tp: c.close + risk * RR };
      }
      // LONG B: EMA50 bounce (selected pairs only)
      if (!sig && EMA50_PAIRS.has(symbol) && e50Up && r >= 38 && r < 62 && volOk && p.close < e50[i-1] && c.close > e50[i]) {
        const sl   = Math.min(...candles.slice(Math.max(0, i-4), i+1).map(x => x.low));
        const risk = c.close - sl;
        if (risk > 0 && risk / c.close < 0.018)
          sig = { dir: "LONG", signal: "EMA50", entry: c.close, sl, tp: c.close + risk * RR };
      }
    }

    if (orb.bias === 'SHORT') {
      // SHORT A: EMA21 rejection
      if (!sig && e50Dn && r > 35 && r <= 60 && volOk && p.close > e21[i-1] && c.close < e21[i]) {
        const sl   = Math.max(...candles.slice(Math.max(0, i-3), i+1).map(x => x.high));
        const risk = sl - c.close;
        if (risk > 0 && risk / c.close < MAX_SL_PCT)
          sig = { dir: "SHORT", signal: "EMA21", entry: c.close, sl, tp: c.close - risk * RR };
      }
      // SHORT B: EMA50 rejection (selected pairs only)
      if (!sig && EMA50_PAIRS.has(symbol) && e50Dn && r > 38 && r <= 62 && volOk && p.close > e50[i-1] && c.close < e50[i]) {
        const sl   = Math.max(...candles.slice(Math.max(0, i-4), i+1).map(x => x.high));
        const risk = sl - c.close;
        if (risk > 0 && risk / c.close < 0.018)
          sig = { dir: "SHORT", signal: "EMA50", entry: c.close, sl, tp: c.close - risk * RR };
      }
    }

    if (sig) {
      const riskUSD = balance * RISK_PCT;
      openPos = { ...sig, entryTime: c.time, riskUSD };
    }
  }

  // Force-close any remaining open position at the last candle
  if (openPos) {
    const last = candles[candles.length - 1];
    const isLong = openPos.dir === "LONG";
    const movePct = isLong
      ? (last.close - openPos.entry) / openPos.entry
      : (openPos.entry - last.close) / openPos.entry;
    const slPct = Math.abs(openPos.entry - openPos.sl) / openPos.entry;
    const pnl   = slPct > 0 ? (movePct / slPct) * openPos.riskUSD * LEVERAGE : 0;
    balance += pnl;
    if (balance > peak) peak = balance;
    const dd = (peak - balance) / peak * 100;
    if (dd > maxDD) maxDD = dd;
    trades.push({ dir: openPos.dir, signal: openPos.signal, pnl, exitReason: "END", time: last.time });
  }

  const wins   = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl <= 0).length;
  const totalPnl = balance - START_BAL;
  const retPct   = (totalPnl / START_BAL) * 100;
  const wr       = trades.length > 0 ? (wins / trades.length) * 100 : 0;

  // Monthly P&L
  const monthly = {};
  for (const t of trades) {
    const d = new Date(t.time);
    const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
    if (!monthly[k]) monthly[k] = 0;
    monthly[k] += t.pnl;
  }

  // Signal breakdown
  const bySignal = {};
  for (const t of trades) {
    if (!bySignal[t.signal]) bySignal[t.signal] = { trades: 0, wins: 0, pnl: 0 };
    bySignal[t.signal].trades++;
    if (t.pnl > 0) bySignal[t.signal].wins++;
    bySignal[t.signal].pnl += t.pnl;
  }

  // Direction breakdown
  const longs  = trades.filter(t => t.dir === "LONG");
  const shorts = trades.filter(t => t.dir === "SHORT");
  const lWR    = longs.length  ? longs.filter(t => t.pnl > 0).length  / longs.length  * 100 : 0;
  const sWR    = shorts.length ? shorts.filter(t => t.pnl > 0).length / shorts.length * 100 : 0;

  return { symbol, trades: trades.length, wins, losses, wr, totalPnl, retPct, balance, maxDD, monthly, bySignal, longs: longs.length, shorts: shorts.length, lWR, sWR };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const results = [];
  const live    = new Set(["BTCUSDT", "BNBUSDT", "XRPUSDT", "SUIUSDT"]);

  console.log(`\n📊 DT Pair Screener  |  ${DAYS} days  |  $${START_BAL.toFixed(0)} start  |  5x leverage  |  0.8% risk\n`);
  console.log(`Testing ${CANDIDATES.length} pairs... (fetching candles takes ~${Math.round(CANDIDATES.length * 2.5 / 60)} min)\n`);

  for (const sym of CANDIDATES) {
    process.stdout.write(`  ${live.has(sym) ? "★" : "·"} ${sym.padEnd(12)} fetching...`);
    const candles = await fetchCandles(sym, DAYS);
    if (!candles || candles.length < 200) {
      process.stdout.write(" ❌ no data\n");
      continue;
    }
    const r = backtestPair(sym, candles);
    results.push(r);
    const flag = r.retPct > 0 ? "✅" : "❌";
    process.stdout.write(`\r  ${live.has(sym) ? "★" : "·"} ${sym.padEnd(12)} ${flag}  ${String(r.trades).padStart(3)} trades  WR ${r.wr.toFixed(1).padStart(5)}%  ret ${(r.retPct >= 0 ? "+" : "") + r.retPct.toFixed(1).padStart(6)}%  DD ${r.maxDD.toFixed(1).padStart(5)}%\n`);
  }

  // ── Ranked summary table ───────────────────────────────────────────────────
  results.sort((a, b) => b.retPct - a.retPct);

  console.log("\n" + "═".repeat(100));
  console.log("  RANKED RESULTS — sorted by total return\n");
  console.log(
    "  " +
    "Pair".padEnd(12) +
    "Live".padEnd(6) +
    "Trades".padStart(7) +
    "WR%".padStart(7) +
    "Ret%".padStart(8) +
    "P&L$".padStart(9) +
    "MaxDD%".padStart(8) +
    "L".padStart(5) +
    "LWR%".padStart(6) +
    "S".padStart(5) +
    "SWR%".padStart(6)
  );
  console.log("  " + "─".repeat(98));

  for (const r of results) {
    const isLive = live.has(r.symbol);
    const retStr = (r.retPct >= 0 ? "+" : "") + r.retPct.toFixed(1);
    const pnlStr = (r.totalPnl >= 0 ? "+$" : "-$") + Math.abs(r.totalPnl).toFixed(0);
    const rec    = r.wr >= 50 && r.retPct > 0 && r.maxDD < 35 && r.trades >= 15 ? " ← ADD" : "";
    console.log(
      "  " +
      r.symbol.padEnd(12) +
      (isLive ? "★" : " ").padEnd(6) +
      String(r.trades).padStart(7) +
      (r.wr.toFixed(1) + "%").padStart(7) +
      (retStr + "%").padStart(8) +
      pnlStr.padStart(9) +
      (r.maxDD.toFixed(1) + "%").padStart(8) +
      String(r.longs).padStart(5) +
      (r.lWR.toFixed(0) + "%").padStart(6) +
      String(r.shorts).padStart(5) +
      (r.sWR.toFixed(0) + "%").padStart(6) +
      rec
    );
  }

  console.log("\n  ← ADD  = WR ≥ 50%, return > 0, maxDD < 35%, ≥ 15 trades\n");
  console.log("═".repeat(100));

  // ── Monthly breakdown for top performers ──────────────────────────────────
  const top = results.slice(0, 8);
  const allMonths = [...new Set(results.flatMap(r => Object.keys(r.monthly)))].sort();

  console.log("\n  MONTHLY P&L — Top 8 by return  ($)\n");
  const hdr = "  Month    " + top.map(r => r.symbol.replace("USDT","").padStart(8)).join("  ");
  console.log(hdr);
  console.log("  " + "─".repeat(hdr.length - 2));

  for (const mo of allMonths.slice(-13)) {
    const cols = top.map(r => {
      const v = r.monthly[mo] || 0;
      const s = (v >= 0 ? "+" : "") + v.toFixed(0);
      return s.padStart(8);
    });
    console.log(`  ${mo}  ${cols.join("  ")}`);
  }

  // ── Signal breakdown for recommended pairs ────────────────────────────────
  const recommended = results.filter(r => r.wr >= 50 && r.retPct > 0 && r.maxDD < 35 && r.trades >= 15);
  if (recommended.length) {
    console.log("\n" + "═".repeat(100));
    console.log("  SIGNAL BREAKDOWN — recommended pairs\n");
    for (const r of recommended) {
      const isLive = live.has(r.symbol);
      console.log(`  ${r.symbol}${isLive ? " ★" : "  "} — ${r.trades} trades  WR ${r.wr.toFixed(1)}%  ret ${(r.retPct >= 0?"+":'') + r.retPct.toFixed(1)}%  maxDD ${r.maxDD.toFixed(1)}%`);
      for (const [sig, s] of Object.entries(r.bySignal)) {
        const swr = s.trades > 0 ? (s.wins / s.trades * 100).toFixed(0) : "0";
        console.log(`     ${sig.padEnd(6)} ${String(s.trades).padStart(3)} trades  WR ${swr}%  P&L $${s.pnl.toFixed(0)}`);
      }
    }
  }

  // ── Recommendation summary ─────────────────────────────────────────────────
  console.log("\n" + "═".repeat(100));
  const toAdd  = recommended.filter(r => !live.has(r.symbol));
  const toKeep = recommended.filter(r =>  live.has(r.symbol));
  const toCut  = results.filter(r => live.has(r.symbol) && !recommended.some(x => x.symbol === r.symbol));

  console.log("\n  📋 RECOMMENDATION\n");
  if (toKeep.length) console.log("  Keep (passing):  " + toKeep.map(r => r.symbol).join(", "));
  if (toCut.length)  console.log("  Review/cut:      " + toCut.map(r => r.symbol).join(", "));
  if (toAdd.length)  console.log("  Add to live bot: " + toAdd.map(r => r.symbol).join(", "));
  console.log();
}

main().catch(console.error);
