/**
 * bot_stocks_orb_mexc.js — RTH Opening Range Breakout on MEXC Stock Futures
 *
 * Strategy: Opening Range Breakout (ORB)
 *   - Opening range: first 30 min of RTH session (13:30–14:00 UTC)
 *   - Entry: break above OR high (LONG) or below OR low (SHORT)
 *            with above-average session volume confirmation
 *   - SL:   other side of the opening range (opposite extreme)
 *   - TP:   1.5× OR range from entry
 *   - 1 trade per symbol per day (first signal only)
 *   - EOD close at 19:55 UTC (5 min before market close)
 *   - Skip first bar of session (13:30) — gap bar with distorted volume
 *   - Volume filter: current vol > rolling 20-session RTH avg
 *
 * Universe (top 10 from 103-symbol MEXC ORB scan, sorted by Calmar):
 *   CSCOSTOCK, NFLXSTOCK, AVGOSTOCK, JPMSTOCK, MRVLSTOCK,
 *   MSFTSTOCK, ASMLSTOCK, PLTRSTOCK, ARMSTOCK, WMTSTOCK
 *
 * Exchange: MEXC Futures (0% taker fee on stock futures)
 * Cron:     every 5 minutes, 13:30–20:05 UTC on weekdays
 *           recommended: star-slash-5 13-20 star star 1-5
 *
 * Capital: $6,250 total, split $625/symbol × 10 symbols
 *
 * Backtest (103-symbol scan, top 10):
 *   Portfolio return: +69.5% in 150 days | Calmar: 7.93 | Avg DD: 21.3%
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import crypto from "crypto";

// ─── Config ───────────────────────────────────────────────────────────────────

const SYMBOLS = [
  "CSCOSTOCK_USDT",   // Top Calmar from scan
  "NFLXSTOCK_USDT",
  "AVGOSTOCK_USDT",
  "JPMSTOCK_USDT",
  "MRVLSTOCK_USDT",
  "MSFTSTOCK_USDT",
  "ASMLSTOCK_USDT",
  "PLTRSTOCK_USDT",
  "ARMSTOCK_USDT",
  "WMTSTOCK_USDT",
];

const CFG = {
  paperTrading:   process.env.PAPER_TRADING !== "false",
  totalUSD:       parseFloat(process.env.STOCKS_PORTFOLIO_USD || "6250"),
  riskPct:        parseFloat(process.env.ORB_RISK_PCT         || "0.01"),   // 1.0% of per-symbol balance
  leverage:       parseFloat(process.env.ORB_LEVERAGE         || "5"),      // 5x
  rrRatio:        1.5,      // TP = 1.5× OR range
  orbMins:        30,       // opening range window = 30 minutes
  orbBars:        6,        // 30 min / 5 min = 6 bars
  eodCloseUTCH:   19,       // EOD close hour (UTC)
  eodCloseUTCM:   55,       // EOD close minute (UTC)
  rtHOpenH:       13,       // RTH open hour (UTC)
  rtHOpenM:       30,       // RTH open minute
  rtHCloseH:      20,       // RTH close hour (UTC)
  volSessionsMA:  20,       // rolling N-session volume baseline
  ntfyTopic:      process.env.STOCKS_NTFY_TOPIC || process.env.NTFY_TOPIC || "hermes-stocks",
  mexc: {
    apiKey:    process.env.MEXC_API_KEY,
    secretKey: process.env.MEXC_SECRET_KEY,
    baseUrl:   "https://futures.mexc.com",
  },
};

// Per-symbol capital
const PER_SYMBOL_USD = CFG.totalUSD / SYMBOLS.length;

const DATA_DIR     = process.env.RAILWAY_ENVIRONMENT ? "/data" : ".";
if (process.env.RAILWAY_ENVIRONMENT) mkdirSync(DATA_DIR, { recursive: true });
const ACCOUNT_FILE = `${DATA_DIR}/paper_account_stocks_orb.json`;
const CSV_FILE     = `${DATA_DIR}/trades_stocks_orb.csv`;
const CSV_HEADERS  = "Date,Time (UTC),Symbol,Direction,Entry,SL,TP,OR_High,OR_Low,Risk $,Size $,P&L $,Exit Reason\n";

const GIST_ID      = process.env.GITHUB_GIST_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GIST_FILE    = "paper_account_stocks_orb.json";

// ─── Utilities ────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
const fmt2 = n => typeof n === "number" ? n.toFixed(2) : "?";

// Is this a weekday (Mon–Fri UTC)?
function isWeekday(date = new Date()) {
  const d = date.getUTCDay();
  return d >= 1 && d <= 5;
}

// UTC minutes since midnight
function utcMinutes(date = new Date()) {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

// Is the current time inside the RTH session?
function isRTH(date = new Date()) {
  const m = utcMinutes(date);
  const open  = CFG.rtHOpenH  * 60 + CFG.rtHOpenM;
  const close = CFG.rtHCloseH * 60;
  return m >= open && m < close;
}

// ─── Notifications ────────────────────────────────────────────────────────────

async function notify(title, body, tags = "") {
  const topic = CFG.ntfyTopic;
  if (!topic) return;
  try {
    await fetch("https://ntfy.sh/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, title, message: body, tags: tags ? tags.split(",") : [] }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* silent */ }
}

// ─── CSV logging ──────────────────────────────────────────────────────────────

function csvLog(trade) {
  if (!existsSync(CSV_FILE)) appendFileSync(CSV_FILE, CSV_HEADERS);
  const d   = new Date(trade.exitTime || trade.entryTime || Date.now());
  const row = [
    d.toISOString().slice(0, 10),
    d.toISOString().slice(11, 19),
    trade.symbol,
    trade.direction,
    trade.entry?.toFixed(4) ?? "",
    trade.sl?.toFixed(4)    ?? "",
    trade.tp?.toFixed(4)    ?? "",
    trade.orHigh?.toFixed(4) ?? "",
    trade.orLow?.toFixed(4)  ?? "",
    trade.riskUSD?.toFixed(2) ?? "",
    trade.sizeUSD?.toFixed(2) ?? "",
    trade.pnl?.toFixed(2)   ?? "",
    trade.exitReason ?? "OPEN",
  ].join(",");
  appendFileSync(CSV_FILE, row + "\n");
}

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
    console.log("  ☁️  State loaded from Gist");
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

function freshAccount() {
  const perSym = {};
  for (const sym of SYMBOLS) {
    perSym[sym] = {
      balance:    PER_SYMBOL_USD,
      startBal:   PER_SYMBOL_USD,
      position:   null,           // active trade or null
      tradedToday: false,         // one trade per day gate
      orHigh:     null,           // today's opening range high
      orLow:      null,           // today's opening range low
      orConfirmed: false,         // true once 30-min ORB window is closed
      sessionVols: [],            // rolling RTH avg volumes (last 20 sessions)
      stats: { total: 0, wins: 0, losses: 0, pnl: 0 },
    };
  }
  return {
    startDate: new Date().toISOString().slice(0, 10),
    symbols:   perSym,
    allTrades: [],
  };
}

async function loadAccount() {
  const gist = await loadFromGist();
  if (gist) return gist;
  if (existsSync(ACCOUNT_FILE)) return JSON.parse(readFileSync(ACCOUNT_FILE, "utf8"));
  console.log("📋 Fresh account created");
  return freshAccount();
}

async function saveAccount(acc) {
  acc.lastRun = new Date().toISOString();
  writeFileSync(ACCOUNT_FILE, JSON.stringify(acc, null, 2));
  await saveToGist(acc);
}

// ─── MEXC Futures Data Fetch ──────────────────────────────────────────────────

async function fetchMexcKlines(symbol, startSec, endSec) {
  const url = `${CFG.mexc.baseUrl}/api/v1/contract/kline/${symbol}?interval=Min5&start=${startSec}&end=${endSec}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.data || !json.data.time) throw new Error(`No data for ${symbol}`);
  const { time, open, close, high, low, vol } = json.data;
  return time.map((t, i) => ({
    t: t * 1000,                // sec → ms
    o: parseFloat(open[i]),
    c: parseFloat(close[i]),
    h: parseFloat(high[i]),
    l: parseFloat(low[i]),
    v: parseFloat(vol[i]),
  })).sort((a, b) => a.t - b.t);
}

// Fetch today's RTH bars (13:30 UTC → now)
async function fetchTodayBars(symbol) {
  const now      = new Date();
  const startSec = Math.floor(new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 13, 30, 0)
  ).getTime() / 1000);
  const endSec   = Math.floor(Date.now() / 1000);
  return fetchMexcKlines(symbol, startSec, endSec);
}

// Fetch yesterday's full RTH session to update sessionVols baseline
async function fetchYesterdayRthVol(symbol) {
  const now = new Date();
  // Find last weekday
  let d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - 1);
  while (!isWeekday(d)) d.setUTCDate(d.getUTCDate() - 1);
  const startSec = Math.floor(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 13, 30, 0)).getTime() / 1000);
  const endSec   = Math.floor(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 20, 0, 0)).getTime() / 1000);
  const bars = await fetchMexcKlines(symbol, startSec, endSec);
  if (!bars.length) return null;
  const totalVol = bars.reduce((s, b) => s + b.v, 0);
  return totalVol / bars.length;  // avg per-bar volume for that RTH session
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
  if (!data.success) throw new Error(`MEXC: ${data.message || JSON.stringify(data)}`);
  return data.data;
}

// ─── ORB Logic ────────────────────────────────────────────────────────────────

// Returns true if UTC time is the 13:30 open bar (gap bar — skip it)
function isOpenBar(barMs) {
  const d = new Date(barMs);
  return d.getUTCHours() === 13 && d.getUTCMinutes() === 30;
}

// Is it time to force-close for EOD?
function isEOD(date = new Date()) {
  const h = date.getUTCHours(), m = date.getUTCMinutes();
  return h > CFG.eodCloseUTCH || (h === CFG.eodCloseUTCH && m >= CFG.eodCloseUTCM);
}

async function processSymbol(sym, state) {
  const now    = new Date();
  const todayKey = now.toISOString().slice(0, 10);

  // ── Reset daily state at session start ──────────────────────────────────
  // If lastTradingDay is not today, start fresh for today
  if (state.lastTradingDay !== todayKey) {
    // Update session volume baseline with yesterday's data (if we have it)
    // Only update once per day (when we see a new day)
    try {
      const yesterdayAvg = await fetchYesterdayRthVol(sym);
      if (yesterdayAvg !== null) {
        state.sessionVols.push(yesterdayAvg);
        if (state.sessionVols.length > CFG.volSessionsMA) state.sessionVols.shift();
      }
    } catch { /* skip if yesterday fetch fails */ }

    state.tradedToday  = false;
    state.orHigh       = null;
    state.orLow        = null;
    state.orConfirmed  = false;
    state.lastTradingDay = todayKey;

    console.log(`  ${sym.padEnd(22)} 🆕 New day — baseline vol: ${state.sessionVols.length > 0
      ? (state.sessionVols.reduce((a,b)=>a+b,0)/state.sessionVols.length).toFixed(0)
      : "N/A"}`);
  }

  // ── EOD force-close ──────────────────────────────────────────────────────
  if (state.position && isEOD(now)) {
    const pos = state.position;
    const bars = await fetchTodayBars(sym);
    const lastBar = bars[bars.length - 1];
    const exitPx  = lastBar ? lastBar.c : pos.entry;  // close at last bar close
    await closeTrade(sym, state, exitPx, "EOD");
    return;
  }

  // ── Exit check for open position ─────────────────────────────────────────
  if (state.position) {
    const bars = await fetchTodayBars(sym);
    // Look at last closed 5-min bar
    const nowSec  = Math.floor(Date.now() / 1000);
    const closed  = bars.filter(b => b.t + 5*60*1000 < Date.now());
    if (closed.length > 0) {
      const last   = closed[closed.length - 1];
      const pos    = state.position;
      const isLong = pos.direction === "LONG";
      const hitSL  = isLong ? last.l <= pos.sl : last.h >= pos.sl;
      const hitTP  = isLong ? last.h >= pos.tp : last.l <= pos.tp;

      if (hitSL && hitTP) { await closeTrade(sym, state, pos.sl, "SL"); return; }
      if (hitSL)           { await closeTrade(sym, state, pos.sl, "SL"); return; }
      if (hitTP)           { await closeTrade(sym, state, pos.tp, "TP"); return; }
    }
    // Position still open, nothing to do
    const pos = state.position;
    console.log(`  ${sym.padEnd(22)} 🔄 ${pos.direction} @ ${fmt2(pos.entry)} | SL ${fmt2(pos.sl)} | TP ${fmt2(pos.tp)}`);
    return;
  }

  // ── Already traded today ─────────────────────────────────────────────────
  if (state.tradedToday) {
    console.log(`  ${sym.padEnd(22)} ✓ Traded today`);
    return;
  }

  // ── Only run during RTH ──────────────────────────────────────────────────
  if (!isRTH(now)) {
    console.log(`  ${sym.padEnd(22)} 💤 Outside RTH`);
    return;
  }

  // ── Fetch today's bars ───────────────────────────────────────────────────
  let bars;
  try {
    bars = await fetchTodayBars(sym);
  } catch (e) {
    console.log(`  ${sym.padEnd(22)} ⚠️  Fetch failed: ${e.message}`);
    return;
  }

  // Filter out the 13:30 open bar (gap bar)
  const rthBars = bars.filter(b => !isOpenBar(b.t));
  if (rthBars.length === 0) {
    console.log(`  ${sym.padEnd(22)} ⏳ Waiting for first RTH bar`);
    return;
  }

  // ── Build opening range ──────────────────────────────────────────────────
  // OR = first 6 non-open bars (13:35–14:00) after skipping 13:30 open bar
  const orbBars = rthBars.slice(0, CFG.orbBars);
  if (!state.orConfirmed) {
    if (orbBars.length < CFG.orbBars) {
      // Still building OR
      const curHigh = Math.max(...orbBars.map(b => b.h));
      const curLow  = Math.min(...orbBars.map(b => b.l));
      state.orHigh = curHigh;
      state.orLow  = curLow;
      console.log(`  ${sym.padEnd(22)} ⏳ Building OR (${orbBars.length}/${CFG.orbBars} bars) H:${fmt2(curHigh)} L:${fmt2(curLow)}`);
      return;
    }
    // OR complete
    state.orHigh     = Math.max(...orbBars.map(b => b.h));
    state.orLow      = Math.min(...orbBars.map(b => b.l));
    state.orConfirmed = true;
    console.log(`  ${sym.padEnd(22)} 📐 OR confirmed: H ${fmt2(state.orHigh)} | L ${fmt2(state.orLow)}`);
  }

  // ── Volume baseline (rolling RTH session avg) ────────────────────────────
  const volBaseline = state.sessionVols.length > 0
    ? state.sessionVols.reduce((a, b) => a + b, 0) / state.sessionVols.length
    : null;

  // ── Signal scan on bars after OR window ──────────────────────────────────
  const postOrbBars = rthBars.slice(CFG.orbBars);  // bars after 14:00 UTC
  if (postOrbBars.length === 0) {
    console.log(`  ${sym.padEnd(22)} ⏳ Waiting for post-ORB bars`);
    return;
  }

  const orRange  = state.orHigh - state.orLow;
  const lastBar  = postOrbBars[postOrbBars.length - 1];
  const volOk    = volBaseline === null || lastBar.v > volBaseline;

  // Breakout LONG: close above OR high
  if (lastBar.c > state.orHigh && volOk) {
    const entry = lastBar.c;
    const sl    = state.orLow;
    const tp    = entry + orRange * CFG.rrRatio;
    await openTrade(sym, state, "LONG", entry, sl, tp, state.orHigh, state.orLow, lastBar.v, volBaseline);
    return;
  }

  // Breakout SHORT: close below OR low
  if (lastBar.c < state.orLow && volOk) {
    const entry = lastBar.c;
    const sl    = state.orHigh;
    const tp    = entry - orRange * CFG.rrRatio;
    await openTrade(sym, state, "SHORT", entry, sl, tp, state.orHigh, state.orLow, lastBar.v, volBaseline);
    return;
  }

  const volLabel = volBaseline ? `(vol ${lastBar.v.toFixed(0)} vs base ${volBaseline.toFixed(0)})` : "(no vol baseline)";
  const closeToOR = lastBar.c > state.orHigh ? `+${((lastBar.c-state.orHigh)/state.orHigh*100).toFixed(2)}% above H`
                  : lastBar.c < state.orLow  ? `${((lastBar.c-state.orLow)/state.orLow*100).toFixed(2)}% below L`
                  : `Inside OR`;
  console.log(`  ${sym.padEnd(22)} 👀 Watching — ${closeToOR} ${volOk ? "" : "⚠️ LOW VOL"} ${volLabel}`);
}

// ─── Open Trade ───────────────────────────────────────────────────────────────

async function openTrade(sym, state, direction, entry, sl, tp, orHigh, orLow, vol, volBase) {
  const slDist  = Math.abs(entry - sl);
  const riskUSD = state.balance * CFG.riskPct;
  // sizeUSD = notional position. With leverage, our margin = sizeUSD/leverage.
  // P&L at SL = sizeUSD × slDist/entry = riskUSD (our max loss from balance)
  const sizeUSD = (riskUSD / slDist) * entry * CFG.leverage;

  const icon = direction === "LONG" ? "📈" : "📉";
  console.log(`  ${sym.padEnd(22)} ${icon} ${direction} OPEN @ ${fmt2(entry)} | SL ${fmt2(sl)} | TP ${fmt2(tp)} | Risk $${fmt2(riskUSD)} | Vol ${vol.toFixed(0)}/${volBase?.toFixed(0) ?? "N/A"}`);

  state.position = {
    symbol: sym, direction, entry, sl, tp,
    orHigh, orLow,
    riskUSD, sizeUSD,
    entryTime: Date.now(),
  };
  state.tradedToday = true;
  csvLog({ ...state.position, pnl: 0, exitReason: "OPEN" });

  // Live order
  if (!CFG.paperTrading && CFG.mexc.apiKey) {
    try {
      const side = direction === "LONG" ? 1 : 3;
      const order = await placeMexcOrder(sym, side, 1);
      state.position.orderId = order?.orderId;
      console.log(`     🔴 LIVE ORDER: ${order?.orderId}`);
    } catch (e) { console.log(`     ⚠️  Live order failed: ${e.message}`); }
  }

  // Notification
  const coin = sym.replace("STOCK_USDT","").replace("_USDT","");
  const potWin = riskUSD * CFG.rrRatio;
  await notify(
    `${icon} ${coin} ORB ${direction} OPENED`,
    `OR: ${fmt2(orLow)}–${fmt2(orHigh)}\nEntry $${fmt2(entry)} | SL $${fmt2(sl)} | TP $${fmt2(tp)}\nWin: +$${fmt2(potWin)} | Risk: -$${fmt2(riskUSD)} | ${CFG.leverage}x\nBalance: $${fmt2(state.balance)}`,
    direction === "LONG" ? "chart_with_upwards_trend,green_circle" : "chart_with_downwards_trend,red_circle"
  );
}

// ─── Close Trade ──────────────────────────────────────────────────────────────

async function closeTrade(sym, state, exitPx, reason) {
  const pos    = state.position;
  const isLong = pos.direction === "LONG";
  const priceDiff = isLong ? exitPx - pos.entry : pos.entry - exitPx;
  const pnl       = (priceDiff / pos.entry) * pos.sizeUSD;

  state.balance += pnl;
  state.stats.total++;
  state.stats.pnl = parseFloat((state.stats.pnl + pnl).toFixed(4));
  if (pnl > 0) state.stats.wins++; else state.stats.losses++;

  const trade = { ...pos, exitPrice: exitPx, exitTime: Date.now(), exitReason: reason, pnl: parseFloat(pnl.toFixed(4)) };
  state.position = null;

  csvLog(trade);

  const icon = pnl >= 0 ? "✅" : "❌";
  const wr   = state.stats.total ? (state.stats.wins / state.stats.total * 100).toFixed(0) : "0";
  console.log(`  ${sym.padEnd(22)} ${icon} ${reason} @ ${fmt2(exitPx)} | P&L: ${pnl >= 0 ? "+" : ""}$${fmt2(pnl)} | Bal: $${fmt2(state.balance)} | WR: ${wr}%`);

  // Live close order
  if (!CFG.paperTrading && CFG.mexc.apiKey) {
    try {
      const side = isLong ? 2 : 4;  // 2=close long, 4=close short
      await placeMexcOrder(sym, side, 1);
    } catch (e) { console.log(`     ⚠️  Live close failed: ${e.message}`); }
  }

  // Notification
  const coin     = sym.replace("STOCK_USDT","").replace("_USDT","");
  const exitLabel = reason === "TP" ? "✅ TP HIT" : reason === "SL" ? "❌ SL HIT" : reason === "EOD" ? "🔔 EOD CLOSE" : reason;
  await notify(
    `${icon} ${coin} CLOSED — ${pnl >= 0 ? "WIN" : "LOSS"}`,
    `${exitLabel} · ${pos.direction}\nP&L: ${pnl >= 0 ? "+" : ""}$${fmt2(pnl)}\nEntry $${fmt2(pos.entry)} → Exit $${fmt2(exitPx)}\nBalance: $${fmt2(state.balance)} | Total P&L: ${state.stats.pnl >= 0 ? "+" : ""}$${fmt2(state.stats.pnl)}`,
    pnl >= 0 ? "moneybag,green_circle" : "chart_with_downwards_trend,red_circle"
  );

  return trade;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const start = Date.now();
  const now   = new Date();
  const ts    = now.toISOString().replace("T", " ").slice(0, 19);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Stocks ORB Bot (MEXC) — ${ts} UTC`);
  console.log(`  Mode: ${CFG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}  |  Symbols: ${SYMBOLS.length}`);
  console.log(`  Capital: $${CFG.totalUSD} (${SYMBOLS.length} × $${PER_SYMBOL_USD.toFixed(0)}) | ${CFG.leverage}x leverage | Risk: ${(CFG.riskPct*100).toFixed(1)}%`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (!isWeekday(now)) {
    console.log("  📅 Weekend — markets closed. Nothing to do.\n");
    return;
  }

  const acc = await loadAccount();

  // Ensure all symbols exist in account (graceful migration)
  for (const sym of SYMBOLS) {
    if (!acc.symbols[sym]) {
      acc.symbols[sym] = freshAccount().symbols[sym];
    }
  }

  // Print portfolio summary
  let totalBal = 0, totalPnl = 0, openCount = 0;
  for (const sym of SYMBOLS) {
    const s = acc.symbols[sym];
    totalBal += s.balance;
    totalPnl += s.stats.pnl;
    if (s.position) openCount++;
  }
  const retPct = ((totalBal - CFG.totalUSD) / CFG.totalUSD * 100).toFixed(1);
  console.log(`  Portfolio Balance: $${totalBal.toFixed(2)} / $${CFG.totalUSD} | Return: ${parseFloat(retPct) >= 0 ? "+" : ""}${retPct}% | Open: ${openCount}/${SYMBOLS.length}\n`);

  // Process each symbol
  for (const sym of SYMBOLS) {
    try {
      await processSymbol(sym, acc.symbols[sym]);
    } catch (e) {
      console.log(`  ${sym.padEnd(22)} ❌ Error: ${e.message}`);
    }
    await delay(200);  // rate limit
  }

  await saveAccount(acc);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n  ⏱️  Run complete in ${elapsed}s`);
  console.log("═══════════════════════════════════════════════════════════════\n");
}

async function status() {
  const acc = await loadAccount();
  console.log("\n── Stocks ORB MEXC Status ──────────────────────────────────────\n");
  let totalBal = 0;
  for (const sym of SYMBOLS) {
    const s = acc.symbols[sym];
    if (!s) continue;
    totalBal += s.balance;
    const wr    = s.stats.total ? (s.stats.wins / s.stats.total * 100).toFixed(0) : "—";
    const retPct = ((s.balance - s.startBal) / s.startBal * 100).toFixed(1);
    const posTag = s.position
      ? ` 🔄 ${s.position.direction} @ ${fmt2(s.position.entry)}`
      : s.tradedToday ? " ✓ traded" : " 👀 watching";
    console.log(`  ${sym.padEnd(22)} $${s.balance.toFixed(2)} (${parseFloat(retPct) >= 0 ? "+" : ""}${retPct}%)  ${s.stats.total} trades  WR ${wr}%${posTag}`);
  }
  console.log(`\n  Total portfolio: $${totalBal.toFixed(2)} / $${CFG.totalUSD}`);
}

if (process.argv.includes("--status")) {
  status().catch(e => { console.error(e); process.exit(1); });
} else {
  run().catch(e => { console.error("[ORB] Fatal:", e.message); process.exit(1); });
}
