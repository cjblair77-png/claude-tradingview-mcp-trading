/**
 * bot_regime_monitor.js — BTC Multi-Timeframe Regime Detector
 *
 * Runs once daily. Detects bear→bull (and bull→bear) regime shifts on
 * BTC across Daily / 3-Day / Weekly timeframes. Alerts ONLY when state
 * changes — no noise.
 *
 * Signals tracked:
 *   Daily:   EMA21>50, EMA50>200 (Golden Cross), Price>EMA200
 *   3-Day:   EMA21>50  (smoother, fewer fakeouts)
 *   Weekly:  EMA10>20  (macro regime flip)
 *
 * Alert tiers:
 *   T1 yellow   Daily EMA21>50 just flipped true        → "Early bull signal — watch for confirmation"
 *   T2 orange   3D EMA21>50 just flipped true           → "Multi-TF bull confirmed — consider MODERATE BULL preset"
 *   T3 green    Daily Golden Cross OR Weekly EMA10>20   → "MAJOR bull signal — escalate to STRONG BULL preset"
 *   T4 red      Death cross OR price loses EMA200       → "Bull regime breaking — de-escalate"
 *
 * Run: once daily via Railway cron (0 12 * * * — noon UTC)
 * State: regime_state.json on the shared GitHub Gist
 * Notify: ntfy.sh/hermes-regime
 */

import "dotenv/config";

const GIST_ID      = process.env.GITHUB_GIST_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const NTFY_TOPIC   = process.env.REGIME_NTFY_TOPIC || "hermes-regime";
const GIST_FILE    = "regime_state.json";
const SYMBOL       = "BTC_USDT";
const MEXC_BASE    = "https://contract.mexc.com";

// ─── MEXC OHLC fetch ──────────────────────────────────────────────────────────

async function fetchKlines(interval, limit = 250) {
  const url = `${MEXC_BASE}/api/v1/contract/kline/${SYMBOL}?interval=${interval}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const json = await res.json();
  if (!json.success || !json.data) throw new Error(`MEXC fetch failed: ${JSON.stringify(json).slice(0,200)}`);
  const d = json.data;
  // MEXC returns parallel arrays: time, open, close, high, low, vol, amount
  const bars = d.time.map((t, i) => ({
    time:  t * 1000,
    open:  parseFloat(d.open[i]),
    high:  parseFloat(d.high[i]),
    low:   parseFloat(d.low[i]),
    close: parseFloat(d.close[i]),
  }));
  return bars.slice(-limit);
}

// Aggregate Day1 bars → 3-Day bars
function aggregate3Day(daily) {
  const out = [];
  for (let i = 0; i + 3 <= daily.length; i += 3) {
    const slice = daily.slice(i, i + 3);
    out.push({
      time:  slice[0].time,
      open:  slice[0].open,
      high:  Math.max(...slice.map(b => b.high)),
      low:   Math.min(...slice.map(b => b.low)),
      close: slice[slice.length - 1].close,
    });
  }
  return out;
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (const v of values.slice(period)) e = v * k + e * (1 - k);
  return e;
}

// EMA series — used to check if a condition has been TRUE for N consecutive bars
function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(e);
  for (const v of values.slice(period)) {
    e = v * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

// ─── Compute regime state ─────────────────────────────────────────────────────

function computeRegime(daily, threeDay, weekly) {
  const dClose = daily.map(b => b.close);
  const tClose = threeDay.map(b => b.close);
  const wClose = weekly.map(b => b.close);

  const dEMA21  = ema(dClose, 21);
  const dEMA50  = ema(dClose, 50);
  const dEMA200 = ema(dClose, 200);
  const tEMA21  = ema(tClose, 21);
  const tEMA50  = ema(tClose, 50);
  const wEMA10  = ema(wClose, 10);
  const wEMA20  = ema(wClose, 20);

  const last     = dClose[dClose.length - 1];
  const weekLast = wClose[wClose.length - 1];

  // Count consecutive days that daily EMA21>50 has held
  const dEMA21series = emaSeries(dClose, 21);
  const dEMA50series = emaSeries(dClose, 50);
  // Align series to same length (50-EMA series is shorter)
  const offset = dEMA21series.length - dEMA50series.length;
  let streak21gt50 = 0;
  for (let i = dEMA50series.length - 1; i >= 0; i--) {
    if (dEMA21series[i + offset] > dEMA50series[i]) streak21gt50++;
    else break;
  }

  return {
    timestamp: new Date().toISOString(),
    btcPrice:  last,
    daily: {
      ema21:        dEMA21,
      ema50:        dEMA50,
      ema200:       dEMA200,
      ema21_gt_50:  dEMA21 > dEMA50,
      ema50_gt_200: dEMA200 ? dEMA50 > dEMA200 : null,  // Golden Cross
      price_gt_ema200: dEMA200 ? last > dEMA200 : null,
      streak21gt50,
    },
    threeDay: {
      ema21:       tEMA21,
      ema50:       tEMA50,
      ema21_gt_50: tEMA21 && tEMA50 ? tEMA21 > tEMA50 : null,
    },
    weekly: {
      ema10:       wEMA10,
      ema20:       wEMA20,
      ema10_gt_20: wEMA10 && wEMA20 ? wEMA10 > wEMA20 : null,
    },
  };
}

// ─── Detect state transitions → build alerts ──────────────────────────────────

function detectTransitions(prev, curr) {
  const alerts = [];

  // Helper: did boolean flip from false→true?
  const flippedUp   = (p, c) => p === false && c === true;
  const flippedDown = (p, c) => p === true  && c === false;

  // T1 YELLOW — daily EMA21>50 flipped TRUE
  if (flippedUp(prev?.daily?.ema21_gt_50, curr.daily.ema21_gt_50)) {
    alerts.push({
      tier: "T1", emoji: "🟡",
      title: "EARLY BULL SIGNAL",
      body:
        "Daily EMA21 crossed above EMA50 (first whiff of trend change).\n\n" +
        "⚠️ Often fakeouts — watch for 3D confirmation over next 1-2 weeks.\n\n" +
        "Action: NO CHANGES YET. Monitor only.",
    });
  }

  // T2 ORANGE — 3D EMA21>50 flipped TRUE, OR daily streak ≥ 7 days
  if (flippedUp(prev?.threeDay?.ema21_gt_50, curr.threeDay.ema21_gt_50)) {
    alerts.push({
      tier: "T2", emoji: "🟠",
      title: "MULTI-TF BULL CONFIRMED",
      body:
        "3-Day EMA21 just crossed above EMA50.\n\n" +
        "This is the smoother mid-term confirmation. Bear→bull regime change in progress.\n\n" +
        "Action: Consider escalating to MODERATE BULL preset.\n" +
        "  RISK_PCT: 0.016 → 0.020\n" +
        "  DT_RISK_PCT: 0.010 → 0.012\n" +
        "Wait 3-5 days of holding before flipping.",
    });
  } else if (
    prev?.daily?.streak21gt50 < 7 && curr.daily.streak21gt50 >= 7 &&
    curr.daily.ema21_gt_50 && !curr.threeDay.ema21_gt_50
  ) {
    alerts.push({
      tier: "T2", emoji: "🟠",
      title: "DAILY 21>50 HELD 7 DAYS",
      body:
        "Daily EMA21 has stayed above EMA50 for a full week.\n\n" +
        "Not a 3D confirmation yet, but strong enough to warrant attention.\n\n" +
        "Action: Consider partial escalation — RISK_PCT 0.016 → 0.018 as a hedge.",
    });
  }

  // T3 GREEN — Daily Golden Cross
  if (flippedUp(prev?.daily?.ema50_gt_200, curr.daily.ema50_gt_200)) {
    alerts.push({
      tier: "T3", emoji: "🟢",
      title: "DAILY GOLDEN CROSS",
      body:
        "Daily EMA50 just crossed above EMA200 — historic bull market signal.\n\n" +
        "Lagging (~3-6 weeks late) but very reliable. Major bull regime confirmed.\n\n" +
        "Action: Escalate to STRONG BULL preset.\n" +
        "  RISK_PCT: → 0.024\n" +
        "  DT_RISK_PCT: → 0.015\n" +
        "  TRAIL_MODE auto-activation should fire soon if alts follow.\n" +
        "  Disable SPY_CIRCUIT_BREAKER if enabled (less downside risk).",
    });
  }

  // T3 GREEN — Weekly EMA10>20 flip
  if (flippedUp(prev?.weekly?.ema10_gt_20, curr.weekly.ema10_gt_20)) {
    alerts.push({
      tier: "T3", emoji: "🟢",
      title: "WEEKLY MACRO BULL FLIP",
      body:
        "Weekly EMA10 crossed above EMA20 — the big macro signal.\n\n" +
        "Usually marks multi-month bull regimes. This is the one to act on.\n\n" +
        "Action: Escalate to STRONG BULL preset (RISK_PCT 0.024, DT 0.015).\n" +
        "If both this AND golden cross fire within 2 weeks of each other,\n" +
        "consider EXTREME BULL preset (RISK_PCT 0.032, DT 0.020) — but only\n" +
        "after 14+ days of sustained price action.",
    });
  }

  // T4 RED — Death Cross
  if (flippedDown(prev?.daily?.ema50_gt_200, curr.daily.ema50_gt_200)) {
    alerts.push({
      tier: "T4", emoji: "🔴",
      title: "DEATH CROSS WARNING",
      body:
        "Daily EMA50 just crossed BELOW EMA200.\n\n" +
        "Bull regime breaking. Historically marks beginning of multi-month decline.\n\n" +
        "Action: De-escalate aggressively.\n" +
        "  RISK_PCT: → 0.012 (defensive)\n" +
        "  DT_RISK_PCT: → 0.008\n" +
        "  Enable SPY_CIRCUIT_BREAKER=true\n" +
        "  Consider pausing GP bot (long-only, struggles in bear).",
    });
  }

  // T4 RED — Price lost EMA200 after being above
  if (flippedDown(prev?.daily?.price_gt_ema200, curr.daily.price_gt_ema200)) {
    alerts.push({
      tier: "T4", emoji: "🔴",
      title: "BTC LOST EMA200",
      body:
        "BTC closed below daily EMA200 for first time in this regime.\n\n" +
        "Major structural support breach. Bull thesis on hold.\n\n" +
        "Action: Reduce risk by 25%. Re-evaluate in 7 days.\n" +
        "  RISK_PCT: → 0.012\n" +
        "  DT_RISK_PCT: → 0.008",
    });
  }

  return alerts;
}

// ─── Build a baseline snapshot for first run / status check ──────────────────

function summarizeRegime(curr) {
  const d = curr.daily, t = curr.threeDay, w = curr.weekly;
  const fmt$ = n => "$" + Math.round(n).toLocaleString();
  const yn = b => b === true ? "✓" : b === false ? "✗" : "?";

  // Overall regime label
  let regime = "BEAR/NEUTRAL";
  if (d.ema50_gt_200 && w.ema10_gt_20) regime = "STRONG BULL";
  else if (d.ema50_gt_200 || w.ema10_gt_20) regime = "MODERATE BULL";
  else if (d.ema21_gt_50 && (t.ema21_gt_50 || d.streak21gt50 >= 14)) regime = "EARLY BULL";

  const recommendedPreset =
    regime === "STRONG BULL"   ? "RISK_PCT=0.024, DT_RISK_PCT=0.015" :
    regime === "MODERATE BULL" ? "RISK_PCT=0.020, DT_RISK_PCT=0.012" :
    regime === "EARLY BULL"    ? "RISK_PCT=0.018, DT_RISK_PCT=0.011" :
                                 "RISK_PCT=0.016, DT_RISK_PCT=0.010 (current)";

  return (
    `📊 BTC REGIME: ${regime}\n` +
    `Price: ${fmt$(curr.btcPrice)}\n\n` +
    `DAILY:\n` +
    `  EMA21 ${fmt$(d.ema21)} vs EMA50 ${fmt$(d.ema50)}: ${yn(d.ema21_gt_50)} (${d.streak21gt50}d streak)\n` +
    `  EMA50 vs EMA200 ${fmt$(d.ema200)}: ${yn(d.ema50_gt_200)} ${d.ema50_gt_200 ? "← GOLDEN" : ""}\n` +
    `  Price vs EMA200: ${yn(d.price_gt_ema200)}\n\n` +
    `3-DAY:\n` +
    `  EMA21 ${fmt$(t.ema21)} vs EMA50 ${fmt$(t.ema50)}: ${yn(t.ema21_gt_50)}\n\n` +
    `WEEKLY:\n` +
    `  EMA10 ${fmt$(w.ema10)} vs EMA20 ${fmt$(w.ema20)}: ${yn(w.ema10_gt_20)}\n\n` +
    `Recommended preset:\n${recommendedPreset}`
  );
}

// ─── Gist state ───────────────────────────────────────────────────────────────

async function loadGistState() {
  if (!GIST_ID || !GITHUB_TOKEN) return null;
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    const file = data.files?.[GIST_FILE];
    if (!file) return null;
    return JSON.parse(file.content);
  } catch { return null; }
}

async function saveGistState(state) {
  if (!GIST_ID || !GITHUB_TOKEN) return;
  try {
    await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: "PATCH",
      headers: { Authorization: `token ${GITHUB_TOKEN}`, "Content-Type": "application/json", Accept: "application/vnd.github+json" },
      body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(state, null, 2) } } }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) { console.warn("[Gist] save failed:", e.message); }
}

// ─── Notify ───────────────────────────────────────────────────────────────────

// Strip non-ASCII chars from HTTP header values (ntfy Title/Tags) to avoid ByteString error
function ascii(s) { return s.replace(/[^\x20-\x7E]/g, "").trim(); }

async function notify(title, body, priority = "default") {
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Title: ascii(title), Priority: priority, Tags: "chart_with_upwards_trend" },
      body,
      signal: AbortSignal.timeout(8000),
    });
    console.log(`[ntfy] sent: ${title}`);
  } catch (e) { console.warn(`[ntfy] failed:`, e.message); }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n📊 BTC Regime Monitor - ${new Date().toISOString()}\n`);

  // Fetch all timeframes
  const daily  = await fetchKlines("Day1", 250);     // ~250 daily bars
  const weekly = await fetchKlines("Week1", 100);    // ~100 weekly bars
  const threeDay = aggregate3Day(daily);

  console.log(`  Daily bars: ${daily.length} | 3D bars: ${threeDay.length} | Weekly bars: ${weekly.length}`);

  const curr = computeRegime(daily, threeDay, weekly);
  const prev = await loadGistState();

  console.log(`  BTC: $${curr.btcPrice.toFixed(0)}`);
  console.log(`  Daily EMA21>50: ${curr.daily.ema21_gt_50} (${curr.daily.streak21gt50}d streak)`);
  console.log(`  Daily EMA50>200 (Golden): ${curr.daily.ema50_gt_200}`);
  console.log(`  Daily Price>EMA200: ${curr.daily.price_gt_ema200}`);
  console.log(`  3D EMA21>50: ${curr.threeDay.ema21_gt_50}`);
  console.log(`  Weekly EMA10>20: ${curr.weekly.ema10_gt_20}`);

  // First-time run? Send baseline summary.
  if (!prev) {
    console.log(`  No previous state — sending baseline snapshot`);
    const summary = summarizeRegime(curr);
    await notify("BTC Regime Monitor - Baseline", summary);
    await saveGistState(curr);
    return;
  }

  // Detect transitions
  const alerts = detectTransitions(prev, curr);

  if (alerts.length === 0) {
    console.log(`  No state changes — silent`);
  } else {
    for (const a of alerts) {
      const priority = a.tier === "T3" || a.tier === "T4" ? "high" : "default";
      const body = `${a.emoji} ${a.body}\n\n--- Current State ---\n${summarizeRegime(curr).split("\n\n").slice(0,2).join("\n\n")}`;
      await notify(`${a.emoji} BTC ${a.title}`, body, priority);
      console.log(`  ALERT: ${a.tier} ${a.title}`);
    }
  }

  // Always save current state for next comparison
  await saveGistState(curr);
  console.log(`\n✅ Done.\n`);
}

main().catch(err => {
  console.error("FATAL:", err);
  notify("BTC Regime Monitor - ERROR", `${err.message}\n${err.stack?.slice(0, 500) || ""}`, "high").catch(() => {});
  process.exit(1);
});
