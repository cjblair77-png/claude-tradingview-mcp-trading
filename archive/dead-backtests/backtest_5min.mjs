/**
 * backtest_5min.mjs — 5-minute day trading strategy backtest
 *
 * Signal logic:
 *   LONG:  EMA9 > EMA21, price < EMA50 OR price < VWAP, RSI crossed >45, vol >1.3x, close > prev high
 *   SHORT: EMA9 < EMA21, price > EMA50 OR price > VWAP, RSI crossed <55, vol >1.3x, close < prev low
 *
 * Filters:
 *   - Session: 01:00–09:00 UTC (Asia) or 14:00–22:00 UTC (US) only
 *   - No long if RSI > 70, no short if RSI < 30
 *
 * Exits:
 *   - Stop loss: lowest low (LONG) or highest high (SHORT) of last 5 candles
 *   - Take profit: 2× the stop distance
 *   - Max hold: 12 candles (1 hour)
 *
 * Run: node backtest_5min.mjs [SYMBOL] [DAYS]
 *   e.g. node backtest_5min.mjs BTCUSDT 30
 */

const SYMBOL    = process.argv[2] || "BTCUSDT";
const DAYS      = parseInt(process.argv[3] || "30");
const TF        = process.argv[4] || "15m";   // 5m or 15m
const LEVERAGE  = parseFloat(process.argv[5] || "1");
const START_BAL = parseFloat(process.argv[6] || "10000");
const RISK_PCT  = 0.008;   // 0.8% of balance risked per trade
// EMA50 bounce/rejection signal only works on these pairs — disable on others
const EMA50_PAIRS = new Set(["BTCUSDT", "SUIUSDT"]);
const TF_MINS   = TF === "5m" ? 5 : 15;
const CANDLES_PER_DAY = Math.floor(1440 / TF_MINS);
// Max hold: 4 candles on 15m = 1 hour; 6 candles on 5m = 30min
const MAX_HOLD  = TF === "5m" ? 6 : 8;   // 5m=30min, 15m=2hr
const RR        = TF === "5m" ? 1.8 : 1.3; // tighter TP on 15m (more achievable)

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw  = await res.json();
  return raw.map(k => ({
    time:   parseInt(k[0]),
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// Fetch more than 1000 candles by paginating
async function fetchAllCandles(symbol, interval, days) {
  const tfMins      = parseInt(interval);   // "5m"→5, "15m"→15
  const msPerCandle = tfMins * 60 * 1000;
  const totalNeeded = days * (86400000 / msPerCandle);
  const batches     = Math.ceil(totalNeeded / 1000);
  const all         = [];
  let   endTime     = Date.now();

  for (let b = 0; b < batches; b++) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1000&endTime=${endTime}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const raw  = await res.json();
    if (!Array.isArray(raw) || raw.length === 0) break;
    const candles = raw.map(k => ({
      time:   parseInt(k[0]),
      open:   parseFloat(k[1]),
      high:   parseFloat(k[2]),
      low:    parseFloat(k[3]),
      close:  parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
    all.unshift(...candles);
    endTime = raw[0][0] - 1;
    if (b < batches - 1) await new Promise(r => setTimeout(r, 200));
  }
  // Sort and deduplicate
  const seen = new Set();
  return all.filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
            .sort((a,b) => a.time - b.time);
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function ema(values, period) {
  const k   = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++)
    out.push(values[i] * k + out[i-1] * (1-k));
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let g = 0, l = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j] - closes[j-1];
      d > 0 ? g += d : l -= d;
    }
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + (g/period) / (l/period));
  }
  return out;
}

function sma(values, period) {
  return values.map((_, i) =>
    i < period - 1 ? null : values.slice(i - period + 1, i + 1).reduce((a,b) => a+b, 0) / period
  );
}

// Rolling VWAP — resets at midnight UTC each day
function vwap(candles) {
  const out    = new Array(candles.length).fill(null);
  let cumPV    = 0, cumVol = 0;
  let dayStart = new Date(candles[0].time);
  dayStart.setUTCHours(0, 0, 0, 0);

  for (let i = 0; i < candles.length; i++) {
    const c      = candles[i];
    const cDay   = new Date(c.time);
    cDay.setUTCHours(0, 0, 0, 0);
    if (cDay.getTime() !== dayStart.getTime()) {
      cumPV = 0; cumVol = 0;
      dayStart = cDay;
    }
    const tp  = (c.high + c.low + c.close) / 3;
    cumPV    += tp * c.volume;
    cumVol   += c.volume;
    out[i]    = cumVol > 0 ? cumPV / cumVol : c.close;
  }
  return out;
}

// ─── Session filter ───────────────────────────────────────────────────────────
// Asia: 01:00–09:00 UTC | London: 08:00–17:00 UTC | US: 13:00–22:00 UTC
// Combined: 01:00–22:00 UTC (only dead zone 22:00–01:00 excluded)

function inSession(timestampMs) {
  const h = new Date(timestampMs).getUTCHours();
  // Asia + London + US — exclude only the dead 22:00–01:00 UTC window
  return h >= 1 && h < 22;
}

// ─── Backtest ─────────────────────────────────────────────────────────────────

function macd(closes, f = 12, s = 26, sig = 9) {
  const fast   = ema(closes, f);
  const slow   = ema(closes, s);
  const line   = closes.map((_, i) => fast[i] - slow[i]);
  const signal = [line[0]];
  const k      = 2 / (sig + 1);
  for (let i = 1; i < line.length; i++)
    signal.push(line[i] * k + signal[i-1] * (1 - k));
  const hist = line.map((v, i) => v - signal[i]);
  return { line, signal, hist };
}

function backtest(candles) {
  const closes = candles.map(c => c.close);
  const vols   = candles.map(c => c.volume);

  const e9    = ema(closes, 9);
  const e21   = ema(closes, 21);
  const e50   = ema(closes, 50);
  const e100  = ema(closes, 100);   // macro trend filter (replaces e200 — catches trend 2× earlier)
  const vwap_ = vwap(candles);
  const rsi_  = rsi(closes, 14);
  const vsma  = sma(vols, 20);

  const trades = [];
  const open   = [];  // active positions

  for (let i = 110; i < candles.length - 1; i++) {  // EMA100 warmup
    const c     = candles[i];
    const prev  = candles[i-1];

    // ── Check open positions for exit ────────────────────────────────────────
    for (let p = open.length - 1; p >= 0; p--) {
      const pos = open[p];
      const isLong = pos.direction === "LONG";

      // Check if TP or SL hit on this candle
      const hitTP = isLong ? c.high >= pos.tp : c.low <= pos.tp;
      const hitSL = isLong ? c.low  <= pos.sl : c.high >= pos.sl;

      let closed = false;
      if (hitSL && hitTP) {
        // Both in same candle — SL takes priority
        const pnl = isLong ? pos.sl - pos.entry : pos.entry - pos.sl;
        trades.push({ ...pos, exit: pos.sl, exitBar: i, pnl, reason: "SL" });
        closed = true;
      } else if (hitSL) {
        const pnl = isLong ? pos.sl - pos.entry : pos.entry - pos.sl;
        trades.push({ ...pos, exit: pos.sl, exitBar: i, pnl, reason: "SL" });
        closed = true;
      } else if (hitTP) {
        const pnl = isLong ? pos.tp - pos.entry : pos.entry - pos.tp;
        trades.push({ ...pos, exit: pos.tp, exitBar: i, pnl, reason: "TP" });
        closed = true;
      } else if (i - pos.entryBar >= MAX_HOLD) {
        // Max hold
        const pnl = isLong ? c.close - pos.entry : pos.entry - c.close;
        trades.push({ ...pos, exit: c.close, exitBar: i, pnl, reason: "TIME" });
        closed = true;
      }

      if (closed) open.splice(p, 1);
    }

    // ── Skip if outside session or indicators not ready ───────────────────────
    if (!inSession(c.time)) continue;
    if (rsi_[i] == null || vsma[i] == null) continue;
    if (open.length >= 2) continue;  // max 2 concurrent positions

    const r    = rsi_[i];

    // Volume filter
    const volOk = c.volume > vsma[i] * 1.2;

    // Shared trend conditions
    const macroLong  = c.close > e100[i];
    const macroShort = c.close < e100[i];
    const ema50Up    = e50[i] > e50[i-8];
    const ema50Down  = e50[i] < e50[i-8];
    const aboveVwap  = c.close > vwap_[i];
    const belowVwap  = c.close < vwap_[i];
    const longRsi    = r >= 40 && r < 65;
    const shortRsi   = r > 35 && r <= 60;

    // ── LONG A: EMA21 recapture ───────────────────────────────────────────────
    if (!open.some(p => p.direction === "LONG")) {
      const prevBelowE21 = prev.close < e21[i-1];
      const nowAboveE21  = c.close > e21[i];
      if (macroLong && ema50Up && aboveVwap && prevBelowE21 && nowAboveE21 && longRsi && volOk) {
        const pullLow = Math.min(...candles.slice(i-3, i+1).map(x => x.low));
        const risk    = c.close - pullLow;
        if (risk > 0 && risk / c.close < 0.012) {
          open.push({ symbol: SYMBOL, direction: "LONG", entry: c.close, sl: pullLow,
                      tp: c.close + risk * RR, entryBar: i, entryTime: c.time, signal: "EMA21" });
        }
      }
    }

    // ── LONG B: EMA50 bounce — only on pairs where EMA50 acts as support ────────
    if (EMA50_PAIRS.has(SYMBOL) && !open.some(p => p.direction === "LONG")) {
      const prevBelowE50 = prev.close < e50[i-1];
      const nowAboveE50  = c.close > e50[i];
      const e50Rsi       = r >= 38 && r < 62;
      if (macroLong && ema50Up && aboveVwap && prevBelowE50 && nowAboveE50 && e50Rsi && volOk) {
        const pullLow = Math.min(...candles.slice(i-4, i+1).map(x => x.low));
        const risk    = c.close - pullLow;
        if (risk > 0 && risk / c.close < 0.018) {
          open.push({ symbol: SYMBOL, direction: "LONG", entry: c.close, sl: pullLow,
                      tp: c.close + risk * RR, entryBar: i, entryTime: c.time, signal: "EMA50" });
        }
      }
    }

    // ── SHORT A: EMA21 rejection ──────────────────────────────────────────────
    if (!open.some(p => p.direction === "SHORT")) {
      const prevAboveE21 = prev.close > e21[i-1];
      const nowBelowE21  = c.close < e21[i];
      if (macroShort && ema50Down && belowVwap && prevAboveE21 && nowBelowE21 && shortRsi && volOk) {
        const rallyHigh = Math.max(...candles.slice(i-3, i+1).map(x => x.high));
        const risk      = rallyHigh - c.close;
        if (risk > 0 && risk / c.close < 0.012) {
          open.push({ symbol: SYMBOL, direction: "SHORT", entry: c.close, sl: rallyHigh,
                      tp: c.close - risk * RR, entryBar: i, entryTime: c.time, signal: "EMA21" });
        }
      }
    }

    // ── SHORT B: EMA50 rejection — only on pairs where EMA50 acts as resistance ─
    if (EMA50_PAIRS.has(SYMBOL) && !open.some(p => p.direction === "SHORT")) {
      const prevAboveE50 = prev.close > e50[i-1];
      const nowBelowE50  = c.close < e50[i];
      const e50Rsi       = r > 38 && r <= 62;
      if (macroShort && ema50Down && belowVwap && prevAboveE50 && nowBelowE50 && e50Rsi && volOk) {
        const rallyHigh = Math.max(...candles.slice(i-4, i+1).map(x => x.high));
        const risk      = rallyHigh - c.close;
        if (risk > 0 && risk / c.close < 0.018) {
          open.push({ symbol: SYMBOL, direction: "SHORT", entry: c.close, sl: rallyHigh,
                      tp: c.close - risk * RR, entryBar: i, entryTime: c.time, signal: "EMA50" });
        }
      }
    }
  }

  return trades;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function stats(trades, candles) {
  if (trades.length === 0) return console.log("  No trades generated.");

  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const longs  = trades.filter(t => t.direction === "LONG");
  const shorts = trades.filter(t => t.direction === "SHORT");

  // ── Equity curve with leverage & compounding ──────────────────────────────
  let   balance  = START_BAL;
  let   peak     = balance;
  let   maxDD    = 0;
  let   maxDDdollar = 0;
  const equity   = [balance];

  for (const t of trades) {
    const riskUSD  = balance * RISK_PCT;          // $ risked this trade
    const slPct    = Math.abs(t.entry - t.sl) / t.entry;
    const movePct  = t.pnl / t.entry;             // raw price move %
    // With leverage: position size = (risk / slPct) * leverage
    // pnl$ = movePct * (risk/slPct * leverage * entry) / entry
    //      = movePct / slPct * risk * leverage
    const pnlUSD   = slPct > 0 ? (movePct / slPct) * riskUSD * LEVERAGE : 0;
    balance       += pnlUSD;
    if (balance <= 0) { balance = 0; break; }   // liquidation / bust
    equity.push(balance);
    if (balance > peak) peak = balance;
    const ddPct    = (peak - balance) / peak * 100;
    const ddDollar = peak - balance;
    if (ddPct    > maxDD)       maxDD       = ddPct;
    if (ddDollar > maxDDdollar) maxDDdollar = ddDollar;
  }

  const totalReturn = ((balance - START_BAL) / START_BAL * 100).toFixed(1);
  const wr          = (wins.length / trades.length * 100).toFixed(1);
  const avgWinPct   = wins.length   ? (wins.reduce((s,t)   => s + t.pnl/t.entry*100, 0) / wins.length).toFixed(3)   : "0";
  const avgLossPct  = losses.length ? (losses.reduce((s,t) => s + t.pnl/t.entry*100, 0)/ losses.length).toFixed(3)  : "0";
  const grossWin    = wins.reduce((s,t) => s + Math.abs(t.pnl), 0);
  const grossLoss   = losses.reduce((s,t) => s + Math.abs(t.pnl), 0);
  const pf          = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";

  const tpCount   = trades.filter(t => t.reason === "TP").length;
  const slCount   = trades.filter(t => t.reason === "SL").length;
  const timeCount = trades.filter(t => t.reason === "TIME").length;

  // Signal breakdown
  const e21trades  = trades.filter(t => t.signal === "EMA21");
  const e50trades  = trades.filter(t => t.signal === "EMA50");
  const e21wr = e21trades.length ? (e21trades.filter(t=>t.pnl>0).length/e21trades.length*100).toFixed(0) : "-";
  const e50wr = e50trades.length ? (e50trades.filter(t=>t.pnl>0).length/e50trades.length*100).toFixed(0) : "-";

  const leverageStr = LEVERAGE > 1 ? ` @ ${LEVERAGE}x leverage` : "";
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${SYMBOL} ${TF} — ${DAYS}-day Backtest${leverageStr}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Start balance:  $${START_BAL.toLocaleString()}`);
  console.log(`  End balance:    $${balance.toFixed(2)}`);
  console.log(`  Total return:   ${totalReturn >= 0 ? "+" : ""}${totalReturn}%`);
  console.log(`  Max drawdown:   ${maxDD.toFixed(1)}%  ($${maxDDdollar.toFixed(2)})`);
  console.log(``);
  console.log(`  Total trades:   ${trades.length}  (${longs.length} long / ${shorts.length} short)`);
  console.log(`  Win rate:       ${wr}%  (${wins.length} wins / ${losses.length} losses)`);
  console.log(`  Profit factor:  ${pf}`);
  console.log(`  Avg win:        +${avgWinPct}%  |  Avg loss: ${avgLossPct}%`);
  console.log(`  Exit breakdown: TP ${tpCount} | SL ${slCount} | TIME ${timeCount}`);
  console.log(``);
  console.log(`  Long  WR: ${longs.length  ? (longs.filter(t=>t.pnl>0).length/longs.length*100).toFixed(1)   : "-"}%  (${longs.filter(t=>t.pnl>0).length}/${longs.length})`);
  console.log(`  Short WR: ${shorts.length ? (shorts.filter(t=>t.pnl>0).length/shorts.length*100).toFixed(1) : "-"}%  (${shorts.filter(t=>t.pnl>0).length}/${shorts.length})`);
  console.log(`  EMA21 signal: ${e21trades.length} trades  ${e21wr}% WR`);
  console.log(`  EMA50 signal: ${e50trades.length} trades  ${e50wr}% WR`);
  console.log(`${"═".repeat(60)}\n`);

  // Last 10 trades
  console.log("  Last 10 trades:");
  trades.slice(-10).forEach(t => {
    const pct  = (t.pnl / t.entry * 100).toFixed(3);
    const date = new Date(t.entryTime).toISOString().slice(5,16);
    console.log(`  ${t.pnl>0?"🟢":"🔴"} ${t.direction.padEnd(5)} ${date}  entry $${t.entry.toFixed(2)}  ${t.pnl>0?"+":""}${pct}%  ${t.reason}`);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log(`\nFetching ${SYMBOL} ${TF} candles (${DAYS} days)...`);
const candles = await fetchAllCandles(SYMBOL, TF, DAYS);
console.log(`  Loaded ${candles.length} candles  (${new Date(candles[0].time).toISOString().slice(0,10)} → ${new Date(candles[candles.length-1].time).toISOString().slice(0,10)})\n`);
const trades = backtest(candles);
stats(trades, candles);
