/**
 * Day Trading Dashboard — bot_daytrading_v01.js
 * Run: node dashboard_dt.js
 * Open: http://localhost:3001
 * Auto-refreshes every 20 seconds.
 *
 * Strategy: EMA21 Recapture / Rejection — 15-Minute
 * Universe: BTCUSDT, BNBUSDT, XRPUSDT, SUIUSDT, LTCUSDT, AVAXUSDT
 * Leverage: 5x | Risk: 0.8% per trade | Sessions: Asia + London + US
 */

import "dotenv/config";
import http from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";

const PORT  = 3001;
const PAIRS = ["BTC_USDT", "BNB_USDT", "XRP_USDT", "SUI_USDT", "LTC_USDT", "AVAX_USDT"];
const LABEL = { BTC_USDT:"BTC", BNB_USDT:"BNB", XRP_USDT:"XRP", SUI_USDT:"SUI", LTC_USDT:"LTC", AVAX_USDT:"AVAX" };
const BINANCE_SYMBOL = { BTC_USDT:"BTCUSDT", BNB_USDT:"BNBUSDT", XRP_USDT:"XRPUSDT", SUI_USDT:"SUIUSDT", LTC_USDT:"LTCUSDT", AVAX_USDT:"AVAXUSDT" };

// ── Gist sync ─────────────────────────────────────────────────────────────────

const GIST_ID      = process.env.GITHUB_GIST_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

async function syncFromGist() {
  if (!GIST_ID || !GITHUB_TOKEN) return;
  try {
    const res  = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    const file = data.files?.["paper_daytrading_v01.json"];
    if (!file) return;
    writeFileSync("paper_daytrading_v01.json", file.content, "utf8");
  } catch { /* silent */ }
}

// ── Account loader ────────────────────────────────────────────────────────────

function loadAccount() {
  try {
    if (existsSync("paper_daytrading_v01.json"))
      return JSON.parse(readFileSync("paper_daytrading_v01.json", "utf8"));
  } catch {}
  return null;
}

// ── Live price fetcher ────────────────────────────────────────────────────────

async function fetchLivePrices(symbols) {
  // MEXC-format symbols in → Binance API call → MEXC keys out
  const prices = {};
  if (!symbols.length) return prices;
  const mexcToBinance = {};
  for (const s of symbols) mexcToBinance[s] = BINANCE_SYMBOL[s] || s.replace("_","");
  const binanceToMexc = Object.fromEntries(Object.entries(mexcToBinance).map(([m,b])=>[b,m]));
  const binanceSyms = Object.values(mexcToBinance);
  try {
    const qs  = binanceSyms.map(s => `"${s}"`).join(",");
    const url = `https://api.binance.com/api/v3/ticker/price?symbols=[${qs}]`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const arr = await res.json();
    if (Array.isArray(arr)) arr.forEach(t => { const mexc = binanceToMexc[t.symbol]; if (mexc) prices[mexc] = parseFloat(t.price); });
  } catch {
    await Promise.allSettled(binanceSyms.map(async bSym => {
      try {
        const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${bSym}`, { signal: AbortSignal.timeout(5000) });
        const j = await r.json();
        const mexc = binanceToMexc[bSym]; if (mexc) prices[mexc] = parseFloat(j.price);
      } catch {}
    }));
  }
  return prices;
}

// ── Session helpers ───────────────────────────────────────────────────────────

function currentSessions() {
  const h = new Date().getUTCHours();
  const sessions = [];
  if (h >= 1  && h < 9)  sessions.push({ name: "Asia",   cls: "sess-asia"   });
  if (h >= 8  && h < 17) sessions.push({ name: "London", cls: "sess-london" });
  if (h >= 13 && h < 22) sessions.push({ name: "US",     cls: "sess-us"     });
  if (!sessions.length)  sessions.push({ name: "Closed (22:00–01:00 UTC)", cls: "sess-closed" });
  return sessions;
}

function nextSessionIn() {
  const h = new Date().getUTCHours();
  const m = new Date().getUTCMinutes();
  const totalMins = h * 60 + m;
  // Next opening is 01:00 UTC if we're in the dead zone
  if (h >= 22 || h < 1) {
    const target = h >= 22 ? (24 * 60 + 60) : 60;  // next 01:00
    const diff = target - totalMins;
    return `Opens in ${Math.floor(diff/60)}h ${diff%60}m`;
  }
  return null;
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmt(n, dp = 2) {
  if (n == null || isNaN(n)) return "N/A";
  const num = Number(n);
  if (Math.abs(num) < 0.01 && num !== 0) return num.toPrecision(4);
  return num.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function fmtPrice(p) {
  if (p == null) return "N/A";
  if (p >= 1000) return fmt(p, 2);
  if (p >= 1)    return fmt(p, 4);
  return fmt(p, 5);
}

function ago(ms) {
  if (!ms) return "never";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m ago`;
  return `${Math.floor(s/86400)}d ago`;
}

// ── Portfolio stats panel ─────────────────────────────────────────────────────

function portfolioPanel(acc, prices) {
  if (!acc) {
    return `<div class="port-panel port-empty">
      <span class="port-title">📋 Day Trading Paper Account</span>
      <p class="muted">No data yet — waiting for first bot run</p>
    </div>`;
  }

  const startBal = 1000;
  const balance  = acc.balance ?? startBal;
  const peak     = acc.peak    ?? balance;
  const dd       = peak > 0 ? ((peak - balance) / peak * 100) : 0;
  const trades   = acc.trades  ?? [];
  const positions = acc.positions ?? [];

  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const wr     = trades.length ? (wins.length / trades.length * 100).toFixed(0) : "—";
  const totPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const retPct = ((balance - startBal) / startBal * 100).toFixed(2);
  const pnlCls = totPnl >= 0 ? "pos" : "neg";
  const ddCls  = dd > 20 ? "neg" : dd > 10 ? "warn" : "pos";

  const tpC    = trades.filter(t => t.exitReason === "TP").length;
  const slC    = trades.filter(t => t.exitReason === "SL").length;
  const timeC  = trades.filter(t => t.exitReason === "TIME").length;

  // Profit factor
  const grossW = wins.reduce((s,t) => s + t.pnl, 0);
  const grossL = Math.abs(losses.reduce((s,t) => s + t.pnl, 0));
  const pf     = grossL > 0 ? (grossW / grossL).toFixed(2) : wins.length ? "∞" : "—";

  // Unrealised P&L from open positions
  let totalUnreal = 0;
  for (const p of positions) {
    const cur = prices[p.symbol];
    if (cur == null) continue;
    const isLong = p.direction === "LONG";
    const slDist = Math.abs(p.entry - p.sl);
    const slPct  = slDist / p.entry;
    const movePct = isLong ? (cur - p.entry)/p.entry : (p.entry - cur)/p.entry;
    const leverage = 5;
    const riskUSD = p.riskUSD || (balance * 0.008);
    const pnl = slPct > 0 ? (movePct / slPct) * riskUSD * leverage : 0;
    totalUnreal += pnl;
  }
  const unrealCls = totalUnreal >= 0 ? "pos" : "neg";
  const equity    = balance + totalUnreal;

  // Per-pair P&L
  const pairPnl = {};
  for (const sym of PAIRS) {
    const pt = trades.filter(t => t.sym === sym || t.symbol === sym);
    pairPnl[sym] = pt.reduce((s,t) => s+t.pnl, 0);
  }

  // Open positions rows
  const posRows = positions.length
    ? positions.map(p => {
        const cur    = prices[p.symbol];
        const isLong = p.direction === "LONG";
        const slDist = Math.abs(p.entry - p.sl);
        const slPct  = slDist / p.entry;
        const movePct = cur != null ? (isLong ? (cur-p.entry)/p.entry : (p.entry-cur)/p.entry) : null;
        const leverage = 5;
        const riskUSD = p.riskUSD || (balance * 0.008);
        const unreal  = movePct != null && slPct > 0 ? (movePct/slPct)*riskUSD*leverage : null;
        const uCls    = unreal == null ? "" : unreal >= 0 ? "pos" : "neg";

        const distSL = cur != null ? (isLong ? (cur-p.sl)/cur*100 : (p.sl-cur)/cur*100) : null;
        const distTP = cur != null ? (isLong ? (p.tp-cur)/cur*100 : (cur-p.tp)/cur*100) : null;
        const slClose = distSL != null && distSL < 1.5;
        const tpClose = distTP != null && distTP < 1.5;
        const barsHeld = Math.round((Date.now() - p.entryTime) / (15*60*1000));
        const timeWarn = barsHeld >= 6;

        const flag = slClose ? `<span class="pos-flag warn">⚠️ SL ${distSL.toFixed(1)}% away</span>`
                   : tpClose ? `<span class="pos-flag good">🎯 TP ${distTP.toFixed(1)}% away</span>`
                   : timeWarn ? `<span class="pos-flag time">⏱ ${barsHeld}/8 bars</span>` : "";

        return `<div class="port-pos ${unreal != null && unreal >= 0 ? "pos-winning" : unreal != null ? "pos-losing" : ""}">
          <span class="pos-dir ${isLong?"long":"short"}">${isLong?"▲":"▼"} ${p.direction}</span>
          <span class="pos-sym">${LABEL[p.symbol]||p.symbol}</span>
          <span class="pos-sig">${p.signal||"EMA21"}</span>
          <span class="pos-entry">Entry $${fmtPrice(p.entry)}</span>
          ${cur != null ? `<span class="pos-cur">→ $${fmtPrice(cur)}</span>` : ""}
          <span class="pos-sl">SL $${fmtPrice(p.sl)}${distSL!=null?` · ${distSL.toFixed(1)}% away`:""}</span>
          <span class="pos-tp">TP $${fmtPrice(p.tp)}${distTP!=null?` · ${distTP.toFixed(1)}% away`:""}</span>
          ${unreal != null
            ? `<span class="pos-unreal ${uCls}">${unreal>=0?"+":""}$${unreal.toFixed(2)}</span>`
            : `<span class="pos-unreal muted">—</span>`}
          <span class="pos-bars">${barsHeld}/8 bars</span>
          <span class="pos-time">${ago(p.entryTime)}</span>
          ${flag}
        </div>`;
      }).join("")
    : `<div class="port-no-pos">No open positions</div>`;

  // Recent trades (last 8)
  const recentTrades = trades.slice(-8).reverse().map(t => {
    const win  = t.pnl > 0;
    const isL  = t.direction === "LONG";
    const sym  = LABEL[t.sym||t.symbol] || (t.sym||t.symbol||"").replace("USDT","");
    return `<div class="port-trade ${win?"win":"loss"}">
      <span class="pt-sym">${sym}</span>
      <span class="pt-dir ${isL?"long":"short"}">${isL?"▲":"▼"} ${t.direction}</span>
      <span class="pt-sig">${t.signal||"EMA21"}</span>
      <span class="pt-exit">${t.exitReason}</span>
      <span class="pt-pnl ${win?"pos":"neg"}">${win?"+":""}$${(t.pnl||0).toFixed(2)}</span>
      <span class="pt-time">${ago(t.exitTime)}</span>
    </div>`;
  }).join("") || `<div class="port-no-pos">No closed trades yet</div>`;

  return `
  <div class="port-panel">
    <div class="port-top">
      <span class="port-title">📋 Day Trading Paper Account &nbsp;<small>5x lev · $8,750 start · 6 pairs</small></span>
      <span class="port-lastrun">Updated: just now</span>
    </div>

    <div class="port-stats">
      <div class="ps"><div class="ps-l">Balance</div><div class="ps-v">$${fmt(balance)}</div></div>
      <div class="ps"><div class="ps-l">Return</div><div class="ps-v ${pnlCls}">${retPct>=0?"+":""}${retPct}%</div></div>
      <div class="ps"><div class="ps-l">Realised P&amp;L</div><div class="ps-v ${pnlCls}">${totPnl>=0?"+":""}$${fmt(totPnl)}</div></div>
      ${positions.length ? `
      <div class="ps"><div class="ps-l">Unrealised</div><div class="ps-v ${unrealCls}">${totalUnreal>=0?"+":""}$${totalUnreal.toFixed(2)}</div></div>
      <div class="ps"><div class="ps-l">Equity</div><div class="ps-v">$${equity.toFixed(2)}</div></div>` : ""}
      <div class="ps"><div class="ps-l">Max DD</div><div class="ps-v ${ddCls}">${dd.toFixed(1)}%</div></div>
      <div class="ps"><div class="ps-l">Trades</div><div class="ps-v">${trades.length}</div></div>
      <div class="ps"><div class="ps-l">Win Rate</div><div class="ps-v">${wr}${wr!=="—"?"%":""}</div></div>
      <div class="ps"><div class="ps-l">W / L</div><div class="ps-v">${wins.length} / ${losses.length}</div></div>
      <div class="ps"><div class="ps-l">Profit Factor</div><div class="ps-v">${pf}</div></div>
      <div class="ps"><div class="ps-l">TP / SL / TIME</div><div class="ps-v">${tpC} / ${slC} / ${timeC}</div></div>
      <div class="ps"><div class="ps-l">Open</div><div class="ps-v">${positions.length} / 6</div></div>
    </div>

    <div class="port-section-label">Per-pair P&amp;L</div>
    <div class="pair-pnl-row">
      ${PAIRS.map(sym => {
        const pnl = pairPnl[sym] || 0;
        const pt  = trades.filter(t=>(t.sym||t.symbol)===sym);
        const pw  = pt.filter(t=>t.pnl>0);
        const pwr = pt.length ? (pw.length/pt.length*100).toFixed(0) : "—";
        const cls = pnl >= 0 ? "pos" : "neg";
        return `<div class="pair-pnl">
          <span class="pp-sym">${LABEL[sym]}</span>
          <span class="pp-pnl ${cls}">${pnl>=0?"+":""}$${pnl.toFixed(2)}</span>
          <span class="pp-wr">${pwr}${pwr!=="—"?"%":""} WR · ${pt.length}t</span>
        </div>`;
      }).join("")}
    </div>

    <div class="port-section-label">Open Positions · Live P&amp;L</div>
    <div class="port-positions">${posRows}</div>

    <div class="port-section-label">Recent Closed Trades</div>
    <div class="port-trades">${recentTrades}</div>
  </div>`;
}

// ── Pair cards ────────────────────────────────────────────────────────────────

function pairCard(sym, acc, price) {
  const positions = acc?.positions ?? [];
  const trades    = acc?.trades    ?? [];
  const openPos   = positions.find(p => p.symbol === sym);
  const pairTrades = trades.filter(t => (t.sym||t.symbol) === sym);
  const pairWins  = pairTrades.filter(t => t.pnl > 0);
  const pairPnl   = pairTrades.reduce((s,t)=>s+t.pnl,0);
  const wr        = pairTrades.length ? (pairWins.length/pairTrades.length*100).toFixed(0) : "—";

  const label = LABEL[sym];

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
    const movePct = cur != null ? (isLong ? (cur-openPos.entry)/openPos.entry : (openPos.entry-cur)/openPos.entry) : null;
    const riskUSD = openPos.riskUSD;
    const unreal  = movePct != null && slPct > 0 ? (movePct/slPct)*riskUSD*5 : null;
    const distSL  = cur != null ? (isLong ? (cur-openPos.sl)/cur*100 : (openPos.sl-cur)/cur*100) : null;
    const distTP  = cur != null ? (isLong ? (openPos.tp-cur)/cur*100 : (cur-openPos.tp)/cur*100) : null;
    const uCls    = unreal == null ? "" : unreal >= 0 ? "pos" : "neg";
    const barsHeld = Math.round((Date.now() - openPos.entryTime) / (15*60*1000));

    posSection = `
    <div class="card-section-label">Open Position</div>
    <div class="open-pos ${openPos.direction.toLowerCase()}">
      <span class="op-dir">${isLong?"▲":"▼"} ${openPos.direction}</span>
      <span class="op-sig">${openPos.signal||"EMA21"}</span>
      <span class="op-entry">$${fmtPrice(openPos.entry)}</span>
      ${cur!=null?`<span class="op-cur">→ $${fmtPrice(cur)}</span>`:""}
      ${unreal!=null?`<span class="op-unreal ${uCls}">${unreal>=0?"+":""}$${unreal.toFixed(2)}</span>`:""}
      <span class="op-sl">SL $${fmtPrice(openPos.sl)}${distSL!=null?` · ${distSL.toFixed(1)}%`:""}</span>
      <span class="op-tp">TP $${fmtPrice(openPos.tp)}${distTP!=null?` · ${distTP.toFixed(1)}%`:""}</span>
      <span class="op-bars">${barsHeld}/8 bars</span>
    </div>`;
  }

  return `
  <div class="card ${statusCls}">
    <div class="card-head">
      <span class="coin">${label}</span>
      <span class="cprice">${price != null ? "$"+fmtPrice(price) : "—"}</span>
      <span class="badge ${statusCls}">${statusTxt}</span>
    </div>
    <div class="card-stats-row">
      <span class="cs ${pairPnl>=0?"pos":"neg"}">${pairPnl>=0?"+":""}$${pairPnl.toFixed(2)}</span>
      <span class="cs-sep">·</span>
      <span class="cs">${wr}${wr!=="—"?"%":""} WR</span>
      <span class="cs-sep">·</span>
      <span class="cs muted">${pairTrades.length} trades</span>
    </div>
    ${posSection}
  </div>`;
}

// ── Session banner ────────────────────────────────────────────────────────────

function sessionBanner() {
  const sessions = currentSessions();
  const next     = nextSessionIn();
  const isActive = !sessions[0].cls.includes("closed");

  const sessionPills = sessions.map(s =>
    `<span class="sess-pill ${s.cls}">${s.name}</span>`
  ).join("");

  const h = new Date().getUTCHours();
  const m = new Date().getUTCMinutes();
  const timeStr = `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")} UTC`;

  return `
  <div class="strategy-banner">
    <div class="sb-left">
      <span class="sb-title">DT PHASE 1</span>
      <span class="sb-sep">·</span>
      <span class="sb-item">15min · EMA21 Recapture · Session ORB Bias · ADX≥15</span>
      <span class="sb-sep">·</span>
      <span class="sb-item" style="color:#fbbf24">⚡ 5x Lev (margin only)</span>
      <span class="sb-sep">·</span>
      <span class="sb-item" style="color:#f97316">1.0% risk · 2.0× R:R · 4.5h max hold</span>
      <span class="sb-sep">·</span>
      <span class="sb-item">TAKER market orders</span>
    </div>
    <div class="sb-right">
      <span class="sess-time">${timeStr}</span>
      ${sessionPills}
      ${!isActive ? `<span class="sess-next">${next||""}</span>` : `<span class="sess-active">🟢 BOT ACTIVE</span>`}
    </div>
  </div>`;
}

// ── Full page ─────────────────────────────────────────────────────────────────

async function page() {
  await syncFromGist();
  const acc  = loadAccount();
  const now  = new Date().toLocaleTimeString();

  const allSymbols = PAIRS;
  const prices     = await fetchLivePrices(allSymbols);

  const cards = PAIRS.map(sym => pairCard(sym, acc, prices[sym])).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="20">
<title>Day Trading Dashboard — DT v01</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080b12;color:#e2e8f0;font-family:'Segoe UI',system-ui,sans-serif;padding:16px;min-height:100vh}
code{font-family:monospace;background:#111827;padding:2px 6px;border-radius:3px;color:#7dd3fc}

/* ── Header ── */
header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #1a2035}
h1{font-size:.95rem;color:#475569;letter-spacing:.08em;text-transform:uppercase}
.hright{font-size:.72rem;color:#374151}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#22c55e;margin-right:5px;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}

/* ── Strategy banner ── */
.strategy-banner{background:#0b111e;border:1px solid #1a2a42;border-radius:10px;padding:10px 16px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.sb-title{font-size:.85rem;font-weight:800;color:#93c5fd;letter-spacing:.04em}
.sb-sep{color:#1e2d45;font-size:.8rem}
.sb-left,.sb-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sb-item{font-size:.68rem;color:#64748b}
.long-txt{color:#4ade80}
.short-txt{color:#f87171}
.warn{color:#fbbf24}

/* ── Session pills ── */
.sess-time{font-size:.72rem;color:#64748b;font-weight:600}
.sess-pill{font-size:.68rem;font-weight:700;padding:2px 8px;border-radius:12px;letter-spacing:.03em}
.sess-asia{background:#1e1b4b;color:#a5b4fc;border:1px solid #3730a3}
.sess-london{background:#1c3a2c;color:#86efac;border:1px solid #15803d}
.sess-us{background:#2d1b0a;color:#fcd34d;border:1px solid #d97706}
.sess-closed{background:#111827;color:#374151;border:1px solid #1e2d45}
.sess-active{font-size:.68rem;font-weight:700;color:#4ade80}
.sess-next{font-size:.65rem;color:#374151}

/* ── Portfolio panel ── */
.port-panel{background:#0b1220;border:1px solid #1e3a5f;border-radius:12px;padding:16px;margin-bottom:14px}
.port-empty{border-color:#1a2035}
.port-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.port-title{font-size:.9rem;font-weight:800;color:#93c5fd;letter-spacing:.04em}
.port-title small{font-size:.65rem;color:#64748b;font-weight:400}
.port-lastrun{font-size:.68rem;color:#374151}
.port-stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.ps{display:flex;flex-direction:column;align-items:center;background:#080c14;border-radius:8px;padding:6px 12px;min-width:80px}
.ps-l{font-size:.58rem;color:#475569;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px}
.ps-v{font-size:.85rem;font-weight:700;color:#cbd5e1}
.ps-v.pos{color:#4ade80}
.ps-v.neg{color:#f87171}
.ps-v.warn{color:#fbbf24}
.port-section-label{font-size:.58rem;color:#374151;text-transform:uppercase;letter-spacing:.07em;margin:8px 0 5px}
.port-positions,.port-trades{display:flex;flex-direction:column;gap:4px;margin-bottom:4px}
.port-no-pos{font-size:.68rem;color:#374151;padding:4px 0}
.muted{color:#374151}

/* ── Per-pair P&L row ── */
.pair-pnl-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px}
.pair-pnl{background:#080c14;border-radius:8px;padding:6px 12px;display:flex;flex-direction:column;align-items:center;min-width:80px}
.pp-sym{font-size:.75rem;font-weight:800;color:#93c5fd;margin-bottom:2px}
.pp-pnl{font-size:.82rem;font-weight:700}
.pp-pnl.pos{color:#4ade80}
.pp-pnl.neg{color:#f87171}
.pp-wr{font-size:.58rem;color:#475569;margin-top:2px}

/* ── Open positions ── */
.port-pos{display:flex;align-items:center;gap:8px;background:#080c14;border-radius:6px;padding:6px 10px;font-size:.68rem;flex-wrap:wrap}
.pos-winning{border-left:2px solid #166534}
.pos-losing{border-left:2px solid #7f1d1d}
.pos-dir{font-weight:800;min-width:70px}
.pos-dir.long{color:#4ade80}
.pos-dir.short{color:#f87171}
.pos-sym{font-weight:700;color:#e2e8f0;min-width:32px}
.pos-sig{font-size:.62rem;background:#111827;padding:1px 5px;border-radius:4px;color:#7dd3fc}
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

/* ── Recent trades ── */
.port-trade{display:flex;align-items:center;gap:8px;background:#080c14;border-radius:6px;padding:5px 10px;font-size:.68rem}
.port-trade.win{border-left:2px solid #166534}
.port-trade.loss{border-left:2px solid #7f1d1d}
.pt-sym{font-weight:700;color:#e2e8f0;min-width:32px}
.pt-dir{font-weight:700;min-width:60px}
.pt-dir.long{color:#4ade80}
.pt-dir.short{color:#f87171}
.pt-sig{font-size:.6rem;background:#111827;padding:1px 5px;border-radius:4px;color:#7dd3fc;min-width:40px}
.pt-exit{color:#64748b;min-width:38px}
.pt-pnl{font-weight:700;min-width:60px;text-align:right}
.pt-pnl.pos{color:#4ade80}
.pt-pnl.neg{color:#f87171}
.pt-time{color:#374151;font-size:.62rem;margin-left:auto}

/* ── Pair cards ── */
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:14px}
@media(max-width:900px){.grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:500px){.grid{grid-template-columns:1fr}}
.card{background:#0f1520;border-radius:10px;padding:14px;border:1px solid #1a2035;position:relative;overflow:hidden}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px}
.card.long::before{background:linear-gradient(90deg,#16a34a,#22c55e)}
.card.short::before{background:linear-gradient(90deg,#b91c1c,#ef4444)}
.card.idle::before{background:#1e2d45}
.card-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.coin{font-size:1.4rem;font-weight:900;color:#f1f5f9;min-width:44px}
.cprice{font-size:.85rem;font-weight:700;color:#94a3b8}
.badge{font-size:.62rem;font-weight:700;padding:2px 8px;border-radius:20px;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;margin-left:auto}
.badge.long{background:#052e16;color:#4ade80;border:1px solid #166534}
.badge.short{background:#2d0a0a;color:#f87171;border:1px solid #7f1d1d}
.badge.idle{background:#111827;color:#374151;border:1px solid #1e2d45}
.card-stats-row{display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:.68rem}
.cs{font-weight:700}
.cs.pos{color:#4ade80}
.cs.neg{color:#f87171}
.cs-sep{color:#1e2d45}
.card-section-label{font-size:.56rem;color:#374151;text-transform:uppercase;letter-spacing:.07em;margin:6px 0 3px}
.open-pos{display:flex;align-items:center;gap:6px;padding:7px 9px;border-radius:6px;font-size:.65rem;flex-wrap:wrap}
.open-pos.long{background:#052e16;border:1px solid #166534}
.open-pos.short{background:#2d0a0a;border:1px solid #7f1d1d}
.op-dir{font-weight:800;min-width:60px}
.open-pos.long .op-dir{color:#4ade80}
.open-pos.short .op-dir{color:#f87171}
.op-sig{font-size:.6rem;background:#0d1f0d;padding:1px 5px;border-radius:4px;color:#86efac}
.op-entry{color:#cbd5e1;font-weight:600}
.op-cur{color:#e2e8f0;font-weight:700}
.op-unreal{font-weight:800;font-size:.72rem}
.op-unreal.pos{color:#4ade80}
.op-unreal.neg{color:#f87171}
.op-sl{color:#f87171;font-size:.60rem}
.op-tp{color:#4ade80;font-size:.60rem}
.op-bars{font-size:.60rem;color:#64748b;margin-left:auto}

footer{text-align:center;margin-top:14px;font-size:.62rem;color:#1e2d45}
</style>
</head>
<body>
<header>
  <h1>⚡ Day Trading Bot · 15m · EMA21 + ORB Bias · 5x Leverage · 6 Pairs</h1>
  <div class="hright"><span class="dot"></span>Auto-refresh 20s &nbsp;·&nbsp; Last: ${now}</div>
</header>
${sessionBanner()}
${portfolioPanel(acc, prices)}
<div class="grid">${cards}</div>
<footer>PAPER TRADING · DT PHASE 1 · 15m · BTC BNB XRP SUI LTC AVAX · 5x Leverage (margin only) · 1.0% risk/trade · R:R 2.0 · Max hold 4.5h · ADX≥15 · TAKER orders · Sessions: Asia 01:00 · London 08:00 · US 13:00 UTC</footer>
</body>
</html>`;
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(await page());
});

server.listen(PORT, () => {
  console.log(`\n⚡ Day Trading Dashboard → http://localhost:${PORT}`);
  console.log(`   BTC · BNB · XRP · SUI · LTC · AVAX · 5x leverage · 0.8% risk · 15m EMA21`);
  console.log(`   Auto-refreshes every 20s. Ctrl+C to stop.\n`);
});
