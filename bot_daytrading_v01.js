/**
 * bot_daytrading_v01.js — 15-Minute Day Trading Strategy
 *
 * Strategy: "EMA21 Recapture / Rejection"
 *   LONG:  EMA50 rising over last 1hr (short-term momentum up)
 *          + prev candle closed below EMA21 + current close above EMA21 (recapture)
 *          + RSI 40–65 + vol spike + ADX > 20 (trending, not choppy)
 *   SHORT: EMA50 falling over last 1hr (short-term momentum down)
 *          + prev candle closed above EMA21 + current close below EMA21 (rejection)
 *          + RSI 35–60 + vol spike + ADX > 20
 *   No macro filters: EMA100 and VWAP removed. Momentum window = 1hr only.
 *
 * Exit:
 *   TP = 1.3× risk (distance entry to swing low/high of last 3 candles)
 *   SL = swing low (LONG) / swing high (SHORT) of last 3 candles
 *   Max hold = 8 candles (2 hours) → time exit at candle close
 *
 * Sessions: Asia 01:00–09:00 UTC + London 08:00–17:00 UTC + US 13:00–22:00 UTC
 *
 * Universe: BTCUSDT, BNBUSDT, XRPUSDT, SUIUSDT, LTCUSDT, AVAXUSDT
 * Cron:     every 15 minutes  [ slash-star-15 star star star star ]
 * Risk:     0.8% of balance per trade × 5x leverage = 4.0% effective risk/trade
 *           Max 6 concurrent positions (1 per pair)
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────

// Validated universe — 365-day pair screener (backtest_pair_screen.mjs), 5x leverage, $1k start
// ETH removed (only +$6/yr). LTC added (63.3% WR, +143%). AVAX added (51.2% WR, +20.6%).
const PAIRS = ["BTCUSDT", "BNBUSDT", "XRPUSDT", "SUIUSDT", "LTCUSDT", "AVAXUSDT"];

// EMA50 bounce/rejection only fires on pairs where EMA50 acts as clean S/R
// LTC and AVAX: EMA21 signal only (EMA50 not validated for them)
const EMA50_PAIRS = new Set(["BTCUSDT", "SUIUSDT"]);

const CFG = {
  paperTrading:  process.env.PAPER_TRADING !== "false",
  portfolioUSD:  parseFloat(process.env.DT_PORTFOLIO_USD || "1000"),
  riskPct:       parseFloat(process.env.DT_RISK_PCT      || "0.008"),  // 0.8% risk per trade
  leverage:      parseFloat(process.env.DT_LEVERAGE      || "5"),      // 5x leverage on exchange
  maxPositions:  6,    // one per pair max
  rrRatio:       1.3,  // take profit at 1.3× risk
  maxHoldBars:   12,   // 12 × 15min = 3 hours max hold  [was 8 — backtest +241pp]
  interval:      "15m",
  candleLimit:   130,  // EMA100 warmup + buffer
  maxSLPct:      0.012, // discard trade if SL > 1.2% from entry
  ntfyTopic:     process.env.DT_NTFY_TOPIC || process.env.NTFY_TOPIC || "hermes-daytrading",
};

// Persistent storage
const DATA_DIR = process.env.RAILWAY_ENVIRONMENT ? "/data" : ".";
if (process.env.RAILWAY_ENVIRONMENT) mkdirSync(DATA_DIR, { recursive: true });
const ACCOUNT_FILE = `${DATA_DIR}/paper_daytrading_v01.json`;
const CSV_FILE     = `${DATA_DIR}/trades_daytrading_v01.csv`;
const CSV_HEADERS  = "Date,Time (UTC),Symbol,Direction,Entry Price,SL,TP,Risk $,Size $,Signal,P&L $,Exit Reason\n";

// Gist persistence
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
  // 1) Try Gist (Railway prod)
  const gist = await loadFromGist();
  if (gist) { console.log("  [state] loaded from Gist"); return gist; }
  // 2) Try local file
  if (existsSync(ACCOUNT_FILE)) {
    return JSON.parse(readFileSync(ACCOUNT_FILE, "utf8"));
  }
  // 3) Fresh start
  return {
    balance:    CFG.portfolioUSD,
    peak:       CFG.portfolioUSD,
    positions:  [],  // { symbol, direction, entry, sl, tp, size, risk, entryBar, entryTime, entryBalanceSnapshot }
    trades:     [],
    lastBarTime: {},  // symbol → last processed 15m bar openTime (ms)
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

// ─── Binance fetch ────────────────────────────────────────────────────────────

async function fetchKlines(symbol, interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol}`);
  const raw = await res.json();
  return raw.map(k => ({
    time:   parseInt(k[0]),
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
    isClosed: parseInt(k[6]) < Date.now(),  // close time in past = closed candle
  }));
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function ema(values, period) {
  const k   = 2 / (period + 1);
  const out  = new Array(values.length).fill(null);
  out[0]    = values[0];
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

// ADX (Wilder, period=14) — trend strength filter. > 20 = trending, < 20 = choppy.
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
  const calcDX=()=>{const p=smTR>0?100*smP/smTR:0,nn=smTR>0?100*smN/smTR:0;return(p+nn)>0?100*Math.abs(p-nn)/(p+nn):0;};
  dx.push(calcDX());
  for (let i=period; i<tr.length; i++){
    smTR=smTR-smTR/period+tr[i]; smP=smP-smP/period+pdm[i]; smN=smN-smN/period+ndm[i];
    dx.push(calcDX());
  }
  if (dx.length < period) return out;
  let adxVal = dx.slice(0,period).reduce((a,b)=>a+b,0)/period;
  out[2*period-1] = adxVal;
  for (let j=period; j<dx.length; j++) { adxVal=(adxVal*(period-1)+dx[j])/period; out[j+period]=adxVal; }
  return out;
}

// Rolling VWAP — resets at midnight UTC
function vwap(candles) {
  const out    = new Array(candles.length).fill(null);
  let cumPV    = 0, cumVol = 0;
  let dayStart = new Date(candles[0].time);
  dayStart.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < candles.length; i++) {
    const cDay = new Date(candles[i].time);
    cDay.setUTCHours(0, 0, 0, 0);
    if (cDay.getTime() !== dayStart.getTime()) {
      cumPV = 0; cumVol = 0; dayStart = cDay;
    }
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    cumPV   += tp * candles[i].volume;
    cumVol  += candles[i].volume;
    out[i]   = cumVol > 0 ? cumPV / cumVol : candles[i].close;
  }
  return out;
}

// ─── Session filter ───────────────────────────────────────────────────────────
// Asia 01–09 UTC + London 08–17 UTC + US 13–22 UTC = active 01–22 UTC

function inSession(timestampMs) {
  const h = new Date(timestampMs).getUTCHours();
  return h >= 1 && h < 22;  // only skip 22:00–01:00 UTC dead zone
}

// ─── Session ORB bias ─────────────────────────────────────────────────────────
// Session opens: Asia 01:00 · London 08:00 · US 13:00 UTC
// ORB = high/low of first 2 candles (30 min) after each session open.
// Bias = direction of the FIRST ORB break in that session:
//   Close above ORB high first → LONG bias (only take longs this session)
//   Close below ORB low first  → SHORT bias (only take shorts this session)
//   Neither broken yet          → null (ranging open, skip all signals)

const ORB_SESSION_OPENS = new Set([1, 8, 13]);

function sessionORBBias(candles) {
  const out      = new Array(candles.length).fill(null);
  let building   = false;
  let orbHigh    = -Infinity, orbLow = Infinity;
  let confirmed  = null;   // { high, low } once locked
  let bias       = null;   // 'LONG' | 'SHORT' | null

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
      if (c.close > confirmed.high) bias = 'LONG';
      else if (c.close < confirmed.low) bias = 'SHORT';
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
  const e50   = ema(closes, 50);    // direction (1hr lookback) + EMA50 bounce signal
  const rsi_  = rsi(closes, 14);
  const vsma  = sma(vols, 20);
  const adx_  = adx(candles, 14);  // trend strength — skip ADX < 20 (choppy)
  const bias_ = sessionORBBias(candles);  // session ORB directional bias

  const n    = candles.length;
  const i    = n - 2;   // last closed candle (n-1 is forming)
  const prev = n - 3;

  if (i < 70 || prev < 0) return null;
  if (!rsi_[i] || !vsma[i]) return null;
  if (!inSession(candles[i].time)) return null;
  if (!adx_[i] || adx_[i] < 20) return null;  // skip choppy/ranging markets

  // ── Asia session block ───────────────────────────────────────────────────
  // Backtest (365d): Asia (01–08 UTC) = PF 0.95, –6.8% return. London+NY = PF 1.66, +865%.
  // Block all entries during Asia session — entries resume at 08:00 UTC (London open).
  const entryHour = new Date(candles[i].time).getUTCHours();
  if (entryHour >= 1 && entryHour < 8) return null;

  // ── Session ORB bias filter ──────────────────────────────────────────────
  // No bias = session still inside ORB range = chop zone, skip
  const bias = bias_[i];
  if (!bias) return null;

  const c      = candles[i];
  const p      = candles[prev];
  const r      = rsi_[i];
  const volOk  = c.volume > vsma[i] * 1.2;
  const tb     = 4;  // 4 × 15m = 1 hour short-term momentum lookback
  const e50Up  = e50[i] > e50[i - tb];
  const e50Dn  = e50[i] < e50[i - tb];
  const longRsi  = r >= 40 && r < 65;
  const shortRsi = r > 35 && r <= 60;

  // ── LONG signals: only when session ORB bias is LONG ────────────────────
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
    // LONG B: EMA50 bounce (BTC + SUI only)
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

  // ── SHORT signals: only when session ORB bias is SHORT ──────────────────
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
    // SHORT B: EMA50 rejection (BTC + SUI only)
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
  const now       = Date.now();
  let   anyExited = false;

  for (let p = acc.positions.length - 1; p >= 0; p--) {
    const pos    = acc.positions[p];
    const isLong = pos.direction === "LONG";

    // Fetch latest 15m candles for this position
    let candles;
    try {
      candles = await fetchKlines(pos.symbol, CFG.interval, 3);
    } catch (e) {
      console.warn(`  [exit] fetch failed for ${pos.symbol}: ${e.message}`);
      continue;
    }

    // Use the last closed candle
    const closed = candles.filter(c => c.isClosed);
    if (closed.length === 0) continue;
    const c = closed[closed.length - 1];

    const hitTP = isLong ? c.high >= pos.tp  : c.low  <= pos.tp;
    const hitSL = isLong ? c.low  <= pos.sl  : c.high >= pos.sl;

    // Count bars held (approximate from time)
    const barsHeld = Math.round((c.time - pos.entryTime) / (15 * 60 * 1000));
    const timeExit = barsHeld >= CFG.maxHoldBars;

    let exitReason = null;
    let exitPrice  = null;

    if (hitSL && hitTP) {
      exitReason = "SL";  // SL priority if both hit same candle
      exitPrice  = pos.sl;
    } else if (hitSL) {
      exitReason = "SL";
      exitPrice  = pos.sl;
    } else if (hitTP) {
      exitReason = "TP";
      exitPrice  = pos.tp;
    } else if (timeExit) {
      exitReason = "TIME";
      exitPrice  = c.close;
    }

    if (!exitReason) continue;

    // Calculate P&L
    const priceDiff = isLong ? exitPrice - pos.entry : pos.entry - exitPrice;
    const pnl       = (priceDiff / pos.entry) * pos.sizeUSD;

    acc.balance += pnl;
    if (acc.balance > acc.peak) acc.peak = acc.balance;

    const trade = {
      symbol:     pos.symbol,
      direction:  pos.direction,
      entry:      pos.entry,
      exit:       exitPrice,
      sl:         pos.sl,
      tp:         pos.tp,
      riskUSD:    pos.riskUSD,
      sizeUSD:    pos.sizeUSD,
      pnl:        Math.round(pnl * 100) / 100,
      exitReason,
      entryTime:  pos.entryTime,
      exitTime:   now,
    };
    acc.trades.push(trade);
    acc.positions.splice(p, 1);
    csvLog(trade);

    const sign = pnl >= 0 ? "✅" : "❌";
    console.log(`  ${sign} EXIT ${pos.symbol} ${pos.direction}  ${exitReason}  P&L: $${pnl.toFixed(2)}`);

    await notify(
      `${sign} DT ${pos.symbol} ${pos.direction} closed — ${exitReason}\n` +
      `P&L: $${pnl.toFixed(2)}  |  Balance: $${acc.balance.toFixed(2)}\n` +
      `Entry: $${pos.entry}  Exit: $${exitPrice.toFixed(4)}`
    );
    anyExited = true;
  }
  return anyExited;
}

// ─── Entry logic ──────────────────────────────────────────────────────────────

async function checkEntries(acc) {
  if (acc.positions.length >= CFG.maxPositions) return;

  for (const symbol of PAIRS) {
    // Already in a trade on this pair?
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

    // Avoid re-entering on the same bar we just saw
    const lastBar = acc.lastBarTime?.[symbol] || 0;
    if (sig.barTime <= lastBar) continue;

    // Size the trade: risk% of balance, scaled by leverage
    // sizeUSD = notional position value on exchange
    // riskUSD = how much of our balance we lose if SL hits (= sizeUSD × slPct / leverage × leverage = slPct × riskUSD ✓)
    const riskUSD = acc.balance * CFG.riskPct;
    const slDist  = Math.abs(sig.entry - sig.sl);
    const sizeUSD = (riskUSD / slDist) * sig.entry * CFG.leverage;  // notional position in USD

    acc.positions.push({
      symbol:    sig.symbol,
      direction: sig.direction,
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

    await notify(
      `${dir} DT ${symbol} ${sig.direction} OPEN  [${sig.signal} @ ${CFG.leverage}x]\n` +
      `Entry: $${sig.entry.toFixed(4)}  SL: $${sig.sl.toFixed(4)}  TP: $${sig.tp.toFixed(4)}\n` +
      `RSI: ${sig.rsi}  Risk: $${riskUSD.toFixed(2)}  Notional: $${sizeUSD.toFixed(2)}`
    );
  }
}

// ─── Main run ─────────────────────────────────────────────────────────────────

async function run() {
  const start = Date.now();
  const ts    = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`\n[DT v01] ${ts} UTC`);

  const acc = await loadAccount();
  const dd  = ((acc.peak - acc.balance) / acc.peak * 100).toFixed(1);
  console.log(
    `  Balance: $${acc.balance.toFixed(2)}  Peak: $${acc.peak.toFixed(2)}  DD: ${dd}%` +
    `  Positions: ${acc.positions.length}/${CFG.maxPositions}  Leverage: ${CFG.leverage}x  Risk: ${(CFG.riskPct*100).toFixed(1)}%`
  );

  // Phase 1: check all open positions for exits
  const anyExited = await checkExits(acc);

  // Phase 2: look for new entries
  await checkEntries(acc);

  // Save state
  await saveAccount(acc);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`  Done in ${elapsed}s  |  Trades closed: ${acc.trades.length}`);
}

run().catch(err => {
  console.error("[DT v01] Fatal:", err.message);
  process.exit(1);
});
