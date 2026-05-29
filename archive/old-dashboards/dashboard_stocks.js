/**
 * dashboard_stocks.js — BitMEX Stock Futures Paper Trading Dashboard
 * Run:  node dashboard_stocks.js
 * Open: http://localhost:3002
 * Auto-refreshes every 20 seconds.
 *
 * Shows DT (EMA21 15m) and ORB (Opening Range Breakout) strategies side by side.
 * DT symbols:  SPY MSTR TSLA NFLX AMZN MSFT ORCL
 * ORB symbols: COIN NVDA GOOGL
 */

import "dotenv/config";
import https from "https";
import http from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";

const PORT      = 3002;
const DT_SYMS   = ["SPYUSDT","MSTRUSDT","TSLAUSDT","NFLXUSDT","AMZNUSDT","MSFTUSDT","ORCLUSDT"];
const ORB_SYMS  = ["COINUSDT","NVDAUSDT","GOOGLUSDT"];
const ALL_SYMS  = [...DT_SYMS, ...ORB_SYMS];

const LABEL = {
  SPYUSDT:"SPY", MSTRUSDT:"MSTR", TSLAUSDT:"TSLA", NFLXUSDT:"NFLX",
  AMZNUSDT:"AMZN", MSFTUSDT:"MSFT", ORCLUSDT:"ORCL",
  COINUSDT:"COIN", NVDAUSDT:"NVDA", GOOGLUSDT:"GOOGL",
};

const GIST_ID      = process.env.GITHUB_GIST_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// ─── Gist sync ────────────────────────────────────────────────────────────────

async function syncFromGist() {
  if (!GIST_ID || !GITHUB_TOKEN) return;
  try {
    const res  = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    const file = data.files?.["paper_stocks_futures.json"];
    if (!file) return;
    writeFileSync("paper_stocks_futures.json", file.content, "utf8");
  } catch { /* silent */ }
}

// ─── Account loader ───────────────────────────────────────────────────────────

function loadAccount() {
  try {
    if (existsSync("paper_stocks_futures.json"))
      return JSON.parse(readFileSync("paper_stocks_futures.json", "utf8"));
  } catch {}
  return null;
}

// ─── BitMEX live prices ───────────────────────────────────────────────────────

function bitmexGet(path) {
  return new Promise((resolve) => {
    const opts = {
      hostname: "www.bitmex.com",
      path,
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
    };
    https.get(opts, r => {
      let d = "";
      r.on("data", c => d += c);
      r.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on("error", () => resolve(null));
  });
}

async function fetchLivePrices(symbols) {
  const prices = {};
  await Promise.allSettled(symbols.map(async sym => {
    try {
      const data = await bitmexGet(`/api/v1/instrument?symbol=${sym}&count=1`);
      if (Array.isArray(data) && data[0]) {
        prices[sym] = data[0].lastPrice || data[0].markPrice;
      }
    } catch {}
  }));
  return prices;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n, dp = 2) {
  if (n == null || isNaN(n)) return "N/A";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function fmtPrice(p) {
  if (p == null) return "—";
  if (p >= 1000) return "$" + fmt(p, 2);
  if (p >= 1)    return "$" + fmt(p, 4);
  return "$" + fmt(p, 5);
}

function ago(ms) {
  if (!ms) return "never";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function utcMinutes() {
  const d = new Date();
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function isRTH() {
  const h = new Date().getUTCHours();
  return h >= 13 && h < 20;
}

function isORWindow() {
  const m = utcMinutes();
  return m >= 13 * 60 + 30 && m < 14 * 60;
}

function timeToRTH() {
  const h = new Date().getUTCHours();
  const m = new Date().getUTCMinutes();
  const nowMin = h * 60 + m;
  const rthStart = 13 * 60 + 30;
  if (nowMin < rthStart) {
    const diff = rthStart - nowMin;
    return `RTH opens in ${Math.floor(diff / 60)}h ${diff % 60}m`;
  }
  if (nowMin >= 20 * 60) {
    const diff = (24 * 60 + rthStart) - nowMin;
    return `RTH opens in ${Math.floor(diff / 60)}h ${diff % 60}m`;
  }
  return null;
}

// ─── Portfolio panel ──────────────────────────────────────────────────────────

function portfolioPanel(acc, prices) {
  if (!acc) return `<div class="port-panel port-empty">
    <span class="port-title">📊 Stock Futures Paper Account</span>
    <p class="muted">Waiting for first bot run…</p>
  </div>`;

  const startBal  = acc.startBalance || 6250;
  const balance   = acc.balance ?? startBal;
  const peak      = acc.peak    ?? balance;
  const dd        = peak > 0 ? ((peak - balance) / peak * 100) : 0;
  const trades    = acc.trades  ?? [];
  const positions = acc.positions ?? [];

  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const wr     = trades.length ? (wins.length / trades.length * 100).toFixed(0) : "—";
  const totPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const retPct = ((balance - startBal) / startBal * 100).toFixed(2);
  const pnlCls = totPnl >= 0 ? "pos" : "neg";
  const ddCls  = dd > 20 ? "neg" : dd > 10 ? "warn" : "pos";

  const dtTrades  = trades.filter(t => t.strategy === "DT");
  const orbTrades = trades.filter(t => t.strategy === "ORB");
  const dtPnl     = dtTrades.reduce((s, t) => s + t.pnl, 0);
  const orbPnl    = orbTrades.reduce((s, t) => s + t.pnl, 0);
  const dtWR      = dtTrades.length ? (dtTrades.filter(t => t.pnl > 0).length / dtTrades.length * 100).toFixed(0) : "—";
  const orbWR     = orbTrades.length ? (orbTrades.filter(t => t.pnl > 0).length / orbTrades.length * 100).toFixed(0) : "—";

  const grossW = wins.reduce((s, t) => s + t.pnl, 0);
  const grossL = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf     = grossL > 0 ? (grossW / grossL).toFixed(2) : wins.length ? "∞" : "—";

  // Unrealised P&L
  let totalUnreal = 0;
  for (const p of positions) {
    const cur = prices[p.symbol];
    if (cur == null) continue;
    const isLong  = p.direction === "LONG";
    const slDist  = Math.abs(p.entry - p.sl);
    const movePct = isLong ? (cur - p.entry) / p.entry : (p.entry - cur) / p.entry;
    const slPct   = slDist / p.entry;
    if (slPct > 0) totalUnreal += (movePct / slPct) * p.riskUSD;
  }
  const unrealCls = totalUnreal >= 0 ? "pos" : "neg";
  const equity    = balance + totalUnreal;

  // Open positions
  const posRows = positions.length
    ? positions.map(p => {
        const cur    = prices[p.symbol];
        const isLong = p.direction === "LONG";
        const slDist = Math.abs(p.entry - p.sl);
        const slPct  = slDist / p.entry;
        const movePct = cur != null ? (isLong ? (cur - p.entry) / p.entry : (p.entry - cur) / p.entry) : null;
        const unreal  = movePct != null && slPct > 0 ? (movePct / slPct) * p.riskUSD : null;
        const uCls    = unreal == null ? "" : unreal >= 0 ? "pos" : "neg";
        const distSL  = cur != null ? (isLong ? (cur - p.sl) / cur * 100 : (p.sl - cur) / cur * 100) : null;
        const distTP  = cur != null ? (isLong ? (p.tp - cur) / cur * 100 : (cur - p.tp) / cur * 100) : null;
        const barsHeld = p.strategy === "DT" ? Math.round((Date.now() - p.entryTime) / (15 * 60 * 1000)) : null;
        const isORB   = p.strategy === "ORB";

        const flag = distSL != null && distSL < 1.5
          ? `<span class="pos-flag warn">⚠️ SL ${distSL.toFixed(1)}% away</span>`
          : distTP != null && distTP < 1.5
          ? `<span class="pos-flag good">🎯 TP ${distTP.toFixed(1)}% away</span>`
          : barsHeld != null && barsHeld >= 8
          ? `<span class="pos-flag time">⏱ ${barsHeld}/12 bars</span>`
          : "";

        const stratBadge = `<span class="strat-badge ${isORB ? "orb" : "dt"}">${p.strategy}</span>`;

        return `<div class="port-pos ${unreal != null && unreal >= 0 ? "pos-winning" : unreal != null ? "pos-losing" : ""}">
          <span class="pos-dir ${isLong ? "long" : "short"}">${isLong ? "▲" : "▼"} ${p.direction}</span>
          ${stratBadge}
          <span class="pos-sym">${LABEL[p.symbol] || p.symbol}</span>
          <span class="pos-entry">Entry ${fmtPrice(p.entry)}</span>
          ${cur != null ? `<span class="pos-cur">→ ${fmtPrice(cur)}</span>` : ""}
          <span class="pos-sl">SL ${fmtPrice(p.sl)}${distSL != null ? ` · ${distSL.toFixed(1)}% away` : ""}</span>
          <span class="pos-tp">TP ${fmtPrice(p.tp)}${distTP != null ? ` · ${distTP.toFixed(1)}% away` : ""}</span>
          ${unreal != null
            ? `<span class="pos-unreal ${uCls}">${unreal >= 0 ? "+" : ""}$${unreal.toFixed(2)}</span>`
            : `<span class="pos-unreal muted">—</span>`}
          ${barsHeld != null ? `<span class="pos-bars">${barsHeld}/12 bars</span>` : `<span class="pos-bars">ORB · ${ago(p.entryTime)}</span>`}
          <span class="pos-time">${ago(p.entryTime)}</span>
          ${flag}
        </div>`;
      }).join("")
    : `<div class="port-no-pos">No open positions</div>`;

  // Recent trades (last 10)
  const recentTrades = trades.slice(-10).reverse().map(t => {
    const win  = t.pnl > 0;
    const isL  = t.direction === "LONG";
    const sym  = LABEL[t.symbol] || (t.symbol || "").replace("USDT", "");
    const isORB = t.strategy === "ORB";
    return `<div class="port-trade ${win ? "win" : "loss"}">
      <span class="pt-sym">${sym}</span>
      <span class="strat-badge ${isORB ? "orb" : "dt"}">${t.strategy}</span>
      <span class="pt-dir ${isL ? "long" : "short"}">${isL ? "▲" : "▼"} ${t.direction}</span>
      <span class="pt-exit">${t.exitReason}</span>
      <span class="pt-pnl ${win ? "pos" : "neg"}">${win ? "+" : ""}$${(t.pnl || 0).toFixed(2)}</span>
      <span class="pt-time">${ago(t.exitTime)}</span>
    </div>`;
  }).join("") || `<div class="port-no-pos">No closed trades yet</div>`;

  return `
  <div class="port-panel">
    <div class="port-top">
      <span class="port-title">📊 Stock Futures Paper Account &nbsp;<small>5x lev · $6,250 start · 10 symbols</small></span>
    </div>

    <div class="port-stats">
      <div class="ps"><div class="ps-l">Balance</div><div class="ps-v">$${fmt(balance)}</div></div>
      <div class="ps"><div class="ps-l">Return</div><div class="ps-v ${pnlCls}">${retPct >= 0 ? "+" : ""}${retPct}%</div></div>
      <div class="ps"><div class="ps-l">Realised P&amp;L</div><div class="ps-v ${pnlCls}">${totPnl >= 0 ? "+" : ""}$${fmt(totPnl)}</div></div>
      ${positions.length ? `
      <div class="ps"><div class="ps-l">Unrealised</div><div class="ps-v ${unrealCls}">${totalUnreal >= 0 ? "+" : ""}$${totalUnreal.toFixed(2)}</div></div>
      <div class="ps"><div class="ps-l">Equity</div><div class="ps-v">$${equity.toFixed(2)}</div></div>` : ""}
      <div class="ps"><div class="ps-l">Max DD</div><div class="ps-v ${ddCls}">${dd.toFixed(1)}%</div></div>
      <div class="ps"><div class="ps-l">Trades</div><div class="ps-v">${trades.length}</div></div>
      <div class="ps"><div class="ps-l">Win Rate</div><div class="ps-v">${wr}${wr !== "—" ? "%" : ""}</div></div>
      <div class="ps"><div class="ps-l">Profit Factor</div><div class="ps-v">${pf}</div></div>
      <div class="ps"><div class="ps-l">Open</div><div class="ps-v">${positions.length} / 10</div></div>
    </div>

    <div class="strat-split">
      <div class="strat-box dt">
        <div class="strat-label">DT Strategy <small>(EMA21 · 15m)</small></div>
        <div class="strat-nums">
          <span>${dtTrades.length} trades</span>
          <span class="${dtPnl >= 0 ? "pos" : "neg"}">${dtPnl >= 0 ? "+" : ""}$${dtPnl.toFixed(2)}</span>
          <span>${dtWR}${dtWR !== "—" ? "% WR" : ""}</span>
        </div>
      </div>
      <div class="strat-box orb">
        <div class="strat-label">ORB Strategy <small>(Opening Range · 5m)</small></div>
        <div class="strat-nums">
          <span>${orbTrades.length} trades</span>
          <span class="${orbPnl >= 0 ? "pos" : "neg"}">${orbPnl >= 0 ? "+" : ""}$${orbPnl.toFixed(2)}</span>
          <span>${orbWR}${orbWR !== "—" ? "% WR" : ""}</span>
        </div>
      </div>
    </div>

    <div class="port-section-label">Open Positions · Live P&amp;L</div>
    <div class="port-positions">${posRows}</div>

    <div class="port-section-label">Recent Closed Trades</div>
    <div class="port-trades">${recentTrades}</div>
  </div>`;
}

// ─── Symbol cards ─────────────────────────────────────────────────────────────

function symbolCard(sym, acc, price) {
  const positions  = acc?.positions ?? [];
  const trades     = acc?.trades    ?? [];
  const openPos    = positions.find(p => p.symbol === sym);
  const symTrades  = trades.filter(t => t.symbol === sym);
  const symWins    = symTrades.filter(t => t.pnl > 0);
  const symPnl     = symTrades.reduce((s, t) => s + t.pnl, 0);
  const wr         = symTrades.length ? (symWins.length / symTrades.length * 100).toFixed(0) : "—";
  const isORB      = ORB_SYMS.includes(sym);
  const stratLabel = isORB ? "ORB" : "DT";
  const label      = LABEL[sym];

  let statusCls = "idle", statusTxt = "— WATCHING";
  if (openPos) {
    statusCls = openPos.direction === "LONG" ? "long" : "short";
    statusTxt = openPos.direction === "LONG" ? "▲ LONG OPEN" : "▼ SHORT OPEN";
  }

  let posSection = "";
  if (openPos) {
    const cur    = price;
    const isLong = openPos.direction === "LONG";
    const slDist = Math.abs(openPos.entry - openPos.sl);
    const slPct  = slDist / openPos.entry;
    const movePct = cur != null ? (isLong ? (cur - openPos.entry) / openPos.entry : (openPos.entry - cur) / openPos.entry) : null;
    const unreal  = movePct != null && slPct > 0 ? (movePct / slPct) * openPos.riskUSD : null;
    const distSL  = cur != null ? (isLong ? (cur - openPos.sl) / cur * 100 : (openPos.sl - cur) / cur * 100) : null;
    const distTP  = cur != null ? (isLong ? (openPos.tp - cur) / cur * 100 : (cur - openPos.tp) / cur * 100) : null;
    const uCls    = unreal == null ? "" : unreal >= 0 ? "pos" : "neg";
    const barsHeld = openPos.strategy === "DT" ? Math.round((Date.now() - openPos.entryTime) / (15 * 60 * 1000)) : null;

    const orInfo = openPos.orRange != null
      ? `<span class="op-or">OR: ${fmtPrice(openPos.orLow)}–${fmtPrice(openPos.orHigh)}</span>`
      : "";

    posSection = `
    <div class="card-section-label">Open Position</div>
    <div class="open-pos ${openPos.direction.toLowerCase()}">
      <span class="op-dir">${isLong ? "▲" : "▼"} ${openPos.direction}</span>
      <span class="op-strat">${openPos.strategy}</span>
      <span class="op-entry">${fmtPrice(openPos.entry)}</span>
      ${cur != null ? `<span class="op-cur">→ ${fmtPrice(cur)}</span>` : ""}
      ${unreal != null ? `<span class="op-unreal ${uCls}">${unreal >= 0 ? "+" : ""}$${unreal.toFixed(2)}</span>` : ""}
      <span class="op-sl">SL ${fmtPrice(openPos.sl)}${distSL != null ? ` · ${distSL.toFixed(1)}%` : ""}</span>
      <span class="op-tp">TP ${fmtPrice(openPos.tp)}${distTP != null ? ` · ${distTP.toFixed(1)}%` : ""}</span>
      ${orInfo}
      ${barsHeld != null ? `<span class="op-bars">${barsHeld}/12 bars</span>` : ""}
    </div>`;
  }

  return `
  <div class="card ${statusCls}">
    <div class="card-head">
      <span class="coin">${label}</span>
      <span class="cprice">${price != null ? fmtPrice(price) : "—"}</span>
      <span class="cstrat ${isORB ? "orb" : "dt"}">${stratLabel}</span>
      <span class="badge ${statusCls}">${statusTxt}</span>
    </div>
    <div class="card-stats-row">
      <span class="cs ${symPnl >= 0 ? "pos" : "neg"}">${symPnl >= 0 ? "+" : ""}$${symPnl.toFixed(2)}</span>
      <span class="cs-sep">·</span>
      <span class="cs">${wr}${wr !== "—" ? "% WR" : ""}</span>
      <span class="cs-sep">·</span>
      <span class="cs muted">${symTrades.length} trades</span>
    </div>
    ${posSection}
  </div>`;
}

// ─── Session / market status banner ──────────────────────────────────────────

function marketBanner() {
  const rth     = isRTH();
  const orWin   = isORWindow();
  const toRTH   = timeToRTH();
  const h       = new Date().getUTCHours();
  const m       = new Date().getUTCMinutes();
  const timeStr = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} UTC`;
  const nowMin  = utcMinutes();
  const orDone  = nowMin >= 14 * 60;

  return `
  <div class="strategy-banner">
    <div class="sb-left">
      <span class="sb-title">STOCKS</span>
      <span class="sb-sep">·</span>
      <span class="sb-item">DT: EMA21 15m · RTH only</span>
      <span class="sb-sep">·</span>
      <span class="sb-item">ORB: Opening Range 13:30–14:00 UTC</span>
      <span class="sb-sep">·</span>
      <span class="sb-item" style="color:#fbbf24">⚡ 5x Leverage</span>
      <span class="sb-sep">·</span>
      <span class="sb-item">0.8% risk · 5x lev</span>
    </div>
    <div class="sb-right">
      <span class="sess-time">${timeStr}</span>
      ${rth
        ? `<span class="sess-pill sess-rth">🟢 RTH ACTIVE</span>`
        : `<span class="sess-pill sess-closed">⛔ Market Closed</span>`}
      ${orWin
        ? `<span class="sess-pill sess-or">📊 OR FORMING</span>`
        : rth && orDone
        ? `<span class="sess-pill sess-post">✅ OR Complete · ORB Watching</span>`
        : ""}
      ${!rth && toRTH ? `<span class="sess-next">${toRTH}</span>` : ""}
    </div>
  </div>`;
}

// ─── Full page ────────────────────────────────────────────────────────────────

async function page() {
  await syncFromGist();
  const acc    = loadAccount();
  const now    = new Date().toLocaleTimeString();
  const prices = await fetchLivePrices(ALL_SYMS);

  const dtCards  = DT_SYMS.map(sym  => symbolCard(sym, acc, prices[sym])).join("\n");
  const orbCards = ORB_SYMS.map(sym => symbolCard(sym, acc, prices[sym])).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="20">
<title>Stock Futures Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080b12;color:#e2e8f0;font-family:'Segoe UI',system-ui,sans-serif;padding:16px;min-height:100vh}

/* Header */
header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #1a2035}
h1{font-size:.95rem;color:#475569;letter-spacing:.08em;text-transform:uppercase}
.hright{font-size:.72rem;color:#374151}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#22c55e;margin-right:5px;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}

/* Strategy banner */
.strategy-banner{background:#0b111e;border:1px solid #1a2a42;border-radius:10px;padding:10px 16px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.sb-title{font-size:.85rem;font-weight:800;color:#fbbf24;letter-spacing:.04em}
.sb-sep{color:#1e2d45}
.sb-left,.sb-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sb-item{font-size:.68rem;color:#64748b}
.sess-time{font-size:.72rem;color:#64748b;font-weight:600}
.sess-pill{font-size:.68rem;font-weight:700;padding:2px 8px;border-radius:12px}
.sess-rth{background:#052e16;color:#4ade80;border:1px solid #166534}
.sess-closed{background:#111827;color:#374151;border:1px solid #1e2d45}
.sess-or{background:#1c1a07;color:#fbbf24;border:1px solid #d97706}
.sess-post{background:#0c1a2e;color:#93c5fd;border:1px solid #1e3a5f}
.sess-next{font-size:.65rem;color:#374151}

/* Strategy badges */
.strat-badge{font-size:.6rem;font-weight:700;padding:1px 6px;border-radius:4px;letter-spacing:.04em}
.strat-badge.dt{background:#1e1b4b;color:#a5b4fc;border:1px solid #3730a3}
.strat-badge.orb{background:#1c3a2c;color:#86efac;border:1px solid #15803d}

/* Portfolio panel */
.port-panel{background:#0b1220;border:1px solid #1e3a5f;border-radius:12px;padding:16px;margin-bottom:14px}
.port-empty{border-color:#1a2035}
.port-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.port-title{font-size:.9rem;font-weight:800;color:#fbbf24;letter-spacing:.04em}
.port-title small{font-size:.65rem;color:#64748b;font-weight:400}
.port-stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.ps{display:flex;flex-direction:column;align-items:center;background:#080c14;border-radius:8px;padding:6px 12px;min-width:80px}
.ps-l{font-size:.58rem;color:#475569;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px}
.ps-v{font-size:.85rem;font-weight:700;color:#cbd5e1}
.ps-v.pos{color:#4ade80}
.ps-v.neg{color:#f87171}
.ps-v.warn{color:#fbbf24}

/* Strategy split */
.strat-split{display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.strat-box{flex:1;min-width:220px;border-radius:8px;padding:10px 14px}
.strat-box.dt{background:#0d0d1f;border:1px solid #3730a3}
.strat-box.orb{background:#0a1a12;border:1px solid #15803d}
.strat-label{font-size:.72rem;font-weight:700;margin-bottom:6px}
.strat-box.dt .strat-label{color:#a5b4fc}
.strat-box.orb .strat-label{color:#86efac}
.strat-label small{font-size:.6rem;font-weight:400;color:#64748b}
.strat-nums{display:flex;gap:14px;font-size:.75rem;color:#94a3b8;flex-wrap:wrap}
.strat-nums span{font-weight:600}

/* Section labels */
.port-section-label{font-size:.58rem;color:#374151;text-transform:uppercase;letter-spacing:.07em;margin:8px 0 5px}
.port-positions,.port-trades{display:flex;flex-direction:column;gap:4px;margin-bottom:4px}
.port-no-pos{font-size:.68rem;color:#374151;padding:4px 0}
.muted{color:#374151}

/* Open positions */
.port-pos{display:flex;align-items:center;gap:8px;background:#080c14;border-radius:6px;padding:6px 10px;font-size:.68rem;flex-wrap:wrap}
.pos-winning{border-left:2px solid #166534}
.pos-losing{border-left:2px solid #7f1d1d}
.pos-dir{font-weight:800;min-width:70px}
.pos-dir.long{color:#4ade80}
.pos-dir.short{color:#f87171}
.pos-sym{font-weight:700;color:#e2e8f0}
.pos-entry{color:#94a3b8}
.pos-cur{color:#e2e8f0;font-weight:700}
.pos-sl{color:#f87171;font-size:.63rem}
.pos-tp{color:#4ade80;font-size:.63rem}
.pos-unreal{font-weight:800;font-size:.72rem}
.pos-unreal.pos{color:#4ade80}
.pos-unreal.neg{color:#f87171}
.pos-bars{font-size:.62rem;color:#64748b}
.pos-time{color:#374151;font-size:.62rem;margin-left:auto}
.pos-flag{font-size:.62rem;font-weight:700;padding:1px 6px;border-radius:4px}
.pos-flag.warn{background:#78350f;color:#fbbf24}
.pos-flag.good{background:#052e16;color:#4ade80}
.pos-flag.time{background:#1e1b4b;color:#a5b4fc}

/* Recent trades */
.port-trade{display:flex;align-items:center;gap:8px;background:#080c14;border-radius:6px;padding:5px 10px;font-size:.68rem}
.port-trade.win{border-left:2px solid #166534}
.port-trade.loss{border-left:2px solid #7f1d1d}
.pt-sym{font-weight:700;min-width:36px}
.pt-dir{font-weight:700;min-width:60px}
.pt-dir.long{color:#4ade80}
.pt-dir.short{color:#f87171}
.pt-exit{color:#64748b;min-width:38px}
.pt-pnl{font-weight:700;min-width:60px;text-align:right}
.pt-pnl.pos{color:#4ade80}
.pt-pnl.neg{color:#f87171}
.pt-time{color:#374151;font-size:.62rem;margin-left:auto}

/* Section divider */
.section-hdr{font-size:.7rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.1em;margin:14px 0 8px;padding:6px 10px;background:#0b111e;border-radius:6px;border-left:3px solid}
.section-hdr.dt{border-color:#4f46e5;color:#a5b4fc}
.section-hdr.orb{border-color:#16a34a;color:#86efac}

/* Cards */
.grid-dt{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}
.grid-orb{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px}
@media(max-width:1100px){.grid-dt{grid-template-columns:repeat(3,1fr)}}
@media(max-width:800px){.grid-dt,.grid-orb{grid-template-columns:repeat(2,1fr)}}
@media(max-width:500px){.grid-dt,.grid-orb{grid-template-columns:1fr}}
.card{background:#0f1520;border-radius:10px;padding:14px;border:1px solid #1a2035;position:relative;overflow:hidden}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px}
.card.long::before{background:linear-gradient(90deg,#16a34a,#22c55e)}
.card.short::before{background:linear-gradient(90deg,#b91c1c,#ef4444)}
.card.idle::before{background:#1e2d45}
.card-head{display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap}
.coin{font-size:1.3rem;font-weight:900;color:#f1f5f9}
.cprice{font-size:.82rem;font-weight:700;color:#94a3b8}
.cstrat{font-size:.58rem;font-weight:700;padding:1px 5px;border-radius:3px}
.cstrat.dt{background:#1e1b4b;color:#a5b4fc}
.cstrat.orb{background:#1c3a2c;color:#86efac}
.badge{font-size:.62rem;font-weight:700;padding:2px 8px;border-radius:20px;letter-spacing:.03em;margin-left:auto;white-space:nowrap}
.badge.long{background:#052e16;color:#4ade80;border:1px solid #166534}
.badge.short{background:#2d0a0a;color:#f87171;border:1px solid #7f1d1d}
.badge.idle{background:#111827;color:#374151;border:1px solid #1e2d45}
.card-stats-row{display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:.68rem}
.cs{font-weight:700}
.cs.pos{color:#4ade80}
.cs.neg{color:#f87171}
.cs-sep{color:#1e2d45}
.card-section-label{font-size:.56rem;color:#374151;text-transform:uppercase;letter-spacing:.07em;margin:6px 0 3px}
.open-pos{display:flex;align-items:center;gap:6px;padding:7px 9px;border-radius:6px;font-size:.64rem;flex-wrap:wrap}
.open-pos.long{background:#052e16;border:1px solid #166534}
.open-pos.short{background:#2d0a0a;border:1px solid #7f1d1d}
.op-dir{font-weight:800;min-width:54px}
.open-pos.long .op-dir{color:#4ade80}
.open-pos.short .op-dir{color:#f87171}
.op-strat{font-size:.58rem;background:#111827;padding:1px 4px;border-radius:3px;color:#7dd3fc}
.op-entry,.op-cur{color:#cbd5e1;font-weight:600}
.op-unreal{font-weight:800;font-size:.7rem}
.op-unreal.pos{color:#4ade80}
.op-unreal.neg{color:#f87171}
.op-sl{color:#f87171;font-size:.60rem}
.op-tp{color:#4ade80;font-size:.60rem}
.op-or{color:#fbbf24;font-size:.58rem}
.op-bars{font-size:.58rem;color:#64748b;margin-left:auto}

.pos{color:#4ade80}
.neg{color:#f87171}
footer{text-align:center;margin-top:14px;font-size:.62rem;color:#1e2d45}
</style>
</head>
<body>
<header>
  <h1>📊 Stock Futures · DT (15m EMA21) + ORB (Opening Range) · BitMEX · 5x Leverage</h1>
  <div class="hright"><span class="dot"></span>Auto-refresh 20s · Last: ${now}</div>
</header>
${marketBanner()}
${portfolioPanel(acc, prices)}

<div class="section-hdr dt">📈 DT Strategy — EMA21 Recapture/Rejection · 15m · RTH 13:30–20:00 UTC · 7 Symbols</div>
<div class="grid-dt">${dtCards}</div>

<div class="section-hdr orb">🎯 ORB Strategy — Opening Range Breakout · 5m · 13:30–14:00 OR · 3 Symbols</div>
<div class="grid-orb">${orbCards}</div>

<footer>PAPER TRADING · Stock Futures · BitMEX · DT: SPY MSTR TSLA NFLX AMZN MSFT ORCL · ORB: COIN NVDA GOOGL · 5x leverage · 0.8% risk/trade · RTH 13:30–20:00 UTC</footer>
</body>
</html>`;
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(await page());
});

server.listen(PORT, () => {
  console.log(`\n📊 Stock Futures Dashboard → http://localhost:${PORT}`);
  console.log(`   DT: SPY MSTR TSLA NFLX AMZN MSFT ORCL`);
  console.log(`   ORB: COIN NVDA GOOGL`);
  console.log(`   Auto-refreshes every 20s. Ctrl+C to stop.\n`);
});
