/**
 * bot_daytrading_mexc.js — 15-Minute Day Trading Strategy on MEXC Futures
 *
 * Migrated from bot_daytrading_v01.js (was Binance) to MEXC Futures.
 *
 * Key changes:
 *   - Data source: Binance REST → MEXC Futures API
 *   - Symbol format: BTCUSDT → BTC_USDT (underscore)
 *   - Signal logic: UNCHANGED (pure math, exchange-agnostic)
 *   - Live orders: MEXC Futures API (paper trading default)
 *
 * Strategy: "EMA21 Recapture / Rejection" (unchanged)
 *   LONG:  EMA50 rising (1hr momentum) + prev close < EMA21 + current close > EMA21
 *          + RSI 40–65 + vol spike + ADX > 20 + session ORB bias = LONG
 *   SHORT: EMA50 falling + prev close > EMA21 + current close < EMA21
 *          + RSI 35–60 + vol spike + ADX > 20 + session ORB bias = SHORT
 *   TP = 1.3× risk | SL = swing low/high of last 3 bars | Max hold = 12 bars (3h)
 *
 * Cron: every 15 minutes (star-slash-15 star star star star)
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import crypto from "crypto";

// ─── Config ───────────────────────────────────────────────────────────────────

// MEXC symbol format: BASE_USDT (underscore separator)
const PAIRS = ["BTC_USDT", "BNB_USDT", "XRP_USDT", "SUI_USDT", "LTC_USDT", "AVAX_USDT"];

// EMA50 bounce signal only validated for BTC and SUI
const EMA50_PAIRS = new Set(["BTC_USDT", "SUI_USDT"]);

const CFG = {
  paperTrading:  process.env.PAPER_TRADING !== "false",
  portfolioUSD:  parseFloat(process.env.DT_PORTFOLIO_USD || "1000"),
  riskPct:       parseFloat(process.env.DT_RISK_PCT      || "0.008"),  // 0.8% risk per trade
  leverage:      parseFloat(process.env.DT_LEVERAGE      || "5"),      // 5x leverage
  maxPositions:  6,
  rrRatio:       1.3,
  maxHoldBars:   12,   // 12 × 15min = 3 hours max hold
  interval:      "Min15",  // MEXC interval format
  candleLimit:   130,
  maxSLPct:      0.012,
  ntfyTopic:     process.env.DT_NTFY_TOPIC || process.env.NTFY_TOPIC || "hermes-daytrading",
  mexc: {
    apiKey:    process.env.MEXC_API_KEY,
    secretKey: process.env.MEXC_SECRET_KEY,
    baseUrl:   "https://futures.mexc.com",
  },
};

const DATA_DIR     = process.env.RAILWAY_ENVIRONMENT ? "/data" : ".";
if (process.env.RAILWAY_ENVIRONMENT) mkdirSync(DATA_DIR, { recursive: true });
const ACCOUNT_FILE = `${DATA_DIR}/paper_daytrading_v01.json`;
const CSV_FILE     = `${DATA_DIR}/trades_daytrading_v01.csv`;
const CSV_HEADERS  = "Date,Time (UTC),Symbol,Direction,Entry Price,SL,TP,Risk $,Size $,Signal,P&L $,Exit Reason\n";

const GIST_ID      = process.env.GITHUB_GIST_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GIST_FILE    = "paper_daytrading_v01.json";

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
      method:  "PATCH",
      headers: {
        Authorization:  `token ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        Accept:         "application/vnd.github+json",
      },
      body:   JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(acc, null, 2) } } }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) { console.warn("  [Gist] save failed:", e.message); }
}

// ─── Account persistence ──────────────────────────────────────────────────────

async function loadAccount() {
  const gist = await loadFromGist();
  if (gist) { console.log("  [state] loaded from Gist"); return gist; }
  if (existsSync(ACCOUNT_FILE)) return JSON.parse(readFileSync(ACCOUNT_FILE, "utf8"));
  return {
    balance:     CFG.portfolioUSD,
    peak:        CFG.portfolioUSD,
    positions:   [],
    trades:      [],
    lastBarTime: {},
  };
}

async function saveAccount(acc) {
  writeFileSync(ACCOUNT_FILE, JSON.stringify(acc, null, 2));
  await saveToGist(acc);
}

// ─── Notifications ────────────────────────────────────────────────────────────

async function notify(msg) {
  if (!CFG.ntfyTopic) return;
  try {
    await fetch(`https://ntfy.sh/${CFG.ntfyTopic}`, {
      method:  "POST",
      headers: { "Content-Type": "text/plain" },
      body:    msg,
      signal:  AbortSignal.timeout(8000),
    });
  } catch { /* silent */ }
}

// ─── CSV logging ──────────────────────────────────────────────────────────────

function csvLog(trade) {
  if (!existsSync(CSV_FILE)) appendFileSync(CSV_FILE, CSV_HEADERS);
  const d   = new Date(trade.exitTime || Date.now());
  const row = [
    d.toISOString().slice(0, 10),
    d.toISOString().slice(11, 19),
    trade.symbol,
    trade.direction,
    trade.entry.toFixed(6),
    trade.sl.toFixed(6),
    trade.tp.toFixed(6),
    trade.riskUSD.toFixed(2),
    trade.sizeUSD.toFixed(2),
    trade.signal || "EMA21_RECAPTURE",
    trade.pnl.toFixed(2),
    trade.exitReason,
  ].join(",");
  appendFileSync(CSV_FILE, row + "\n");
}

// ─── MEXC Futures Data Fetch ──────────────────────────────────────────────────
// MEXC kline format: [timestamp_sec, open, close, high, low, vol, amount, ...]
// API: GET /api/v1/contract/kline/{symbol}?interval=Min{N}&start={sec}&end={sec}

async function fetchKlines(symbol, intervalStr, limit) {
  const barSecs  = 15 * 60;   // 15-minute bars = 900 seconds each
  const nowSec   = Math.floor(Date.now() / 1000);
  const startSec = nowSec - (limit + 5) * barSecs;  // +5 buffer
  const url = `${CFG.mexc.baseUrl}/api/v1/contract/kline/${symbol}?interval=${intervalStr}&start=${startSec}&end=${nowSec}`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol}`);
  const json = await res.json();
  if (!json.data) throw new Error(`No kline data for ${symbol}`);
  const { time, open, close, high, low, vol } = json.data;
  if (!time || time.length === 0) throw new Error(`Empty kline data for ${symbol}`);

  return time.map((t, i) => ({
    time:     t * 1000,                          // sec → ms
    open:     parseFloat(open[i]),
    high:     parseFloat(high[i]),
    low:      parseFloat(low[i]),
    close:    parseFloat(close[i]),
    volume:   parseFloat(vol[i]),
    isClosed: (t + barSecs) * 1000 < Date.now(), // candle closed if next bar start is in the past
  })).sort((a, b) => a.time - b.time);
}

// ─── SPY Circuit Breaker ──────────────────────────────────────────────────────
// Uses QQQSTOCK_USDT (Nasdaq-100) as SPY proxy on MEXC.
// If QQQ 4H price < EMA50(4H), block ALL long entries.
// This prevents buying crypto dips during equity market corrections.
// Enable by setting SPY_CIRCUIT_BREAKER=true in env.

let spyBreakerCache = null;  // { timestamp, blocksLong }

async function checkSpyCircuitBreaker() {
  if (process.env.SPY_CIRCUIT_BREAKER !== "true") return false;  // disabled by default

  // Cache result for 10 minutes to avoid hammering the API
  if (spyBreakerCache && Date.now() - spyBreakerCache.timestamp < 10 * 60 * 1000) {
    return spyBreakerCache.blocksLong;
  }

  try {
    const endSec   = Math.floor(Date.now() / 1000);
    const startSec = endSec - 60 * 4 * 3600;  // 60 × 4H bars back
    const url = `${CFG.mexc.baseUrl}/api/v1/contract/kline/QQQSTOCK_USDT?interval=Hour4&start=${startSec}&end=${endSec}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const json = await res.json();
    if (!json.data?.close || json.data.close.length < 55) {
      console.log("  [SPY CB] Insufficient QQQ data — breaker OFF");
      return false;
    }

    const closes = json.data.close.map(Number);
    // EMA50
    const k = 2 / 51;
    let e50 = closes[0];
    for (let i = 1; i < closes.length; i++) e50 = closes[i] * k + e50 * (1 - k);
    const lastClose = closes[closes.length - 1];
    const blocksLong = lastClose < e50;

    spyBreakerCache = { timestamp: Date.now(), blocksLong };
    console.log(`  [SPY CB] QQQ $${lastClose.toFixed(2)} vs EMA50 $${e50.toFixed(2)} → longs ${blocksLong ? "🚫 BLOCKED" : "✅ OK"}`);
    return blocksLong;
  } catch (e) {
    console.log(`  [SPY CB] Check failed: ${e.message} — breaker OFF`);
    return false;
  }
}

// ─── MEXC Live Order ──────────────────────────────────────────────────────────

function signMexc(timestamp, body) {
  const msg = CFG.mexc.apiKey + timestamp + body;
  return crypto.createHmac("sha256", CFG.mexc.secretKey).update(msg).digest("hex");
}

async function placeMexcOrder(symbol, side, vol) {
  // side: 1=open long, 2=close long, 3=open short, 4=close short
  const timestamp = Date.now().toString();
  const bodyObj   = { symbol, side, openType: 1, type: 5, vol, leverage: CFG.leverage };
  const bodyStr   = JSON.stringify(bodyObj);
  const sig       = signMexc(timestamp, bodyStr);
  const res = await fetch(`${CFG.mexc.baseUrl}/api/v1/private/order/submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ApiKey":       CFG.mexc.apiKey,
      "Request-Time": timestamp,
      "Signature":    sig,
    },
    body: bodyStr,
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  if (!data.success) throw new Error(`MEXC order error: ${data.message || JSON.stringify(data)}`);
  return data.data;
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function ema(values, period) {
  const k  = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++)
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? g += d : l -= d;
  }
  out[period] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) { g = (g * (period - 1) + d) / period; l = l * (period - 1) / period; }
    else       { g = g * (period - 1) / period; l = (l * (period - 1) - d) / period; }
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

function sma(values, period) {
  return values.map((_, i) =>
    i < period - 1 ? null : values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period
  );
}

function adx(candles, period = 14) {
  const n = candles.length, out = new Array(n).fill(null);
  const tr = [], pdm = [], ndm = [];
  for (let i = 1; i < n; i++) {
    const h=candles[i].high, l=candles[i].low, pc=candles[i-1].close;
    const ph=candles[i-1].high, pl=candles[i-1].low;
    tr.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
    const up=h-ph, dn=pl-l;
    pdm.push(up>dn&&up>0?up:0);
    ndm.push(dn>up&&dn>0?dn:0);
  }
  if (tr.length < period*2) return out;
  let smTR=tr.slice(0,period).reduce((a,b)=>a+b,0);
  let smP =pdm.slice(0,period).reduce((a,b)=>a+b,0);
  let smN =ndm.slice(0,period).reduce((a,b)=>a+b,0);
  const dx = [];
  const calcDX=()=>{ const p=smTR>0?100*smP/smTR:0,nn=smTR>0?100*smN/smTR:0; return (p+nn)>0?100*Math.abs(p-nn)/(p+nn):0; };
  dx.push(calcDX());
  for (let i=period; i<tr.length; i++) {
    smTR=smTR-smTR/period+tr[i]; smP=smP-smP/period+pdm[i]; smN=smN-smN/period+ndm[i];
    dx.push(calcDX());
  }
  if (dx.length < period) return out;
  let adxVal = dx.slice(0,period).reduce((a,b)=>a+b,0)/period;
  out[2*period-1] = adxVal;
  for (let j=period; j<dx.length; j++) { adxVal=(adxVal*(period-1)+dx[j])/period; out[j+period]=adxVal; }
  return out;
}

// ─── Session filter ───────────────────────────────────────────────────────────

function inSession(timestampMs) {
  const h = new Date(timestampMs).getUTCHours();
  return h >= 1 && h < 22;
}

// ─── Session ORB bias ─────────────────────────────────────────────────────────

const ORB_SESSION_OPENS = new Set([1, 8, 13]);

function sessionORBBias(candles) {
  const out     = new Array(candles.length).fill(null);
  let building  = false;
  let orbHigh   = -Infinity, orbLow = Infinity;
  let confirmed = null;
  let bias      = null;

  for (let j = 0; j < candles.length; j++) {
    const c = candles[j];
    const h = new Date(c.time).getUTCHours();
    const m = new Date(c.time).getUTCMinutes();

    if (ORB_SESSION_OPENS.has(h) && m === 0) {
      building  = true;
      orbHigh   = c.high;
      orbLow    = c.low;
      confirmed = null;
      bias      = null;
    } else if (building) {
      orbHigh   = Math.max(orbHigh, c.high);
      orbLow    = Math.min(orbLow,  c.low);
      confirmed = { high: orbHigh, low: orbLow };
      building  = false;
    }

    if (confirmed && bias === null) {
      if (c.close > confirmed.high)      bias = 'LONG';
      else if (c.close < confirmed.low)  bias = 'SHORT';
    }

    out[j] = confirmed ? bias : null;
  }
  return out;
}

// ─── Signal logic ─────────────────────────────────────────────────────────────

function analyzeSymbol(symbol, candles) {
  const closes = candles.map(c => c.close);
  const vols   = candles.map(c => c.volume);

  const e21   = ema(closes, 21);
  const e50   = ema(closes, 50);
  const rsi_  = rsi(closes, 14);
  const vsma  = sma(vols, 20);
  const adx_  = adx(candles, 14);
  const bias_ = sessionORBBias(candles);

  const n    = candles.length;
  const i    = n - 2;   // last closed candle
  const prev = n - 3;

  if (i < 70 || prev < 0) return null;
  if (!rsi_[i] || !vsma[i]) return null;
  if (!inSession(candles[i].time)) return null;
  if (!adx_[i] || adx_[i] < 20) return null;

  // Block Asia session entries (01–08 UTC)
  const entryHour = new Date(candles[i].time).getUTCHours();
  if (entryHour >= 1 && entryHour < 8) return null;

  // Require established ORB bias
  const bias = bias_[i];
  if (!bias) return null;

  const c      = candles[i];
  const p      = candles[prev];
  const r      = rsi_[i];
  const volOk  = c.volume > vsma[i] * 1.2;
  const tb     = 4;  // 4 × 15m = 1 hour momentum lookback
  const e50Up  = e50[i] > e50[i - tb];
  const e50Dn  = e50[i] < e50[i - tb];
  const longRsi  = r >= 40 && r < 65;
  const shortRsi = r > 35 && r <= 60;

  // ── LONG signals ─────────────────────────────────────────────────────────
  if (bias === 'LONG') {
    // LONG A: EMA21 recapture
    if (e50Up && longRsi && volOk && p.close < e21[prev] && c.close > e21[i]) {
      const swingLow = Math.min(...candles.slice(Math.max(0, i - 3), i + 1).map(x => x.low));
      const risk     = c.close - swingLow;
      if (risk > 0 && risk / c.close < CFG.maxSLPct) {
        return { symbol, direction: "LONG", signal: "EMA21",
                 entry: c.close, sl: swingLow, tp: c.close + risk * CFG.rrRatio,
                 rsi: r.toFixed(1), barTime: c.time };
      }
    }
    // LONG B: EMA50 bounce (BTC_USDT + SUI_USDT only)
    if (EMA50_PAIRS.has(symbol) && e50Up && r >= 38 && r < 62 && volOk &&
        p.close < e50[prev] && c.close > e50[i]) {
      const swingLow = Math.min(...candles.slice(Math.max(0, i - 4), i + 1).map(x => x.low));
      const risk     = c.close - swingLow;
      if (risk > 0 && risk / c.close < 0.018) {
        return { symbol, direction: "LONG", signal: "EMA50",
                 entry: c.close, sl: swingLow, tp: c.close + risk * CFG.rrRatio,
                 rsi: r.toFixed(1), barTime: c.time };
      }
    }
  }

  // ── SHORT signals ─────────────────────────────────────────────────────────
  if (bias === 'SHORT') {
    // SHORT A: EMA21 rejection
    if (e50Dn && shortRsi && volOk && p.close > e21[prev] && c.close < e21[i]) {
      const swingHigh = Math.max(...candles.slice(Math.max(0, i - 3), i + 1).map(x => x.high));
      const risk      = swingHigh - c.close;
      if (risk > 0 && risk / c.close < CFG.maxSLPct) {
        return { symbol, direction: "SHORT", signal: "EMA21",
                 entry: c.close, sl: swingHigh, tp: c.close - risk * CFG.rrRatio,
                 rsi: r.toFixed(1), barTime: c.time };
      }
    }
    // SHORT B: EMA50 rejection (BTC_USDT + SUI_USDT only)
    if (EMA50_PAIRS.has(symbol) && e50Dn && r > 38 && r <= 62 && volOk &&
        p.close > e50[prev] && c.close < e50[i]) {
      const swingHigh = Math.max(...candles.slice(Math.max(0, i - 4), i + 1).map(x => x.high));
      const risk      = swingHigh - c.close;
      if (risk > 0 && risk / c.close < 0.018) {
        return { symbol, direction: "SHORT", signal: "EMA50",
                 entry: c.close, sl: swingHigh, tp: c.close - risk * CFG.rrRatio,
                 rsi: r.toFixed(1), barTime: c.time };
      }
    }
  }

  return null;
}

// ─── Exit checking ────────────────────────────────────────────────────────────

async function checkExits(acc) {
  const now = Date.now();

  for (let p = acc.positions.length - 1; p >= 0; p--) {
    const pos    = acc.positions[p];
    const isLong = pos.direction === "LONG";

    let candles;
    try {
      candles = await fetchKlines(pos.symbol, CFG.interval, 3);
    } catch (e) {
      console.warn(`  [exit] fetch failed for ${pos.symbol}: ${e.message}`);
      continue;
    }

    const closed = candles.filter(c => c.isClosed);
    if (closed.length === 0) continue;
    const c = closed[closed.length - 1];

    const hitTP   = isLong ? c.high >= pos.tp  : c.low  <= pos.tp;
    const hitSL   = isLong ? c.low  <= pos.sl  : c.high >= pos.sl;
    const barsHeld = Math.round((c.time - pos.entryTime) / (15 * 60 * 1000));
    const timeExit = barsHeld >= CFG.maxHoldBars;

    let exitReason = null, exitPrice = null;
    if (hitSL && hitTP) { exitReason = "SL"; exitPrice = pos.sl; }
    else if (hitSL)     { exitReason = "SL"; exitPrice = pos.sl; }
    else if (hitTP)     { exitReason = "TP"; exitPrice = pos.tp; }
    else if (timeExit)  { exitReason = "TIME"; exitPrice = c.close; }

    if (!exitReason) continue;

    const priceDiff = isLong ? exitPrice - pos.entry : pos.entry - exitPrice;
    const pnl       = (priceDiff / pos.entry) * pos.sizeUSD;

    acc.balance += pnl;
    if (acc.balance > acc.peak) acc.peak = acc.balance;

    const trade = {
      symbol: pos.symbol, direction: pos.direction,
      entry: pos.entry, exit: exitPrice, sl: pos.sl, tp: pos.tp,
      riskUSD: pos.riskUSD, sizeUSD: pos.sizeUSD,
      signal: pos.signal,
      pnl: Math.round(pnl * 100) / 100,
      exitReason, entryTime: pos.entryTime, exitTime: now,
    };
    acc.trades.push(trade);
    acc.positions.splice(p, 1);
    csvLog(trade);

    const sign = pnl >= 0 ? "✅" : "❌";
    console.log(`  ${sign} EXIT ${pos.symbol} ${pos.direction}  ${exitReason}  P&L: $${pnl.toFixed(2)}`);

    const totPnl = acc.trades.reduce((s, t) => s + (t.pnl || 0), 0);
    await notify(
      `${sign} DT ${pos.symbol} ${pos.direction} — ${exitReason}\n` +
      `P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}  |  Balance: $${acc.balance.toFixed(2)}\n` +
      `Entry: $${pos.entry}  →  Exit: $${exitPrice.toFixed(4)}\n` +
      `Total P&L: ${totPnl >= 0 ? "+" : ""}$${totPnl.toFixed(2)}  |  Trades: ${acc.trades.length}`
    );
  }
}

// ─── Entry logic ──────────────────────────────────────────────────────────────

async function checkEntries(acc) {
  if (acc.positions.length >= CFG.maxPositions) return;

  // SPY circuit breaker: blocks LONG entries during equity corrections
  const spyBlocksLong = await checkSpyCircuitBreaker();

  for (const symbol of PAIRS) {
    if (acc.positions.some(p => p.symbol === symbol)) continue;

    let candles;
    try {
      candles = await fetchKlines(symbol, CFG.interval, CFG.candleLimit);
    } catch (e) {
      console.warn(`  [entry] fetch failed for ${symbol}: ${e.message}`);
      continue;
    }

    const sig = analyzeSymbol(symbol, candles);
    if (!sig) continue;

    // SPY circuit breaker — block long entries during equity corrections
    if (sig.direction === "LONG" && spyBlocksLong) {
      console.log(`  [SPY CB] ${symbol} LONG signal blocked (QQQ below EMA50)`);
      continue;
    }

    const lastBar = acc.lastBarTime?.[symbol] || 0;
    if (sig.barTime <= lastBar) continue;

    const riskUSD = acc.balance * CFG.riskPct;
    const slDist  = Math.abs(sig.entry - sig.sl);
    const sizeUSD = (riskUSD / slDist) * sig.entry * CFG.leverage;

    acc.positions.push({
      symbol:    sig.symbol,
      direction: sig.direction,
      signal:    sig.signal,
      entry:     sig.entry,
      sl:        sig.sl,
      tp:        sig.tp,
      sizeUSD:   Math.round(sizeUSD * 100) / 100,
      riskUSD:   Math.round(riskUSD * 100) / 100,
      entryTime: sig.barTime,
    });
    if (!acc.lastBarTime) acc.lastBarTime = {};
    acc.lastBarTime[symbol] = sig.barTime;

    const dir    = sig.direction === "LONG" ? "📈" : "📉";
    const slPct  = ((slDist / sig.entry) * 100).toFixed(2);
    const tpDist = Math.abs(sig.tp - sig.entry);
    const tpPct  = ((tpDist / sig.entry) * 100).toFixed(2);

    console.log(
      `  ${dir} ENTRY ${symbol} ${sig.direction}  $${sig.entry.toFixed(4)}\n` +
      `     SL: $${sig.sl.toFixed(4)} (${slPct}%)  TP: $${sig.tp.toFixed(4)} (${tpPct}%)\n` +
      `     RSI: ${sig.rsi}  Signal: ${sig.signal}  Risk: $${riskUSD.toFixed(2)}  Notional: $${sizeUSD.toFixed(2)} (${CFG.leverage}x)`
    );

    // Live order (only when PAPER_TRADING=false and MEXC keys are set)
    if (!CFG.paperTrading && CFG.mexc.apiKey) {
      try {
        const mexcSide = sig.direction === "LONG" ? 1 : 3;
        const orderData = await placeMexcOrder(symbol, mexcSide, 1);
        console.log(`     🔴 LIVE ORDER: ${orderData?.orderId || "no ID"}`);
      } catch (e) {
        console.log(`     ⚠️  Live order failed: ${e.message}`);
      }
    }

    const potWin = riskUSD * CFG.rrRatio;
    await notify(
      `${dir} DT ${symbol} ${sig.direction} OPEN  [${sig.signal} @ ${CFG.leverage}x]\n` +
      `Entry: $${sig.entry.toFixed(4)}  SL: $${sig.sl.toFixed(4)}  TP: $${sig.tp.toFixed(4)}\n` +
      `Win: +$${potWin.toFixed(2)}  |  Loss: -$${riskUSD.toFixed(2)}\n` +
      `Balance: $${acc.balance.toFixed(2)}  |  RSI: ${sig.rsi}`
    );
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const start = Date.now();
  const ts    = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`\n[DT MEXC] ${ts} UTC  |  ${CFG.paperTrading ? "📋 PAPER" : "🔴 LIVE"}`);

  const acc = await loadAccount();
  const dd  = ((acc.peak - acc.balance) / acc.peak * 100).toFixed(1);
  console.log(
    `  Balance: $${acc.balance.toFixed(2)}  Peak: $${acc.peak.toFixed(2)}  DD: ${dd}%` +
    `  Positions: ${acc.positions.length}/${CFG.maxPositions}  ${CFG.leverage}x  Risk: ${(CFG.riskPct*100).toFixed(1)}%`
  );

  await checkExits(acc);
  await checkEntries(acc);
  await saveAccount(acc);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`  Done in ${elapsed}s  |  Trades closed: ${acc.trades.length}`);
}

run().catch(err => {
  console.error("[DT MEXC] Fatal:", err.message);
  process.exit(1);
});
