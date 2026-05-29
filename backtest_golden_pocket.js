/**
 * backtest_golden_pocket.js — "The Golden Pocket" Fibonacci strategy backtest
 *
 * Based on the Fibonacci retracement strategy from the YouTube transcript
 * the user shared. This is a STANDALONE test (we previously only used it as a
 * filter on DT, which blocked too many trades).
 *
 * Strategy mechanics:
 *   1. Detect impulse moves on 15min (≥2.5% over 6 bars + breaks 20-bar structure)
 *   2. Confirm direction with 1H EMA21 vs EMA50 trend
 *   3. Wait for retracement to 0.5-0.618 zone (golden pocket)
 *   4. Place LIMIT order at 0.618 fib level
 *   5. SL just beyond 1.0 (full retracement)
 *   6. TP at 1:1.6 R:R
 *   7. Only enter during London-NY overlap (13:00-18:00 UTC)
 *   8. Cancel order if price retraces beyond 0.786 OR 24h pass without fill
 *
 * Universe: 12 mid/high-vol crypto pairs (excluding BTC/ETH)
 * Risk: 0.5% per trade (Option 1 sizing) | Max 4 concurrent positions
 *
 * Run: node backtest_golden_pocket.js
 */

import "dotenv/config";

const MEXC_BASE = "https://futures.mexc.com";
const DAYS      = 180;
const NOW_SEC   = Math.floor(Date.now() / 1000);
const START     = NOW_SEC - DAYS * 86400;
const FEE_PCT   = 0.0004; // 0.02% × 2

// ── Universe (same as Grinder for fair comparison) ──────────────────────────
const PAIRS = [
  "SUI_USDT", "AVAX_USDT", "ONDO_USDT",
  "ENA_USDT", "TIA_USDT", "WIF_USDT",
  "WLD_USDT", "JUP_USDT", "FILECOIN_USDT",
  "AR_USDT", "AIXBT_USDT", "S_USDT",
];

const CFG = {
  startBalance:       5000,
  riskPct:            0.005,    // 0.5% per trade
  leverage:           5,
  rrRatio:            1.6,      // 1:1.6 R:R per Fibonacci video
  maxHoldBars:        192,      // 48h on 15min = 192 bars
  pendingMaxBars:     96,       // 24h on 15min = limit order timeout
  maxPositions:       4,

  // Impulse detection
  impulseLookback:    6,        // 6 × 15min = 1.5h window for impulse
  impulseMinPct:      0.025,    // 2.5% minimum range
  structureLookback:  20,       // 20-bar prior structure to break

  // Fibonacci levels
  fibEntry:           0.618,    // golden pocket entry
  fibInvalidate:      0.786,    // deeper than this = cancel order
  slBufferPct:        0.005,    // SL is 0.5% beyond the 1.0 level

  // Session filter — London-NY overlap (high volume window)
  sessionStartH:      13,
  sessionEndH:        18,

  // Higher-TF (1H) trend filter
  htfEMAfast:         21,
  htfEMAslow:         50,
};

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
  while(cur<endSec){const end=Math.min(cur+chunk,endSec);const batch=await fetchChunk(symbol,intervalStr,cur,end);if(!batch.length){emptyRuns++;if(emptyRuns>=10)break;cur=end+barSecs;await sleep(120);continue;}emptyRuns=0;bars.push(...batch);cur=Math.floor(batch[batch.length-1].t/1000)+barSecs;await sleep(130);}
  const seen=new Set();return bars.filter(b=>{if(seen.has(b.t))return false;seen.add(b.t);return true;}).sort((a,b)=>a.t-b.t);
}
function ema(values, period) {
  const k = 2 / (period + 1), out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i-1] * (1-k));
  return out;
}
function sma(values, period) {
  return values.map((_,i) => i<period-1 ? null : values.slice(i-period+1,i+1).reduce((a,b)=>a+b,0)/period);
}

// ── 1H trend from 15min bars ────────────────────────────────────────────────
// Aggregate 4 × 15min bars into each 1H bar, then compute EMA21/EMA50

function build1HTrend(bars15) {
  const hourly = {};
  for (const b of bars15) {
    const d = new Date(b.t);
    const hourKey = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}`;
    if (!hourly[hourKey]) hourly[hourKey] = { t: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())).getTime(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
    else { const x = hourly[hourKey]; x.h = Math.max(x.h, b.h); x.l = Math.min(x.l, b.l); x.c = b.c; x.v += b.v; }
  }
  const hours = Object.values(hourly).sort((a,b)=>a.t-b.t);
  const closes = hours.map(h=>h.c);
  const e21 = ema(closes, CFG.htfEMAfast);
  const e50 = ema(closes, CFG.htfEMAslow);
  // Build a map: 15min timestamp → 1H trend at that moment
  const trendArr = hours.map((h, i) => ({
    t: h.t,
    trend: e21[i] != null && e50[i] != null ? (e21[i] > e50[i] ? "UP" : "DOWN") : "NEUTRAL"
  }));
  return trendArr;
}

function lookup1HTrend(trendArr, ts) {
  const oneHourMs = 3600 * 1000;
  // Find the latest 1H bar whose CLOSE was at or before ts
  let lo = 0, hi = trendArr.length - 1, result = "NEUTRAL";
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (trendArr[mid].t + oneHourMs <= ts) { result = trendArr[mid].trend; lo = mid + 1; }
    else hi = mid - 1;
  }
  return result;
}

// ── Impulse detection ──────────────────────────────────────────────────────
// Returns null if no clean impulse, else { dir: "UP"|"DOWN", start, end, range }

function detectImpulse(bars, i) {
  if (i < CFG.impulseLookback + CFG.structureLookback) return null;

  const window = bars.slice(i - CFG.impulseLookback + 1, i + 1);
  const windowHigh = Math.max(...window.map(b => b.h));
  const windowLow  = Math.min(...window.map(b => b.l));
  const rangePct = (windowHigh - windowLow) / windowLow;
  if (rangePct < CFG.impulseMinPct) return null;

  // Find index of window high and window low
  let highIdx = 0, lowIdx = 0;
  let hv = window[0].h, lv = window[0].l;
  for (let j = 1; j < window.length; j++) {
    if (window[j].h > hv) { hv = window[j].h; highIdx = j; }
    if (window[j].l < lv) { lv = window[j].l; lowIdx = j; }
  }

  // Direction = whichever extreme came LAST (most recent)
  const dir = highIdx > lowIdx ? "UP" : "DOWN";

  // Check structure break — the impulse extreme must exceed prior 20-bar level
  const priorStart = Math.max(0, i - CFG.impulseLookback - CFG.structureLookback);
  const priorBars = bars.slice(priorStart, i - CFG.impulseLookback + 1);
  if (priorBars.length === 0) return null;
  const priorHigh = Math.max(...priorBars.map(b => b.h));
  const priorLow  = Math.min(...priorBars.map(b => b.l));
  if (dir === "UP" && windowHigh <= priorHigh) return null;
  if (dir === "DOWN" && windowLow >= priorLow) return null;

  return {
    dir,
    start: dir === "UP" ? windowLow : windowHigh,
    end:   dir === "UP" ? windowHigh : windowLow,
    range: windowHigh - windowLow,
  };
}

// ── Compute Fibonacci entry levels ──────────────────────────────────────────

function computeFibLevels(impulse) {
  const range = Math.abs(impulse.end - impulse.start);
  let entry, sl, fibInvalid;

  if (impulse.dir === "UP") {
    entry      = impulse.end - range * CFG.fibEntry;
    sl         = impulse.start * (1 - CFG.slBufferPct);
    fibInvalid = impulse.end - range * CFG.fibInvalidate;
  } else {
    entry      = impulse.end + range * CFG.fibEntry;
    sl         = impulse.start * (1 + CFG.slBufferPct);
    fibInvalid = impulse.end + range * CFG.fibInvalidate;
  }

  const slDist = Math.abs(entry - sl);
  const tp = impulse.dir === "UP"
    ? entry + slDist * CFG.rrRatio
    : entry - slDist * CFG.rrRatio;

  return { entry, sl, tp, fibInvalid, slDist };
}

// ── Session filter — London-NY overlap ────────────────────────────────────

function inSession(ts) {
  const h = new Date(ts).getUTCHours();
  return h >= CFG.sessionStartH && h < CFG.sessionEndH;
}

// ── Week key ──
function weekKey(ts) {
  const d = new Date(ts);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThu = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstThuDayNr = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstThuDayNr + 3);
  return `${target.getUTCFullYear()}-W${String(1+Math.round((target-firstThu)/(7*86400000))).padStart(2,"0")}`;
}
function weekStartDate(wk) {
  const [yr, w] = wk.split("-W");
  const jan4 = new Date(Date.UTC(parseInt(yr), 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const w1Mon = new Date(jan4); w1Mon.setUTCDate(jan4.getUTCDate() - jan4Day);
  const monday = new Date(w1Mon); monday.setUTCDate(w1Mon.getUTCDate() + (parseInt(w)-1)*7);
  return monday.toISOString().slice(0,10);
}

// ── Simulator ──────────────────────────────────────────────────────────────

function simulate(indicators) {
  let balance = CFG.startBalance, peak = balance, maxDD = 0;
  const positions = [];
  const pending = [];
  const trades = [];
  let totalFees = 0;
  let stats = { signalsFired: 0, ordersPlaced: 0, ordersFilled: 0, ordersCancelled: 0, ordersExpired: 0, blocked_session: 0, blocked_trend: 0, blocked_maxpos: 0 };

  const tsMap = {};
  for (const sym of PAIRS) {
    const ind = indicators[sym]; if (!ind) continue;
    tsMap[sym] = new Map();
    for (let i = 0; i < ind.bars.length; i++) tsMap[sym].set(ind.bars[i].t, i);
  }

  const allTs = new Set();
  for (const sym of PAIRS) { const ind = indicators[sym]; if (!ind) continue; for (const b of ind.bars) if (b.t/1000 >= START) allTs.add(b.t); }
  const sortedTs = [...allTs].sort((a,b)=>a-b);

  for (const ts of sortedTs) {
    // ── 1. EXITS on filled positions ──────────────────────────────────────
    for (let p = positions.length-1; p >= 0; p--) {
      const pos = positions[p];
      const ind = indicators[pos.sym]; if (!ind) continue;
      const bi = tsMap[pos.sym].get(ts); if (bi === undefined) continue;
      const bar = ind.bars[bi];
      if (bar.t <= pos.fillTs) continue;
      const isL = pos.dir==="LONG"; const barsHeld = bi - pos.fillBarIdx;
      const hitSL = isL ? bar.l<=pos.sl : bar.h>=pos.sl;
      const hitTP = isL ? bar.h>=pos.tp : bar.l<=pos.tp;
      const timeExit = barsHeld >= CFG.maxHoldBars;
      let exitReason=null, exitPrice=null;
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
        trades.push({ sym: pos.sym, dir: pos.dir, gross: grossPnl, fee, net: netPnl, reason: exitReason, exitTs: ts });
        positions.splice(p, 1);
      }
    }

    // ── 2. Check pending limit orders ─────────────────────────────────────
    for (let q = pending.length-1; q >= 0; q--) {
      const p = pending[q];
      const ind = indicators[p.sym]; if (!ind) continue;
      const bi = tsMap[p.sym].get(ts); if (bi === undefined) continue;
      const bar = ind.bars[bi];
      if (bar.t <= p.signalTs) continue;

      // Check invalidation (price went past 0.786)
      const invalidated = p.dir === "LONG" ? bar.l <= p.fibInvalid : bar.h >= p.fibInvalid;
      if (invalidated) { pending.splice(q, 1); stats.ordersCancelled++; continue; }

      // Check fill
      const filled = p.dir === "LONG" ? bar.l <= p.entry : bar.h >= p.entry;
      if (filled) {
        positions.push({
          sym: p.sym, dir: p.dir,
          entry: p.entry, sl: p.sl, tp: p.tp,
          sizeUSD: p.sizeUSD, riskUSD: p.riskUSD,
          fillBarIdx: bi, fillTs: bar.t,
        });
        pending.splice(q, 1);
        stats.ordersFilled++;
        continue;
      }

      // Check expiry (24h since placed)
      const ageBars = bi - p.signalBarIdx;
      if (ageBars >= CFG.pendingMaxBars) { pending.splice(q, 1); stats.ordersExpired++; }
    }

    // ── 3. Look for new entries ───────────────────────────────────────────
    if (positions.length + pending.length >= CFG.maxPositions) { stats.blocked_maxpos++; continue; }
    if (!inSession(ts)) { stats.blocked_session++; continue; }

    for (const sym of PAIRS) {
      if (positions.some(p=>p.sym===sym)) continue;
      if (pending.some(p=>p.sym===sym)) continue;
      const ind = indicators[sym]; if (!ind) continue;
      const bi = tsMap[sym].get(ts); if (bi === undefined) continue;
      const bar = ind.bars[bi];

      // Detect impulse on this bar
      const imp = detectImpulse(ind.bars, bi);
      if (!imp) continue;

      // Higher-TF trend filter
      const htfTrend = lookup1HTrend(ind.trend, bar.t);
      if (imp.dir === "UP"   && htfTrend !== "UP")   { stats.blocked_trend++; continue; }
      if (imp.dir === "DOWN" && htfTrend !== "DOWN") { stats.blocked_trend++; continue; }

      // Compute fib levels
      const fib = computeFibLevels(imp);
      if (fib.slDist <= 0) continue;

      stats.signalsFired++;

      const riskUSD = balance * CFG.riskPct;
      const sizeUSD = (riskUSD / fib.slDist) * fib.entry;  // Option 1 sizing

      pending.push({
        sym, dir: imp.dir === "UP" ? "LONG" : "SHORT",
        entry: fib.entry, sl: fib.sl, tp: fib.tp,
        fibInvalid: fib.fibInvalid,
        sizeUSD, riskUSD,
        signalBarIdx: bi, signalTs: bar.t,
      });
      stats.ordersPlaced++;
      if (positions.length + pending.length >= CFG.maxPositions) break;
    }
  }

  // Force-close any open positions
  for (const pos of positions) {
    const ind = indicators[pos.sym]; if (!ind) continue;
    const lastBar = ind.bars[ind.bars.length-1];
    const isL = pos.dir==="LONG";
    const grossPnl = ((isL?lastBar.c-pos.entry:pos.entry-lastBar.c)/pos.entry) * pos.sizeUSD;
    const fee = pos.sizeUSD * FEE_PCT;
    const netPnl = grossPnl - fee;
    balance += netPnl; totalFees += fee;
    trades.push({ sym: pos.sym, dir: pos.dir, gross: grossPnl, fee, net: netPnl, reason: "OPEN@END", exitTs: lastBar.t });
  }

  const wins = trades.filter(t=>t.net>0); const losses = trades.filter(t=>t.net<0);
  const winRate = trades.length ? wins.length/trades.length*100 : 0;
  const netW = wins.reduce((s,t)=>s+t.net,0); const netL = Math.abs(losses.reduce((s,t)=>s+t.net,0));
  const pf = netL>0 ? netW/netL : (wins.length?Infinity:0);
  const ret = (balance - CFG.startBalance) / CFG.startBalance * 100;
  const avgWin = wins.length ? netW/wins.length : 0;
  const avgLoss = losses.length ? netL/losses.length : 0;
  const tpCount = trades.filter(t=>t.reason==="TP").length;
  const slCount = trades.filter(t=>t.reason==="SL").length;
  const timeCount = trades.filter(t=>t.reason==="TIME").length;
  return { balance, ret, maxDD, trades, totalFees, stats, winRate, pf, avgWin, avgLoss, tpCount, slCount, timeCount };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const startDate = new Date(START*1000).toISOString().slice(0,10);
  const endDate = new Date().toISOString().slice(0,10);

  console.log("╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  THE GOLDEN POCKET — Fibonacci retracement strategy                ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`  Period:    ${startDate} → ${endDate}  (${DAYS} days)`);
  console.log(`  Universe:  ${PAIRS.length} mid/high-vol crypto pairs`);
  console.log(`  Capital:   $${CFG.startBalance.toLocaleString()}`);
  console.log(`  Logic:     Impulse ≥${CFG.impulseMinPct*100}% over ${CFG.impulseLookback} bars → break ${CFG.structureLookback}-bar structure`);
  console.log(`             → LIMIT order at ${CFG.fibEntry*100}% fib retrace → SL beyond 1.0 → TP at 1:${CFG.rrRatio}`);
  console.log(`  Session:   ${CFG.sessionStartH}:00-${CFG.sessionEndH}:00 UTC (London-NY overlap)`);
  console.log(`  HTF trend: 1H EMA${CFG.htfEMAfast} vs EMA${CFG.htfEMAslow} must align with impulse direction`);
  console.log(`  Risk:      ${(CFG.riskPct*100).toFixed(1)}% per trade | Max ${CFG.maxPositions} concurrent`);

  console.log(`\n[1/1] Fetching 15min data for ${PAIRS.length} pairs…`);
  const data = {};
  let fetched = 0;
  for (const sym of PAIRS) {
    process.stdout.write(`  [${++fetched}/${PAIRS.length}] ${sym}…`);
    data[sym] = await fetchAllBars(sym, "Min15", 15*60, START - 21*86400, NOW_SEC);
    process.stdout.write(`\r  [${fetched}/${PAIRS.length}] ${sym.padEnd(20)} ${String(data[sym].length).padStart(6)} bars ✓\n`);
    await sleep(130);
  }

  console.log("\n  Computing indicators + 1H trend…");
  const ind = {};
  for (const sym of PAIRS) {
    const bars = data[sym]; if (bars.length < 200) continue;
    const closes = bars.map(b=>b.c), vols=bars.map(b=>b.v);
    ind[sym] = { bars, closes, vols, trend: build1HTrend(bars) };
  }

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Running simulation…");
  console.log("══════════════════════════════════════════════════════════════");
  const r = simulate(ind);
  console.log(`  Done: $${r.balance.toFixed(0)} | ${r.trades.length} trades fired`);

  // Report
  console.log("\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║  RESULTS                                                            ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log(`\n  Start:        $${CFG.startBalance.toLocaleString()}`);
  console.log(`  End balance:  $${r.balance.toFixed(0)}`);
  console.log(`  Return:       ${r.ret>=0?'+':''}${r.ret.toFixed(1)}%`);
  console.log(`  Max DD:       ${r.maxDD.toFixed(1)}%`);
  console.log(`  Annualized:   ~${(r.ret*2).toFixed(0)}%`);
  console.log(`  Weekly avg:   ${(r.ret/26).toFixed(2)}%`);
  console.log(`  Daily avg:    ${(r.ret/180).toFixed(3)}%`);

  console.log(`\n  ── Order flow ──`);
  console.log(`  Signals fired:       ${r.stats.signalsFired}`);
  console.log(`  Orders placed:       ${r.stats.ordersPlaced}`);
  console.log(`  Orders filled:       ${r.stats.ordersFilled}  (${r.stats.ordersPlaced>0?(r.stats.ordersFilled/r.stats.ordersPlaced*100).toFixed(0):'—'}% fill rate)`);
  console.log(`  Orders cancelled:    ${r.stats.ordersCancelled}  (price went past 0.786 invalidation)`);
  console.log(`  Orders expired:      ${r.stats.ordersExpired}  (24h timeout, no fill)`);
  console.log(`  Blocked: session ${r.stats.blocked_session}, trend ${r.stats.blocked_trend}, maxpos ${r.stats.blocked_maxpos}`);

  console.log(`\n  ── Trade stats ──`);
  const wins = r.trades.filter(t=>t.net>0).length;
  const losses = r.trades.filter(t=>t.net<0).length;
  console.log(`  Total trades:     ${r.trades.length}  (W:${wins} / L:${losses})`);
  console.log(`  Win rate:         ${r.winRate.toFixed(1)}%  (video claimed 60-70%)`);
  console.log(`  Avg win:          +$${r.avgWin.toFixed(2)}`);
  console.log(`  Avg loss:         -$${r.avgLoss.toFixed(2)}`);
  console.log(`  Profit factor:    ${r.pf===Infinity?'∞':r.pf.toFixed(2)}`);
  console.log(`  Exit breakdown:   TP ${r.tpCount} / SL ${r.slCount} / TIME ${r.timeCount}`);
  console.log(`  Total fees:       $${r.totalFees.toFixed(0)}`);

  console.log(`\n  ── Per-pair P&L ──`);
  const byPair = {};
  for (const t of r.trades) { if (!byPair[t.sym]) byPair[t.sym]={pnl:0,trades:0,wins:0}; byPair[t.sym].pnl+=t.net; byPair[t.sym].trades++; if (t.net>0) byPair[t.sym].wins++; }
  const sorted = Object.entries(byPair).sort((a,b)=>b[1].pnl-a[1].pnl);
  for (const [sym, s] of sorted) {
    const wr = s.trades>0 ? (s.wins/s.trades*100).toFixed(0)+'%' : '—';
    const flag = s.pnl>0 ? '✅' : '❌';
    console.log(`     ${flag} ${sym.padEnd(18)} ${(s.pnl>=0?'+':'')}$${s.pnl.toFixed(2).padStart(8)}  ${String(s.trades).padStart(4)} trades, ${wr.padStart(4)} WR`);
  }

  console.log(`\n  ── Week-by-week P&L ──`);
  const byWeek = {};
  for (const t of r.trades) { const wk = weekKey(t.exitTs); if (!byWeek[wk]) byWeek[wk] = { net: 0, trades: 0 }; byWeek[wk].net += t.net; byWeek[wk].trades++; }
  const wks = Object.keys(byWeek).sort();
  let cum = 0;
  console.log(`  ${"Week".padEnd(12)} ${"Date".padEnd(12)} ${"Trades".padStart(7)} ${"Net P&L".padStart(11)} ${"Cum.".padStart(11)} ${"%/Wk".padStart(8)}`);
  console.log(`  ${"─".repeat(12)} ${"─".repeat(12)} ${"─".repeat(7)} ${"─".repeat(11)} ${"─".repeat(11)} ${"─".repeat(8)}`);
  for (const wk of wks) {
    const w = byWeek[wk];
    cum += w.net;
    const pctWk = (w.net / CFG.startBalance) * 100;
    console.log(`  ${wk.padEnd(12)} ${weekStartDate(wk).padEnd(12)} ${String(w.trades).padStart(7)} ${((w.net>=0?'+':'')+'$'+w.net.toFixed(0)).padStart(11)} ${((cum>=0?'+':'')+'$'+cum.toFixed(0)).padStart(11)} ${(pctWk.toFixed(1)+'%').padStart(8)}`);
  }
  if (wks.length > 0) {
    const wkPnls = wks.map(w => byWeek[w].net);
    const winWks = wkPnls.filter(n=>n>0).length;
    console.log(`\n  Weekly win rate: ${winWks}/${wks.length} (${(winWks/wks.length*100).toFixed(0)}%)`);
    console.log(`  Best week:       ${(Math.max(...wkPnls)>=0?'+':'')}$${Math.max(...wkPnls).toFixed(0)}`);
    console.log(`  Worst week:      ${(Math.min(...wkPnls)>=0?'+':'')}$${Math.min(...wkPnls).toFixed(0)}`);
    console.log(`  Avg per week:    ${(cum/wks.length>=0?'+':'')}$${(cum/wks.length).toFixed(0)}`);
  }

  // Verdict
  console.log(`\n  📋 VERDICT:`);
  const wkPct = r.ret / 26;
  if (r.pf > 1.5 && r.maxDD < 12 && wkPct > 1.5) {
    console.log(`     ✅ EXCELLENT — PF ${r.pf.toFixed(2)}, ${wkPct.toFixed(1)}%/wk, ${r.maxDD.toFixed(1)}% DD`);
    console.log(`     This is the strategy we've been looking for. Deploy alongside v09 + DT.`);
  } else if (r.pf > 1.2 && r.maxDD < 18 && wkPct > 0.7) {
    console.log(`     ✅ GOOD — PF ${r.pf.toFixed(2)}, ${wkPct.toFixed(1)}%/wk, ${r.maxDD.toFixed(1)}% DD`);
    console.log(`     Solid third strategy candidate. Worth paper testing.`);
  } else if (r.pf > 1.0 && r.maxDD < 20) {
    console.log(`     ⚠️  MARGINAL — PF ${r.pf.toFixed(2)}, ${wkPct.toFixed(1)}%/wk`);
    console.log(`     Profitable but doesn't dramatically improve portfolio.`);
  } else {
    console.log(`     ❌ WEAK — PF ${r.pf.toFixed(2)}, ${wkPct.toFixed(1)}%/wk`);
    console.log(`     Strategy as-coded doesn't deliver the Fibonacci video's claims.`);
  }

  const mins = ((Date.now()-t0)/60000).toFixed(1);
  console.log(`\n  Backtest time: ${mins} min\n`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
