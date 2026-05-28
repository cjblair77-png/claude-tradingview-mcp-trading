/**
 * bot_golden_pocket.js — "The Golden Pocket" Fibonacci Retracement Bot
 *
 * Strategy:
 *   1. Detect impulse moves on 15min: ≥2.5% over 6 bars + break of 20-bar structure
 *   2. Confirm direction via 1H EMA21/EMA50 trend filter
 *   3. Place LIMIT order at 0.618 Fib retracement (golden pocket)
 *   4. SL just beyond 1.0 retracement (impulse start ± 0.5% buffer)
 *   5. TP at 1:1.6 R:R
 *   6. Cancel pending if price retraces beyond 0.786 OR 24h pass without fill
 *   7. Force-close position after 48h
 *   8. Only enter during London-NY overlap (13:00-18:00 UTC)
 *
 * Universe: 7 walk-forward-validated mid/high-vol crypto pairs
 *
 * Run: every 15 minutes via cron
 * Cron: every 15 minutes  (0,15,30,45 * * * *)
 *
 * State: paper_account_golden_pocket.json (mirrored to GitHub Gist)
 * Logs:  trades_golden_pocket.csv
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import crypto from "crypto";

// ─── Config ───────────────────────────────────────────────────────────────────

// 7 walk-forward-validated pairs (4/4 = ALL-WEATHER, 3/4 = RELIABLE)
const PAIRS = [
  "RUNE_USDT",      // 🟢 All-weather (+$1,387 in 12mo walk-forward)
  "AR_USDT",        // 🟢 All-weather (+$443)
  "ENA_USDT",       // 🟢 All-weather (+$425)
  "TIA_USDT",       // 🟡 Reliable 3/4 (+$1,200)
  "SUI_USDT",       // 🟡 Reliable 3/4 (+$1,186)
  "AIXBT_USDT",     // 🟡 Reliable 3/4 (+$332)
  "KAIA_USDT",      // 🟡 Reliable 3/4 (+$106)
];

const CFG = {
  paperTrading:    process.env.PAPER_TRADING !== "false",
  portfolioUSD:    parseFloat(process.env.GP_PORTFOLIO_USD || "8750"),
  riskPct:         parseFloat(process.env.GP_RISK_PCT      || "0.005"),  // 0.5%
  leverage:        parseFloat(process.env.GP_LEVERAGE      || "5"),
  maxPositions:    4,
  maxHoldBars:     192,        // 48h on 15min
  pendingMaxBars:  96,         // 24h pending timeout
  rrRatio:         1.6,        // 1:1.6 R:R
  // Impulse detection
  impulseLookback:    6,       // 6 × 15min = 1.5h window
  impulseMinPct:      0.025,   // 2.5% minimum range
  structureLookback:  20,      // break of prior 20-bar structure
  // Fib levels
  fibEntry:           0.618,
  fibInvalidate:      0.786,
  slBufferPct:        0.005,   // 0.5% beyond impulse start
  // Session filter (London-NY overlap)
  sessionStartH:      13,
  sessionEndH:        18,
  // Higher timeframe trend
  htfEMAfast:         21,
  htfEMAslow:         50,
  // Data
  interval:           "Min15",
  candleLimit:        200,
  ntfyTopic:          process.env.GP_NTFY_TOPIC || "hermes-goldenpocket",
  summaryTopic:       process.env.SUMMARY_NTFY_TOPIC || "hermes-summary",
  summaryIntervalHrs: parseFloat(process.env.SUMMARY_INTERVAL_HRS || "2"),
  mexc: {
    apiKey:    process.env.MEXC_API_KEY,
    secretKey: process.env.MEXC_SECRET_KEY,
    baseUrl:   "https://futures.mexc.com",
  },
};

const DATA_DIR     = process.env.RAILWAY_ENVIRONMENT ? "/data" : ".";
if (process.env.RAILWAY_ENVIRONMENT) mkdirSync(DATA_DIR, { recursive: true });
const ACCOUNT_FILE = `${DATA_DIR}/paper_account_golden_pocket.json`;
const CSV_FILE     = `${DATA_DIR}/trades_golden_pocket.csv`;
const CSV_HEADERS  = "Date,Time(UTC),Symbol,Direction,Entry,SL,TP,RiskUSD,SizeUSD,FibInvalid,P&L,ExitReason,OrderType\n";

const GIST_ID      = process.env.GITHUB_GIST_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GIST_FILE    = "paper_account_golden_pocket.json";

// ─── Gist helpers ─────────────────────────────────────────────────────────────

async function loadFromGist() {
  if (!GIST_ID || !GITHUB_TOKEN) return null;
  try {
    const res  = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
      signal:  AbortSignal.timeout(10000),
    });
    const data = await res.json();
    const file = data.files?.[GIST_FILE];
    if (!file) return null;
    return JSON.parse(file.content);
  } catch { return null; }
}

async function saveToGist(acc) {
  if (!GIST_ID || !GITHUB_TOKEN) return;
  try {
    await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: "PATCH",
      headers: { Authorization: `token ${GITHUB_TOKEN}`, "Content-Type": "application/json", Accept: "application/vnd.github+json" },
      body:   JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(acc, null, 2) } } }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) { console.warn("  [Gist] save failed:", e.message); }
}

// ─── Account ──────────────────────────────────────────────────────────────────

async function loadAccount() {
  const gist = await loadFromGist();
  if (gist) {
    console.log("  [state] loaded from Gist");
    if (!gist.pendingPositions) gist.pendingPositions = [];
    if (!gist.positions) gist.positions = [];
    if (!gist.trades) gist.trades = [];
    if (!gist.lastBarTime) gist.lastBarTime = {};
    return gist;
  }
  if (existsSync(ACCOUNT_FILE)) {
    const a = JSON.parse(readFileSync(ACCOUNT_FILE, "utf8"));
    if (!a.pendingPositions) a.pendingPositions = [];
    return a;
  }
  return {
    balance:          CFG.portfolioUSD,
    peak:             CFG.portfolioUSD,
    positions:        [],
    pendingPositions: [],
    trades:           [],
    lastBarTime:      {},
    lastRun:          null,
  };
}

async function saveAccount(acc) {
  acc.lastRun = new Date().toISOString();
  writeFileSync(ACCOUNT_FILE, JSON.stringify(acc, null, 2));
  await saveToGist(acc);
}

// ─── Notifications ────────────────────────────────────────────────────────────

async function notify(msg) {
  if (!CFG.ntfyTopic) return;
  try {
    await fetch(`https://ntfy.sh/${CFG.ntfyTopic}`, {
      method: "POST", headers: { "Content-Type": "text/plain" }, body: msg,
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* silent */ }
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

function csvLog(trade) {
  if (!existsSync(CSV_FILE)) appendFileSync(CSV_FILE, CSV_HEADERS);
  const d = new Date(trade.exitTime || Date.now());
  const row = [
    d.toISOString().slice(0, 10),
    d.toISOString().slice(11, 19),
    trade.symbol, trade.direction,
    trade.entry.toFixed(6), trade.sl.toFixed(6), trade.tp.toFixed(6),
    trade.riskUSD.toFixed(2), trade.sizeUSD.toFixed(2),
    trade.fibInvalid?.toFixed(6) ?? "",
    trade.pnl.toFixed(2),
    trade.exitReason,
    trade.orderType || "MAKER",
  ].join(",");
  appendFileSync(CSV_FILE, row + "\n");
}

// ─── MEXC Data Fetch ──────────────────────────────────────────────────────────

async function fetchKlines(symbol, intervalStr, limit) {
  const barSecs  = 15 * 60;
  const nowSec   = Math.floor(Date.now() / 1000);
  const startSec = nowSec - (limit + 5) * barSecs;
  const url = `${CFG.mexc.baseUrl}/api/v1/contract/kline/${symbol}?interval=${intervalStr}&start=${startSec}&end=${nowSec}`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol}`);
  const json = await res.json();
  if (!json.data?.time?.length) throw new Error(`No kline data for ${symbol}`);
  const { time, open, close, high, low, vol } = json.data;
  return time.map((t, i) => ({
    time: t*1000, open: +open[i], high: +high[i], low: +low[i], close: +close[i], volume: +vol[i],
    isClosed: (t + barSecs)*1000 < Date.now(),
  })).sort((a,b)=>a.time-b.time);
}

// Fetch 1H bars for trend filter (need 60+ bars for EMA50)
async function fetch1HKlines(symbol, limit = 80) {
  const barSecs = 3600;
  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = nowSec - (limit + 5) * barSecs;
  const url = `${CFG.mexc.baseUrl}/api/v1/contract/kline/${symbol}?interval=Min60&start=${startSec}&end=${nowSec}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol} 1H`);
  const json = await res.json();
  if (!json.data?.time?.length) throw new Error(`No 1H kline data for ${symbol}`);
  const { time, close } = json.data;
  return time.map((t, i) => ({ time: t*1000, close: +close[i] })).sort((a,b)=>a.time-b.time);
}

// ─── MEXC Orders ──────────────────────────────────────────────────────────────

function signMexc(timestamp, body) {
  const msg = CFG.mexc.apiKey + timestamp + body;
  return crypto.createHmac("sha256", CFG.mexc.secretKey).update(msg).digest("hex");
}

// Post-only limit order — guaranteed MAKER (0% fee on MEXC futures)
async function placeMexcLimitOrder(symbol, side, vol, price) {
  const timestamp = Date.now().toString();
  const bodyObj = { symbol, side, openType: 1, type: 2, vol, price, leverage: CFG.leverage };
  const bodyStr = JSON.stringify(bodyObj);
  const sig = signMexc(timestamp, bodyStr);
  const res = await fetch(`${CFG.mexc.baseUrl}/api/v1/private/order/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "ApiKey": CFG.mexc.apiKey, "Request-Time": timestamp, "Signature": sig },
    body: bodyStr, signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  if (!data.success) throw new Error(`MEXC limit order error: ${data.message || JSON.stringify(data)}`);
  return data.data;
}

async function cancelMexcOrder(orderId) {
  const timestamp = Date.now().toString();
  const bodyStr = JSON.stringify([orderId]);
  const sig = signMexc(timestamp, bodyStr);
  const res = await fetch(`${CFG.mexc.baseUrl}/api/v1/private/order/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "ApiKey": CFG.mexc.apiKey, "Request-Time": timestamp, "Signature": sig },
    body: bodyStr, signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  return data.success;
}

// ─── Indicators ──────────────────────────────────────────────────────────────

function ema(values, period) {
  const k = 2/(period+1), out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i]*k + out[i-1]*(1-k));
  return out;
}

// 1H trend: returns "UP" / "DOWN" / "NEUTRAL"
function get1HTrend(closes1H) {
  if (closes1H.length < CFG.htfEMAslow + 1) return "NEUTRAL";
  const e21 = ema(closes1H, CFG.htfEMAfast);
  const e50 = ema(closes1H, CFG.htfEMAslow);
  const i = closes1H.length - 1;
  if (e21[i] > e50[i]) return "UP";
  if (e21[i] < e50[i]) return "DOWN";
  return "NEUTRAL";
}

// ─── Session filter ──────────────────────────────────────────────────────────

function inSession() {
  const h = new Date().getUTCHours();
  return h >= CFG.sessionStartH && h < CFG.sessionEndH;
}

// ─── Impulse detection ──────────────────────────────────────────────────────

function detectImpulse(bars) {
  const n = bars.length;
  const i = n - 2;  // last CLOSED bar
  if (i < CFG.impulseLookback + CFG.structureLookback) return null;

  const window = bars.slice(i - CFG.impulseLookback + 1, i + 1);
  const wH = Math.max(...window.map(b => b.high));
  const wL = Math.min(...window.map(b => b.low));
  if ((wH - wL) / wL < CFG.impulseMinPct) return null;

  // Direction = whichever extreme came last in window
  let highIdx = 0, lowIdx = 0, hv = window[0].high, lv = window[0].low;
  for (let j = 1; j < window.length; j++) {
    if (window[j].high > hv) { hv = window[j].high; highIdx = j; }
    if (window[j].low < lv)  { lv = window[j].low;  lowIdx = j; }
  }
  const dir = highIdx > lowIdx ? "UP" : "DOWN";

  // Confirm structure break
  const priorStart = Math.max(0, i - CFG.impulseLookback - CFG.structureLookback);
  const priorBars = bars.slice(priorStart, i - CFG.impulseLookback + 1);
  if (priorBars.length === 0) return null;
  const priorHigh = Math.max(...priorBars.map(b => b.high));
  const priorLow  = Math.min(...priorBars.map(b => b.low));
  if (dir === "UP"   && wH <= priorHigh) return null;
  if (dir === "DOWN" && wL >= priorLow) return null;

  return {
    dir,
    start: dir === "UP" ? wL : wH,
    end:   dir === "UP" ? wH : wL,
    range: Math.abs(wH - wL),
    barTime: bars[i].time,
  };
}

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
  const tp = impulse.dir === "UP" ? entry + slDist * CFG.rrRatio : entry - slDist * CFG.rrRatio;
  return { entry, sl, tp, fibInvalid, slDist };
}

// ─── Check pending limit orders ──────────────────────────────────────────────

async function checkPendingFills(acc) {
  if (!acc.pendingPositions?.length) return;

  for (let p = acc.pendingPositions.length-1; p >= 0; p--) {
    const pending = acc.pendingPositions[p];
    const ageMs = Date.now() - pending.placedAt;
    const ageBars = Math.floor(ageMs / (15 * 60 * 1000));

    let candles;
    try { candles = await fetchKlines(pending.symbol, CFG.interval, Math.max(ageBars + 2, 4)); }
    catch (e) { console.warn(`  [pending] fetch failed for ${pending.symbol}: ${e.message}`); continue; }

    const sincePlaced = candles.filter(c => c.isClosed && c.time > pending.placedAt);

    // Check invalidation FIRST (price went past 0.786)
    const isLong = pending.direction === "LONG";
    let invalidated = false, fillBar = null;
    for (const bar of sincePlaced) {
      const isInvalid = isLong ? bar.low <= pending.fibInvalid : bar.high >= pending.fibInvalid;
      if (isInvalid) { invalidated = true; break; }
      const filled = isLong ? bar.low <= pending.limitPrice : bar.high >= pending.limitPrice;
      if (filled) { fillBar = bar; break; }
    }

    if (invalidated) {
      console.log(`  ❌ INVALIDATED ${pending.direction} ${pending.symbol} — price retraced past 0.786 (${pending.fibInvalid.toFixed(4)})`);
      if (!CFG.paperTrading && pending.orderId) {
        try { await cancelMexcOrder(pending.orderId); } catch {}
      }
      acc.pendingPositions.splice(p, 1);
      continue;
    }

    if (fillBar) {
      const pos = {
        symbol:     pending.symbol,
        direction:  pending.direction,
        entry:      pending.limitPrice,
        sl:         pending.sl,
        tp:         pending.tp,
        sizeUSD:    pending.sizeUSD,
        riskUSD:    pending.riskUSD,
        entryTime:  fillBar.time,
        orderType:  "MAKER",
      };
      acc.positions.push(pos);
      acc.pendingPositions.splice(p, 1);
      console.log(`  ✅ FILLED ${pending.direction} ${pending.symbol} @ $${pending.limitPrice.toFixed(4)} [MAKER · 0% fee]`);
      const dir = pending.direction === "LONG" ? "📈" : "📉";
      await notify(
        `${dir} GP ${pending.symbol} ${pending.direction} FILLED\n` +
        `Entry: $${pending.limitPrice.toFixed(4)}  SL: $${pending.sl.toFixed(4)}  TP: $${pending.tp.toFixed(4)}\n` +
        `Risk: $${pending.riskUSD.toFixed(2)}  Fee: $0 (maker)`
      );
      continue;
    }

    if (ageBars >= CFG.pendingMaxBars) {
      console.log(`  ⏰ EXPIRED ${pending.direction} ${pending.symbol} — 24h timeout, unfilled`);
      if (!CFG.paperTrading && pending.orderId) {
        try { await cancelMexcOrder(pending.orderId); } catch {}
      }
      acc.pendingPositions.splice(p, 1);
    } else {
      console.log(`  ⏳ PENDING ${pending.direction} ${pending.symbol} @ $${pending.limitPrice.toFixed(4)} (${ageBars}/${CFG.pendingMaxBars} bars)`);
    }
  }
}

// ─── Check exits on open positions ──────────────────────────────────────────

async function checkExits(acc) {
  for (let p = acc.positions.length-1; p >= 0; p--) {
    const pos = acc.positions[p];
    let candles;
    try { candles = await fetchKlines(pos.symbol, CFG.interval, 3); }
    catch (e) { console.warn(`  [exit] fetch failed for ${pos.symbol}: ${e.message}`); continue; }

    const closed = candles.filter(c => c.isClosed);
    if (closed.length === 0) continue;
    const c = closed[closed.length-1];

    const isLong = pos.direction === "LONG";
    const hitSL = isLong ? c.low <= pos.sl : c.high >= pos.sl;
    const hitTP = isLong ? c.high >= pos.tp : c.low <= pos.tp;
    const barsHeld = Math.round((c.time - pos.entryTime) / (15 * 60 * 1000));
    const timeExit = barsHeld >= CFG.maxHoldBars;

    let exitReason = null, exitPrice = null;
    if (hitSL && hitTP) { exitReason = "SL"; exitPrice = pos.sl; }
    else if (hitSL)     { exitReason = "SL"; exitPrice = pos.sl; }
    else if (hitTP)     { exitReason = "TP"; exitPrice = pos.tp; }
    else if (timeExit)  { exitReason = "TIME"; exitPrice = c.close; }

    if (!exitReason) continue;

    const priceDiff = isLong ? exitPrice - pos.entry : pos.entry - exitPrice;
    const gross     = (priceDiff / pos.entry) * pos.sizeUSD;
    // Net of fees: GP uses maker (limit) orders = 0% on MEXC. Taker fallback = 0.04% round-trip.
    const fee       = pos.orderType === "TAKER" ? pos.sizeUSD * 0.0004 : 0;
    const pnl       = gross - fee;
    acc.balance += pnl;
    if (acc.balance > acc.peak) acc.peak = acc.balance;

    const trade = {
      symbol: pos.symbol, direction: pos.direction,
      entry: pos.entry, exit: exitPrice, sl: pos.sl, tp: pos.tp,
      riskUSD: pos.riskUSD, sizeUSD: pos.sizeUSD,
      gross: Math.round(gross * 100) / 100, fee: Math.round(fee * 100) / 100,
      pnl: Math.round(pnl * 100) / 100,
      exitReason, entryTime: pos.entryTime, exitTime: Date.now(),
      orderType: pos.orderType,
    };
    acc.trades.push(trade);
    acc.positions.splice(p, 1);
    csvLog(trade);

    const sign = pnl >= 0 ? "✅" : "❌";
    console.log(`  ${sign} EXIT ${pos.symbol} ${pos.direction}  ${exitReason}  P&L: $${pnl.toFixed(2)}`);

    const totPnl = acc.trades.reduce((s, t) => s + (t.pnl || 0), 0);
    await notify(
      `${sign} GP ${pos.symbol} ${pos.direction} — ${exitReason}\n` +
      `P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}  |  Balance: $${acc.balance.toFixed(2)}\n` +
      `Entry: $${pos.entry}  →  Exit: $${exitPrice.toFixed(4)}\n` +
      `Total P&L: ${totPnl >= 0 ? "+" : ""}$${totPnl.toFixed(2)}  |  Trades: ${acc.trades.length}`
    );
  }
}

// ─── Check for new entries ──────────────────────────────────────────────────

async function checkEntries(acc) {
  if (!acc.pendingPositions) acc.pendingPositions = [];
  if (acc.positions.length + acc.pendingPositions.length >= CFG.maxPositions) {
    console.log(`  ℹ️  At max positions (${CFG.maxPositions})`);
    return;
  }
  if (!inSession()) {
    const h = new Date().getUTCHours();
    console.log(`  💤 Outside session (now ${h}:00 UTC, active ${CFG.sessionStartH}-${CFG.sessionEndH})`);
    return;
  }

  for (const symbol of PAIRS) {
    if (acc.positions.some(p => p.symbol === symbol)) continue;
    if (acc.pendingPositions.some(p => p.symbol === symbol)) continue;
    if (acc.positions.length + acc.pendingPositions.length >= CFG.maxPositions) break;

    // Fetch data
    let candles, candles1H;
    try {
      candles   = await fetchKlines(symbol, CFG.interval, CFG.candleLimit);
      candles1H = await fetch1HKlines(symbol, 80);
    } catch (e) {
      console.warn(`  [entry] fetch failed for ${symbol}: ${e.message}`);
      continue;
    }

    // Detect impulse on last closed bar
    const closedBars = candles.filter(c => c.isClosed);
    if (closedBars.length < 30) continue;
    const imp = detectImpulse(closedBars);
    if (!imp) continue;

    // Dedup — only act once per impulse bar
    const lastBar = acc.lastBarTime?.[symbol] || 0;
    if (imp.barTime <= lastBar) continue;

    // 1H trend filter
    const trend = get1HTrend(candles1H.map(c => c.close));
    if (imp.dir === "UP"   && trend !== "UP")   { continue; }
    if (imp.dir === "DOWN" && trend !== "DOWN") { continue; }

    // Compute fib levels
    const fib = computeFibLevels(imp);
    if (fib.slDist <= 0) continue;

    const riskUSD  = acc.balance * CFG.riskPct;
    const sizeUSD  = (riskUSD / fib.slDist) * fib.entry;
    const direction = imp.dir === "UP" ? "LONG" : "SHORT";

    const pending = {
      symbol, direction,
      limitPrice: Math.round(fib.entry * 1e6) / 1e6,
      sl:         Math.round(fib.sl * 1e6) / 1e6,
      tp:         Math.round(fib.tp * 1e6) / 1e6,
      fibInvalid: Math.round(fib.fibInvalid * 1e6) / 1e6,
      sizeUSD:    Math.round(sizeUSD * 100) / 100,
      riskUSD:    Math.round(riskUSD * 100) / 100,
      barTime:    imp.barTime,
      placedAt:   Date.now(),
      orderId:    null,
    };

    const dir = direction === "LONG" ? "📈" : "📉";
    console.log(
      `  ${dir} IMPULSE ${symbol} ${direction} (${imp.dir} trend, 1H ${trend})\n` +
      `     Range: ${(imp.range / Math.min(imp.start, imp.end) * 100).toFixed(1)}%\n` +
      `     LIMIT @ $${pending.limitPrice} (0.618 fib)\n` +
      `     SL $${pending.sl} (beyond 1.0) | TP $${pending.tp} (1:${CFG.rrRatio}) | Invalid @ $${pending.fibInvalid}\n` +
      `     Risk $${riskUSD.toFixed(2)} | Size $${sizeUSD.toFixed(2)}`
    );

    // Live order
    if (!CFG.paperTrading && CFG.mexc.apiKey) {
      try {
        const mexcSide = direction === "LONG" ? 1 : 3;
        const orderData = await placeMexcLimitOrder(symbol, mexcSide, 1, pending.limitPrice);
        pending.orderId = orderData?.orderId;
        console.log(`     🔴 LIVE LIMIT order: ${orderData?.orderId || "no ID"}`);
      } catch (e) {
        console.log(`     ⚠️  Live order failed: ${e.message} — skipping`);
        continue;
      }
    }

    acc.pendingPositions.push(pending);
    acc.lastBarTime[symbol] = imp.barTime;

    await notify(
      `${dir} GP ${symbol} ${direction} LIMIT PLACED\n` +
      `Impulse ${(imp.range / Math.min(imp.start, imp.end) * 100).toFixed(1)}% (1H trend ${trend})\n` +
      `Limit: $${pending.limitPrice} (0.618 fib)\n` +
      `SL $${pending.sl}  |  TP $${pending.tp}  |  R:R 1:${CFG.rrRatio}\n` +
      `Timeout: 24h | Risk $${riskUSD.toFixed(2)} | Fee if filled: $0 (maker)`
    );
  }
}

// ─── Portfolio Summary (every N hours) ─────────────────────────────────────
// Loads all 3 strategy accounts from the Gist and pushes a P&L summary to
// your phone. Throttled by acc.lastSummary timestamp.

async function fetchGistFile(filename) {
  if (!GIST_ID || !GITHUB_TOKEN) return null;
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    const file = data.files?.[filename];
    if (!file) return null;
    return JSON.parse(file.content);
  } catch { return null; }
}

async function sendPortfolioSummary() {
  const v09 = await fetchGistFile("paper_account_v09.json");
  const dt  = await fetchGistFile("paper_daytrading_v01.json");
  const gp  = await fetchGistFile("paper_account_golden_pocket.json");

  const fmt$ = n => (n >= 0 ? "+" : "") + "$" + Math.abs(n).toFixed(2);

  function summarize(name, acc, defaultStart) {
    if (!acc) return `\n${name}: (no data)`;
    const start = acc.startBalance ?? defaultStart;
    const bal = acc.balance ?? start;
    const realized = bal - start;
    const realizedPct = start > 0 ? (realized / start * 100) : 0;
    const positions = acc.openPositions || acc.positions || [];
    const pending = acc.pendingPositions || [];
    const trades = acc.closedTrades || acc.trades || [];
    const wins = trades.filter(t => (t.pnl || 0) > 0).length;
    const wr = trades.length ? Math.round(wins / trades.length * 100) : "—";
    return `\n${name}: $${bal.toFixed(0)} (${realizedPct >= 0 ? '+' : ''}${realizedPct.toFixed(1)}%) · ${trades.length}t ${wr}%WR · ${positions.length}open ${pending.length}pend`;
  }

  function openList(name, acc) {
    if (!acc) return "";
    const positions = acc.openPositions || acc.positions || [];
    if (!positions.length) return "";
    let s = `\n\n${name} open:`;
    for (const p of positions) {
      const sym = (p.symbol || "").replace("_USDT", "").replace("USDT", "");
      const entry = p.entryPrice || p.entry;
      s += `\n  ${p.direction === "LONG" ? "▲" : "▼"} ${sym} @$${entry?.toFixed(4)} (SL $${p.sl?.toFixed(4)} / TP $${p.tp?.toFixed(4)})`;
    }
    return s;
  }

  const v09Bal = v09?.balance ?? 13750;
  const dtBal  = dt?.balance  ?? 2500;
  const gpBal  = gp?.balance  ?? CFG.portfolioUSD;
  const v09Start = v09?.startBalance ?? 13750;
  const dtStart  = dt?.startBalance  ?? 2500;
  const gpStart  = gp?.startBalance  ?? CFG.portfolioUSD;
  const totalStart = v09Start + dtStart + gpStart;
  const totalBal = v09Bal + dtBal + gpBal;
  const totalPnL = totalBal - totalStart;
  const totalPct = totalStart > 0 ? (totalPnL / totalStart * 100) : 0;

  let body = `Portfolio: $${totalBal.toFixed(0)} (${fmt$(totalPnL)}, ${totalPct >= 0 ? "+" : ""}${totalPct.toFixed(2)}%)`;
  body += summarize("v09", v09, 13750);
  body += summarize("DT", dt, 2500);
  body += summarize("GP", gp, CFG.portfolioUSD);
  body += openList("v09", v09);
  body += openList("DT", dt);
  body += openList("GP", gp);

  try {
    await fetch(`https://ntfy.sh/${CFG.summaryTopic}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "Title": CFG.summaryIntervalHrs + "h Portfolio Summary" },
      body, signal: AbortSignal.timeout(8000),
    });
    console.log(`  📊 Sent ${CFG.summaryIntervalHrs}h summary to ntfy/${CFG.summaryTopic}`);
  } catch (e) {
    console.log(`  ⚠️  Summary push failed: ${e.message}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const start = Date.now();
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`\n[GOLDEN POCKET] ${ts} UTC  |  ${CFG.paperTrading ? "📋 PAPER" : "🔴 LIVE"}`);

  const acc = await loadAccount();
  const dd  = ((acc.peak - acc.balance) / acc.peak * 100).toFixed(1);
  const pendCount = acc.pendingPositions?.length || 0;
  console.log(
    `  Balance: $${acc.balance.toFixed(2)}  Peak: $${acc.peak.toFixed(2)}  DD: ${dd}%\n` +
    `  Positions: ${acc.positions.length} filled + ${pendCount} pending / ${CFG.maxPositions}  |  Risk: ${(CFG.riskPct*100).toFixed(2)}% per trade  |  R:R 1:${CFG.rrRatio}`
  );

  // 1. Check pending limit orders for fills
  await checkPendingFills(acc);
  // 2. Check exits on open positions
  await checkExits(acc);
  // 3. Look for new entries (impulse detection)
  await checkEntries(acc);
  // 4. Portfolio summary push (throttled — every N hours)
  const summaryIntervalMs = CFG.summaryIntervalHrs * 3600 * 1000;
  const lastSummary = acc.lastSummary || 0;
  if (Date.now() - lastSummary > summaryIntervalMs) {
    await sendPortfolioSummary();
    acc.lastSummary = Date.now();
  }
  // Save
  await saveAccount(acc);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`  Done in ${elapsed}s  |  Trades closed: ${acc.trades.length}`);
}

run().catch(err => {
  console.error("[GOLDEN POCKET] Fatal:", err.message);
  process.exit(1);
});
