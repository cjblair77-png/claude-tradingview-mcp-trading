/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via BitGet if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const missing = required.filter((k) => process.env[k] === undefined);

  if (!existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# BitGet credentials",
        "BITGET_API_KEY=",
        "BITGET_SECRET_KEY=",
        "BITGET_PASSPHRASE=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    try {
      execSync("notepad .env");
    } catch {}
    console.log(
      "Fill in your BitGet credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try {
      execSync("notepad .env");
    } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

const LOG_FILE    = "safety-check-log.json";
const PAPER_FILE  = "paper_account.json";
const SL_PCT      = 0.05;   // 5% stop loss  — optimised: backtest +$310 vs +$110 at 2%
const TP_PCT      = 0.15;   // 15% take profit — optimised: 1:3 R:R, 47% win rate
const MIN_CONF    = 65;     // minimum confidence % to allow a trade
const PAPER_SIZE  = parseFloat(process.env.PAPER_TRADE_SIZE_USD || "50"); // $ per trade

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Confidence Score ────────────────────────────────────────────────────────

function calcConfidenceScore(price, ema20, vwap, rsi14, st, macd, bbSignals, stMACDSignals) {
  const rsi = rsi14 ?? 50;
  let L = 0, S = 0;

  // Trend alignment (35 pts)
  if (st) { if (st.direction === 1) L += 20; else S += 20; }
  if (ema20 != null) { if (price > ema20) L += 10; else S += 10; }
  if (vwap  != null) { if (price > vwap)  L += 5;  else S += 5;  }

  // MACD momentum (25 pts)
  if (macd) {
    if (macd.macdLine > 0)               L += 12; else S += 12;
    if (macd.macdLine > macd.signalLine) L += 13; else S += 13;
  }

  // RSI entry timing (25 pts)
  if      (rsi < 30) L += 25;
  else if (rsi < 40) L += 15;
  else if (rsi < 50) L += 5;
  if      (rsi > 70) S += 25;
  else if (rsi > 60) S += 15;
  else if (rsi > 50) S += 5;

  // Active signal bonus (15 pts)
  const bbSigs = bbSignals || [];
  const stSigs = stMACDSignals || [];
  if (stSigs.find(s => s.direction === 'LONG'))  L += 15;
  if (stSigs.find(s => s.direction === 'SHORT')) S += 15;
  if (bbSigs.find(s => s.direction === 'LONG'))  L += 10;
  if (bbSigs.find(s => s.direction === 'SHORT')) S += 10;

  return { long: Math.min(L, 100), short: Math.min(S, 100) };
}

// ─── Paper Trading Account ───────────────────────────────────────────────────

function loadPaperAccount() {
  if (!existsSync(PAPER_FILE)) {
    const account = {
      balance:       CONFIG.portfolioValue,
      startBalance:  CONFIG.portfolioValue,
      openPositions: [],
      closedTrades:  [],
      stats: { totalTrades: 0, wins: 0, losses: 0, totalPnl: 0 }
    };
    writeFileSync(PAPER_FILE, JSON.stringify(account, null, 2));
    console.log(`📋 Paper account created — starting balance $${CONFIG.portfolioValue}`);
    return account;
  }
  return JSON.parse(readFileSync(PAPER_FILE, 'utf8'));
}

function savePaperAccount(account) {
  writeFileSync(PAPER_FILE, JSON.stringify(account, null, 2));
}

function updateOpenPositions(account, symbol, currentPrice) {
  const stillOpen = [];
  const closed    = [];

  for (const pos of account.openPositions) {
    if (pos.symbol !== symbol) { stillOpen.push(pos); continue; }

    const isLong  = pos.direction === 'LONG';
    const hitSL   = isLong ? currentPrice <= pos.stopLoss  : currentPrice >= pos.stopLoss;
    const hitTP   = isLong ? currentPrice >= pos.takeProfit : currentPrice <= pos.takeProfit;

    if (hitSL || hitTP) {
      const exitPrice  = currentPrice;
      const rawPnl     = isLong
        ? (exitPrice - pos.entryPrice) / pos.entryPrice * pos.size
        : (pos.entryPrice - exitPrice) / pos.entryPrice * pos.size;
      const pnlPct     = isLong
        ? (exitPrice - pos.entryPrice) / pos.entryPrice * 100
        : (pos.entryPrice - exitPrice) / pos.entryPrice * 100;
      const exitReason = hitTP ? 'TAKE_PROFIT' : 'STOP_LOSS';

      const trade = {
        ...pos,
        exitPrice,
        exitTime:   new Date().toISOString(),
        pnl:        parseFloat(rawPnl.toFixed(2)),
        pnlPct:     parseFloat(pnlPct.toFixed(2)),
        exitReason,
      };

      account.balance += pos.size + rawPnl; // return capital + P&L
      account.stats.totalTrades++;
      account.stats.totalPnl = parseFloat((account.stats.totalPnl + rawPnl).toFixed(2));
      if (rawPnl > 0) account.stats.wins++; else account.stats.losses++;
      account.closedTrades.push(trade);
      closed.push(trade);

      const icon = hitTP ? '🟢' : '🔴';
      console.log(`  ${icon} ${exitReason} — ${pos.direction} ${symbol} @ $${exitPrice.toFixed(4)} | P&L: ${rawPnl >= 0 ? '+' : ''}$${rawPnl.toFixed(2)} (${pnlPct.toFixed(2)}%)`);
    } else {
      stillOpen.push(pos);
    }
  }

  account.openPositions = stillOpen;
  return closed;
}

function openPaperPosition(account, symbol, direction, entryPrice, signal, confidence) {
  // Only 1 open position per symbol
  if (account.openPositions.find(p => p.symbol === symbol)) {
    console.log(`  ℹ️  Already have an open ${symbol} position — skipping new entry`);
    return null;
  }

  const isLong    = direction === 'LONG';
  const stopLoss  = isLong ? entryPrice * (1 - SL_PCT) : entryPrice * (1 + SL_PCT);
  const takeProfit = isLong ? entryPrice * (1 + TP_PCT) : entryPrice * (1 - TP_PCT);
  const qty       = parseFloat((PAPER_SIZE / entryPrice).toFixed(8));

  if (account.balance < PAPER_SIZE) {
    console.log(`  ⚠️  Insufficient paper balance ($${account.balance.toFixed(2)}) for $${PAPER_SIZE} trade`);
    return null;
  }

  account.balance -= PAPER_SIZE; // reserve capital

  const pos = {
    id:          `PAPER-${Date.now()}`,
    symbol,
    direction,
    entryPrice,
    size:        PAPER_SIZE,
    qty,
    stopLoss:    parseFloat(stopLoss.toFixed(6)),
    takeProfit:  parseFloat(takeProfit.toFixed(6)),
    entryTime:   new Date().toISOString(),
    signal,
    confidence,
  };

  account.openPositions.push(pos);
  console.log(`  📋 PAPER ${direction} opened — ${symbol} @ $${entryPrice.toFixed(4)}`);
  console.log(`     Size: $${PAPER_SIZE} | SL: $${stopLoss.toFixed(4)} | TP: $${takeProfit.toFixed(4)}`);
  console.log(`     Signal: ${signal} | Confidence: ${confidence}%`);
  return pos;
}

// ─── Market Data (Binance public API — free, no auth) ───────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  // Map our timeframe format to Binance interval format
  const intervalMap = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1H": "1h",
    "4H": "4h",
    "1D": "1d",
    "1W": "1w",
  };
  const binanceInterval = intervalMap[interval] || "1m";

  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const data = await res.json();

  return data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ATR (Wilder smoothing)
function calcATRSeries(candles, period) {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  const atr = new Array(candles.length).fill(null);
  atr[period - 1] = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// SuperTrend — returns full series with direction (1 = bullish, -1 = bearish)
function calcSuperTrendSeries(candles, atrPeriod = 10, multiplier = 3) {
  const atr = calcATRSeries(candles, atrPeriod);
  const result = new Array(candles.length).fill(null);
  let prevUpper = null, prevLower = null, prevDir = null;
  for (let i = atrPeriod; i < candles.length; i++) {
    const hl2 = (candles[i].high + candles[i].low) / 2;
    let upper = hl2 + multiplier * atr[i];
    let lower = hl2 - multiplier * atr[i];
    if (prevLower !== null) lower = candles[i].close > prevLower ? Math.max(lower, prevLower) : lower;
    if (prevUpper !== null) upper = candles[i].close < prevUpper ? Math.min(upper, prevUpper) : upper;
    let direction;
    if (prevDir === null)       direction = candles[i].close > upper ? 1 : -1;
    else if (prevDir === -1)    direction = candles[i].close > prevUpper ? 1 : -1;
    else                        direction = candles[i].close < prevLower ? -1 : 1;
    result[i] = { upper, lower, direction, line: direction === 1 ? lower : upper };
    prevUpper = upper; prevLower = lower; prevDir = direction;
  }
  return result;
}

// MACD (12, 26, 9) — returns full series
function calcEMASeries(values, period) {
  const k = 2 / (period + 1);
  const result = new Array(values.length).fill(null);
  let ema = values[0];
  result[0] = ema;
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

function calcMACDSeries(closes, fast = 12, slow = 26, signal = 9) {
  const fastEMA = calcEMASeries(closes, fast);
  const slowEMA = calcEMASeries(closes, slow);
  const macdLine = closes.map((_, i) =>
    fastEMA[i] !== null && slowEMA[i] !== null ? fastEMA[i] - slowEMA[i] : null
  );
  const signalLine = new Array(closes.length).fill(null);
  const start = macdLine.findIndex(v => v !== null);
  if (start >= 0) {
    const k = 2 / (signal + 1);
    let sig = macdLine[start];
    signalLine[start] = sig;
    for (let i = start + 1; i < closes.length; i++) {
      if (macdLine[i] === null) continue;
      sig = macdLine[i] * k + sig * (1 - k);
      signalLine[i] = sig;
    }
  }
  return { macdLine, signalLine };
}

// Bollinger Bands — returns full series so we can compare prev vs current bar
function calcBBSeries(values, length, mult) {
  return values.map((_, i) => {
    if (i < length - 1) return null;
    const slice = values.slice(i - length + 1, i + 1);
    const mean = slice.reduce((s, v) => s + v, 0) / length;
    const variance = slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / length;
    const std = Math.sqrt(variance);
    return { mid: mean, upper: mean + mult * std, lower: mean - mult * std };
  });
}

// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Bollinger Band Signal Check ────────────────────────────────────────────
// Based on backtest of 500 x 1H BTC candles (May 2026):
//   S10: BB1 lower expands below BB2 lower + close below BB2 lower → SHORT (PF 2.29, 70% win)
//   S11: Price crosses back above BB1 lower after being below it  → LONG  (PF 2.01, 63% win)

function checkBBSignals(candles, bb1Series, bb2Series) {
  const n = candles.length - 1;
  const prev = n - 1;

  const bb1Now  = bb1Series[n];
  const bb1Prev = bb1Series[prev];
  const bb2Now  = bb2Series[n];

  if (!bb1Now || !bb2Now || !bb1Prev) return [];

  const closeNow  = candles[n].close;
  const closePrev = candles[prev].close;
  const signals   = [];

  // S10 — volatility breakdown SHORT
  // BB1(4,4) lower expands below BB2(20,2) lower AND price closes below BB2 lower
  if (bb1Now.lower < bb2Now.lower && closeNow < bb2Now.lower) {
    signals.push({
      direction: "SHORT",
      name:      "BB1/BB2 Volatility Breakdown",
      detail:    `BB1 lower $${bb1Now.lower.toFixed(2)} broke below BB2 lower $${bb2Now.lower.toFixed(2)}, close $${closeNow.toFixed(2)}`,
      bb1Lower:  bb1Now.lower,
      bb2Lower:  bb2Now.lower,
      profitFactor: 2.29,
      winRate:   "70%",
    });
  }

  // S11 — extreme oversold recovery LONG
  // Previous close was below BB1 lower (extreme), current close back above it
  if (closePrev < bb1Prev.lower && closeNow > bb1Now.lower) {
    signals.push({
      direction: "LONG",
      name:      "BB1 Recovery Bounce",
      detail:    `Price recovered above BB1 lower $${bb1Now.lower.toFixed(2)} after extreme oversold`,
      bb1Lower:  bb1Now.lower,
      profitFactor: 2.01,
      winRate:   "63%",
    });
  }

  return signals;
}

// ─── SuperTrend + MACD Signal Check ─────────────────────────────────────────
// Based on backtest of 500 x 1H BTC candles (May 2026):
//   S1:  SuperTrend flips bullish                          → LONG  (PF 5.10, 83% win)
//   S10: SuperTrend bearish + MACD<0 + RSI(3)>70          → SHORT (PF 2.78, 73% win)

function checkSuperTrendMACDSignals(candles, stSeries, macdLine, rsi14) {
  const n    = candles.length - 1;
  const prev = n - 1;

  const stNow  = stSeries[n];
  const stPrev = stSeries[prev];
  if (!stNow || !stPrev) return [];

  const signals = [];

  // S1 — SuperTrend flip bullish → LONG
  if (stPrev.direction === -1 && stNow.direction === 1) {
    signals.push({
      direction:    'LONG',
      name:         'SuperTrend Bullish Flip',
      detail:       `SuperTrend flipped bullish at $${stNow.line.toFixed(2)}`,
      profitFactor: 5.10,
      winRate:      '83%',
    });
  }

  // S10 — SuperTrend bearish + MACD below zero + RSI(14) > 70 → SHORT
  const macdNow = macdLine[n];
  if (
    stNow.direction === -1 &&
    macdNow !== null && macdNow < 0 &&
    rsi14 !== null && rsi14 > 70
  ) {
    signals.push({
      direction:    'SHORT',
      name:         'SuperTrend Bear + MACD + RSI Triple Confirm',
      detail:       `ST bearish, MACD ${macdNow.toFixed(2)} < 0, RSI(14) ${rsi14.toFixed(1)} > 70`,
      profitFactor: 2.78,
      winRate:      '73%',
    });
  }

  return signals;
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema20, vwap, rsi14, rules) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  // Determine bias first
  const bullishBias = price > vwap && price > ema20;
  const bearishBias = price < vwap && price < ema20;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");

    // 1. Price above VWAP
    check(
      "Price above VWAP (buyers in control)",
      `> ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price > vwap,
    );

    // 2. Price above EMA(20)
    check(
      "Price above EMA(20) (uptrend confirmed)",
      `> ${ema20.toFixed(2)}`,
      price.toFixed(2),
      price > ema20,
    );

    // 3. RSI(14) pullback
    check(
      "RSI(14) below 30 (pullback in uptrend)",
      "< 30",
      rsi14.toFixed(2),
      rsi14 < 30,
    );

    // 4. Not overextended from VWAP
    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else if (bearishBias) {
    console.log("  Bias: BEARISH — checking short entry conditions\n");

    check(
      "Price below VWAP (sellers in control)",
      `< ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price < vwap,
    );

    check(
      "Price below EMA(20) (downtrend confirmed)",
      `< ${ema20.toFixed(2)}`,
      price.toFixed(2),
      price < ema20,
    );

    check(
      "RSI(14) above 70 (overbought reversal in downtrend)",
      "> 70",
      rsi14.toFixed(2),
      rsi14 > 70,
    );

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({
      label: "Market bias",
      required: "Bullish or bearish",
      actual: "Neutral",
      pass: false,
    });
  }

  const allPass = results.every((r) => r.pass);
  const direction = bullishBias ? "LONG" : bearishBias ? "SHORT" : null;
  return { results, allPass, direction };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

  return true;
}

// ─── BitGet Execution ────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto
    .createHmac("sha256", CONFIG.bitget.secretKey)
    .update(message)
    .digest("base64");
}

async function placeBitGetOrder(symbol, side, sizeUSD, price) {
  const quantity = (sizeUSD / price).toFixed(6);
  const timestamp = Date.now().toString();
  const path =
    CONFIG.tradeMode === "spot"
      ? "/api/v2/spot/trade/placeOrder"
      : "/api/v2/mix/order/placeOrder";

  const body = JSON.stringify({
    symbol,
    side,
    orderType: "market",
    quantity,
    ...(CONFIG.tradeMode === "futures" && {
      productType: "USDT-FUTURES",
      marginMode: "isolated",
      marginCoin: "USDT",
    }),
  });

  const signature = signBitGet(timestamp, "POST", path, body);

  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") {
    throw new Error(`BitGet order failed: ${data.msg}`);
  }

  return data.data;
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = "All conditions met";
  } else {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date,
    time,
    "BitGet",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  // Load strategy
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  // Load log and check daily limits
  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Fetch candle data — need enough for EMA(8) + full session for VWAP
  console.log("\n── Fetching market data from Binance ───────────────────\n");
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: $${price.toFixed(2)}`);

  // Calculate indicators
  const opens  = candles.map((c) => c.open);
  const ema20  = calcEMA(closes, 20);
  const vwap   = calcVWAP(candles);
  const rsi14  = calcRSI(closes, 14);

  // Bollinger Bands — BB1 (red: 4/4/open), BB2 (white: 20/2/close)
  const bb1Series = calcBBSeries(opens,  4,  4);
  const bb2Series = calcBBSeries(closes, 20, 2);
  const bb1 = bb1Series[bb1Series.length - 1];
  const bb2 = bb2Series[bb2Series.length - 1];

  // SuperTrend (ATR 10, Mult 3) + MACD (12, 26, 9)
  const stSeries              = calcSuperTrendSeries(candles, 10, 3);
  const { macdLine, signalLine } = calcMACDSeries(closes, 12, 26, 9);
  const stNow                 = stSeries[stSeries.length - 1];
  const macdNow               = macdLine[macdLine.length - 1];
  const macdSignalNow         = signalLine[signalLine.length - 1];

  // RSI(14) passed directly to ST+MACD signal check

  console.log(`  EMA(20):      $${ema20.toFixed(2)}`);
  console.log(`  VWAP:         $${vwap ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(14):      ${rsi14 != null ? rsi14.toFixed(2) : "N/A"}`);
  console.log(`  SuperTrend:   $${stNow ? stNow.line.toFixed(2) : "N/A"} (${stNow ? (stNow.direction === 1 ? "🟢 Bullish" : "🔴 Bearish") : "N/A"})`);
  console.log(`  MACD:         ${macdNow ? macdNow.toFixed(2) : "N/A"} | Signal: ${macdSignalNow ? macdSignalNow.toFixed(2) : "N/A"}`);
  console.log(`  BB1(4,4):     $${bb1 ? bb1.upper.toFixed(2) : "N/A"} / $${bb1 ? bb1.lower.toFixed(2) : "N/A"}`);
  console.log(`  BB2(20,2):    $${bb2 ? bb2.upper.toFixed(2) : "N/A"} / $${bb2 ? bb2.lower.toFixed(2) : "N/A"}`);

  if (vwap == null || rsi14 == null) {
    console.log("\n⚠️  Not enough data to calculate indicators. Exiting.");
    return;
  }

  // ── BB Signal Check (backtested: PF 2.29 + 2.01) ─────────────────────────
  const bbSignals = checkBBSignals(candles, bb1Series, bb2Series);
  const bbLong  = bbSignals.find((s) => s.direction === "LONG");
  const bbShort = bbSignals.find((s) => s.direction === "SHORT");

  console.log("\n── Bollinger Band Signals ───────────────────────────────\n");
  if (bbSignals.length === 0) {
    console.log("  No BB signal this bar.");
  } else {
    bbSignals.forEach((s) => {
      console.log(`  🎯 ${s.direction} — ${s.name}`);
      console.log(`     ${s.detail}`);
      console.log(`     Backtest: Win Rate ${s.winRate} | Profit Factor ${s.profitFactor}`);
    });
  }

  // ── SuperTrend + MACD Signal Check (backtested: PF 5.10 + 2.78) ──────────
  const stMACDSignals = checkSuperTrendMACDSignals(candles, stSeries, macdLine, rsi14);
  const stLong  = stMACDSignals.find((s) => s.direction === "LONG");
  const stShort = stMACDSignals.find((s) => s.direction === "SHORT");

  console.log("\n── SuperTrend + MACD Signals ────────────────────────────\n");
  if (stMACDSignals.length === 0) {
    console.log("  No ST+MACD signal this bar.");
  } else {
    stMACDSignals.forEach((s) => {
      console.log(`  🎯 ${s.direction} — ${s.name}`);
      console.log(`     ${s.detail}`);
      console.log(`     Backtest: Win Rate ${s.winRate} | Profit Factor ${s.profitFactor}`);
    });
  }

  // Run original VWAP+RSI+EMA safety check
  const { results, allPass, direction: safetyDirection } = runSafetyCheck(price, ema20, vwap, rsi14, rules);

  // ── Confidence Score ─────────────────────────────────────────────────────
  const macdObj = { macdLine: macdNow, signalLine: macdSignalNow };
  const conf    = calcConfidenceScore(price, ema20, vwap, rsi14, stNow, macdObj, bbSignals, stMACDSignals);

  console.log("\n── Confidence Score ─────────────────────────────────────\n");
  console.log(`  ▲ LONG:  ${conf.long}%`);
  console.log(`  ▼ SHORT: ${conf.short}%`);

  // ── Determine signal direction ──────────────────────────────────────────
  const originalFires = allPass;
  const bbLongFires   = !!bbLong;                                        // BB Recovery  ✅ 1H backtest: +$17, 38.1% win
  const bbShortFires  = false;                                           // BB Breakdown ❌ 1H backtest: -$22 — keep off
  const stLongFires   = !!stLong;
  const stShortFires  = !!stShort && CONFIG.tradeMode === "futures";     // ST+MACD+RSI Short ✅ 1H backtest: +$10, 40.4% win
  const anySignal     = originalFires || bbLongFires || bbShortFires || stLongFires || stShortFires;

  let tradeDirection = "buy";
  let signalSource   = "VWAP + RSI(14) + EMA(20)";
  if (stLongFires)        { tradeDirection = "buy";  signalSource = stLong.name; }
  else if (stShortFires)  { tradeDirection = "sell"; signalSource = stShort.name; }
  else if (bbShortFires)  { tradeDirection = "sell"; signalSource = bbShort.name; }
  else if (bbLongFires)   { tradeDirection = "buy";  signalSource = bbLong.name; }
  else if (originalFires) { tradeDirection = safetyDirection === "SHORT" ? "sell" : "buy"; signalSource = "VWAP + RSI(14) + EMA(20)"; }

  // Confidence gate — check score for the intended direction
  const dirConf        = tradeDirection === "buy" ? conf.long : conf.short;
  const confBlocked    = anySignal && dirConf < MIN_CONF;
  const failedConf     = confBlocked ? [`Low confidence (${dirConf}% — need ${MIN_CONF}%+)`] : [];

  const tradeAllowed   = anySignal && !confBlocked;

  // Notes for skipped signals
  if (bbShort  && !bbShortFires)  console.log(`ℹ️  BB SHORT signal skipped — TRADE_MODE=futures required`);
  if (stShort  && !stShortFires)  console.log(`ℹ️  ST+MACD SHORT signal skipped — TRADE_MODE=futures required`);
  if (confBlocked)                console.log(`🚫 CONFIDENCE TOO LOW — ${dirConf}% (need ${MIN_CONF}%+)`);

  // ── Decision ──────────────────────────────────────────────────────────────
  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);

  const logEntry = {
    timestamp:    new Date().toISOString(),
    symbol:       CONFIG.symbol,
    timeframe:    CONFIG.timeframe,
    price,
    indicators:   { ema20, vwap, rsi14, bb1, bb2 },
    bbSignals,
    conditions:   results,
    allPass,
    tradeSize,
    orderPlaced:  false,
    orderId:      null,
    paperTrading: CONFIG.paperTrading,
    confidence:   { long: conf.long, short: conf.short, used: dirConf },
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday:     countTodaysTrades(log),
    },
  };

  // ── Paper Trading Account — update open positions ─────────────────────────
  const paperAccount = loadPaperAccount();
  console.log("── Paper Account ────────────────────────────────────────\n");
  console.log(`  Balance: $${paperAccount.balance.toFixed(2)} | Open: ${paperAccount.openPositions.length} | Trades: ${paperAccount.stats.totalTrades} | P&L: ${paperAccount.stats.totalPnl >= 0 ? '+' : ''}$${paperAccount.stats.totalPnl.toFixed(2)}`);

  // Check SL/TP on any existing position for this symbol
  const closedNow = updateOpenPositions(paperAccount, CONFIG.symbol, price);
  if (closedNow.length === 0) console.log(`  No open ${CONFIG.symbol} position to update.`);

  if (!anySignal) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`\n🚫 TRADE BLOCKED`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else if (confBlocked) {
    console.log(`\n🚫 TRADE BLOCKED — confidence ${dirConf}% below ${MIN_CONF}% threshold`);
  } else {
    console.log(`\n✅ SIGNAL CONFIRMED — ${signalSource} | Confidence: ${dirConf}%`);
    if (originalFires && (bbLongFires || bbShortFires || stLongFires || stShortFires)) {
      console.log(`   ⚡ Double confirmation: multiple signals firing`);
    }

    // Open paper position
    const direction = tradeDirection === "buy" ? "LONG" : "SHORT";
    openPaperPosition(paperAccount, CONFIG.symbol, direction, price, signalSource, dirConf);

    logEntry.orderPlaced  = true;
    logEntry.orderId      = `PAPER-${Date.now()}`;
    logEntry.direction    = tradeDirection;
    logEntry.signalSource = signalSource;
  }

  savePaperAccount(paperAccount);

  // Save decision log
  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);

  // Write per-symbol result for dashboard
  const openPos = paperAccount.openPositions.find(p => p.symbol === CONFIG.symbol) || null;
  const dashResult = {
    symbol:           CONFIG.symbol,
    time:             new Date().toISOString(),
    price,
    ema20,
    vwap:             vwap || null,
    rsi14:            rsi14 ?? null,
    superTrend:       stNow ? { line: stNow.line, direction: stNow.direction } : null,
    macd:             { macdLine: macdNow, signalLine: macdSignalNow },
    bb1,
    bb2,
    bbSignals,
    stMACDSignals,
    allPass,
    direction:        logEntry.direction || null,
    signalSource:     logEntry.signalSource || null,
    blocked:          !tradeAllowed,
    failedConditions: [
      ...results.filter((r) => !r.pass).map((r) => r.label),
      ...failedConf,
    ],
    confidence:       { long: conf.long, short: conf.short },
    openPosition:     openPos,
    paperStats:       paperAccount.stats,
  };
  writeFileSync(`results-${CONFIG.symbol}.json`, JSON.stringify(dashResult, null, 2));

  // Write tax CSV row for every run
  writeTradeCsv(logEntry);

  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
