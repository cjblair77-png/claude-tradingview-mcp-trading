/**
 * bot_crypto_v09_mexc.js — v09 strategy on MEXC Futures
 *
 * Migrated from bot_crypto_v09.js (was BitGet/Binance) to MEXC Futures.
 *
 * Key changes from v09:
 *   - Data source: Binance REST → MEXC Futures API
 *   - Symbol format: KAIAUSDT → KAIA_USDT (with underscore)
 *   - Exceptions: FILUSDT → FILECOIN_USDT, ZKUSDT → ZKSYNC_USDT
 *   - Signal logic: UNCHANGED (pure math, exchange-agnostic)
 *   - Live orders: MEXC Futures API (paper trading default)
 *
 * Strategy (unchanged from v09):
 *   - Universe: Top-30 curated pairs (isolation-scored)
 *   - 1.5x leverage, 4H candles, full breakout + rebound signals
 *   - SL 6.5% | TP 23% | Trail 19%
 *
 * Cron: 0 0,4,8,12,16,20 * * *  (every 4 hours at candle close)
 * Files:
 *   paper_account_v09.json  — balance, open positions, closed trades
 *   v09-log.json            — full decision log
 *   trades_v09.csv          — tax-ready trade record
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import crypto from "crypto";

// ─── Config ───────────────────────────────────────────────────────────────────

// MEXC symbol format uses underscores (BASE_USDT)
// Two special cases: FIL → FILECOIN, ZK → ZKSYNC
const PAIRS = [
  // Rank 1–10  (isolation score ≥ 0.60)
  "KAIA_USDT",    "S_USDT",      "FILECOIN_USDT", "AR_USDT",    "PLUME_USDT",
  "FIDA_USDT",    "GMT_USDT",    "ENA_USDT",      "TIA_USDT",   "TURBO_USDT",
  // Rank 11–20 (isolation score ≥ 0.55)
  "WIF_USDT",     "SHIB_USDT",   "BCH_USDT",      "VET_USDT",   "ONDO_USDT",
  "THETA_USDT",   "HBAR_USDT",   "RUNE_USDT",     "IOTA_USDT",  "JUP_USDT",
  // Rank 21–30 (isolation score ≥ 0.47)
  "FLUX_USDT",    "W_USDT",      "CATI_USDT",     "ZKSYNC_USDT","KAITO_USDT",
  "WLD_USDT",     "AIXBT_USDT",  "LA_USDT",       "JASMY_USDT", "HOME_USDT",
];

const CFG = {
  paperTrading:      process.env.PAPER_TRADING !== "false",
  portfolioUSD:      parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  riskPct:           parseFloat(process.env.RISK_PCT            || "0.008"),  // 0.8% per trade
  minRisk:           parseFloat(process.env.MIN_RISK_USD        || "2"),
  maxPositions:      parseInt(process.env.MAX_POSITIONS         || "10"),
  leverage:          parseFloat(process.env.LEVERAGE            || "1.5"),
  interval:          "Min240",   // MEXC format for 4H
  interval1h:        "Min60",    // MEXC format for 1H exit checks
  candleLimit:       550,        // 500 + buffer for 200 EMA + 30-bar lookback
  slPct:             parseFloat(process.env.SL_PCT              || "0.065"),  // 6.5%
  tpPct:             parseFloat(process.env.TP_PCT              || "0.23"),   // 23%
  trailPct:          parseFloat(process.env.TRAIL_PCT           || "0.19"),   // 19%
  trailMode:         (process.env.TRAIL_MODE                    || "auto").toLowerCase(),
  trailAutoBullPct:  parseFloat(process.env.TRAIL_AUTO_BULL_PCT || "90"),
  reboundSlPct:      parseFloat(process.env.REBOUND_SL_PCT      || "0.035"), // 3.5%
  reboundTpPct:      parseFloat(process.env.REBOUND_TP_PCT      || "0.22"),  // 22%
  rsiOversold:       parseFloat(process.env.RSI_OVERSOLD        || "20"),
  rsiOverbought:     parseFloat(process.env.RSI_OVERBOUGHT      || "80"),
  breakoutRsiMin:    parseFloat(process.env.BREAKOUT_RSI_MIN    || "54"),
  breakoutRsiMax:    parseFloat(process.env.BREAKOUT_RSI_MAX    || "65"),
  breakoutLookback:  parseInt(process.env.BREAKOUT_LOOKBACK     || "30"),
  mexc: {
    apiKey:    process.env.MEXC_API_KEY,
    secretKey: process.env.MEXC_SECRET_KEY,
    baseUrl:   "https://futures.mexc.com",
  },
};

const DATA_DIR     = process.env.RAILWAY_ENVIRONMENT ? "/data" : ".";
if (process.env.RAILWAY_ENVIRONMENT) mkdirSync(DATA_DIR, { recursive: true });
const ACCOUNT_FILE = `${DATA_DIR}/paper_account_v09.json`;
const LOG_FILE     = `${DATA_DIR}/v09-log.json`;
const CSV_FILE     = `${DATA_DIR}/trades_v09.csv`;
const CSV_HEADERS  = "Date,Time (UTC),Symbol,Direction,Entry Price,SL,TP,Risk $,Size $,Leverage,Mode,Signal,Regime,P&L $,Exit Reason,Order ID\n";

// ─── Utilities ────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
const fmt2   = n => n.toFixed(2);
const fmtPct = n => (n >= 0 ? "+" : "") + (n * 100).toFixed(1) + "%";

// ─── Push Notifications (ntfy.sh) ────────────────────────────────────────────

async function notify(title, body, tags = "") {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    const res = await fetch("https://ntfy.sh/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, title, message: body, tags: tags ? tags.split(",") : [] }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) console.log(`  📱 Notification sent: ${title}`);
    else        console.log(`  ⚠️  Notification failed: HTTP ${res.status}`);
  } catch (e) {
    console.log(`  ⚠️  Notification failed: ${e.message}`);
  }
}

// ─── MEXC Futures Data Fetch ──────────────────────────────────────────────────
// MEXC kline format: [timestamp_sec, open, close, high, low, vol, amount, ...]
// API: GET /api/v1/contract/kline/{symbol}?interval=Min{N}&start={sec}&end={sec}

async function fetchMexcKlines(symbol, intervalStr, startSec, endSec) {
  const url = `${CFG.mexc.baseUrl}/api/v1/contract/kline/${symbol}?interval=${intervalStr}&start=${startSec}&end=${endSec}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol}`);
  const json = await res.json();
  if (!json.data) throw new Error(`No data for ${symbol}: ${JSON.stringify(json).slice(0,100)}`);
  const { time, open, close, high, low, vol } = json.data;
  if (!time || time.length === 0) throw new Error(`Empty kline data for ${symbol}`);

  const bars = time.map((t, i) => ({
    time:   t * 1000,                  // sec → ms
    open:   parseFloat(open[i]),
    close:  parseFloat(close[i]),
    high:   parseFloat(high[i]),
    low:    parseFloat(low[i]),
    volume: parseFloat(vol[i]),
  }));
  bars.sort((a, b) => a.time - b.time);
  return bars;
}

// Fetch 4H candles for signal analysis (~550 bars = ~91 days, well within MEXC depth)
async function getCandles(symbol) {
  const endSec   = Math.floor(Date.now() / 1000);
  const startSec = endSec - CFG.candleLimit * 4 * 3600 + 1;  // 550 × 4h back
  const bars = await fetchMexcKlines(symbol, CFG.interval, startSec, endSec);
  if (bars.length < 50) throw new Error(`Insufficient data for ${symbol}: ${bars.length} bars`);
  return bars.map(b => ({
    time:   b.time,
    open:   b.open,
    high:   b.high,
    low:    b.low,
    close:  b.close,
    volume: b.volume,
  }));
}

// Fetch the 2 most recent 1H candles for intra-4H exit detection
async function get1HOhlc(symbol) {
  const endSec   = Math.floor(Date.now() / 1000);
  const startSec = endSec - 3 * 3600;   // 3H window → guaranteed 2 complete 1H bars
  const bars = await fetchMexcKlines(symbol, CFG.interval1h, startSec, endSec);
  if (bars.length < 1) throw new Error(`No 1H data for ${symbol}`);
  // Use last 2 bars (most recently closed + current forming)
  const recent = bars.slice(-2);
  const high   = Math.max(...recent.map(b => b.high));
  const low    = Math.min(...recent.map(b => b.low));
  const close  = recent[recent.length - 1].close;
  return { high, low, close };
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++)
    out.push(values[i] * k + out[i-1] * (1-k));
  return out;
}

function smaSeries(values, period) {
  return values.map((_, i) =>
    i < period - 1 ? null : values.slice(i - period + 1, i + 1).reduce((a,b) => a+b, 0) / period
  );
}

function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let g = 0, l = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j] - closes[j-1];
      d > 0 ? g += d : l -= d;
    }
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + (g/period) / (l/period));
  }
  return out;
}

function macdSeries(closes, f=12, s=26, sig=9) {
  const fast = emaSeries(closes, f);
  const slow = emaSeries(closes, s);
  const line = closes.map((_, i) => fast[i] - slow[i]);
  const signal = [line[0]];
  const k = 2 / (sig + 1);
  for (let i = 1; i < closes.length; i++)
    signal.push(line[i] * k + signal[i-1] * (1-k));
  return { line, signal, hist: line.map((v, i) => v - signal[i]) };
}

// ─── Regime ───────────────────────────────────────────────────────────────────

function regime(i, closes, e21, e50, e200) {
  if (!e200[i] || !e50[i] || !e21[i]) return "neutral";
  const c = closes[i];
  let score = 0;
  if (c      > e200[i]) score++; else score--;
  if (c      > e50[i])  score++; else score--;
  if (c      > e21[i])  score++; else score--;
  if (e21[i] > e50[i])  score++; else score--;
  if (e50[i] > e200[i]) score++; else score--;
  return score >= 4 ? "bull" : score <= -4 ? "bear" : "neutral";
}

function riskForRegimeAndDir(reg, direction, balance) {
  const base = Math.max(balance * CFG.riskPct, CFG.minRisk);
  if (reg === "neutral") return parseFloat((base * 0.75).toFixed(2));
  const withTrend = (reg === "bull" && direction === "LONG") ||
                    (reg === "bear" && direction === "SHORT");
  return parseFloat((withTrend ? base : base * 0.5).toFixed(2));
}

// ─── Signals ──────────────────────────────────────────────────────────────────

function evalSignals(candles) {
  const closes = candles.map(c => c.close);
  const vols   = candles.map(c => c.volume);
  const n      = candles.length - 1;
  const i      = n - 1;

  if (i < 22) return { long: false, short: false, regime: "neutral", indicators: {} };

  const e21  = emaSeries(closes, 21);
  const e50  = emaSeries(closes, 50);
  const e200 = emaSeries(closes, 200);
  const rsi  = rsiSeries(closes, 14);
  const mc   = macdSeries(closes);
  const vsma = smaSeries(vols, 20);

  const c    = closes[i];
  const rNow = rsi[i];
  const rPrv = rsi[i-1];
  const vol  = candles[i].volume;
  const reg  = regime(i, closes, e21, e50, e200);

  if (rNow == null || rPrv == null || vsma[i] == null)
    return { long: false, short: false, regime: reg, indicators: { price: closes[n] } };

  // ── LONG: structural breakout (30-bar lookback, RSI 54-65) ────────────────
  const lookback = CFG.breakoutLookback;
  const highN    = Math.max(...closes.slice(Math.max(0, i - lookback), i));
  const breakout = c > highN;
  const trendUp  = e21[i] > e50[i] && e21[i] > e21[i-1] && e21[i-1] > e21[i-3];
  const rsiLong  = rNow >= CFG.breakoutRsiMin && rNow <= CFG.breakoutRsiMax;
  const volLong  = vol  > vsma[i] * 1.5;
  const longSig  = breakout && trendUp && rsiLong && volLong;

  // ── SHORT: overbought breakdown ────────────────────────────────────────────
  const wasOB   = [1,2,3,4,5].some(k => rsi[i-k] != null && rsi[i-k] >= 65);
  const rsiBrk  = rPrv >= 58 && rNow < 58;
  const macdBrk = mc.hist[i-1] >= 0 && mc.hist[i] < 0;
  const volShrt = vol > vsma[i] * 1.2;
  const shortSig = wasOB && (rsiBrk || macdBrk) && c < e21[i] && rNow > 35 && volShrt;

  // ── LONG REBOUND: RSI extreme oversold reversal ────────────────────────────
  const wasOversold   = [1,2,3].some(k => rsi[i-k] != null && rsi[i-k] <= CFG.rsiOversold);
  const rsiTurnUp     = rPrv != null && rPrv <= 30 && rNow > 30;
  const notFreefalling= c > e21[i] * 0.92;
  const volRebound    = vol > vsma[i] * 1.0;
  const longRebound   = wasOversold && rsiTurnUp && reg === "bull" && notFreefalling && volRebound && !longSig;

  // ── SHORT REBOUND: RSI extreme overbought reversal ─────────────────────────
  const wasOverbought = [1,2,3].some(k => rsi[i-k] != null && rsi[i-k] >= CFG.rsiOverbought);
  const rsiTurnDown   = rPrv != null && rPrv >= 70 && rNow < 70;
  const notMeltingUp  = c < e21[i] * 1.08;
  const shortRebound  = wasOverbought && rsiTurnDown && reg !== "bull" && notMeltingUp && volRebound && !shortSig;

  return {
    long: longSig, short: shortSig, longRebound, shortRebound,
    regime: reg,
    indicators: {
      price: closes[n], rsi: rNow, rsiPrev: rPrv,
      e21: e21[i], e50: e50[i], e200: e200[i],
      macdHist: mc.hist[i], highN, vol, volSma: vsma[i],
    },
    longDetail:         longSig      ? `Breakout above ${fmt2(highN)} (${lookback}bar), EMA21>${fmt2(e50[i])}, RSI ${rNow.toFixed(1)}, vol ${(vol/vsma[i]).toFixed(1)}x` : null,
    shortDetail:        shortSig     ? `RSI faded to ${rNow.toFixed(1)} (was >=65), price ${fmt2(c)}<EMA21 ${fmt2(e21[i])}, ${rsiBrk?"RSI cross":"MACD flip"}` : null,
    longReboundDetail:  longRebound  ? `RSI oversold turn: ${rPrv?.toFixed(1)}->${rNow.toFixed(1)} (was <=${CFG.rsiOversold}), ${reg} regime` : null,
    shortReboundDetail: shortRebound ? `RSI overbought turn: ${rPrv?.toFixed(1)}->${rNow.toFixed(1)} (was >=${CFG.rsiOverbought}), ${reg} regime` : null,
  };
}

// ─── Gist persistence (Railway) ───────────────────────────────────────────────

const GIST_ID      = process.env.GITHUB_GIST_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GIST_FILE    = "paper_account_v09.json";

async function loadFromGist() {
  if (!GIST_ID || !GITHUB_TOKEN) return null;
  try {
    const res  = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    const file = data.files?.[GIST_FILE];
    if (!file) { console.log("  ⚠️  Gist file not found — using local"); return null; }
    console.log("  ☁️  Account loaded from GitHub Gist");
    return JSON.parse(file.content);
  } catch (e) {
    console.log(`  ⚠️  Gist load failed: ${e.message} — using local`);
    return null;
  }
}

async function saveToGist(acc) {
  if (!GIST_ID || !GITHUB_TOKEN) return;
  try {
    await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: "PATCH",
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(acc, null, 2) } } }),
      signal: AbortSignal.timeout(10000),
    });
    console.log("  ☁️  Account saved to GitHub Gist");
  } catch (e) {
    console.log(`  ⚠️  Gist save failed: ${e.message}`);
  }
}

// ─── Paper Account ────────────────────────────────────────────────────────────

async function loadAccount() {
  const gist = await loadFromGist();
  if (gist) return gist;

  if (!existsSync(ACCOUNT_FILE)) {
    const acc = {
      balance:       CFG.portfolioUSD,
      startBalance:  CFG.portfolioUSD,
      leverage:      CFG.leverage,
      openPositions: [],
      closedTrades:  [],
      stats: { total: 0, wins: 0, losses: 0, pnl: 0, longWins: 0, longTotal: 0, shortWins: 0, shortTotal: 0 },
      lastRun: null,
    };
    writeFileSync(ACCOUNT_FILE, JSON.stringify(acc, null, 2));
    console.log(`📋 Paper account created — $${CFG.portfolioUSD} starting balance | ${CFG.leverage}x leverage`);
    return acc;
  }
  return JSON.parse(readFileSync(ACCOUNT_FILE, "utf8"));
}

async function saveAccount(acc) {
  acc.lastRun = new Date().toISOString();
  writeFileSync(ACCOUNT_FILE, JSON.stringify(acc, null, 2));
  await saveToGist(acc);
}

// ─── P&L (leverage-adjusted) ──────────────────────────────────────────────────

function calcPnl(pos, price) {
  const raw = pos.direction === "LONG"
    ? (price - pos.entryPrice) / pos.entryPrice * pos.size
    : (pos.entryPrice - price) / pos.entryPrice * pos.size;
  return raw * CFG.leverage;
}

// ─── Close position ───────────────────────────────────────────────────────────

function closeTrade(acc, pos, price, reason, closed) {
  const pnl = calcPnl(pos, price);
  const won = pnl > 0;

  acc.balance += pos.size + pnl;
  acc.stats.total++;
  acc.stats.pnl += pnl;
  acc.stats.pnl  = parseFloat(acc.stats.pnl.toFixed(4));
  if (won) acc.stats.wins++; else acc.stats.losses++;
  if (pos.direction === "LONG")  { acc.stats.longTotal++;  if (won) acc.stats.longWins++;  }
  if (pos.direction === "SHORT") { acc.stats.shortTotal++; if (won) acc.stats.shortWins++; }

  const trade = { ...pos, exitPrice: price, exitTime: new Date().toISOString(), exitReason: reason, pnl: parseFloat(pnl.toFixed(4)), won };
  acc.closedTrades.push(trade);
  closed.push(trade);

  const icon       = won ? "🟢" : "🔴";
  const leverageTag = `[${CFG.leverage}x]`;
  console.log(`  ${icon} ${reason} — ${pos.direction} ${pos.symbol} @ $${fmt2(price)} | P&L: ${pnl >= 0 ? "+" : ""}$${fmt2(pnl)} ${leverageTag}`);
  writeCsvTrade(trade);

  const coin2     = pos.symbol.replace("_USDT","");
  const pnlPctStr = fmtPct(pnl / pos.size);
  const exitLabel = reason === "TP" ? "✅ TP HIT" : reason === "SL" ? "❌ SL HIT" : reason === "TRAIL_SL" ? "🏁 TRAIL STOP" : reason;
  notify(
    `${icon} ${coin2} CLOSED — ${won ? "WIN" : "LOSS"}`,
    `${exitLabel} · ${pos.direction}\nP&L: ${pnl >= 0 ? "+" : ""}$${fmt2(pnl)} (${pnlPctStr}) ${leverageTag}\nEntry $${fmt2(pos.entryPrice)} → Exit $${fmt2(price)}\nBalance: $${fmt2(acc.balance)}  |  Total P&L: ${acc.stats.pnl >= 0 ? "+" : ""}$${fmt2(acc.stats.pnl)}`,
    won ? "moneybag,green_circle" : "chart_with_downwards_trend,red_circle"
  );
}

// ─── Process exits ────────────────────────────────────────────────────────────

function processExits(acc, ohlcMap) {
  const closed    = [];
  const remaining = [];

  for (const pos of acc.openPositions) {
    const ohlc = ohlcMap[pos.symbol];
    if (!ohlc) { remaining.push(pos); continue; }

    const isLong = pos.direction === "LONG";
    const { high, low, close } = ohlc;

    if (pos.trailing) {
      let moved = false;
      if (isLong && high > pos.trailHigh) {
        pos.trailHigh = high;
        pos.sl        = parseFloat((high * (1 - CFG.trailPct)).toFixed(6));
        moved = true;
      } else if (!isLong && low < pos.trailLow) {
        pos.trailLow = low;
        pos.sl       = parseFloat((low * (1 + CFG.trailPct)).toFixed(6));
        moved = true;
      }

      const hitTrail = isLong ? low <= pos.sl : high >= pos.sl;
      if (hitTrail) {
        const pct = ((calcPnl(pos, pos.sl) / pos.size) * 100).toFixed(1);
        console.log(`  🏁 TRAIL SL HIT — ${pos.direction} ${pos.symbol} @ $${fmt2(pos.sl)} | Trail locked in ${pct}%`);
        closeTrade(acc, pos, pos.sl, "TRAIL_SL", closed);
        continue;
      }

      if (moved) {
        const refPx  = isLong ? pos.trailHigh : pos.trailLow;
        const profit = isLong
          ? (refPx - pos.entryPrice) / pos.entryPrice * 100
          : (pos.entryPrice - refPx) / pos.entryPrice * 100;
        console.log(`  📈 TRAIL MOVED — ${pos.direction} ${pos.symbol} | Peak $${fmt2(refPx)} (+${profit.toFixed(1)}%) | New SL $${fmt2(pos.sl)}`);
      }

      remaining.push(pos);
      continue;
    }

    const hitSL = isLong ? low  <= pos.sl : high >= pos.sl;
    const hitTP = isLong ? high >= pos.tp : low  <= pos.tp;

    if (!hitSL && !hitTP) { remaining.push(pos); continue; }

    if (hitSL && hitTP) {
      console.log(`  ⚠️  SL+TP both hit in same candle — closing at SL (conservative)`);
      closeTrade(acc, pos, pos.sl, "SL", closed);
      continue;
    }

    if (hitTP) {
      const profit = isLong
        ? (pos.tp - pos.entryPrice) / pos.entryPrice * 100
        : (pos.entryPrice - pos.tp) / pos.entryPrice * 100;
      if (pos.noTrail) {
        console.log(`  ✅ TP HIT — ${pos.direction} ${pos.symbol} @ $${fmt2(pos.tp)} (+${profit.toFixed(1)}%)`);
        closeTrade(acc, pos, pos.tp, "TP", closed);
      } else {
        pos.trailing = true;
        if (isLong) { pos.trailHigh = pos.tp; }
        else        { pos.trailLow  = pos.tp; }
        pos.sl = parseFloat((isLong
          ? pos.tp * (1 - CFG.trailPct)
          : pos.tp * (1 + CFG.trailPct)).toFixed(6));
        console.log(`  🚀 TP HIT → TRAILING — ${pos.direction} ${pos.symbol} @ $${fmt2(pos.tp)} (+${profit.toFixed(1)}%) | Trail SL $${fmt2(pos.sl)}`);
        remaining.push(pos);
      }
      continue;
    }

    closeTrade(acc, pos, pos.sl, "SL", closed);
  }

  acc.openPositions = remaining;
  return closed;
}

// ─── Open position ────────────────────────────────────────────────────────────

function openPosition(acc, symbol, direction, entryPrice, signal, detail, reg, riskUSD, opts = {}) {
  if (acc.openPositions.find(p => p.symbol === symbol)) return null;
  if (acc.openPositions.length >= CFG.maxPositions) {
    console.log(`  ⚠️  Position cap (${CFG.maxPositions}) reached — skipping ${symbol}`);
    return null;
  }
  if (acc.balance < riskUSD * 2) {
    console.log(`  ⚠️  Low balance $${fmt2(acc.balance)} — skipping ${symbol}`);
    return null;
  }

  const isLong  = direction === "LONG";
  const slPct   = opts.slPct  ?? CFG.slPct;
  const tpPct   = opts.tpPct  ?? CFG.tpPct;
  const noTrail = opts.noTrail ?? false;
  const size    = riskUSD / slPct;
  const sl      = isLong ? entryPrice * (1 - slPct) : entryPrice * (1 + slPct);
  const tp      = isLong ? entryPrice * (1 + tpPct) : entryPrice * (1 - tpPct);

  acc.balance -= riskUSD;

  const pos = {
    id:         `P9M-${Date.now()}-${symbol}`,
    symbol, direction, entryPrice, size,
    risk:       riskUSD,
    leverage:   CFG.leverage,
    sl:         parseFloat(sl.toFixed(6)),
    tp:         parseFloat(tp.toFixed(6)),
    trailing:   false, noTrail,
    trailHigh:  null, trailLow: null,
    entryTime:  new Date().toISOString(),
    signal, detail, regime: reg,
  };

  acc.openPositions.push(pos);
  return pos;
}

// ─── MEXC Futures Live Order ──────────────────────────────────────────────────
// Signs requests with MEXC API key + HMAC-SHA256
// Disabled until PAPER_TRADING=false and keys are set

function signMexc(timestamp, body) {
  const msg = CFG.mexc.apiKey + timestamp + body;
  return crypto.createHmac("sha256", CFG.mexc.secretKey).update(msg).digest("hex");
}

async function placeMexcOrder(symbol, side, price, vol) {
  // side: 1=open long, 2=close long, 3=open short, 4=close short
  const timestamp = Date.now().toString();
  const bodyObj = {
    symbol,
    side,
    openType: 1,          // 1=isolated, 2=cross
    type: 5,              // 5=market order
    vol,                  // contract quantity
    leverage: CFG.leverage,
  };
  const bodyStr   = JSON.stringify(bodyObj);
  const signature = signMexc(timestamp, bodyStr);
  const res = await fetch(`${CFG.mexc.baseUrl}/api/v1/private/order/submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ApiKey":       CFG.mexc.apiKey,
      "Request-Time": timestamp,
      "Signature":    signature,
    },
    body: bodyStr,
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  if (!data.success) throw new Error(`MEXC order error: ${data.message || JSON.stringify(data)}`);
  return data.data;
}

// ─── CSV Logging ──────────────────────────────────────────────────────────────

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS);
    console.log(`📄 Tax log created -> ${CSV_FILE}`);
  }
}

function writeCsvTrade(trade) {
  const d    = new Date(trade.exitTime || trade.entryTime);
  const date = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 19);
  const row  = [
    date, time, trade.symbol, trade.direction,
    trade.entryPrice?.toFixed(6) ?? "",
    trade.sl?.toFixed(6)         ?? "",
    trade.tp?.toFixed(6)         ?? "",
    trade.risk?.toFixed(2)       ?? "",
    trade.size?.toFixed(2)       ?? "",
    CFG.leverage + "x",
    CFG.paperTrading ? "PAPER" : "LIVE",
    trade.signal ?? "", trade.regime ?? "",
    trade.pnl?.toFixed(4) ?? "",
    trade.exitReason ?? "OPEN",
    trade.id ?? "",
  ].join(",");
  appendFileSync(CSV_FILE, row + "\n");
}

// ─── Decision log ─────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { runs: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}
function saveLog(log) { writeFileSync(LOG_FILE, JSON.stringify(log, null, 2)); }

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const startTime  = Date.now();
  const now        = new Date();
  const utcHour    = now.getUTCHours();
  const is4HBoundary = utcHour % 4 === 0;
  const runMode    = is4HBoundary ? "FULL (exits + signal scan)" : "MANAGE (exits only)";

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Crypto Bot v09 MEXC — Top-30 Curated | ${CFG.leverage}x Leverage`);
  console.log(`  ${now.toISOString()}`);
  console.log(`  Mode: ${CFG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}  |  Run: ${runMode}`);
  const trailModeLabel = CFG.trailMode === "on" ? "ON (always)" : CFG.trailMode === "off" ? "OFF (always)"
    : `AUTO (>=${CFG.trailAutoBullPct}% pairs bull)`;
  console.log(`  Pairs: ${PAIRS.length} | Max positions: ${CFG.maxPositions} | Risk: ${(CFG.riskPct*100).toFixed(1)}% | Leverage: ${CFG.leverage}x`);
  console.log(`  Trail: ${trailModeLabel}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (!CFG.paperTrading) {
    const missing = ["MEXC_API_KEY","MEXC_SECRET_KEY"].filter(k => !process.env[k]);
    if (missing.length) { console.error(`❌ Missing MEXC credentials: ${missing.join(", ")}`); process.exit(1); }
  }

  initCsv();
  const acc = await loadAccount();
  const log = loadLog();

  const pnlPct  = (acc.stats.pnl / acc.startBalance * 100).toFixed(2);
  const longWR  = acc.stats.longTotal  ? (acc.stats.longWins  / acc.stats.longTotal  * 100).toFixed(1) : "-";
  const shortWR = acc.stats.shortTotal ? (acc.stats.shortWins / acc.stats.shortTotal * 100).toFixed(1) : "-";
  console.log("── Account Status ──────────────────────────────────────────────\n");
  console.log(`  Balance:    $${fmt2(acc.balance)}  |  Start: $${fmt2(acc.startBalance)}  |  Leverage: ${CFG.leverage}x`);
  console.log(`  Total P&L:  ${acc.stats.pnl >= 0 ? "+" : ""}$${fmt2(acc.stats.pnl)} (${pnlPct}%)`);
  console.log(`  Trades:     ${acc.stats.total}  |  Wins: ${acc.stats.wins}  |  Losses: ${acc.stats.losses}`);
  console.log(`  Long WR:    ${longWR}% (${acc.stats.longWins}/${acc.stats.longTotal})`);
  console.log(`  Short WR:   ${shortWR}% (${acc.stats.shortWins}/${acc.stats.shortTotal})`);
  console.log(`  Open:       ${acc.openPositions.length}/${CFG.maxPositions} positions\n`);

  if (acc.openPositions.length > 0) {
    console.log("  Open positions:");
    for (const p of acc.openPositions) {
      const age      = Math.round((Date.now() - new Date(p.entryTime).getTime()) / 3600000);
      const trailTag = p.trailing
        ? ` 🔄 TRAILING (peak $${fmt2(p.trailHigh || p.trailLow)})`
        : p.noTrail ? ` TP $${fmt2(p.tp)} [rebound]` : ` TP $${fmt2(p.tp)}`;
      console.log(`    ${p.direction === "LONG" ? "🟢" : "🔴"} ${p.symbol.padEnd(14)} ${p.direction.padEnd(6)} @ $${fmt2(p.entryPrice)}  SL $${fmt2(p.sl)}${trailTag}  [${age}h, ${p.regime}]`);
    }
    console.log();
  }

  const runLog = { time: now.toISOString(), mode: runMode, signals: [], opened: [], closed: [] };

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1 — Exit check via 1H candles (every hour)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("── Exit Check (1H candles) ─────────────────────────────────────\n");
  let closedThisRun = [];

  if (acc.openPositions.length > 0) {
    const ohlcMap1H = {};
    const seenSyms  = new Set();
    for (const pos of acc.openPositions) {
      if (seenSyms.has(pos.symbol)) continue;
      seenSyms.add(pos.symbol);
      try {
        ohlcMap1H[pos.symbol] = await get1HOhlc(pos.symbol);
        const o = ohlcMap1H[pos.symbol];
        process.stdout.write(`  ${pos.symbol.padEnd(14)} 1H H $${fmt2(o.high)}  L $${fmt2(o.low)}  C $${fmt2(o.close)}\n`);
        await delay(150);
      } catch (e) {
        console.log(`  ⚠️  ${pos.symbol}: 1H fetch failed — ${e.message}`);
      }
    }
    console.log();
    closedThisRun  = processExits(acc, ohlcMap1H);
    runLog.closed  = closedThisRun.map(t => t.symbol);
    if (closedThisRun.length === 0) console.log("  No exits this hour.\n");
  } else {
    console.log("  No open positions.\n");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2 — Signal scan on 4H candles (only at 4H UTC boundary)
  // ═══════════════════════════════════════════════════════════════════════════
  if (is4HBoundary) {
    console.log(`── Signal Scan (4H candles — ${utcHour.toString().padStart(2,"0")}:00 UTC) ──────────────────────\n`);

    const marketData = {};
    let fetchErrors  = 0;

    for (const symbol of PAIRS) {
      try {
        marketData[symbol] = await getCandles(symbol);
        process.stdout.write(`  ${symbol.padEnd(14)} ✓  ${marketData[symbol].length} bars\n`);
        await delay(150);
      } catch (err) {
        console.log(`  ${symbol.padEnd(14)} ✗ ${err.message}`);
        fetchErrors++;
      }
    }
    if (fetchErrors > 0) console.log(`\n  ⚠️  ${fetchErrors} pairs failed to fetch`);

    console.log("\n── Signals ─────────────────────────────────────────────────────\n");
    const signals = [];

    for (const symbol of PAIRS) {
      const candles = marketData[symbol];
      if (!candles) continue;

      let sig;
      try { sig = evalSignals(candles); }
      catch (err) { console.log(`  ${symbol}: signal error — ${err.message}`); continue; }

      const { long, short, longRebound, shortRebound, regime: reg, indicators,
              longDetail, shortDetail, longReboundDetail, shortReboundDetail } = sig;

      runLog.signals.push({ symbol, regime: reg, long, short, longRebound, shortRebound, price: indicators.price });

      if (long || short) {
        let direction = null;
        if (long && !short)  direction = "LONG";
        if (short && !long)  direction = "SHORT";
        if (long && short) {
          direction = reg === "bull" ? "LONG" : reg === "bear" ? "SHORT" : null;
          if (!direction) { console.log(`  ${symbol.padEnd(14)} CONFLICT (${reg}) — skipping`); continue; }
        }
        const signal  = direction === "LONG" ? "Breakout" : "Breakdown";
        const detail  = direction === "LONG" ? longDetail : shortDetail;
        const riskUSD = riskForRegimeAndDir(reg, direction, acc.balance);
        signals.push({ symbol, direction, signal, detail, regime: reg, riskUSD, price: indicators.price, indicators });
        const regIcon = reg === "bull" ? "🟢" : reg === "bear" ? "🔴" : "🟡";
        console.log(`  ${regIcon} ${symbol.padEnd(14)} ${direction.padEnd(6)} | ${signal} | Risk $${fmt2(riskUSD)} | ${detail}`);
        continue;
      }

      if (longRebound || shortRebound) {
        let direction = null;
        if (longRebound && !shortRebound)  direction = "LONG";
        if (shortRebound && !longRebound)  direction = "SHORT";
        if (longRebound && shortRebound) {
          direction = reg === "bull" ? "LONG" : reg === "bear" ? "SHORT" : null;
          if (!direction) { console.log(`  ${symbol.padEnd(14)} REBOUND CONFLICT (${reg}) — skipping`); continue; }
        }
        const signal  = direction === "LONG" ? "RSI Rebound L" : "RSI Rebound S";
        const detail  = direction === "LONG" ? longReboundDetail : shortReboundDetail;
        const riskUSD = riskForRegimeAndDir(reg, direction, acc.balance);
        signals.push({ symbol, direction, signal, detail, regime: reg, riskUSD, price: indicators.price, indicators, isRebound: true });
        const regIcon = reg === "bull" ? "🟢" : reg === "bear" ? "🔴" : "🟡";
        console.log(`  ${regIcon} ${symbol.padEnd(14)} ${direction.padEnd(6)} | ${signal} | Risk $${fmt2(riskUSD)} | ${detail}`);
      }
    }

    if (signals.length === 0) console.log("  No signals this bar.");

    // Trailing mode from regime snapshot
    const regimeCounts = { bull: 0, neutral: 0, bear: 0 };
    for (const s of runLog.signals) { if (regimeCounts[s.regime] !== undefined) regimeCounts[s.regime]++; }
    const totalPairs = regimeCounts.bull + regimeCounts.neutral + regimeCounts.bear;
    const bullPct    = totalPairs ? (regimeCounts.bull / totalPairs * 100) : 0;
    const bearPct    = totalPairs ? (regimeCounts.bear / totalPairs * 100) : 0;
    let useTrail = false;
    if      (CFG.trailMode === "on")  useTrail = true;
    else if (CFG.trailMode === "off") useTrail = false;
    else    useTrail = bullPct >= CFG.trailAutoBullPct;
    const trailIcon   = useTrail ? "🚀" : "🎯";
    const trailReason = useTrail
      ? `AUTO ON  — ${bullPct.toFixed(0)}% pairs bull >= ${CFG.trailAutoBullPct}%`
      : `AUTO OFF — ${bullPct.toFixed(0)}% pairs bull < ${CFG.trailAutoBullPct}% (hard TP)`;
    console.log(`\n  ${trailIcon} Trail SL: ${trailReason}\n`);
    runLog.trailMode = CFG.trailMode;
    runLog.useTrail  = useTrail;
    runLog.bullPct   = parseFloat(bullPct.toFixed(1));

    console.log("── Opening Positions ───────────────────────────────────────────\n");
    let opened = 0;

    for (const sig of signals) {
      if (acc.openPositions.find(p => p.symbol === sig.symbol)) {
        console.log(`  ${sig.symbol.padEnd(14)} already open — skipping`);
        continue;
      }
      const entryPrice  = sig.price;
      const reboundOpts = sig.isRebound
        ? { slPct: CFG.reboundSlPct, tpPct: CFG.reboundTpPct, noTrail: true }
        : { noTrail: !useTrail };
      const pos = openPosition(acc, sig.symbol, sig.direction, entryPrice, sig.signal, sig.detail, sig.regime, sig.riskUSD, reboundOpts);
      if (!pos) continue;

      const icon      = sig.direction === "LONG" ? "🟢" : "🔴";
      const typeLabel = sig.isRebound ? "REBOUND" : "MOMENTUM";
      console.log(`  ${icon} ${sig.direction.padEnd(6)} ${sig.symbol.padEnd(14)} @ $${fmt2(entryPrice)} [${typeLabel}] [${CFG.leverage}x]`);
      console.log(`     Risk $${fmt2(sig.riskUSD)} | SL $${fmt2(pos.sl)} | TP $${fmt2(pos.tp)} | ${sig.regime}`);
      console.log(`     ${sig.detail}`);
      writeCsvTrade(pos);
      runLog.opened.push({ symbol: sig.symbol, direction: sig.direction, entry: entryPrice, regime: sig.regime, risk: sig.riskUSD });
      opened++;

      // Live order (only when PAPER_TRADING=false and MEXC keys are set)
      if (!CFG.paperTrading && CFG.mexc.apiKey) {
        try {
          const mexcSide = sig.direction === "LONG" ? 1 : 3;
          const orderData = await placeMexcOrder(sig.symbol, mexcSide, entryPrice, 1);
          pos.orderId = orderData?.orderId;
          console.log(`     🔴 LIVE ORDER placed: ${orderData?.orderId || "no ID"}`);
        } catch (e) {
          console.log(`     ⚠️  Live order failed: ${e.message}`);
        }
      }

      // Push notification
      const coin       = sig.symbol.replace("_USDT","");
      const slDist     = Math.abs(entryPrice - pos.sl);
      const tpDist     = Math.abs(pos.tp - entryPrice);
      const potWin     = slDist > 0 ? sig.riskUSD * (tpDist / slDist) : 0;
      notify(
        `${icon} ${sig.direction} ${coin} OPENED`,
        `${typeLabel} · ${sig.regime.toUpperCase()}\nEntry $${fmt2(entryPrice)} · SL $${fmt2(pos.sl)} · TP $${fmt2(pos.tp)}\nWin: +$${fmt2(potWin)}  |  Loss: -$${fmt2(sig.riskUSD)} · ${CFG.leverage}x\nBalance: $${fmt2(acc.balance)}`,
        sig.direction === "LONG" ? "chart_with_upwards_trend,green_circle" : "chart_with_downwards_trend,red_circle"
      );
    }

    if (opened === 0 && signals.length > 0) console.log("  All signals filtered.");
    if (signals.length === 0) console.log("  Nothing to open this bar.");

    console.log(`\n── Market Regime Snapshot ──────────────────────────────────────`);
    console.log(`  🟢 Bull:    ${regimeCounts.bull}/${totalPairs} pairs (${bullPct.toFixed(0)}%)`);
    console.log(`  🟡 Neutral: ${regimeCounts.neutral}/${totalPairs} pairs`);
    console.log(`  🔴 Bear:    ${regimeCounts.bear}/${totalPairs} pairs (${bearPct.toFixed(0)}%)`);

  } else {
    const nextScan = (Math.ceil((utcHour + 1) / 4) * 4) % 24;
    console.log(`  ℹ️  Next full scan at ${nextScan.toString().padStart(2,"0")}:00 UTC (${4 - (utcHour % 4)}h away)\n`);
  }

  await saveAccount(acc);
  log.runs.push(runLog);
  saveLog(log);

  const elapsed   = ((Date.now() - startTime) / 1000).toFixed(1);
  const newPnlPct = (acc.stats.pnl / acc.startBalance * 100).toFixed(2);
  console.log(`\n── Summary ─────────────────────────────────────────────────────`);
  console.log(`  Closed: ${closedThisRun.length} | Open: ${acc.openPositions.length}/${CFG.maxPositions}`);
  console.log(`  P&L: ${acc.stats.pnl >= 0 ? "+" : ""}$${fmt2(acc.stats.pnl)} (${newPnlPct}%)  |  Run time: ${elapsed}s`);
  console.log("═══════════════════════════════════════════════════════════════\n");
}

async function taxSummary() {
  const acc = await loadAccount();
  console.log("\n── v09 MEXC Tax Summary ─────────────────────────────────────────\n");
  console.log(`  Start balance:   $${fmt2(acc.startBalance)}`);
  console.log(`  Current balance: $${fmt2(acc.balance)}`);
  console.log(`  Leverage:        ${CFG.leverage}x`);
  console.log(`  Total P&L:       ${acc.stats.pnl >= 0 ? "+" : ""}$${fmt2(acc.stats.pnl)}`);
  console.log(`  Total trades:    ${acc.stats.total}  |  Win rate: ${acc.stats.total ? (acc.stats.wins/acc.stats.total*100).toFixed(1) : 0}%`);
  console.log(`  Long:  ${acc.stats.longTotal} trades  WR ${acc.stats.longTotal ? (acc.stats.longWins/acc.stats.longTotal*100).toFixed(1) : 0}%`);
  console.log(`  Short: ${acc.stats.shortTotal} trades  WR ${acc.stats.shortTotal ? (acc.stats.shortWins/acc.stats.shortTotal*100).toFixed(1) : 0}%`);
  console.log(`  Open positions:  ${acc.openPositions.length}`);
  console.log(`  Trade log:       ${CSV_FILE}\n`);
}

if (process.argv.includes("--tax-summary") || process.argv.includes("--status")) {
  taxSummary().catch(err => { console.error(err); process.exit(1); });
} else {
  run().catch(err => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
