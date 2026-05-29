/**
 * bot_stocks_futures.js — BitMEX Stock Futures Paper Trading
 *
 * Two strategies running simultaneously:
 *
 * DT (Day Trading) — EMA21 Recapture/Rejection on 15m candles
 *   Symbols: SPYUSDT, MSTRUSDT, TSLAUSDT, NFLXUSDT, AMZNUSDT, MSFTUSDT, ORCLUSDT
 *   Entry: EMA21 cross + EMA50 direction (4-bar) + volume spike
 *   SL: 0.42% fixed | TP: 0.546% (1.3 R:R) | Max hold: 12 bars (3h)
 *   Session: RTH only (13:30–20:00 UTC = NYSE 9:30am–4pm ET)
 *
 * ORB (Opening Range Breakout) — on 5m candles
 *   Symbols: COINUSDT, NVDAUSDT, GOOGLUSDT
 *   OR window: 13:30–14:00 UTC (first 30 min of RTH)
 *   Entry: close above OR high (LONG) / below OR low (SHORT) + volume spike
 *   SL: other side of OR | TP: 1.5× OR range | Max 1 trade/day/symbol
 *   EOD force-close: 19:55 UTC
 *
 * Cron:     every 15 minutes
 * Risk:     0.8% per trade × 5x leverage
 * Capital:  $8,333 starting balance (1/3 of $25k combined portfolio)
 * Notify:   ntfy.sh push to phone on every entry/exit
 */

import "dotenv/config";
import https from "https";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────

const DT_SYMBOLS  = ["SPYUSDT", "MSTRUSDT", "TSLAUSDT", "NFLXUSDT", "AMZNUSDT", "MSFTUSDT", "ORCLUSDT"];
const ORB_SYMBOLS = ["COINUSDT", "NVDAUSDT", "GOOGLUSDT"];
const ALL_SYMBOLS = [...DT_SYMBOLS, ...ORB_SYMBOLS];

const CFG = {
  paperTrading:   true,
  portfolioUSD:   parseFloat(process.env.STOCKS_PORTFOLIO_USD || "8333"),
  riskPct:        parseFloat(process.env.STOCKS_RISK_PCT      || "0.008"),
  leverage:       parseFloat(process.env.STOCKS_LEVERAGE      || "5"),
  // DT params
  dtSlPct:        0.0042,
  dtTpMult:       1.3,
  dtMaxHold:      12,       // 12 × 15m = 3 hours
  dtVolMult:      1.2,
  dtEmaS:         21,
  dtEmaL:         50,
  dtEmaLb:        4,        // bars for EMA50 direction
  // ORB params
  orStartMin:     13 * 60 + 30,   // 13:30 UTC in minutes
  orEndMin:       14 * 60,        // 14:00 UTC
  orbTpMult:      1.5,
  orbVolMult:     1.3,
  eodCloseMin:    19 * 60 + 55,   // force-close at 19:55 UTC
  // RTH window
  rthStartH:      13,
  rthEndH:        20,
  // Notifications
  ntfyTopic:      process.env.STOCKS_NTFY_TOPIC || process.env.NTFY_TOPIC || "hermes-stocks",
};

// ─── Persistence ──────────────────────────────────────────────────────────────

const DATA_DIR    = process.env.RAILWAY_ENVIRONMENT ? "/data" : ".";
if (process.env.RAILWAY_ENVIRONMENT) mkdirSync(DATA_DIR, { recursive: true });
const ACCOUNT_FILE = `${DATA_DIR}/paper_stocks_futures.json`;
const CSV_FILE     = `${DATA_DIR}/trades_stocks_futures.csv`;
const CSV_HEADERS  = "Date,Time (UTC),Symbol,Strategy,Direction,Entry,SL,TP,Risk$,PnL$,ExitReason\n";

const GIST_ID      = process.env.GITHUB_GIST_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GIST_FILE    = "paper_stocks_futures.json";

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
        Authorization: `token ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
      },
      body:   JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(acc, null, 2) } } }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) { console.warn("  [Gist] save failed:", e.message); }
}

// ─── Account ──────────────────────────────────────────────────────────────────

async function loadAccount() {
  const gist = await loadFromGist();
  if (gist) { console.log("  [state] loaded from Gist"); return gist; }
  if (existsSync(ACCOUNT_FILE)) return JSON.parse(readFileSync(ACCOUNT_FILE, "utf8"));
  return {
    balance:       CFG.portfolioUSD,
    peak:          CFG.portfolioUSD,
    startBalance:  CFG.portfolioUSD,
    positions:     [],   // { symbol, strategy, direction, entry, sl, tp, sizeUSD, riskUSD, entryTime, barIndex }
    trades:        [],
    lastDTBarTime: {},   // symbol → last processed 15m bar openTime (ms)
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
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: msg,
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* silent */ }
}

// ─── BitMEX data fetch ────────────────────────────────────────────────────────

function bitmexGet(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "www.bitmex.com",
      path,
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
    };
    https.get(opts, r => {
      let d = "";
      r.on("data", c => d += c);
      r.on("end", () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve([]); }
      });
    }).on("error", reject);
  });
}

async function fetchBars5m(symbol, count = 220) {
  const raw = await bitmexGet(
    `/api/v1/trade/bucketed?binSize=5m&symbol=${symbol}&count=${count}&reverse=true&partial=false`
  );
  if (!Array.isArray(raw) || raw.length === 0) return [];
  // reverse to chronological, skip last bar (may be forming)
  return raw.reverse().slice(0, -1)
    .filter(b => b.open && b.close)
    .map(b => ({
      t: new Date(b.timestamp).getTime(),
      o: b.open, h: b.high, l: b.low, c: b.close,
      v: b.volume || 0,
    }));
}

async function fetchLivePrice(symbol) {
  try {
    const data = await bitmexGet(`/api/v1/instrument?symbol=${symbol}&count=1`);
    if (Array.isArray(data) && data[0]) return data[0].lastPrice || data[0].markPrice;
  } catch {}
  return null;
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcEma(arr, p) {
  const k = 2 / (p + 1);
  let e = arr[0];
  return arr.map(v => { e = v * k + e * (1 - k); return e; });
}

function calcSma(arr, p) {
  return arr.map((_, i) =>
    i < p - 1 ? null : arr.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function utcMinutes(ms) {
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function utcDateStr(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function inRTH(ms) {
  const h = new Date(ms).getUTCHours();
  return h >= CFG.rthStartH && h < CFG.rthEndH;
}

function fmtP(p) {
  if (p == null) return "N/A";
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1)    return p.toFixed(4);
  return p.toFixed(5);
}

// ─── CSV log ──────────────────────────────────────────────────────────────────

function csvLog(trade) {
  if (!existsSync(CSV_FILE)) appendFileSync(CSV_FILE, CSV_HEADERS);
  const d = new Date(trade.exitTime || Date.now());
  appendFileSync(CSV_FILE, [
    d.toISOString().slice(0, 10),
    d.toISOString().slice(11, 19),
    trade.symbol, trade.strategy, trade.direction,
    trade.entry.toFixed(5), trade.sl.toFixed(5), trade.tp.toFixed(5),
    trade.riskUSD.toFixed(2), (trade.pnl || 0).toFixed(2), trade.exitReason,
  ].join(",") + "\n");
}

// ─── 5m → 15m aggregation ─────────────────────────────────────────────────────

function agg15m(bars5) {
  const out = [];
  // align to 15m boundary
  for (let i = 0; i + 2 < bars5.length; i += 3) {
    const t = [bars5[i], bars5[i + 1], bars5[i + 2]];
    out.push({
      t: t[0].t,
      o: t[0].o,
      h: Math.max(...t.map(b => b.h)),
      l: Math.min(...t.map(b => b.l)),
      c: t[2].c,
      v: t.reduce((s, b) => s + b.v, 0),
    });
  }
  return out;
}

// ─── DT Signal ────────────────────────────────────────────────────────────────

function dtSignal(symbol, bars15) {
  if (bars15.length < CFG.dtEmaL + CFG.dtEmaLb + 5) return null;

  const closes = bars15.map(b => b.c);
  const vols   = bars15.map(b => b.v);
  const e21    = calcEma(closes, CFG.dtEmaS);
  const e50    = calcEma(closes, CFG.dtEmaL);
  const vSma   = calcSma(vols, 20);

  const n    = bars15.length;
  const i    = n - 2;   // last fully closed bar
  const prev = n - 3;

  if (!vSma[i]) return null;
  if (!inRTH(bars15[i].t)) return null;

  const rising  = e50[i] > e50[i - CFG.dtEmaLb];
  const falling = e50[i] < e50[i - CFG.dtEmaLb];
  const volOk   = bars15[i].v > CFG.dtVolMult * vSma[i];

  const longSig  = bars15[prev].c < e21[prev] && bars15[i].c > e21[i] && rising  && volOk;
  const shortSig = bars15[prev].c > e21[prev] && bars15[i].c < e21[i] && falling && volOk;

  if (!longSig && !shortSig) return null;

  const dir   = longSig ? "LONG" : "SHORT";
  const entry = bars15[i].c;
  const sl    = longSig ? entry * (1 - CFG.dtSlPct) : entry * (1 + CFG.dtSlPct);
  const tp    = longSig ? entry * (1 + CFG.dtSlPct * CFG.dtTpMult) : entry * (1 - CFG.dtSlPct * CFG.dtTpMult);

  return { symbol, strategy: "DT", direction: dir, entry, sl, tp, barTime: bars15[i].t };
}

// ─── ORB Signal ───────────────────────────────────────────────────────────────

function orbSignal(symbol, bars5, tradedToday) {
  if (tradedToday) return null;

  const now = Date.now();
  const nowMin = utcMinutes(now);

  // Only look for entries after OR is complete and before trade end
  if (nowMin < CFG.orEndMin || nowMin >= CFG.eodCloseMin) return null;

  const today = utcDateStr(now);

  // Get today's bars
  const todayBars = bars5.filter(b => utcDateStr(b.t) === today);

  // OR bars: 13:30–14:00 UTC
  const orBars = todayBars.filter(b => {
    const m = utcMinutes(b.t);
    return m >= CFG.orStartMin && m < CFG.orEndMin;
  });

  if (orBars.length < 3) return null;  // need enough bars to form OR

  const orHigh = Math.max(...orBars.map(b => b.h));
  const orLow  = Math.min(...orBars.map(b => b.l));
  const orRange = orHigh - orLow;

  if (orRange <= 0) return null;

  // Bars after OR window (potential entry candles)
  const postOrBars = todayBars.filter(b => utcMinutes(b.t) >= CFG.orEndMin);
  if (postOrBars.length < 2) return null;

  // Last closed post-OR bar (skip last which may be forming)
  const lastBar = postOrBars[postOrBars.length - 2];
  const prevBar = postOrBars[postOrBars.length - 3] || orBars[orBars.length - 1];

  if (!lastBar) return null;

  // Volume filter
  const recentVols = bars5.slice(-40).map(b => b.v);
  const avgVol = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
  const volOk  = lastBar.v > CFG.orbVolMult * avgVol;

  // Breakout signals — candle must cross the OR level
  const longBreak  = prevBar.c <= orHigh && lastBar.c > orHigh && volOk;
  const shortBreak = prevBar.c >= orLow  && lastBar.c < orLow  && volOk;

  if (!longBreak && !shortBreak) return null;

  const dir   = longBreak ? "LONG" : "SHORT";
  const entry = lastBar.c;
  const sl    = longBreak ? orLow  : orHigh;
  const tp    = longBreak ? entry + orRange * CFG.orbTpMult : entry - orRange * CFG.orbTpMult;

  return { symbol, strategy: "ORB", direction: dir, entry, sl, tp, orHigh, orLow, orRange, barTime: lastBar.t };
}

// ─── Exit checks ──────────────────────────────────────────────────────────────

async function checkExits(acc) {
  const now = Date.now();

  for (let p = acc.positions.length - 1; p >= 0; p--) {
    const pos    = acc.positions[p];
    const isLong = pos.direction === "LONG";

    let bars;
    try {
      bars = await fetchBars5m(pos.symbol, 10);
    } catch (e) {
      console.warn(`  [exit] fetch failed ${pos.symbol}: ${e.message}`);
      continue;
    }

    if (bars.length === 0) continue;
    const b = bars[bars.length - 1];  // most recent closed bar

    const hitSL  = isLong ? b.l <= pos.sl : b.h >= pos.sl;
    const hitTP  = isLong ? b.h >= pos.tp : b.l <= pos.tp;

    // DT: time exit after maxHold 15m bars
    const barsHeld = Math.round((b.t - pos.entryTime) / (15 * 60 * 1000));
    const dtTimeExit = pos.strategy === "DT" && barsHeld >= CFG.dtMaxHold;

    // ORB: EOD force-close
    const nowMin = utcMinutes(now);
    const orbEodExit = pos.strategy === "ORB" && nowMin >= CFG.eodCloseMin;

    let exitReason = null;
    let exitPrice  = null;

    if (hitSL && hitTP) { exitReason = "SL"; exitPrice = pos.sl; }
    else if (hitSL)     { exitReason = "SL"; exitPrice = pos.sl; }
    else if (hitTP)     { exitReason = "TP"; exitPrice = pos.tp; }
    else if (dtTimeExit || orbEodExit) { exitReason = orbEodExit ? "EOD" : "TIME"; exitPrice = b.c; }

    if (!exitReason) continue;

    const priceDiff = isLong ? exitPrice - pos.entry : pos.entry - exitPrice;
    const slDist    = Math.abs(pos.entry - pos.sl);
    const pnl       = slDist > 0 ? (priceDiff / slDist) * pos.riskUSD : 0;

    acc.balance += pnl;
    if (acc.balance > acc.peak) acc.peak = acc.balance;

    const trade = { ...pos, exit: exitPrice, pnl: Math.round(pnl * 100) / 100, exitReason, exitTime: now };
    acc.trades.push(trade);
    acc.positions.splice(p, 1);
    csvLog(trade);

    const sign = pnl >= 0 ? "✅" : "❌";
    const dd   = ((acc.peak - acc.balance) / acc.peak * 100).toFixed(1);
    console.log(`  ${sign} EXIT [${pos.strategy}] ${pos.symbol} ${pos.direction} ${exitReason}  P&L: $${pnl.toFixed(2)}  Bal: $${acc.balance.toFixed(2)}`);

    const totPnl = acc.trades.reduce((s, t) => s + (t.pnl || 0), 0);
    await notify(
      `${sign} STOCKS ${pos.strategy} ${pos.symbol} ${pos.direction} — ${exitReason}\n` +
      `P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}  |  Balance: $${acc.balance.toFixed(2)}\n` +
      `Entry: $${fmtP(pos.entry)}  →  Exit: $${fmtP(exitPrice)}\n` +
      `Total P&L: ${totPnl >= 0 ? "+" : ""}$${totPnl.toFixed(2)}  |  DD: ${dd}%`
    );

    await new Promise(r => setTimeout(r, 300));
  }
}

// ─── DT Entry ─────────────────────────────────────────────────────────────────

async function checkDTEntries(acc) {
  for (const symbol of DT_SYMBOLS) {
    if (acc.positions.some(p => p.symbol === symbol)) continue;

    let bars5;
    try {
      bars5 = await fetchBars5m(symbol, 220);
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.warn(`  [DT entry] fetch failed ${symbol}: ${e.message}`);
      continue;
    }

    const bars15 = agg15m(bars5);
    if (bars15.length < 60) continue;

    const sig = dtSignal(symbol, bars15);
    if (!sig) continue;

    // Deduplicate — don't re-enter on same bar
    const lastBar = acc.lastDTBarTime?.[symbol] || 0;
    if (sig.barTime <= lastBar) continue;

    const riskUSD  = acc.balance * CFG.riskPct;
    const slDist   = Math.abs(sig.entry - sig.sl);
    const sizeUSD  = slDist > 0 ? (riskUSD / slDist) * sig.entry * CFG.leverage : 0;

    acc.positions.push({
      symbol:    sig.symbol,
      strategy:  "DT",
      direction: sig.direction,
      entry:     sig.entry,
      sl:        sig.sl,
      tp:        sig.tp,
      sizeUSD:   Math.round(sizeUSD * 100) / 100,
      riskUSD:   Math.round(riskUSD * 100) / 100,
      entryTime: sig.barTime,
    });

    if (!acc.lastDTBarTime) acc.lastDTBarTime = {};
    acc.lastDTBarTime[symbol] = sig.barTime;

    const dir    = sig.direction === "LONG" ? "📈" : "📉";
    const slPct  = (CFG.dtSlPct * 100).toFixed(2);
    const tpPct  = (CFG.dtSlPct * CFG.dtTpMult * 100).toFixed(2);
    console.log(`  ${dir} DT ENTRY ${symbol} ${sig.direction}  $${fmtP(sig.entry)}  SL ${slPct}%  TP ${tpPct}%  Risk $${riskUSD.toFixed(2)}`);

    const potWin = riskUSD * CFG.dtTpMult;
    await notify(
      `${dir} STOCKS DT ${symbol} ${sig.direction}  [15m EMA21 @ 5x]\n` +
      `Entry: $${fmtP(sig.entry)}  SL: $${fmtP(sig.sl)}  TP: $${fmtP(sig.tp)}\n` +
      `Win: +$${potWin.toFixed(2)}  |  Loss: -$${riskUSD.toFixed(2)}\n` +
      `Balance: $${acc.balance.toFixed(2)}`
    );

    await new Promise(r => setTimeout(r, 300));
  }
}

// ─── ORB Entry ────────────────────────────────────────────────────────────────

async function checkORBEntries(acc) {
  const nowMin = utcMinutes(Date.now());

  // Only look for ORB entries after the OR window has closed
  if (nowMin < CFG.orEndMin || nowMin >= CFG.eodCloseMin) return;

  const today = utcDateStr(Date.now());

  for (const symbol of ORB_SYMBOLS) {
    if (acc.positions.some(p => p.symbol === symbol)) continue;

    // Only 1 trade per symbol per day — check closed trades today
    const tradedToday = acc.trades.some(
      t => t.symbol === symbol && t.strategy === "ORB" && utcDateStr(t.exitTime || t.entryTime) === today
    );

    let bars5;
    try {
      bars5 = await fetchBars5m(symbol, 100);
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.warn(`  [ORB entry] fetch failed ${symbol}: ${e.message}`);
      continue;
    }

    const sig = orbSignal(symbol, bars5, tradedToday);
    if (!sig) continue;

    const riskUSD  = acc.balance * CFG.riskPct;
    const slDist   = Math.abs(sig.entry - sig.sl);
    const sizeUSD  = slDist > 0 ? (riskUSD / slDist) * sig.entry * CFG.leverage : 0;

    // Sanity: SL distance shouldn't exceed 15% of entry (bad ORB)
    if (slDist / sig.entry > 0.15) {
      console.log(`  [ORB] ${symbol} skipped — OR range too wide (${(slDist/sig.entry*100).toFixed(1)}%)`);
      continue;
    }

    acc.positions.push({
      symbol:    sig.symbol,
      strategy:  "ORB",
      direction: sig.direction,
      entry:     sig.entry,
      sl:        sig.sl,
      tp:        sig.tp,
      sizeUSD:   Math.round(sizeUSD * 100) / 100,
      riskUSD:   Math.round(riskUSD * 100) / 100,
      entryTime: sig.barTime,
      orHigh:    sig.orHigh,
      orLow:     sig.orLow,
      orRange:   sig.orRange,
    });

    const dir    = sig.direction === "LONG" ? "📈" : "📉";
    const orPct  = (sig.orRange / sig.entry * 100).toFixed(2);
    console.log(`  ${dir} ORB ENTRY ${symbol} ${sig.direction}  $${fmtP(sig.entry)}  OR: $${fmtP(sig.orLow)}–$${fmtP(sig.orHigh)} (${orPct}%)  Risk $${riskUSD.toFixed(2)}`);

    const orbSlDist = Math.abs(sig.entry - sig.sl);
    const orbTpDist = Math.abs(sig.tp - sig.entry);
    const orbPotWin = orbSlDist > 0 ? riskUSD * (orbTpDist / orbSlDist) : riskUSD * CFG.orbTpMult;
    await notify(
      `${dir} STOCKS ORB ${symbol} ${sig.direction}  [Opening Range @ 5x]\n` +
      `Entry: $${fmtP(sig.entry)}  SL: $${fmtP(sig.sl)}  TP: $${fmtP(sig.tp)}\n` +
      `Win: +$${orbPotWin.toFixed(2)}  |  Loss: -$${riskUSD.toFixed(2)}\n` +
      `OR: $${fmtP(sig.orLow)} – $${fmtP(sig.orHigh)} (${orPct}%)  Bal: $${acc.balance.toFixed(2)}`
    );

    await new Promise(r => setTimeout(r, 300));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const start = Date.now();
  const ts    = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`\n[STOCKS] ${ts} UTC`);

  const acc  = await loadAccount();
  const dd   = acc.peak > 0 ? ((acc.peak - acc.balance) / acc.peak * 100).toFixed(1) : "0.0";
  const ret  = ((acc.balance - acc.startBalance) / acc.startBalance * 100).toFixed(2);
  console.log(
    `  Bal: $${acc.balance.toFixed(2)}  Peak: $${acc.peak.toFixed(2)}  DD: ${dd}%  ` +
    `Return: ${ret >= 0 ? "+" : ""}${ret}%  Open: ${acc.positions.length}  ` +
    `Closed: ${acc.trades.length}  Lev: ${CFG.leverage}x`
  );

  // Phase 1: Exit checks
  console.log("  → Checking exits...");
  await checkExits(acc);

  // Phase 2: DT entries (RTH only)
  const nowH = new Date().getUTCHours();
  if (nowH >= CFG.rthStartH && nowH < CFG.rthEndH) {
    console.log("  → Checking DT entries (RTH active)...");
    await checkDTEntries(acc);
  } else {
    console.log(`  → DT entries skipped (outside RTH — ${nowH}:xx UTC)`);
  }

  // Phase 3: ORB entries
  console.log("  → Checking ORB entries...");
  await checkORBEntries(acc);

  // Save
  await saveAccount(acc);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`  Done in ${elapsed}s`);
}

run().catch(err => {
  console.error("[STOCKS] Fatal:", err.message);
  process.exit(1);
});
