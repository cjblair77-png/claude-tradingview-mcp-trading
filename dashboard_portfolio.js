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
    totalUnreal += unreal;
  }
  const equity = balance + totalUnreal;
  const totalPnl = realizedPnl + totalUnreal;
  const totalPct = start > 0 ? (totalPnl / start * 100) : 0;

  const wins = trades.filter(t => (t.pnl || 0) > 0).length;
  const wr = trades.length ? Math.round(wins / trades.length * 100) : null;

  // Open positions rows
  const posRows = positions.length ? positions.map(p => {
    const sym = p.symbol;
    const cur = prices[sym];
    const isLong = p.direction === "LONG";
    const entry = p.entryPrice || p.entry;
    const sl = p.sl;
    const tp = p.tp;
    let unreal = null;
    if (cur != null) {
      const move = isLong ? (cur - entry) / entry : (entry - cur) / entry;
      const size = s.key === "v09" ? (p.size || 0) : (p.sizeUSD || 0);
      unreal = move * size;
    }
    const uCls = unreal == null ? "" : unreal >= 0 ? "pos" : "neg";
    const ageStr = ago(p.entryTime || (p.openedAt ? new Date(p.openedAt).getTime() : null));
    return `<div class="pos-row ${unreal != null && unreal >= 0 ? 'win' : unreal != null ? 'lose' : ''}">
      <span class="pos-dir ${isLong?'long':'short'}">${isLong?'▲':'▼'} ${p.direction}</span>
      <span class="pos-sym">${(sym||'').replace('_USDT','').replace('USDT','')}</span>
      <span class="pos-entry">@$${fmtPrice(entry)}</span>
      ${cur != null ? `<span class="pos-cur">→ $${fmtPrice(cur)}</span>` : ''}
      ${unreal != null ? `<span class="pos-unreal ${uCls}">${fmt$(unreal)}</span>` : '<span class="pos-unreal muted">—</span>'}
      <span class="pos-sl">SL $${fmtPrice(sl)}</span>
      <span class="pos-tp">TP $${fmtPrice(tp)}</span>
      <span class="pos-age">${ageStr}</span>
    </div>`;
  }).join("") : `<div class="no-pos">No open positions</div>`;

  // Pending orders (GP)
  const pendRows = pending.length ? pending.map(p => {
    const isLong = p.direction === "LONG";
    return `<div class="pos-row pending">
      <span class="pos-dir ${isLong?'long':'short'}">${isLong?'▲':'▼'} ${p.direction}</span>
      <span class="pos-sym">${(p.symbol||'').replace('_USDT','').replace('USDT','')}</span>
      <span class="pos-entry">⏳ Limit @ $${fmtPrice(p.limitPrice)}</span>
      <span class="pos-sl">SL $${fmtPrice(p.sl)}</span>
      <span class="pos-tp">TP $${fmtPrice(p.tp)}</span>
      <span class="pos-age">${ago(p.placedAt)}</span>
    </div>`;
  }).join("") : "";

  // Recent trades (last 5)
  const recent = trades.slice(-5).reverse();
  const tradeRows = recent.length ? recent.map(t => {
    const sym = (t.symbol || '').replace('_USDT','').replace('USDT','');
    const win = (t.pnl || 0) > 0;
    return `<div class="trade-row ${win?'win':'lose'}">
      <span class="t-dir ${t.direction === 'LONG' ? 'long' : 'short'}">${t.direction === 'LONG' ? '▲' : '▼'}</span>
      <span class="t-sym">${sym}</span>
      <span class="t-exit">${t.exitReason}</span>
      <span class="t-pnl ${win?'pos':'neg'}">${fmt$(t.pnl)}</span>
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

  // Collect all symbols needing prices
  const allSymbols = new Set();
  for (const s of strategies) {
    const positions = s.account?.openPositions || s.account?.positions || [];
    for (const p of positions) allSymbols.add(p.symbol);
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
      totalUnreal += move * size;
    }
  }
  const totalEquity = totalBalance + totalUnreal;
  const totalPnl = totalRealized + totalUnreal;
  const totalPct = totalStart > 0 ? (totalPnl / totalStart * 100) : 0;

  const now = new Date().toLocaleTimeString();
  const cards = strategies.map(s => strategyCard(s, prices)).join("\n");

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

/* Strategy cards grid */
.strats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}
@media(max-width:1300px){.strats{grid-template-columns:1fr}}
.strat-card{background:#0b1220;border:1px solid #1a2a42;border-radius:12px;padding:14px;position:relative;overflow:hidden}
.strat-card.profit::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#16a34a,#22c55e)}
.strat-card.loss::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#b91c1c,#ef4444)}
.strat-card.empty{opacity:.6}
.sc-head{display:flex;align-items:baseline;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.sc-name{font-size:1.3rem;font-weight:900;color:#fbbf24}
.sc-sub{font-size:.65rem;color:#64748b;flex:1}
.sc-lastrun{font-size:.6rem;color:#475569}
.sc-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:10px}
@media(max-width:600px){.sc-stats{grid-template-columns:repeat(2,1fr)}}
.sc-stat{background:#080c14;border-radius:6px;padding:6px 8px;text-align:center}
.sc-l{font-size:.55rem;color:#475569;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px}
.sc-v{font-size:.78rem;font-weight:700;color:#cbd5e1}
.sc-v.pos{color:#4ade80}
.sc-v.neg{color:#f87171}
.sc-sub2{font-size:.55rem;color:#64748b;font-weight:400}
.sc-section-label{font-size:.55rem;color:#374151;text-transform:uppercase;letter-spacing:.07em;margin:8px 0 4px}
.sc-positions,.sc-trades{display:flex;flex-direction:column;gap:3px}
.pos-row{display:flex;align-items:center;gap:6px;background:#080c14;border-radius:5px;padding:5px 8px;font-size:.62rem;flex-wrap:wrap}
.pos-row.win{border-left:2px solid #166534}
.pos-row.lose{border-left:2px solid #7f1d1d}
.pos-row.pending{border-left:2px solid #d97706;background:#1c1a07}
.pos-dir{font-weight:800;min-width:56px}
.pos-dir.long{color:#4ade80}
.pos-dir.short{color:#f87171}
.pos-sym{font-weight:700;color:#e2e8f0;min-width:34px}
.pos-entry,.pos-sl,.pos-tp,.pos-age{color:#94a3b8;font-size:.6rem}
.pos-cur{color:#cbd5e1;font-weight:600}
.pos-unreal{font-weight:800;font-size:.66rem;margin-left:auto}
.pos-unreal.pos{color:#4ade80}
.pos-unreal.neg{color:#f87171}
.pos-age{margin-left:auto;color:#475569}
.trade-row{display:flex;align-items:center;gap:6px;background:#080c14;border-radius:5px;padding:4px 8px;font-size:.62rem}
.trade-row.win{border-left:2px solid #166534}
.trade-row.lose{border-left:2px solid #7f1d1d}
.t-dir{font-weight:800;min-width:14px}
.t-dir.long{color:#4ade80}
.t-dir.short{color:#f87171}
.t-sym{font-weight:700;min-width:40px}
.t-exit{color:#64748b;flex:1}
.t-pnl{font-weight:700;min-width:60px;text-align:right}
.t-pnl.pos{color:#4ade80}
.t-pnl.neg{color:#f87171}
.t-time{color:#374151;font-size:.58rem;margin-left:6px}
.no-pos{font-size:.62rem;color:#374151;padding:4px}
.muted{color:#374151;font-size:.7rem;padding:6px}
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
