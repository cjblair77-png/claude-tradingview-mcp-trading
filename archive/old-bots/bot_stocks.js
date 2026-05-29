/**
 * US Stocks Paper Trading Bot
 *
 * Uses Yahoo Finance free API (no key needed).
 * Long-only — backtest showed ST+MACD+RSI Short drags stocks (-$9.39 on 5%/15%).
 * Signals: ST Bullish Flip (LONG) · BB Recovery Bounce (LONG)
 * SL: 5% | TP: 15% | $50/trade
 *
 * Usage: SYMBOL=AAPL node bot_stocks.js
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

// ─── Config ────────────────────────────────────────────────────────────────

const SYMBOL     = process.env.SYMBOL || "AAPL";
const SL_PCT     = 0.05;   // 5% SL — backtest winner
const TP_PCT     = 0.15;   // 15% TP — 1:3 R:R
const MIN_CONF   = 65;     // minimum confidence %
const PAPER_SIZE = 50;     // $ per trade
const PAPER_FILE = "paper_account_stocks.json";

// ─── Market Hours Check ───────────────────────────────────────────────────
// NYSE/NASDAQ: 9:30 AM – 4:00 PM ET
// EDT = UTC-4 (Mar–Nov) | EST = UTC-5 (Nov–Mar)

function isMarketOpen() {
  const now     = new Date();
  const dayUTC  = now.getUTCDay();        // 0=Sun, 6=Sat
  if (dayUTC === 0 || dayUTC === 6) return false;

  // Determine ET offset: DST active Mar 2nd Sun – Nov 1st Sun
  const year  = now.getUTCFullYear();
  const dstStart = nthSunday(year, 2,  2); // March 2nd Sun
  const dstEnd   = nthSunday(year, 10, 1); // Nov 1st Sun
  const isDST    = now >= dstStart && now < dstEnd;
  const etOffset = isDST ? -4 : -5;       // hours behind UTC

  const etHour = now.getUTCHours() + etOffset;
  const etMin  = now.getUTCMinutes();
  const etTotalMin = ((etHour % 24 + 24) % 24) * 60 + etMin;

  const openMin  = 9 * 60 + 30;   // 9:30 AM ET
  const closeMin = 16 * 60;        // 4:00 PM ET
  return etTotalMin >= openMin && etTotalMin < closeMin;
}

function nthSunday(year, month, n) {
  // month: 0-indexed (2=March, 10=November)
  const d = new Date(Date.UTC(year, month, 1));
  d.setUTCDate(1 + ((7 - d.getUTCDay()) % 7) + (n - 1) * 7);
  return d;
}

// ─── Yahoo Finance Data Fetch ──────────────────────────────────────────────

async function fetchStockCandles(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1h&range=5d&includePrePost=false`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`Yahoo Finance ${res.status} for ${symbol}`);
  const data = await res.json();

  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No data returned for ${symbol}`);

  const timestamps = result.timestamp || [];
  const q          = result.indicators.quote[0];
  const currentPrice = result.meta.regularMarketPrice;

  const candles = timestamps
    .map((t, i) => ({
      time:   t * 1000,
      open:   q.open[i]   ?? null,
      high:   q.high[i]   ?? null,
      low:    q.low[i]    ?? null,
      close:  q.close[i]  ?? null,
      volume: q.volume[i] ?? 0,
    }))
    .filter((c) => c.open !== null && c.high !== null && c.low !== null && c.close !== null);

  return { candles, currentPrice };
}

// ─── VWAP — resets at 9:30 AM ET each trading day ─────────────────────────

function calcStockVWAP(candles) {
  // Find today's 9:30 AM ET in UTC ms
  const now        = new Date();
  const year       = now.getUTCFullYear();
  const dstStart   = nthSunday(year, 2, 2);
  const dstEnd     = nthSunday(year, 10, 1);
  const isDST      = now >= dstStart && now < dstEnd;
  const etOffset   = isDST ? -4 : -5;

  // Build 9:30 AM ET today in UTC
  const etNow      = new Date(now.getTime() + etOffset * 3600 * 1000);
  const marketOpen = new Date(Date.UTC(
    etNow.getUTCFullYear(), etNow.getUTCMonth(), etNow.getUTCDate(),
    9 - etOffset, 30, 0, 0   // 9:30 ET = 9:30 + |etOffset| UTC
  ));

  const sessionCandles = candles.filter((c) => c.time >= marketOpen.getTime());
  if (sessionCandles.length === 0) return null;

  const cumTPV = sessionCandles.reduce(
    (s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0
  );
  const cumVol = sessionCandles.reduce((s, c) => s + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Indicator Calculations (identical to bot.js) ──────────────────────────

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const ag = gains / period, al = losses / period;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function calcATRSeries(candles, period) {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  const atr = new Array(candles.length).fill(null);
  atr[period - 1] = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < candles.length; i++)
    atr[i] = (atr[i - 1] * (period - 1) + trs[i]) / period;
  return atr;
}

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
    let dir;
    if   (prevDir === null)    dir = candles[i].close > upper ? 1 : -1;
    else if (prevDir === -1)   dir = candles[i].close > prevUpper ? 1 : -1;
    else                       dir = candles[i].close < prevLower ? -1 : 1;
    result[i] = { upper, lower, direction: dir, line: dir === 1 ? lower : upper };
    prevUpper = upper; prevLower = lower; prevDir = dir;
  }
  return result;
}

function calcEMASeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let ema = values[0]; out[0] = ema;
  for (let i = 1; i < values.length; i++) { ema = values[i] * k + ema * (1 - k); out[i] = ema; }
  return out;
}

function calcMACDSeries(closes, fast = 12, slow = 26, signal = 9) {
  const fastEMA  = calcEMASeries(closes, fast);
  const slowEMA  = calcEMASeries(closes, slow);
  const macdLine = closes.map((_, i) =>
    fastEMA[i] !== null && slowEMA[i] !== null ? fastEMA[i] - slowEMA[i] : null
  );
  const signalLine = new Array(closes.length).fill(null);
  const start = macdLine.findIndex((v) => v !== null);
  if (start >= 0) {
    const k = 2 / (signal + 1); let sig = macdLine[start]; signalLine[start] = sig;
    for (let i = start + 1; i < closes.length; i++) {
      if (macdLine[i] === null) continue;
      sig = macdLine[i] * k + sig * (1 - k); signalLine[i] = sig;
    }
  }
  return { macdLine, signalLine };
}

function calcBBSeries(values, length, mult) {
  return values.map((_, i) => {
    if (i < length - 1) return null;
    const slice = values.slice(i - length + 1, i + 1);
    const mean  = slice.reduce((s, v) => s + v, 0) / length;
    const std   = Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / length);
    return { mid: mean, upper: mean + mult * std, lower: mean - mult * std };
  });
}

// ─── Confidence Score ────────────────────────────────────────────────────────

function calcConfidence(price, ema20, vwap, rsi14, st, macd, bbSignals, stSignals) {
  const rsi = rsi14 ?? 50;
  let L = 0;

  // Trend alignment (35 pts)
  if (st)    { if (st.direction === 1) L += 20; }
  if (ema20) { if (price > ema20)      L += 10; }
  if (vwap)  { if (price > vwap)       L += 5;  }

  // MACD momentum (25 pts)
  if (macd) {
    if (macd.macdLine > 0)               L += 12;
    if (macd.macdLine > macd.signalLine) L += 13;
  }

  // RSI timing (25 pts)
  if      (rsi < 30) L += 25;
  else if (rsi < 40) L += 15;
  else if (rsi < 50) L += 5;

  // Active signal bonus (15 pts)
  if (stSignals?.find((s) => s.direction === "LONG"))  L += 15;
  if (bbSignals?.find((s) => s.direction === "LONG"))  L += 10;

  return Math.min(L, 100);
}

// ─── Signal Checks ───────────────────────────────────────────────────────────

function checkBBSignals(candles, bb1Series, bb2Series) {
  const n = candles.length - 1;
  const bb1Now = bb1Series[n], bb1Prev = bb1Series[n - 1], bb2Now = bb2Series[n];
  if (!bb1Now || !bb2Now || !bb1Prev) return [];

  const closeNow = candles[n].close, closePrev = candles[n - 1].close;
  const signals = [];

  // BB Recovery Bounce LONG: prev close below BB1 lower → now back above
  if (closePrev < bb1Prev.lower && closeNow > bb1Now.lower) {
    signals.push({
      direction: "LONG",
      name:      "BB1 Recovery Bounce",
      detail:    `Price recovered above BB1 lower $${bb1Now.lower.toFixed(2)} after extreme oversold`,
    });
  }
  return signals;
}

function checkSuperTrendSignals(candles, stSeries) {
  const n    = candles.length - 1;
  const stNow  = stSeries[n];
  const stPrev = stSeries[n - 1];
  if (!stNow || !stPrev) return [];

  const signals = [];
  // SuperTrend Bullish Flip LONG
  if (stPrev.direction === -1 && stNow.direction === 1) {
    signals.push({
      direction: "LONG",
      name:      "SuperTrend Bullish Flip",
      detail:    `SuperTrend flipped bullish at $${stNow.line.toFixed(2)}`,
    });
  }
  return signals;
}

// ─── Paper Trading Account ────────────────────────────────────────────────────

function loadPaperAccount() {
  if (!existsSync(PAPER_FILE)) {
    const acc = {
      balance:       1000,
      startBalance:  1000,
      openPositions: [],
      closedTrades:  [],
      stats: { totalTrades: 0, wins: 0, losses: 0, totalPnl: 0 },
    };
    writeFileSync(PAPER_FILE, JSON.stringify(acc, null, 2));
    console.log(`📋 Paper account created — starting balance $1000`);
    return acc;
  }
  return JSON.parse(readFileSync(PAPER_FILE, "utf8"));
}

function savePaperAccount(acc) {
  writeFileSync(PAPER_FILE, JSON.stringify(acc, null, 2));
}

function updateOpenPositions(acc, symbol, currentPrice) {
  const stillOpen = [], closed = [];
  for (const pos of acc.openPositions) {
    if (pos.symbol !== symbol) { stillOpen.push(pos); continue; }

    const hitSL = currentPrice <= pos.stopLoss;
    const hitTP = currentPrice >= pos.takeProfit;

    if (hitSL || hitTP) {
      const rawPnl     = (currentPrice - pos.entryPrice) / pos.entryPrice * pos.size;
      const pnlPct     = (currentPrice - pos.entryPrice) / pos.entryPrice * 100;
      const exitReason = hitTP ? "TAKE_PROFIT" : "STOP_LOSS";

      const trade = {
        ...pos,
        exitPrice:  currentPrice,
        exitTime:   new Date().toISOString(),
        pnl:        parseFloat(rawPnl.toFixed(2)),
        pnlPct:     parseFloat(pnlPct.toFixed(2)),
        exitReason,
      };

      acc.balance += pos.size + rawPnl;
      acc.stats.totalTrades++;
      acc.stats.totalPnl = parseFloat((acc.stats.totalPnl + rawPnl).toFixed(2));
      if (rawPnl > 0) acc.stats.wins++; else acc.stats.losses++;
      acc.closedTrades.push(trade);
      closed.push(trade);

      const icon = hitTP ? "🟢" : "🔴";
      console.log(`  ${icon} ${exitReason} — LONG ${symbol} @ $${currentPrice.toFixed(2)} | P&L: ${rawPnl >= 0 ? "+" : ""}$${rawPnl.toFixed(2)} (${pnlPct.toFixed(2)}%)`);
    } else {
      stillOpen.push(pos);
    }
  }
  acc.openPositions = stillOpen;
  return closed;
}

function openPaperPosition(acc, symbol, entryPrice, signal, confidence) {
  if (acc.openPositions.find((p) => p.symbol === symbol)) {
    console.log(`  ℹ️  Already have an open ${symbol} position — skipping`);
    return null;
  }
  if (acc.balance < PAPER_SIZE) {
    console.log(`  ⚠️  Insufficient balance ($${acc.balance.toFixed(2)}) for $${PAPER_SIZE} trade`);
    return null;
  }

  const stopLoss   = entryPrice * (1 - SL_PCT);
  const takeProfit = entryPrice * (1 + TP_PCT);
  const qty        = parseFloat((PAPER_SIZE / entryPrice).toFixed(8));

  acc.balance -= PAPER_SIZE;

  const pos = {
    id:          `PAPER-STOCK-${Date.now()}`,
    symbol,
    direction:   "LONG",
    entryPrice,
    size:        PAPER_SIZE,
    qty,
    stopLoss:    parseFloat(stopLoss.toFixed(4)),
    takeProfit:  parseFloat(takeProfit.toFixed(4)),
    entryTime:   new Date().toISOString(),
    signal,
    confidence,
  };

  acc.openPositions.push(pos);
  console.log(`  📋 PAPER LONG opened — ${symbol} @ $${entryPrice.toFixed(2)}`);
  console.log(`     Size: $${PAPER_SIZE} | SL: $${stopLoss.toFixed(2)} | TP: $${takeProfit.toFixed(2)}`);
  console.log(`     Signal: ${signal} | Confidence: ${confidence}%`);
  return pos;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  US Stocks Paper Bot  |  ${SYMBOL}  |  ${new Date().toISOString()}`);
  console.log("═══════════════════════════════════════════════════════════");

  // ── Market hours gate ─────────────────────────────────────────────────────
  if (!isMarketOpen()) {
    console.log(`\n⏰ Market is closed right now. US market: 9:30 AM – 4:00 PM ET, Mon–Fri.\n`);

    // Still update SL/TP on open positions using last known price
    const acc = loadPaperAccount();
    const openForSymbol = acc.openPositions.filter((p) => p.symbol === SYMBOL);
    if (openForSymbol.length > 0) {
      console.log(`  ℹ️  Have open ${SYMBOL} position — checking price anyway`);
    } else {
      writeResultFile(SYMBOL, null, null, null, null, null, null, null, null, null, acc, "MARKET_CLOSED");
      return;
    }
  }

  // ── Fetch data ────────────────────────────────────────────────────────────
  console.log(`\n── Fetching ${SYMBOL} from Yahoo Finance ─────────────────\n`);
  let candles, currentPrice;
  try {
    ({ candles, currentPrice } = await fetchStockCandles(SYMBOL));
  } catch (err) {
    console.error(`  ❌ Failed to fetch ${SYMBOL}: ${err.message}`);
    return;
  }

  if (candles.length < 30) {
    console.log(`  ⚠️  Only ${candles.length} candles — not enough data. Skipping.`);
    return;
  }

  const closes = candles.map((c) => c.close);
  const opens  = candles.map((c) => c.open);
  const price  = currentPrice || closes[closes.length - 1];

  console.log(`  Current price: $${price.toFixed(2)}  (${candles.length} bars loaded)`);

  // ── Indicators ────────────────────────────────────────────────────────────
  const ema20  = calcEMA(closes, 20);
  const vwap   = calcStockVWAP(candles);
  const rsi14  = calcRSI(closes, 14);
  const bb1Series = calcBBSeries(opens,  4,  4);
  const bb2Series = calcBBSeries(closes, 20, 2);
  const stSeries  = calcSuperTrendSeries(candles, 10, 3);
  const { macdLine, signalLine } = calcMACDSeries(closes, 12, 26, 9);

  const stNow       = stSeries[stSeries.length - 1];
  const macdNow     = macdLine[macdLine.length - 1];
  const macdSigNow  = signalLine[signalLine.length - 1];

  console.log(`  EMA(20):     $${ema20.toFixed(2)}`);
  console.log(`  VWAP:        $${vwap ? vwap.toFixed(2) : "N/A (pre-market?)"}`);
  console.log(`  RSI(14):     ${rsi14 != null ? rsi14.toFixed(2) : "N/A"}`);
  console.log(`  SuperTrend:  $${stNow ? stNow.line.toFixed(2) : "N/A"} (${stNow ? (stNow.direction === 1 ? "🟢 Bullish" : "🔴 Bearish") : "N/A"})`);
  console.log(`  MACD:        ${macdNow ? macdNow.toFixed(4) : "N/A"} | Signal: ${macdSigNow ? macdSigNow.toFixed(4) : "N/A"}`);

  // ── Signals ───────────────────────────────────────────────────────────────
  const bbSignals = checkBBSignals(candles, bb1Series, bb2Series);
  const stSignals = checkSuperTrendSignals(candles, stSeries);
  const allSignals = [...stSignals, ...bbSignals];

  console.log(`\n── Signals ──────────────────────────────────────────────\n`);
  if (allSignals.length === 0) {
    console.log("  No signal this bar.");
  } else {
    allSignals.forEach((s) => {
      console.log(`  🎯 ${s.direction} — ${s.name}`);
      console.log(`     ${s.detail}`);
    });
  }

  // ── Confidence ────────────────────────────────────────────────────────────
  const macdObj = { macdLine: macdNow, signalLine: macdSigNow };
  const conf    = calcConfidence(price, ema20, vwap, rsi14, stNow, macdObj, bbSignals, stSignals);

  console.log(`\n── Confidence Score: ${conf}% (need ${MIN_CONF}%+) ─────────────\n`);

  // ── Paper Account ─────────────────────────────────────────────────────────
  const acc = loadPaperAccount();
  console.log(`── Paper Account (Stocks) ────────────────────────────────\n`);
  console.log(`  Balance: $${acc.balance.toFixed(2)} | Open: ${acc.openPositions.length} | Trades: ${acc.stats.totalTrades} | P&L: ${acc.stats.totalPnl >= 0 ? "+" : ""}$${acc.stats.totalPnl.toFixed(2)}`);

  updateOpenPositions(acc, SYMBOL, price);

  // ── Decision ──────────────────────────────────────────────────────────────
  const hasSignal  = allSignals.length > 0;
  const confPassed = conf >= MIN_CONF;
  let signalFired  = null;

  console.log(`\n── Decision ─────────────────────────────────────────────\n`);

  if (!hasSignal) {
    console.log(`🚫 No signal this bar.`);
  } else if (!confPassed) {
    console.log(`🚫 Signal detected but confidence too low: ${conf}% < ${MIN_CONF}%`);
  } else {
    // Priority: ST Flip first, then BB Recovery
    const chosen = stSignals.find((s) => s.direction === "LONG") || bbSignals.find((s) => s.direction === "LONG");
    if (chosen) {
      console.log(`✅ SIGNAL CONFIRMED — ${chosen.name} | Confidence: ${conf}%`);
      signalFired = openPaperPosition(acc, SYMBOL, price, chosen.name, conf);
    }
  }

  savePaperAccount(acc);

  // ── Write result file for dashboard ───────────────────────────────────────
  writeResultFile(SYMBOL, price, ema20, vwap, rsi14, stNow, macdNow, macdSigNow, bbSignals, stSignals, acc, signalFired ? "SIGNAL" : hasSignal ? "CONF_BLOCKED" : "NO_SIGNAL");

  console.log("\n═══════════════════════════════════════════════════════════\n");
}

function writeResultFile(symbol, price, ema20, vwap, rsi14, stNow, macdNow, macdSigNow, bbSignals, stSignals, acc, status) {
  const openPos = acc ? acc.openPositions.find((p) => p.symbol === symbol) || null : null;
  const result  = {
    symbol,
    time:        new Date().toISOString(),
    price,
    ema20,
    vwap:        vwap || null,
    rsi14:       rsi14 ?? null,
    superTrend:  stNow ? { line: stNow.line, direction: stNow.direction } : null,
    macd:        { macdLine: macdNow, signalLine: macdSigNow },
    bbSignals:   bbSignals || [],
    stSignals:   stSignals || [],
    status,
    openPosition: openPos,
    paperStats:  acc ? acc.stats : null,
  };
  writeFileSync(`results-stocks-${symbol}.json`, JSON.stringify(result, null, 2));
}

run().catch((err) => {
  console.error("Bot error:", err.message);
  process.exit(1);
});
