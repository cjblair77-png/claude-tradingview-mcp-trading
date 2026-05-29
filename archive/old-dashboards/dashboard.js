/**
 * Trading Bot Dashboard — v09 Strategy
 * Run once: node dashboard.js
 * Then open: http://localhost:3000
 * Auto-refreshes every 30 seconds.
 *
 * Strategy: Top-30 Curated Universe | 1.5x Leverage | $1,000 paper start
 * Timeframe: 4H | Pairs: 30 (isolation-scored) | Risk-based position sizing
 *
 * Backtest (top-30, 400 days, $10k, 1.5x leverage):
 *   Return: +20,807% | Final: $2,090,747 | Max DD: 27.2% | Sharpe: 3.31
 */

import "dotenv/config";
import http from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";

const PORT = 3000;

// ── Top-30 curated universe (isolation-scored, v09) — MEXC format ─────────
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

const LABEL = {
  KAIA_USDT:"KAIA",       S_USDT:"S",          FILECOIN_USDT:"FIL", AR_USDT:"AR",
  PLUME_USDT:"PLUME",     FIDA_USDT:"FIDA",    GMT_USDT:"GMT",      ENA_USDT:"ENA",
  TIA_USDT:"TIA",         TURBO_USDT:"TURBO",
  WIF_USDT:"WIF",         SHIB_USDT:"SHIB",    BCH_USDT:"BCH",      VET_USDT:"VET",
  ONDO_USDT:"ONDO",       THETA_USDT:"THETA",  HBAR_USDT:"HBAR",    RUNE_USDT:"RUNE",
  IOTA_USDT:"IOTA",       JUP_USDT:"JUP",
  FLUX_USDT:"FLUX",       W_USDT:"W",          CATI_USDT:"CATI",    ZKSYNC_USDT:"ZK",
  KAITO_USDT:"KAITO",     WLD_USDT:"WLD",      AIXBT_USDT:"AIXBT",  LA_USDT:"LA",
  JASMY_USDT:"JASMY",     HOME_USDT:"HOME",
};

// Binance lookup map for live price fetching (Binance still uses BTCUSDT format)
const BINANCE_SYMBOL = {
  KAIA_USDT:"KAIAUSDT",       S_USDT:"SUSDT",         FILECOIN_USDT:"FILUSDT",
  AR_USDT:"ARUSDT",           PLUME_USDT:"PLUMEUSDT", FIDA_USDT:"FIDAUSDT",
  GMT_USDT:"GMTUSDT",         ENA_USDT:"ENAUSDT",     TIA_USDT:"TIAUSDT",
  TURBO_USDT:"TURBOUSDT",     WIF_USDT:"WIFUSDT",     SHIB_USDT:"SHIBUSDT",
  BCH_USDT:"BCHUSDT",         VET_USDT:"VETUSDT",     ONDO_USDT:"ONDOUSDT",
  THETA_USDT:"THETAUSDT",     HBAR_USDT:"HBARUSDT",   RUNE_USDT:"RUNEUSDT",
  IOTA_USDT:"IOTAUSDT",       JUP_USDT:"JUPUSDT",     FLUX_USDT:"FLUXUSDT",
  W_USDT:"WUSDT",             CATI_USDT:"CATIUSDT",   ZKSYNC_USDT:"ZKUSDT",
  KAITO_USDT:"KAITOUSDT",     WLD_USDT:"WLDUSDT",     AIXBT_USDT:"AIXBTUSDT",
  LA_USDT:"LAUSDT",           JASMY_USDT:"JASMYUSDT", HOME_USDT:"HOMEUSDT",
};

// ── Live price fetcher ────────────────────────────────────────────────────────

async function fetchLivePrices(symbols) {
  // Input symbols are MEXC format (BTC_USDT). Translate to Binance format for the API call,
  // then map results back to MEXC keys.
  const prices = {};
  if (!symbols.length) return prices;
  const mexcToBinance = {};
  const binanceSyms = [];
  for (const s of symbols) {
    const b = BINANCE_SYMBOL[s] || s.replace("_", "");
    mexcToBinance[s] = b;
    binanceSyms.push(b);
  }
  const binanceToMexc = Object.fromEntries(Object.entries(mexcToBinance).map(([m,b]) => [b,m]));
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

// ── Gist sync ────────────────────────────────────────────────────────────────
// Pulls the live account state from GitHub Gist (written by Railway bot) so the
// dashboard always reflects the latest data even when Railway ran while the
// computer was off.

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
    const file = data.files?.["paper_account_v09.json"];
    if (!file) return;
    writeFileSync("paper_account_v09.json", file.content, "utf8");
  } catch {
    // Silent fail — dashboard still shows local file
  }
}

// ── Data loaders ─────────────────────────────────────────────────────────────

function loadV9Account() {
  try {
    if (existsSync("paper_account_v09.json"))
      return JSON.parse(readFileSync("paper_account_v09.json", "utf8"));
  } catch {}
  return null;
}

function loadV9Log() {
  try {
    if (existsSync("v09-log.json"))
      return JSON.parse(readFileSync("v09-log.json", "utf8"));
  } catch {}
  return null;
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmt(n, dp = 2) {
  if (n == null || isNaN(n)) return "N/A";
  const num = Number(n);
  // Auto-precision for very small numbers
  if (Math.abs(num) < 0.01 && num !== 0) {
    return num.toPrecision(4);
  }
  return num.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function ago(iso) {
  if (!iso) return "never";
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function regimeIcon(r) {
  if (r === "bull") return "🟢";
  if (r === "bear") return "🔴";
  return "⚪";
}

function riskLabel(regime, dir) {
  // with-trend = 100%, neutral = 75%, against-trend = 50%
  if (!dir) return "";
  if (regime === "bull" && dir === "LONG")  return "Full $";
  if (regime === "bear" && dir === "SHORT") return "Full $";
  if (regime === "neutral")                 return "¾ $";
  return "½ $";
}

// ── Portfolio panel ───────────────────────────────────────────────────────────

function portfolioPanel(acc, prices = {}) {
  if (!acc) {
    return `<div class="port-panel port-empty">
      <span class="port-title">📋 v09 Paper Account</span>
      <p class="muted">No account data yet — run: <code>node bot_crypto_v09.js</code></p>
    </div>`;
  }

  const { balance, startBalance, openPositions, closedTrades, stats, lastRun } = acc;
  const realisedPnl = stats.pnl ?? 0;
  const pnlPct      = startBalance > 0 ? ((balance - startBalance) / startBalance * 100).toFixed(2) : "0.00";
  const pnlCls      = realisedPnl >= 0 ? "pos" : "neg";
  const wr          = stats.total > 0 ? (stats.wins / stats.total * 100).toFixed(0) : "—";
  const longWr      = stats.longTotal > 0 ? `${(stats.longWins / stats.longTotal * 100).toFixed(0)}%` : "—";
  const shortWr     = stats.shortTotal > 0 ? `${(stats.shortWins / stats.shortTotal * 100).toFixed(0)}%` : "—";

  // Calculate unrealised P&L across all open positions
  let totalUnreal = 0;
  const posRows = openPositions.length
    ? openPositions.map(p => {
        const isLong   = p.direction === "LONG";
        const reg      = p.regime || "";
        const cur      = prices[p.symbol];
        const qty      = (p.sizeUSD ?? p.size) / p.entryPrice;
        const unreal   = cur != null
          ? (isLong ? (cur - p.entryPrice) * qty : (p.entryPrice - cur) * qty)
          : null;
        const unrealPct = cur != null
          ? (isLong ? (cur - p.entryPrice) / p.entryPrice * 100 : (p.entryPrice - cur) / p.entryPrice * 100)
          : null;
        const sl_      = p.stopLoss ?? p.sl;
        const tp_      = p.takeProfit ?? p.tp;
        const distSL   = cur != null
          ? (isLong ? (cur - sl_) / cur * 100 : (sl_ - cur) / cur * 100)
          : null;
        const distTP   = cur != null
          ? (isLong ? (tp_ - cur) / cur * 100 : (cur - tp_) / cur * 100)
          : null;
        const slClose  = distSL != null && distSL < 2;
        const tpClose  = distTP != null && distTP < 2;

        if (unreal != null) totalUnreal += unreal;

        const unrealCls = unreal == null ? "" : unreal >= 0 ? "pos" : "neg";
        const flag = slClose ? `<span class="pos-flag warn">⚠️ SL ${distSL.toFixed(1)}% away</span>`
                   : tpClose ? `<span class="pos-flag good">🎯 TP ${distTP.toFixed(1)}% away</span>` : "";

        const trailingTag = p.trailing
          ? `<span class="pos-trail">🔄 TRAILING · peak $${fmt(isLong ? p.trailHigh : p.trailLow, 4)}</span>`
          : `<span class="pos-tp-label">TP $${fmt(tp_, 4)}${distTP != null ? ` · ${distTP.toFixed(1)}% away` : ""}</span>`;

        return `<div class="port-pos ${unreal != null && unreal >= 0 ? "pos-winning" : unreal != null ? "pos-losing" : ""}">
          <span class="pos-dir ${isLong ? "long" : "short"}">${isLong ? "▲" : "▼"} ${p.direction}</span>
          <span class="pos-sym">${(p.symbol || "").replace("USDT","")}</span>
          <span class="pos-regime">${regimeIcon(reg)} ${reg.toUpperCase()}</span>
          <span class="pos-entry">Entry $${fmt(p.entryPrice, 4)}</span>
          ${cur != null ? `<span class="pos-cur">Now $${fmt(cur, 4)}</span>` : ""}
          <span class="pos-sl">${p.trailing ? "🔒" : "SL"} $${fmt(p.sl, 4)}${distSL != null ? ` · ${distSL.toFixed(1)}% away` : ""}</span>
          ${trailingTag}
          ${unreal != null
            ? `<span class="pos-unreal ${unrealCls}">${unreal >= 0 ? "+" : ""}$${unreal.toFixed(2)} (${unrealPct >= 0 ? "+" : ""}${unrealPct.toFixed(2)}%)</span>`
            : `<span class="pos-unreal muted">price N/A</span>`}
          <span class="pos-sl">SL $${fmt(sl_, 4)}${distSL != null ? ` · ${distSL.toFixed(1)}% away` : ""}</span>
          <span class="pos-risk">Risk $${fmt(p.riskUSD ?? p.risk)}</span>
          <span class="pos-time">${ago(p.openedAt ?? p.entryTime)}</span>
          ${flag}
        </div>`;
      }).join("")
    : `<div class="port-no-pos">No open positions</div>`;

  const totalUnrealCls = totalUnreal >= 0 ? "pos" : "neg";
  const equity         = balance + totalUnreal;

  const recentTrades = (closedTrades || []).slice(-6).reverse().map(t => {
    const win = t.pnl >= 0;
    const isL = t.direction === "LONG";
    return `<div class="port-trade ${win ? "win" : "loss"}">
      <span class="pt-sym">${(t.symbol || "").replace("USDT","")}</span>
      <span class="pt-dir ${isL ? "long" : "short"}">${isL ? "▲" : "▼"} ${t.direction}</span>
      <span class="pt-exit">${(t.exitReason || "").replace(/_/g," ")}</span>
      <span class="pt-pnl">${win ? "+" : ""}$${(t.pnl || 0).toFixed(2)}</span>
      <span class="pt-pct ${win ? "pos" : "neg"}">${win ? "+" : ""}${(t.pnlPct || 0).toFixed(1)}%</span>
    </div>`;
  }).join("") || `<div class="port-no-pos">No closed trades yet</div>`;

  return `
  <div class="port-panel">
    <div class="port-top">
      <span class="port-title">📋 v09 Paper Account &nbsp;<small style="font-size:.65rem;color:#64748b;font-weight:400">1.5x leverage · 30 pairs · Phase 1 (1.6% risk)</small></span>
      <span class="port-lastrun">Last run: ${ago(lastRun)} &nbsp;·&nbsp; Prices live</span>
    </div>
    <div class="port-stats">
      <div class="ps"><div class="ps-l">Balance</div><div class="ps-v">$${fmt(balance)}</div></div>
      <div class="ps"><div class="ps-l">Realised P&amp;L</div><div class="ps-v ${pnlCls}">${realisedPnl >= 0 ? "+" : ""}$${fmt(realisedPnl)} (${pnlPct}%)</div></div>
      ${openPositions.length ? `<div class="ps"><div class="ps-l">Unrealised P&amp;L</div><div class="ps-v ${totalUnrealCls}">${totalUnreal >= 0 ? "+" : ""}$${totalUnreal.toFixed(2)}</div></div>
      <div class="ps"><div class="ps-l">Equity</div><div class="ps-v">$${equity.toFixed(2)}</div></div>` : ""}
      <div class="ps"><div class="ps-l">Total Trades</div><div class="ps-v">${stats.total}</div></div>
      <div class="ps"><div class="ps-l">Win Rate</div><div class="ps-v">${wr}%</div></div>
      <div class="ps"><div class="ps-l">▲ Long WR</div><div class="ps-v long-txt">${longWr} <span class="ps-sub">(${stats.longTotal || 0})</span></div></div>
      <div class="ps"><div class="ps-l">▼ Short WR</div><div class="ps-v short-txt">${shortWr} <span class="ps-sub">(${stats.shortTotal || 0})</span></div></div>
      <div class="ps"><div class="ps-l">Leverage</div><div class="ps-v">${acc.leverage ?? 1.5}x</div></div>
      <div class="ps"><div class="ps-l">Open</div><div class="ps-v">${openPositions.length} / 10</div></div>
      <div class="ps"><div class="ps-l">W / L</div><div class="ps-v">${stats.wins} / ${stats.losses}</div></div>
    </div>
    <div class="port-section-label">Open Positions · Live P&amp;L</div>
    <div class="port-positions">${posRows}</div>
    <div class="port-section-label">Recent Closed Trades</div>
    <div class="port-trades">${recentTrades}</div>
  </div>`;
}

// ── Regime heatmap ────────────────────────────────────────────────────────────

function regimeHeatmap(latestSignals) {
  if (!latestSignals || !latestSignals.length) {
    return `<div class="heatmap-panel"><p class="muted">No regime data yet</p></div>`;
  }

  const bulls   = latestSignals.filter(s => s.regime === "bull");
  const bears   = latestSignals.filter(s => s.regime === "bear");
  const neutral = latestSignals.filter(s => s.regime === "neutral");
  const total   = latestSignals.length;

  const bullPct    = Math.round(bulls.length / total * 100);
  const bearPct    = Math.round(bears.length / total * 100);
  const neutralPct = 100 - bullPct - bearPct;

  // Market sentiment from regimes
  let sentiment = "MIXED";
  let sentCls   = "neutral";
  if (bullPct >= 60)  { sentiment = "BULLISH";  sentCls = "bull"; }
  if (bearPct >= 60)  { sentiment = "BEARISH";  sentCls = "bear"; }
  if (bullPct >= 40 && bearPct < 20) { sentiment = "LEANING BULL"; sentCls = "bull"; }
  if (bearPct >= 40 && bullPct < 20) { sentiment = "LEANING BEAR"; sentCls = "bear"; }

  // Count active signals
  const longFiring  = latestSignals.filter(s => s.long).length;
  const shortFiring = latestSignals.filter(s => s.short).length;

  return `
  <div class="heatmap-panel">
    <div class="hm-top">
      <div class="hm-sentiment ${sentCls}">${sentiment}</div>
      <div class="hm-counts">
        <span class="hm-bull">🟢 Bull: ${bulls.length}</span>
        <span class="hm-neut">⚪ Neutral: ${neutral.length}</span>
        <span class="hm-bear">🔴 Bear: ${bears.length}</span>
      </div>
      <div class="hm-signals">
        <span class="hm-sig long-txt">▲ LONG signals: ${longFiring}</span>
        <span class="hm-sig short-txt">▼ SHORT signals: ${shortFiring}</span>
      </div>
    </div>
    <div class="hm-bar-wrap">
      <div class="hm-bar">
        <div class="hm-bull-fill" style="width:${bullPct}%" title="${bullPct}% Bull">${bullPct > 8 ? bullPct+"%" : ""}</div>
        <div class="hm-neut-fill" style="width:${neutralPct}%" title="${neutralPct}% Neutral">${neutralPct > 8 ? neutralPct+"%" : ""}</div>
        <div class="hm-bear-fill" style="width:${bearPct}%" title="${bearPct}% Bear">${bearPct > 8 ? bearPct+"%" : ""}</div>
      </div>
    </div>
    <div class="hm-grid">
      ${latestSignals.map(s => {
        const lbl = LABEL[s.symbol] || s.symbol;
        const cls = s.long ? "hm-cell long" : s.short ? "hm-cell short" : `hm-cell ${s.regime}`;
        const sig = s.long ? "▲" : s.short ? "▼" : "";
        return `<div class="${cls}" title="${s.symbol} · ${s.regime.toUpperCase()}${s.long ? " · LONG SIGNAL" : s.short ? " · SHORT SIGNAL" : ""}">
          <span class="hm-lbl">${lbl}</span>
          ${sig ? `<span class="hm-sig-icon">${sig}</span>` : ""}
        </div>`;
      }).join("")}
    </div>
  </div>`;
}

// ── Per-coin card ─────────────────────────────────────────────────────────────

function coinCard(signal, openPos, livePrice) {
  const sym  = signal.symbol;
  const coin = LABEL[sym] || sym;
  const { regime, long: isLong, short: isShort, price } = signal;

  const statusCls = isLong ? "long" : isShort ? "short" : "idle";
  const statusTxt = isLong ? "▲ LONG SIGNAL" : isShort ? "▼ SHORT SIGNAL" : "— IDLE";

  const regCls = regime === "bull" ? "reg-bull" : regime === "bear" ? "reg-bear" : "reg-neutral";
  const regTxt = `${regimeIcon(regime)} ${regime.toUpperCase()}`;

  // Conviction sizing based on regime+direction
  let convTxt = "";
  if (isLong) {
    convTxt = regime === "bull" ? "Full size (with-trend)" :
              regime === "neutral" ? "¾ size (neutral)" : "½ size (against-trend)";
  } else if (isShort) {
    convTxt = regime === "bear" ? "Full size (with-trend)" :
              regime === "neutral" ? "¾ size (neutral)" : "½ size (against-trend)";
  }

  let posSection = "";
  if (openPos) {
    const isL       = openPos.direction === "LONG";
    const cur       = livePrice;
    const osl_      = openPos.stopLoss ?? openPos.sl;
    const otp_      = openPos.takeProfit ?? openPos.tp;
    const qty       = (openPos.sizeUSD ?? openPos.size) / openPos.entryPrice;
    const unreal    = cur != null ? (isL ? (cur - openPos.entryPrice) * qty : (openPos.entryPrice - cur) * qty) : null;
    const unrealPct = cur != null ? (isL ? (cur - openPos.entryPrice) / openPos.entryPrice * 100 : (openPos.entryPrice - cur) / openPos.entryPrice * 100) : null;
    const distSL    = cur != null ? (isL ? (cur - osl_) / cur * 100 : (osl_ - cur) / cur * 100) : null;
    const distTP    = cur != null ? (isL ? (otp_ - cur) / cur * 100 : (cur - otp_) / cur * 100) : null;
    const uCls      = unreal == null ? "" : unreal >= 0 ? "pos" : "neg";

    posSection = `
    <div class="card-section-label">Open Position · Live P&amp;L</div>
    <div class="open-pos ${openPos.direction.toLowerCase()}">
      <span class="op-dir">${isL ? "▲" : "▼"} ${openPos.direction}</span>
      <span class="op-entry">Entry $${fmt(openPos.entryPrice, 4)}</span>
      ${cur != null ? `<span class="op-cur">→ $${fmt(cur, 4)}</span>` : ""}
      ${unreal != null ? `<span class="op-unreal ${uCls}">${unreal >= 0 ? "+" : ""}$${unreal.toFixed(2)} (${unrealPct >= 0 ? "+" : ""}${unrealPct.toFixed(1)}%)</span>` : ""}
      <span class="op-sl">SL $${fmt(osl_, 4)}${distSL != null ? ` · ${distSL.toFixed(1)}% away` : ""}</span>
      <span class="op-tp">TP $${fmt(otp_, 4)}${distTP != null ? ` · ${distTP.toFixed(1)}% away` : ""}</span>
      <span class="op-risk">Risk $${fmt(openPos.riskUSD ?? openPos.risk)}</span>
    </div>`;
  }

  const signalDetail = (isLong || isShort) ? `
    <div class="card-section-label">Signal Detail</div>
    <div class="sig-detail">
      <div class="sig-type">${isLong ? "▲ Structural Breakout" : "▼ Overbought Breakdown"}</div>
      ${convTxt ? `<div class="sig-conv">${convTxt}</div>` : ""}
    </div>` : "";

  return `
  <div class="card ${statusCls}">
    <div class="card-head">
      <span class="coin">${coin}</span>
      <span class="cprice">$${fmt(price, price < 1 ? 6 : 2)}</span>
      <span class="badge ${statusCls}">${statusTxt}</span>
    </div>
    <div class="card-regime">
      <span class="reg-badge ${regCls}">${regTxt}</span>
      ${isLong || isShort ? `<span class="reg-conv">${convTxt}</span>` : ""}
    </div>
    ${posSection}
    ${signalDetail}
  </div>`;
}

// ── Strategy info banner ──────────────────────────────────────────────────────

function strategyBanner(latestRun) {
  const trailMode = process.env.TRAIL_MODE || "auto";
  const threshold = parseFloat(process.env.TRAIL_AUTO_BULL_PCT || "60");
  const useTrail  = latestRun?.useTrail ?? false;
  const bullPct   = latestRun?.bullPct  ?? 0;

  let trailBadge;
  if (trailMode === "on") {
    trailBadge = `<span class="trail-badge trail-on">🚀 TRAILING: ON</span>`;
  } else if (trailMode === "off") {
    trailBadge = `<span class="trail-badge trail-off">🎯 TRAILING: OFF</span>`;
  } else if (useTrail) {
    trailBadge = `<span class="trail-badge trail-on">🚀 TRAILING: AUTO ON <small>(${bullPct}% bull ≥ ${threshold}%)</small></span>`;
  } else {
    trailBadge = `<span class="trail-badge trail-off">🎯 TRAILING: AUTO OFF <small>(${bullPct}% bull &lt; ${threshold}%)</small></span>`;
  }

  return `
  <div class="strategy-banner">
    <div class="sb-left">
      <span class="sb-title">v09 Strategy</span>
      <span class="sb-sep">·</span>
      <span class="sb-item">4H · Top-30 curated</span>
      <span class="sb-sep">·</span>
      <span class="sb-item" style="color:#fbbf24">⚡ 1.5x Leverage</span>
      <span class="sb-sep">·</span>
      <span class="sb-item long-txt">▲ Breakout LONG (SL 4% / TP 35%)</span>
      <span class="sb-sep">·</span>
      <span class="sb-item short-txt">▼ Breakdown SHORT (SL 4% / TP 35%)</span>
      <span class="sb-sep">·</span>
      <span class="sb-item rebound-txt">↩ RSI Rebound S (SL 3.5% / TP 22%)</span>
      <span class="sb-sep">·</span>
      <span class="sb-item" style="color:#f97316">Phase 1: 1.6% risk</span>
    </div>
    <div class="sb-right">
      ${trailBadge}
      <span class="sb-sep">·</span>
      <span class="sb-item">Max 10 pos</span>
      <span class="sb-sep">·</span>
      <span class="sb-regime">🟢 Full · ⚪ ¾ · 🔴 ½ sizing</span>
    </div>
  </div>`;
}

// ── Full page ─────────────────────────────────────────────────────────────────

async function page() {
  await syncFromGist();          // pull latest state from Railway via Gist
  const acc      = loadV9Account();
  const log      = loadV9Log();
  const now      = new Date().toLocaleTimeString();

  // Get latest run signals
  const latestRun = log && log.runs && log.runs.length
    ? log.runs[log.runs.length - 1]
    : null;
  const latestSignals = latestRun ? latestRun.signals : [];

  // Build signal map for quick lookup
  const sigMap = {};
  latestSignals.forEach(s => { sigMap[s.symbol] = s; });

  // Build open position map
  const posMap = {};
  if (acc && acc.openPositions) {
    acc.openPositions.forEach(p => { posMap[p.symbol] = p; });
  }

  // Fetch live prices for all open positions
  const openSymbols = acc?.openPositions?.map(p => p.symbol) ?? [];
  const prices = await fetchLivePrices(openSymbols);

  // Fallback cards for pairs without signal data yet
  const cards = PAIRS.map(sym => {
    const sig = sigMap[sym] || { symbol: sym, regime: "neutral", long: false, short: false, price: null };
    return coinCard(sig, posMap[sym], prices[sym]);
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="30">
<title>v09 Trading Bot Dashboard — Top-30</title>
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
.rebound-txt{color:#a78bfa}
.trail-badge{font-size:.72rem;font-weight:700;padding:3px 8px;border-radius:5px;letter-spacing:.03em}
.trail-badge small{font-weight:400;opacity:.8}
.trail-on{background:#052e16;color:#4ade80;border:1px solid #166534}
.trail-off{background:#1c1917;color:#a8a29e;border:1px solid #44403c}
.sb-left,.sb-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sb-item{font-size:.68rem;color:#64748b}
.sb-regime{font-size:.68rem;color:#64748b}
.long-txt{color:#4ade80}
.short-txt{color:#f87171}

/* ── Portfolio panel ── */
.port-panel{background:#0b1220;border:1px solid #1e3a5f;border-radius:12px;padding:16px;margin-bottom:14px}
.port-empty{border-color:#1a2035}
.port-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.port-title{font-size:.9rem;font-weight:800;color:#93c5fd;letter-spacing:.04em}
.port-lastrun{font-size:.68rem;color:#374151}
.port-stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.ps{display:flex;flex-direction:column;align-items:center;background:#080c14;border-radius:8px;padding:6px 12px;min-width:80px}
.ps-l{font-size:.58rem;color:#475569;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px}
.ps-v{font-size:.85rem;font-weight:700;color:#cbd5e1}
.ps-v.pos,.ps-v.long-txt{color:#4ade80}
.ps-v.neg,.ps-v.short-txt{color:#f87171}
.ps-sub{font-size:.65rem;font-weight:400;color:#374151}
.port-section-label{font-size:.58rem;color:#374151;text-transform:uppercase;letter-spacing:.07em;margin:8px 0 5px}
.port-positions,.port-trades{display:flex;flex-direction:column;gap:4px;margin-bottom:4px}
.port-pos{display:flex;align-items:center;gap:8px;background:#080c14;border-radius:6px;padding:6px 10px;font-size:.68rem;flex-wrap:wrap}
.pos-dir{font-weight:800;min-width:58px}
.pos-dir.long,.long-txt{color:#4ade80}
.pos-dir.short,.short-txt{color:#f87171}
.pos-sym{font-weight:700;color:#e2e8f0;min-width:36px}
.pos-regime{color:#94a3b8;font-size:.62rem}
.pos-entry{color:#94a3b8}
.pos-sl{color:#f87171;font-size:.63rem}
.pos-tp{color:#4ade80;font-size:.63rem}
.pos-risk{color:#fbbf24;font-size:.63rem}
.pos-size{color:#64748b;font-size:.63rem}
.pos-time{color:#374151;font-size:.62rem;margin-left:auto}
.port-trade{display:flex;align-items:center;gap:8px;background:#080c14;border-radius:6px;padding:5px 10px;font-size:.68rem}
.port-trade.win{border-left:2px solid #166534}
.port-trade.loss{border-left:2px solid #7f1d1d}
.pt-sym{font-weight:700;color:#e2e8f0;min-width:36px}
.pt-dir{font-weight:700;min-width:52px}
.pt-exit{color:#64748b;flex:1}
.pt-pnl{font-weight:700;color:#cbd5e1;min-width:60px;text-align:right}
.pt-pct{font-weight:700;min-width:44px;text-align:right}
.pt-pct.pos{color:#4ade80}
.pt-pct.neg{color:#f87171}
.port-no-pos{font-size:.68rem;color:#374151;padding:4px 0}
.muted{font-size:.8rem;color:#374151;margin-top:8px;padding:4px 0}
.pos-winning{border-left:2px solid #166534}
.pos-losing{border-left:2px solid #7f1d1d}
.pos-cur{color:#e2e8f0;font-weight:700}
.pos-unreal{font-weight:800;font-size:.72rem;margin-left:auto}
.pos-flag{font-size:.62rem;font-weight:700;padding:1px 6px;border-radius:4px}
.pos-flag.warn{background:#78350f;color:#fbbf24}
.pos-flag.good{background:#052e16;color:#4ade80}
.op-cur{color:#e2e8f0;font-weight:700;font-size:.68rem}
.op-unreal{font-weight:800;font-size:.72rem}
.op-unreal.pos{color:#4ade80}
.op-unreal.neg{color:#f87171}

/* ── Regime heatmap ── */
.heatmap-panel{background:#0b111e;border:1px solid #1a2035;border-radius:12px;padding:14px;margin-bottom:14px}
.hm-top{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:10px}
.hm-sentiment{font-size:1rem;font-weight:900;letter-spacing:.05em}
.hm-sentiment.bull{color:#4ade80}
.hm-sentiment.bear{color:#f87171}
.hm-sentiment.neutral{color:#94a3b8}
.hm-counts{display:flex;gap:12px;font-size:.72rem}
.hm-bull{color:#4ade80;font-weight:700}
.hm-neut{color:#94a3b8;font-weight:600}
.hm-bear{color:#f87171;font-weight:700}
.hm-signals{display:flex;gap:12px;font-size:.72rem;font-weight:700;margin-left:auto}
.hm-sig{font-size:.7rem}
.hm-bar-wrap{margin-bottom:10px}
.hm-bar{display:flex;height:14px;border-radius:6px;overflow:hidden;background:#1a2035}
.hm-bull-fill{background:#16a34a;height:100%;display:flex;align-items:center;justify-content:center;font-size:.58rem;font-weight:800;color:#fff;transition:width .5s}
.hm-neut-fill{background:#334155;height:100%;display:flex;align-items:center;justify-content:center;font-size:.58rem;font-weight:800;color:#94a3b8;transition:width .5s}
.hm-bear-fill{background:#991b1b;height:100%;display:flex;align-items:center;justify-content:center;font-size:.58rem;font-weight:800;color:#fff;transition:width .5s}
.hm-grid{display:flex;flex-wrap:wrap;gap:4px}
.hm-cell{padding:4px 8px;border-radius:6px;font-size:.65rem;font-weight:700;display:flex;align-items:center;gap:4px;cursor:default;border:1px solid transparent}
.hm-cell.bull{background:#052e16;border-color:#166534;color:#4ade80}
.hm-cell.bear{background:#2d0a0a;border-color:#7f1d1d;color:#f87171}
.hm-cell.neutral{background:#111827;border-color:#1e2d45;color:#64748b}
.hm-cell.long{background:#052e16;border-color:#22c55e;color:#86efac;box-shadow:0 0 8px #22c55e33}
.hm-cell.short{background:#2d0a0a;border-color:#ef4444;color:#fca5a5;box-shadow:0 0 8px #ef444433}
.hm-lbl{font-size:.65rem}
.hm-sig-icon{font-size:.7rem}

/* ── Coin cards grid ── */
.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}
@media(max-width:1400px){.grid{grid-template-columns:repeat(4,1fr)}}
@media(max-width:1100px){.grid{grid-template-columns:repeat(3,1fr)}}
@media(max-width:750px){.grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:500px){.grid{grid-template-columns:1fr}}

.card{background:#0f1520;border-radius:10px;padding:12px;border:1px solid #1a2035;position:relative;overflow:hidden}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px}
.card.long::before{background:linear-gradient(90deg,#16a34a,#22c55e)}
.card.short::before{background:linear-gradient(90deg,#b91c1c,#ef4444)}
.card.idle::before{background:#1e2d45}

.card-head{display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap}
.coin{font-size:1.1rem;font-weight:800;color:#f1f5f9;min-width:38px}
.cprice{font-size:.82rem;font-weight:700;color:#94a3b8}
.badge{font-size:.62rem;font-weight:700;padding:2px 8px;border-radius:20px;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;margin-left:auto}
.badge.long{background:#052e16;color:#4ade80;border:1px solid #166534}
.badge.short{background:#2d0a0a;color:#f87171;border:1px solid #7f1d1d}
.badge.idle{background:#111827;color:#374151;border:1px solid #1e2d45}

.card-regime{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.reg-badge{font-size:.65rem;font-weight:700;padding:2px 8px;border-radius:5px}
.reg-bull{background:#052e16;color:#4ade80;border:1px solid #166534}
.reg-bear{background:#2d0a0a;color:#f87171;border:1px solid #7f1d1d}
.reg-neutral{background:#111827;color:#64748b;border:1px solid #1e2d45}
.reg-conv{font-size:.62rem;color:#64748b;font-style:italic}

.card-section-label{font-size:.56rem;color:#374151;text-transform:uppercase;letter-spacing:.07em;margin:6px 0 3px}

.open-pos{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:6px;font-size:.65rem;flex-wrap:wrap;margin-bottom:2px}
.open-pos.long{background:#052e16;border:1px solid #166534}
.open-pos.short{background:#2d0a0a;border:1px solid #7f1d1d}
.op-dir{font-weight:800;min-width:54px}
.open-pos.long .op-dir{color:#4ade80}
.open-pos.short .op-dir{color:#f87171}
.op-entry{color:#cbd5e1;font-weight:600}
.op-sl{color:#f87171;font-size:.60rem}
.op-tp{color:#4ade80;font-size:.60rem}
.op-risk{color:#fbbf24;font-size:.60rem;margin-left:auto}

.sig-detail{background:#080c14;border-radius:6px;padding:7px 9px}
.sig-type{font-size:.68rem;font-weight:700;color:#93c5fd;margin-bottom:3px}
.sig-conv{font-size:.62rem;color:#64748b;font-style:italic}

footer{text-align:center;margin-top:14px;font-size:.65rem;color:#1e2d45}
</style>
</head>
<body>
<header>
  <h1>🤖 v09 Trading Bot · Top-${PAIRS.length} Curated · 1.5x Leverage</h1>
  <div class="hright"><span class="dot"></span>Auto-refresh 30s &nbsp;·&nbsp; Last: ${now} &nbsp;·&nbsp; Next run: every 4H candle close</div>
</header>
${strategyBanner(latestRun)}
${portfolioPanel(acc, prices)}
${regimeHeatmap(latestSignals)}
<div class="grid">${cards}</div>
<footer>PAPER TRADING · v09 PHASE 1 · 4H · Top-30 Curated · 1.5x Leverage · Path A: SL 4% / TP 35% (R:R 8.8:1) · 1.6% risk per trade · RSI Rebound SL 3.5% / TP 22% · Max 10 positions</footer>
</body>
</html>`;
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(await page());
});

server.listen(PORT, () => {
  console.log(`\n🖥️  v09 Dashboard → http://localhost:${PORT}`);
  console.log(`   Top-30 curated universe · 1.5x leverage · $1,000 paper start`);
  console.log(`   Auto-refreshes every 30s. Ctrl+C to stop.\n`);
});
