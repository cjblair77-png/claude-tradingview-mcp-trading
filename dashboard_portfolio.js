/**
 * Portfolio Dashboard — combined view of all 3 strategies
 * Run: node dashboard_portfolio.js
 * Open: http://localhost:3003
 * Auto-refreshes every 30 seconds.
 *
 * Shows:
 *   - Total portfolio P&L (combined v09 + DT + GP)
 *   - Per-strategy breakdown (balance, return, open positions, recent trades)
 *   - Aggregated open positions across all bots
 *   - Recent activity from all 3 strategies
 */

import "dotenv/config";
import http from "http";

const PORT = 3003;

const GIST_ID      = process.env.GITHUB_GIST_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const STRATEGIES = [
  { key: "v09",  file: "paper_account_v09.json",          name: "v09",   subtitle: "4H crypto · 30 alts · Phase 1 (1.6% risk)" },
  { key: "dt",   file: "paper_daytrading_v01.json",       name: "DT",    subtitle: "15m crypto · 6 pairs · R:R 2.0 (1.0% risk)" },
  { key: "gp",   file: "paper_account_golden_pocket.json", name: "GP",   subtitle: "15m Fib · 7 pairs · 13-18 UTC (0.5% risk)" },
];

async function fetchGist() {
  if (!GIST_ID || !GITHUB_TOKEN) return null;
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000),
    });
    return await res.json();
  } catch { return null; }
}

async function fetchLivePrices(symbols) {
  const prices = {};
  if (!symbols.length) return prices;
  const toBinance = s => s.replace("_", "").replace("FILECOIN","FIL").replace("ZKSYNC","ZK");
  const binSyms = symbols.map(toBinance);
  try {
    const qs = binSyms.map(s => `"${s}"`).join(",");
    const url = `https://api.binance.com/api/v3/ticker/price?symbols=[${qs}]`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const arr = await res.json();
    if (Array.isArray(arr)) {
      arr.forEach(t => {
        const mexcSym = symbols.find(s => toBinance(s) === t.symbol);
        if (mexcSym) prices[mexcSym] = parseFloat(t.price);
      });
    }
  } catch {}
  return prices;
}

function fmt(n, dp=2) {
  if (n == null || isNaN(n)) return "N/A";
  const num = Number(n);
  if (Math.abs(num) < 0.01 && num !== 0) return num.toPrecision(4);
  return num.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function fmtPrice(p) { if (p == null) return "—"; if (p >= 1000) return fmt(p, 2); if (p >= 1) return fmt(p, 4); return fmt(p, 5); }
function fmt$(n) { if (n == null || isNaN(n)) return "—"; return (n >= 0 ? "+" : "") + "$" + Math.abs(n).toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2}); }
function ago(ms) {
  if (!ms) return "never";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m ago`;
  return `${Math.floor(s/86400)}d ago`;
}
function agoIso(iso) { if (!iso) return "never"; return ago(new Date(iso).getTime()); }

// Estimated round-trip fee for an open position, so unrealized P&L shows NET.
// v09 = taker market orders; DT = taker unless maker-tagged; GP = maker (0%).
function posFee(key, p) {
  const size = key === "v09" ? (p.size || 0) : (p.sizeUSD || 0);
  if (key === "gp") return p.orderType === "TAKER" ? size * 0.0004 : 0;
  if (key === "dt") return p.orderType === "MAKER" ? 0 : size * 0.0004;
  return size * 0.0004; // v09 taker
}

function loadStrategy(gist, st) {
  const f = gist?.files?.[st.file];
  if (!f) return { ...st, account: null };
  try { return { ...st, account: JSON.parse(f.content) }; }
  catch { return { ...st, account: null }; }
}

// ── Build a strategy card ─────────────────────────────────────────────────

function strategyCard(s, prices) {
  if (!s.account) {
    return `<div class="strat-card empty">
      <div class="sc-head"><span class="sc-name">${s.name}</span><span class="sc-sub">${s.subtitle}</span></div>
      <p class="muted">No data yet — bot hasn't run</p>
    </div>`;
  }
  const a = s.account;
  const start = a.startBalance ?? (s.key === "v09" ? 13750 : s.key === "dt" ? 2500 : 8750);
  const balance = a.balance ?? start;
  const realizedPnl = balance - start;
  const realizedPct = start > 0 ? (realizedPnl / start * 100) : 0;
  const positions = a.openPositions || a.positions || [];
  const pending   = a.pendingPositions || [];
  const trades    = a.closedTrades || a.trades || [];
  const lastRun   = a.lastRun;

  // Unrealized P&L across open positions
  let totalUnreal = 0, posWithPrice = 0;
  for (const p of positions) {
    const sym = p.symbol;
    const cur = prices[sym];
    if (cur == null) continue;
    posWithPrice++;
    const isLong = p.direction === "LONG";
    let unreal = 0;
    if (s.key === "v09") {
      // v09: pnl = priceChange × size (Option 1, no leverage)
      const move = isLong ? (cur - p.entryPrice) / p.entryPrice : (p.entryPrice - cur) / p.entryPrice;
      unreal = move * (p.size || 0);
    } else {
      // DT/GP: pnl = priceChange × sizeUSD
      const move = isLong ? (cur - p.entry) / p.entry : (p.entry - cur) / p.entry;
      unreal = move * (p.sizeUSD || 0);
    }
    unreal -= posFee(s.key, p);  // net of estimated round-trip fee
    totalUnreal += unreal;
  }
  const equity = balance + totalUnreal;
  const totalPnl = realizedPnl + totalUnreal;
  const totalPct = start > 0 ? (totalPnl / start * 100) : 0;

  const wins = trades.filter(t => (t.pnl || 0) > 0).length;
  const wr = trades.length ? Math.round(wins / trades.length * 100) : null;

  // ── Open positions: detailed table ─────────────────────────────────────
  const posRows = positions.length ? positions.map(p => {
    const sym = p.symbol;
    const cur = prices[sym];
    const isLong = p.direction === "LONG";
    const entry = p.entryPrice || p.entry;
    const sl = p.sl;
    const tp = p.tp;
    const size = s.key === "v09" ? (p.size || 0) : (p.sizeUSD || 0);
    const risk = p.risk || p.riskUSD;

    let unreal = null, movePct = null, slDistPct = null, tpDistPct = null, rMult = null;
    if (cur != null) {
      const move = isLong ? (cur - entry) / entry : (entry - cur) / entry;
      movePct = move * 100;
      unreal = move * size - posFee(s.key, p);  // net of estimated round-trip fee
      slDistPct = isLong ? (cur - sl) / cur * 100 : (sl - cur) / cur * 100;
      tpDistPct = isLong ? (tp - cur) / cur * 100 : (cur - tp) / cur * 100;
      if (risk) rMult = unreal / risk;
    }

    const uCls = unreal == null ? "" : unreal >= 0 ? "pos" : "neg";
    const ageStr = ago(p.entryTime ? new Date(p.entryTime).getTime() : (p.openedAt ? new Date(p.openedAt).getTime() : null));
    const slLossPct = ((isLong ? (sl - entry) / entry : (entry - sl) / entry) * 100);
    const tpGainPct = ((isLong ? (tp - entry) / entry : (entry - tp) / entry) * 100);
    const rr = Math.abs(slLossPct) > 0 ? (tpGainPct / Math.abs(slLossPct)) : null;
    const signal = p.signal || p.detail || "—";

    return `<div class="pos-card ${unreal != null && unreal >= 0 ? 'win' : unreal != null ? 'lose' : ''}">
      <div class="pos-top">
        <span class="pos-dir ${isLong?'long':'short'}">${isLong?'▲ LONG':'▼ SHORT'}</span>
        <span class="pos-sym">${(sym||'').replace('_USDT','').replace('USDT','')}</span>
        ${cur != null ? `<span class="pos-pnl ${uCls}">${fmt$(unreal)} ${movePct != null ? `<span class="pos-pct">(${movePct>=0?'+':''}${movePct.toFixed(2)}%)</span>` : ''} ${rMult != null ? `<span class="pos-r">${rMult>=0?'+':''}${rMult.toFixed(2)}R</span>` : ''}</span>` : '<span class="pos-pnl muted">price loading…</span>'}
        <span class="pos-age">${ageStr}</span>
      </div>
      <div class="pos-grid">
        <div class="pg-cell"><div class="pg-l">Entry</div><div class="pg-v">$${fmtPrice(entry)}</div></div>
        <div class="pg-cell"><div class="pg-l">Current</div><div class="pg-v ${movePct != null && movePct >= 0 ? 'pos' : movePct != null ? 'neg' : ''}">${cur != null ? '$' + fmtPrice(cur) : '—'}</div></div>
        <div class="pg-cell"><div class="pg-l">Stop Loss</div><div class="pg-v neg">$${fmtPrice(sl)}<span class="pg-sub">${slDistPct != null ? `${slDistPct.toFixed(2)}% away` : `-${Math.abs(slLossPct).toFixed(2)}%`}</span></div></div>
        <div class="pg-cell"><div class="pg-l">Take Profit</div><div class="pg-v pos">$${fmtPrice(tp)}<span class="pg-sub">${tpDistPct != null ? `${tpDistPct.toFixed(2)}% away` : `+${tpGainPct.toFixed(2)}%`}</span></div></div>
        <div class="pg-cell"><div class="pg-l">Size</div><div class="pg-v">$${fmt(size, 0)}</div></div>
        <div class="pg-cell"><div class="pg-l">Risk</div><div class="pg-v">${risk ? '$' + fmt(risk, 2) : '—'}</div></div>
        <div class="pg-cell"><div class="pg-l">R:R</div><div class="pg-v">${rr ? '1:' + rr.toFixed(2) : '—'}</div></div>
        <div class="pg-cell"><div class="pg-l">Signal</div><div class="pg-v signal">${signal.length > 28 ? signal.slice(0,28)+'…' : signal}</div></div>
      </div>
    </div>`;
  }).join("") : `<div class="no-pos">No open positions</div>`;

  // ── Pending limit orders: detailed table ───────────────────────────────
  const pendRows = pending.length ? pending.map(p => {
    const isLong = p.direction === "LONG";
    const cur = prices[p.symbol];
    const limit = p.limitPrice;
    const sl = p.sl;
    const tp = p.tp;
    const risk = p.riskUSD;
    const size = p.sizeUSD;
    const fibInv = p.fibInvalid;
    const slLossPct = ((isLong ? (sl - limit) / limit : (limit - sl) / limit) * 100);
    const tpGainPct = ((isLong ? (tp - limit) / limit : (limit - tp) / limit) * 100);
    const rr = Math.abs(slLossPct) > 0 ? (tpGainPct / Math.abs(slLossPct)) : null;
    // For LONG: limit is BELOW current. Distance = how far price has to drop to fill.
    const fillDistPct = cur != null ? (isLong ? (cur - limit) / cur * 100 : (limit - cur) / cur * 100) : null;
    const placedAgo = ago(p.placedAt);
    // GP timeout: 24h pending → calculate time remaining
    const PENDING_TIMEOUT_MS = 24 * 60 * 60 * 1000;
    const timeRemaining = p.placedAt ? (p.placedAt + PENDING_TIMEOUT_MS - Date.now()) : null;
    const hrsRemaining = timeRemaining != null ? (timeRemaining / 3600000) : null;

    return `<div class="pos-card pending">
      <div class="pos-top">
        <span class="pos-dir ${isLong?'long':'short'}">⏳ ${isLong?'▲ LONG':'▼ SHORT'} LIMIT</span>
        <span class="pos-sym">${(p.symbol||'').replace('_USDT','').replace('USDT','')}</span>
        ${fillDistPct != null ? `<span class="pos-fill">Fill ${fillDistPct >= 0 ? 'needs' : 'crossed by'} <strong>${Math.abs(fillDistPct).toFixed(2)}%</strong></span>` : ''}
        <span class="pos-age">placed ${placedAgo}${hrsRemaining != null ? ` · expires in ${hrsRemaining.toFixed(1)}h` : ''}</span>
      </div>
      <div class="pos-grid">
        <div class="pg-cell"><div class="pg-l">Limit Price</div><div class="pg-v amber">$${fmtPrice(limit)}</div></div>
        <div class="pg-cell"><div class="pg-l">Current</div><div class="pg-v">${cur != null ? '$' + fmtPrice(cur) : '—'}</div></div>
        <div class="pg-cell"><div class="pg-l">Stop Loss</div><div class="pg-v neg">$${fmtPrice(sl)}<span class="pg-sub">-${Math.abs(slLossPct).toFixed(2)}%</span></div></div>
        <div class="pg-cell"><div class="pg-l">Take Profit</div><div class="pg-v pos">$${fmtPrice(tp)}<span class="pg-sub">+${tpGainPct.toFixed(2)}%</span></div></div>
        <div class="pg-cell"><div class="pg-l">Size</div><div class="pg-v">$${fmt(size, 0)}</div></div>
        <div class="pg-cell"><div class="pg-l">Risk</div><div class="pg-v">$${fmt(risk, 2)}</div></div>
        <div class="pg-cell"><div class="pg-l">R:R</div><div class="pg-v">${rr ? '1:' + rr.toFixed(2) : '—'}</div></div>
        ${fibInv ? `<div class="pg-cell"><div class="pg-l">Fib Invalid</div><div class="pg-v">$${fmtPrice(fibInv)}</div></div>` : '<div class="pg-cell"><div class="pg-l">—</div><div class="pg-v">—</div></div>'}
      </div>
    </div>`;
  }).join("") : "";

  // ── Recent closed trades (last 5) ──────────────────────────────────────
  const recent = trades.slice(-5).reverse();
  const tradeRows = recent.length ? recent.map(t => {
    const sym = (t.symbol || '').replace('_USDT','').replace('USDT','');
    const win = (t.pnl || 0) > 0;
    // v09 uses entryPrice/exitPrice; DT and GP use entry/exit
    const entry = t.entry ?? t.entryPrice;
    const exit  = t.exit  ?? t.exitPrice;
    const pnlPct = (entry && exit) ? (((t.direction === 'LONG' ? (exit - entry) : (entry - exit)) / entry) * 100) : null;
    return `<div class="trade-row ${win?'win':'lose'}">
      <span class="t-dir ${t.direction === 'LONG' ? 'long' : 'short'}">${t.direction === 'LONG' ? '▲' : '▼'}</span>
      <span class="t-sym">${sym}</span>
      <span class="t-prices">${entry ? '$' + fmtPrice(entry) : ''}${exit ? ` → $${fmtPrice(exit)}` : ''}</span>
      <span class="t-exit">${t.exitReason || ''}</span>
      <span class="t-pnl ${win?'pos':'neg'}">${fmt$(t.pnl)}${pnlPct != null ? ` (${pnlPct>=0?'+':''}${pnlPct.toFixed(2)}%)` : ''}</span>
      <span class="t-time">${t.exitTime ? agoIso(t.exitTime) : ''}</span>
    </div>`;
  }).join("") : `<div class="no-pos">No closed trades yet</div>`;

  return `<div class="strat-card ${realizedPnl >= 0 ? 'profit' : 'loss'}">
    <div class="sc-head">
      <span class="sc-name">${s.name}</span>
      <span class="sc-sub">${s.subtitle}</span>
      <span class="sc-lastrun">${lastRun ? agoIso(lastRun) : 'never'}</span>
    </div>
    <div class="sc-stats">
      <div class="sc-stat"><div class="sc-l">Balance</div><div class="sc-v">$${fmt(balance)}</div></div>
      <div class="sc-stat"><div class="sc-l">Equity</div><div class="sc-v">$${fmt(equity)}</div></div>
      <div class="sc-stat"><div class="sc-l">Realized P&amp;L</div><div class="sc-v ${realizedPnl>=0?'pos':'neg'}">${fmt$(realizedPnl)}</div></div>
      <div class="sc-stat"><div class="sc-l">Unrealized</div><div class="sc-v ${totalUnreal>=0?'pos':'neg'}">${fmt$(totalUnreal)}</div></div>
      <div class="sc-stat"><div class="sc-l">Total P&amp;L</div><div class="sc-v ${totalPnl>=0?'pos':'neg'}">${fmt$(totalPnl)} <span class="sc-sub2">${totalPct>=0?'+':''}${totalPct.toFixed(1)}%</span></div></div>
      <div class="sc-stat"><div class="sc-l">Trades</div><div class="sc-v">${trades.length}${wr != null ? ` <span class="sc-sub2">${wr}% WR</span>` : ''}</div></div>
      <div class="sc-stat"><div class="sc-l">Open / Pending</div><div class="sc-v">${positions.length} / ${pending.length}</div></div>
    </div>
    <div class="sc-section-label">Open Positions${posWithPrice < positions.length ? ` <small>(${posWithPrice}/${positions.length} priced)</small>` : ''}</div>
    <div class="sc-positions">${posRows}</div>
    ${pending.length ? `<div class="sc-section-label">Pending Limit Orders</div><div class="sc-positions">${pendRows}</div>` : ''}
    <div class="sc-section-label">Recent Closed Trades</div>
    <div class="sc-trades">${tradeRows}</div>
  </div>`;
}

// ── Build full page ───────────────────────────────────────────────────────

async function page() {
  const gist = await fetchGist();
  const strategies = STRATEGIES.map(s => loadStrategy(gist, s));

  // Collect all symbols needing prices (open positions + pending limit orders)
  const allSymbols = new Set();
  for (const s of strategies) {
    const positions = s.account?.openPositions || s.account?.positions || [];
    const pending   = s.account?.pendingPositions || [];
    for (const p of positions) allSymbols.add(p.symbol);
    for (const p of pending)   allSymbols.add(p.symbol);
  }
  const prices = await fetchLivePrices([...allSymbols]);

  // Aggregate totals
  let totalStart = 0, totalBalance = 0, totalRealized = 0, totalUnreal = 0, totalTrades = 0, totalOpen = 0, totalPending = 0;
  for (const s of strategies) {
    if (!s.account) continue;
    const start = s.account.startBalance ?? (s.key === "v09" ? 13750 : s.key === "dt" ? 2500 : 8750);
    const balance = s.account.balance ?? start;
    totalStart += start; totalBalance += balance; totalRealized += (balance - start);
    const positions = s.account.openPositions || s.account.positions || [];
    totalOpen += positions.length; totalPending += (s.account.pendingPositions?.length || 0);
    totalTrades += (s.account.closedTrades?.length || s.account.trades?.length || 0);
    for (const p of positions) {
      const cur = prices[p.symbol]; if (cur == null) continue;
      const isLong = p.direction === "LONG";
      const entry = p.entryPrice || p.entry;
      const size = s.key === "v09" ? (p.size || 0) : (p.sizeUSD || 0);
      const move = isLong ? (cur - entry) / entry : (entry - cur) / entry;
      totalUnreal += move * size - posFee(s.key, p);  // net of estimated round-trip fee
    }
  }
  const totalEquity = totalBalance + totalUnreal;
  const totalPnl = totalRealized + totalUnreal;
  const totalPct = totalStart > 0 ? (totalPnl / totalStart * 100) : 0;

  const now = new Date().toLocaleTimeString();
  const cards = strategies.map(s => strategyCard(s, prices)).join("\n");

  // ── Build COMBINED recent trades (all 3 strategies, newest first) ──────
  const allTrades = [];
  for (const s of strategies) {
    if (!s.account) continue;
    const ts = s.account.closedTrades || s.account.trades || [];
    for (const t of ts) {
      allTrades.push({ ...t, _strategy: s.name, _key: s.key });
    }
  }
  // Sort by exitTime descending (newest first)
  allTrades.sort((a, b) => {
    const ta = a.exitTime ? new Date(a.exitTime).getTime() : 0;
    const tb = b.exitTime ? new Date(b.exitTime).getTime() : 0;
    return tb - ta;
  });
  const combinedRecent = allTrades.slice(0, 15);

  const combinedRows = combinedRecent.length ? combinedRecent.map(t => {
    const sym = (t.symbol || '').replace('_USDT','').replace('USDT','');
    const win = (t.pnl || 0) > 0;
    const entry = t.entry ?? t.entryPrice;
    const exit  = t.exit  ?? t.exitPrice;
    const pnlPct = (entry && exit) ? (((t.direction === 'LONG' ? (exit - entry) : (entry - exit)) / entry) * 100) : null;
    const badgeClass = t._key === 'v09' ? 'badge-v09' : t._key === 'dt' ? 'badge-dt' : 'badge-gp';
    return `<div class="trade-row ${win?'win':'lose'}">
      <span class="t-badge ${badgeClass}">${t._strategy}</span>
      <span class="t-dir ${t.direction === 'LONG' ? 'long' : 'short'}">${t.direction === 'LONG' ? '▲' : '▼'}</span>
      <span class="t-sym">${sym}</span>
      <span class="t-prices">${entry ? '$' + fmtPrice(entry) : ''}${exit ? ` → $${fmtPrice(exit)}` : ''}</span>
      <span class="t-exit">${t.exitReason || ''}</span>
      <span class="t-pnl ${win?'pos':'neg'}">${fmt$(t.pnl)}${pnlPct != null ? ` (${pnlPct>=0?'+':''}${pnlPct.toFixed(2)}%)` : ''}</span>
      <span class="t-time">${t.exitTime ? agoIso(t.exitTime) : ''}</span>
    </div>`;
  }).join("") : `<div class="no-pos">No trades closed across any strategy yet</div>`;

  // Combined stats
  const combinedWins = allTrades.filter(t => (t.pnl || 0) > 0).length;
  const combinedLosses = allTrades.filter(t => (t.pnl || 0) <= 0).length;
  const combinedWR = allTrades.length ? Math.round(combinedWins / allTrades.length * 100) : 0;
  const combinedNet = allTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta http-equiv="refresh" content="30">
<title>Hermes Portfolio — All Strategies</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080b12;color:#e2e8f0;font-family:'Segoe UI',system-ui,sans-serif;padding:16px;min-height:100vh}
header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #1a2035}
h1{font-size:1rem;color:#fbbf24;letter-spacing:.08em;text-transform:uppercase;font-weight:800}
.hright{font-size:.72rem;color:#374151}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#22c55e;margin-right:5px;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}

/* Portfolio summary panel */
.portfolio-summary{background:linear-gradient(135deg,#0b1220 0%,#0d1f2e 100%);border:1px solid #1e3a5f;border-radius:12px;padding:18px;margin-bottom:18px}
.ps-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.ps-title{font-size:1rem;font-weight:800;color:#93c5fd;letter-spacing:.04em}
.ps-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:10px}
.ps-cell{background:#080c14;border-radius:8px;padding:10px;text-align:center}
.ps-label{font-size:.62rem;color:#475569;text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px}
.ps-value{font-size:1.05rem;font-weight:700;color:#cbd5e1}
.ps-value.pos{color:#4ade80}
.ps-value.neg{color:#f87171}
.ps-sub{font-size:.6rem;color:#64748b;display:block;margin-top:2px}

/* Strategy cards — stacked full-width */
.strats{display:flex;flex-direction:column;gap:18px;max-width:1500px;margin:0 auto}
.strat-card{background:#0b1220;border:1px solid #1a2a42;border-radius:14px;padding:22px;position:relative;overflow:hidden;box-shadow:0 4px 18px rgba(0,0,0,.3)}
.strat-card.profit::before{content:'';position:absolute;top:0;left:0;right:0;height:4px;background:linear-gradient(90deg,#16a34a,#22c55e)}
.strat-card.loss::before{content:'';position:absolute;top:0;left:0;right:0;height:4px;background:linear-gradient(90deg,#b91c1c,#ef4444)}
.strat-card.empty{opacity:.6}
.sc-head{display:flex;align-items:baseline;gap:14px;margin-bottom:16px;flex-wrap:wrap;padding-bottom:12px;border-bottom:1px solid #1a2a42}
.sc-name{font-size:2rem;font-weight:900;color:#fbbf24;letter-spacing:.02em}
.sc-sub{font-size:.85rem;color:#94a3b8;flex:1}
.sc-lastrun{font-size:.75rem;color:#64748b}
.sc-stats{display:grid;grid-template-columns:repeat(7,1fr);gap:8px;margin-bottom:14px}
@media(max-width:1100px){.sc-stats{grid-template-columns:repeat(4,1fr)}}
@media(max-width:600px){.sc-stats{grid-template-columns:repeat(2,1fr)}}
.sc-stat{background:#080c14;border-radius:8px;padding:10px 12px;text-align:center}
.sc-l{font-size:.65rem;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px}
.sc-v{font-size:1rem;font-weight:700;color:#cbd5e1}
.sc-v.pos{color:#4ade80}
.sc-v.neg{color:#f87171}
.sc-sub2{font-size:.7rem;color:#64748b;font-weight:400;display:block;margin-top:2px}

.sc-section-label{font-size:.75rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;margin:18px 0 8px;font-weight:700;display:flex;align-items:center;gap:8px}
.sc-section-label::before{content:'';display:inline-block;width:3px;height:14px;background:#fbbf24;border-radius:2px}
.sc-section-label.pending::before{background:#d97706}
.sc-section-label.trades::before{background:#475569}

.sc-positions,.sc-trades{display:flex;flex-direction:column;gap:8px}

/* Position card — rich detail */
.pos-card{background:#080c14;border-radius:8px;padding:12px 14px;border-left:3px solid #334155}
.pos-card.win{border-left-color:#22c55e}
.pos-card.lose{border-left-color:#ef4444}
.pos-card.pending{border-left-color:#d97706;background:#150f06}
.pos-top{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:10px}
.pos-dir{font-weight:800;font-size:.85rem;min-width:110px}
.pos-dir.long{color:#4ade80}
.pos-dir.short{color:#f87171}
.pos-sym{font-weight:800;color:#fbbf24;font-size:1.1rem;letter-spacing:.02em}
.pos-pnl{font-weight:800;font-size:1.05rem;margin-left:auto;display:flex;align-items:baseline;gap:6px}
.pos-pnl.pos{color:#4ade80}
.pos-pnl.neg{color:#f87171}
.pos-pct{font-size:.8rem;font-weight:600;opacity:.85}
.pos-r{font-size:.75rem;background:rgba(255,255,255,.05);padding:2px 6px;border-radius:4px;color:#cbd5e1;font-weight:700}
.pos-age{color:#64748b;font-size:.7rem;margin-left:auto}
.pos-fill{color:#fbbf24;font-size:.78rem;margin-left:auto}
.pos-grid{display:grid;grid-template-columns:repeat(8,1fr);gap:6px}
@media(max-width:1100px){.pos-grid{grid-template-columns:repeat(4,1fr)}}
@media(max-width:600px){.pos-grid{grid-template-columns:repeat(2,1fr)}}
.pg-cell{background:#040810;border-radius:5px;padding:6px 8px}
.pg-l{font-size:.6rem;color:#475569;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px}
.pg-v{font-size:.82rem;font-weight:700;color:#cbd5e1}
.pg-v.pos{color:#4ade80}
.pg-v.neg{color:#f87171}
.pg-v.amber{color:#fbbf24}
.pg-v.signal{font-size:.65rem;font-weight:500;color:#94a3b8}
.pg-sub{display:block;font-size:.58rem;color:#64748b;font-weight:500;margin-top:1px}

/* Closed trades list */
.trade-row{display:flex;align-items:center;gap:10px;background:#080c14;border-radius:6px;padding:8px 12px;font-size:.78rem}
.trade-row.win{border-left:3px solid #22c55e}
.trade-row.lose{border-left:3px solid #ef4444}
.t-dir{font-weight:800;min-width:14px;font-size:.9rem}
.t-dir.long{color:#4ade80}
.t-dir.short{color:#f87171}
.t-sym{font-weight:800;color:#fbbf24;min-width:60px}
.t-prices{color:#cbd5e1;font-size:.72rem;min-width:140px}
.t-exit{color:#94a3b8;flex:1;font-size:.72rem}
.t-pnl{font-weight:800;min-width:140px;text-align:right}
.t-pnl.pos{color:#4ade80}
.t-pnl.neg{color:#f87171}
.t-time{color:#475569;font-size:.7rem;margin-left:8px;min-width:80px;text-align:right}
.no-pos{font-size:.85rem;color:#475569;padding:14px;text-align:center;background:#080c14;border-radius:6px;font-style:italic}
.muted{color:#475569;font-size:.85rem;padding:10px}

/* Combined trades section (all 3 strategies merged) */
.combined-section{max-width:1500px;margin:18px auto 0;background:#0b1220;border:1px solid #1a2a42;border-radius:14px;padding:22px;box-shadow:0 4px 18px rgba(0,0,0,.3);position:relative;overflow:hidden}
.combined-section::before{content:'';position:absolute;top:0;left:0;right:0;height:4px;background:linear-gradient(90deg,#3b82f6,#8b5cf6,#ec4899)}
.cs-head{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #1a2a42}
.cs-title{font-size:1.15rem;font-weight:900;color:#a78bfa;letter-spacing:.04em}
.cs-stats{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.cs-stat{font-size:.78rem;color:#94a3b8;background:#080c14;padding:5px 11px;border-radius:6px;font-weight:600}
.cs-stat.pos{color:#4ade80}
.cs-stat.neg{color:#f87171}
.cs-trades{display:flex;flex-direction:column;gap:6px}
.cs-foot{text-align:center;margin-top:10px;font-size:.7rem;color:#475569;font-style:italic}

/* Strategy badge inside combined trades */
.t-badge{font-weight:800;font-size:.65rem;padding:3px 8px;border-radius:4px;min-width:42px;text-align:center;letter-spacing:.05em;text-transform:uppercase}
.badge-v09{background:rgba(251,191,36,.15);color:#fbbf24;border:1px solid rgba(251,191,36,.3)}
.badge-dt{background:rgba(59,130,246,.15);color:#60a5fa;border:1px solid rgba(59,130,246,.3)}
.badge-gp{background:rgba(167,139,250,.15);color:#a78bfa;border:1px solid rgba(167,139,250,.3)}

footer{text-align:center;margin-top:14px;font-size:.6rem;color:#1e2d45}
</style></head>
<body>
<header>
  <h1>🤖 Hermes Portfolio · 3 Strategies · MEXC Paper Trading</h1>
  <div class="hright"><span class="dot"></span>Auto-refresh 30s · Last: ${now}</div>
</header>

<div class="portfolio-summary">
  <div class="ps-top">
    <span class="ps-title">📊 PORTFOLIO TOTAL</span>
    <span class="hright" style="color:#64748b">${totalOpen} open · ${totalPending} pending · ${totalTrades} closed trades</span>
  </div>
  <div class="ps-grid">
    <div class="ps-cell"><div class="ps-label">Start Capital</div><div class="ps-value">$${fmt(totalStart)}</div></div>
    <div class="ps-cell"><div class="ps-label">Balance</div><div class="ps-value">$${fmt(totalBalance)}</div></div>
    <div class="ps-cell"><div class="ps-label">Realized P&amp;L</div><div class="ps-value ${totalRealized>=0?'pos':'neg'}">${fmt$(totalRealized)}</div></div>
    <div class="ps-cell"><div class="ps-label">Unrealized</div><div class="ps-value ${totalUnreal>=0?'pos':'neg'}">${fmt$(totalUnreal)}</div></div>
    <div class="ps-cell"><div class="ps-label">Total P&amp;L</div><div class="ps-value ${totalPnl>=0?'pos':'neg'}">${fmt$(totalPnl)}<span class="ps-sub">${totalPct>=0?'+':''}${totalPct.toFixed(2)}%</span></div></div>
    <div class="ps-cell"><div class="ps-label">Equity</div><div class="ps-value">$${fmt(totalEquity)}</div></div>
  </div>
</div>

<div class="strats">${cards}</div>

<div class="combined-section">
  <div class="cs-head">
    <span class="cs-title">📜 ALL RECENT TRADES (COMBINED)</span>
    <span class="cs-stats">
      <span class="cs-stat">${allTrades.length} total</span>
      <span class="cs-stat">${combinedWins}W / ${combinedLosses}L</span>
      <span class="cs-stat">${combinedWR}% WR</span>
      <span class="cs-stat ${combinedNet >= 0 ? 'pos' : 'neg'}">${fmt$(combinedNet)} net</span>
    </span>
  </div>
  <div class="cs-trades">${combinedRows}</div>
  <div class="cs-foot">Showing last ${Math.min(15, allTrades.length)} of ${allTrades.length} closed trades · newest first</div>
</div>

<footer>PAPER TRADING · v09 + DT + GP · MEXC Futures · Live prices from Binance · State from GitHub Gist · Refreshes every 30s</footer>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(await page());
});
server.listen(PORT, () => {
  console.log(`\n📊 Portfolio Dashboard → http://localhost:${PORT}`);
  console.log(`   v09 + DT + GP · Combined view · Auto-refreshes every 30s`);
  console.log(`   Ctrl+C to stop.\n`);
});
