/**
 * backtest_portfolio.mjs — Multi-pair portfolio backtest from a single shared pool
 *
 * All 4 pairs (BTC, BNB, XRP, SUI) trade concurrently from one balance.
 * Each trade risks RISK_PCT of the *current* balance — so the whole portfolio
 * compounds together rather than each pair growing independently.
 *
 * Also compares two sizing modes side-by-side:
 *   A) Fixed:   always risk RISK_PCT regardless of how many positions are open
 *   B) Dynamic: total portfolio risk is capped, so per-trade risk scales down
 *               as more positions open simultaneously
 *
 * Run: node backtest_portfolio.mjs [DAYS] [LEVERAGE] [START_BAL]
 *   e.g. node backtest_portfolio.mjs 90 3 1000
 */

const DAYS      = parseInt(process.argv[2] || "90");
const LEVERAGE  = parseFloat(process.argv[3] || "3");
const START_BAL = parseFloat(process.argv[4] || "1000");
const RISK_PCT  = 0.008;          // 0.8% per trade (fixed mode)
const MAX_PORT_RISK = 0.03;       // 3% total portfolio risk at any time (dynamic mode)
const RR        = 1.3;
const MAX_HOLD  = 8;              // 8 × 15m = 2hr
const MAX_SL_PCT = 0.012;
const EMA50_PAIRS = new Set(["BTCUSDT", "SUIUSDT"]);
const PAIRS     = ["BTCUSDT", "BNBUSDT", "XRPUSDT", "SUIUSDT", "LTCUSDT", "AVAXUSDT"];

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchAllCandles(symbol, days) {
  const msPerCandle = 15 * 60 * 1000;
  const totalNeeded = days * (86400000 / msPerCandle);
  const batches     = Math.ceil(totalNeeded / 1000);
  const all         = [];
  let   endTime     = Date.now();

  for (let b = 0; b < batches; b++) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=1000&endTime=${endTime}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const raw  = await res.json();
    if (!Array.isArray(raw) || raw.length === 0) break;
    all.unshift(...raw.map(k => ({
      time:   parseInt(k[0]),
      open:   parseFloat(k[1]),
      high:   parseFloat(k[2]),
      low:    parseFloat(k[3]),
      close:  parseFloat(k[4]),
      volume: parseFloat(k[5]),
    })));
    endTime = raw[0][0] - 1;
    if (b < batches - 1) await new Promise(r => setTimeout(r, 200));
  }
  const seen = new Set();
  return all.filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
            .sort((a, b) => a.time - b.time);
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++)
    out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i-1]; d > 0 ? g += d : l -= d; }
  out[period] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) { g = (g*(period-1)+d)/period; l = l*(period-1)/period; }
    else        { g = g*(period-1)/period;     l = (l*(period-1)-d)/period; }
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

function sma(values, period) {
  return values.map((_, i) =>
    i < period - 1 ? null : values.slice(i-period+1, i+1).reduce((a,b)=>a+b,0)/period
  );
}

function vwap(candles) {
  const out = [];
  let cumPV = 0, cumVol = 0;
  let dayStart = new Date(candles[0].time); dayStart.setUTCHours(0,0,0,0);
  for (const c of candles) {
    const cDay = new Date(c.time); cDay.setUTCHours(0,0,0,0);
    if (cDay.getTime() !== dayStart.getTime()) { cumPV = 0; cumVol = 0; dayStart = cDay; }
    const tp = (c.high + c.low + c.close) / 3;
    cumPV += tp * c.volume; cumVol += c.volume;
    out.push(cumVol > 0 ? cumPV / cumVol : c.close);
  }
  return out;
}

function inSession(ts) { const h = new Date(ts).getUTCHours(); return h >= 1 && h < 22; }

// ADX (Wilder, period=14) — trend strength filter. > 20 = trending, < 20 = choppy.
function adxCalc(candles, period=14) {
  const n=candles.length, out=new Array(n).fill(null);
  const tr=[],pdm=[],ndm=[];
  for(let i=1;i<n;i++){
    const h=candles[i].high,l=candles[i].low,pc=candles[i-1].close;
    const ph=candles[i-1].high,pl=candles[i-1].low;
    tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
    const up=h-ph,dn=pl-l;
    pdm.push(up>dn&&up>0?up:0);
    ndm.push(dn>up&&dn>0?dn:0);
  }
  if(tr.length<period*2) return out;
  let smTR=tr.slice(0,period).reduce((a,b)=>a+b,0);
  let smP=pdm.slice(0,period).reduce((a,b)=>a+b,0);
  let smN=ndm.slice(0,period).reduce((a,b)=>a+b,0);
  const dx=[];
  const calcDX=()=>{const p=smTR>0?100*smP/smTR:0,nn=smTR>0?100*smN/smTR:0;return(p+nn)>0?100*Math.abs(p-nn)/(p+nn):0;};
  dx.push(calcDX());
  for(let i=period;i<tr.length;i++){
    smTR=smTR-smTR/period+tr[i];smP=smP-smP/period+pdm[i];smN=smN-smN/period+ndm[i];
    dx.push(calcDX());
  }
  if(dx.length<period) return out;
  let adxVal=dx.slice(0,period).reduce((a,b)=>a+b,0)/period;
  out[2*period-1]=adxVal;
  for(let j=period;j<dx.length;j++){adxVal=(adxVal*(period-1)+dx[j])/period;out[j+period]=adxVal;}
  return out;
}

// ─── Pre-compute signals for one pair ─────────────────────────────────────────
// Returns array indexed by candle, each entry is the signal at that bar (or null)

function computeSignals(symbol, candles) {
  const closes = candles.map(c => c.close);
  const vols   = candles.map(c => c.volume);
  const e21    = ema(closes, 21);
  const e50    = ema(closes, 50);  // short-term direction (1hr) + EMA50 bounce signal
  const rsi_   = rsi(closes, 14);
  const vsma   = sma(vols, 20);
  const adx_   = adxCalc(candles);
  const signals = new Array(candles.length).fill(null);
  const tb = 4;  // 4 bars × 15m = 1 hour short-term momentum lookback

  for (let i = 70; i < candles.length - 1; i++) {
    if (!rsi_[i] || !vsma[i] || i < tb) continue;
    if (!inSession(candles[i].time)) continue;
    if (!adx_[i] || adx_[i] < 20) continue;  // skip choppy/ranging markets

    const c = candles[i], p = candles[i-1];
    const r = rsi_[i];
    const volOk = c.volume > vsma[i] * 1.2;
    const e50Up = e50[i] > e50[i-tb];  // EMA50 rising over last 1 hour
    const e50Dn = e50[i] < e50[i-tb];  // EMA50 falling over last 1 hour

    // LONG A: EMA21 recapture — short-term momentum up (1hr), no macro filter
    if (!signals[i] && e50Up && r >= 40 && r < 65 && volOk
        && p.close < e21[i-1] && c.close > e21[i]) {
      const sl = Math.min(...candles.slice(Math.max(0,i-3), i+1).map(x => x.low));
      const risk = c.close - sl;
      if (risk > 0 && risk/c.close < MAX_SL_PCT)
        signals[i] = { direction:"LONG", entry:c.close, sl, tp:c.close+risk*RR, signal:"EMA21" };
    }
    // LONG B: EMA50 bounce (BTC+SUI only) — EMA50 rising = consistent bounce direction
    if (!signals[i] && EMA50_PAIRS.has(symbol)
        && e50Up && r >= 38 && r < 62 && volOk
        && p.close < e50[i-1] && c.close > e50[i]) {
      const sl = Math.min(...candles.slice(Math.max(0,i-4), i+1).map(x => x.low));
      const risk = c.close - sl;
      if (risk > 0 && risk/c.close < 0.018)
        signals[i] = { direction:"LONG", entry:c.close, sl, tp:c.close+risk*RR, signal:"EMA50" };
    }
    // SHORT A: EMA21 rejection — short-term momentum down (1hr), no macro filter
    if (!signals[i] && e50Dn && r > 35 && r <= 60 && volOk
        && p.close > e21[i-1] && c.close < e21[i]) {
      const sl = Math.max(...candles.slice(Math.max(0,i-3), i+1).map(x => x.high));
      const risk = sl - c.close;
      if (risk > 0 && risk/c.close < MAX_SL_PCT)
        signals[i] = { direction:"SHORT", entry:c.close, sl, tp:c.close-risk*RR, signal:"EMA21" };
    }
    // SHORT B: EMA50 rejection (BTC+SUI only) — EMA50 falling = consistent rejection direction
    if (!signals[i] && EMA50_PAIRS.has(symbol)
        && e50Dn && r > 38 && r <= 62 && volOk
        && p.close > e50[i-1] && c.close < e50[i]) {
      const sl = Math.max(...candles.slice(Math.max(0,i-4), i+1).map(x => x.high));
      const risk = sl - c.close;
      if (risk > 0 && risk/c.close < 0.018)
        signals[i] = { direction:"SHORT", entry:c.close, sl, tp:c.close-risk*RR, signal:"EMA50" };
    }
  }
  return signals;
}

// ─── Portfolio simulation ──────────────────────────────────────────────────────
// riskPct  = fraction of balance risked per trade (e.g. 0.008)
// leverage = position leverage multiplier (e.g. 3)

function simulate(allCandles, allSignals, riskPct, leverage) {
  // Build a merged timeline of all candles sorted by time
  // We step through time bar-by-bar across all pairs simultaneously

  // Find the common time range
  const allTimes = new Set();
  for (const candles of Object.values(allCandles))
    for (const c of candles) allTimes.add(c.time);

  const sortedTimes = [...allTimes].sort((a,b) => a-b);

  // Index each pair's candles by time for O(1) lookup
  const byTime = {};
  for (const [sym, candles] of Object.entries(allCandles)) {
    byTime[sym] = {};
    candles.forEach((c, idx) => { byTime[sym][c.time] = { candle: c, idx }; });
  }

  let balance  = START_BAL;
  let peak     = balance;
  let maxDD    = 0;
  let maxDDdollar = 0;
  const trades = [];
  const open   = {};  // symbol → { direction, entry, sl, tp, entryTime, entryIdx, riskUSD, sizeUSD, signal }

  for (const t of sortedTimes) {
    // 1. Check exits on all open positions at this candle
    for (const [sym, pos] of Object.entries(open)) {
      const hit = byTime[sym]?.[t];
      if (!hit) continue;
      const c = hit.candle;
      const isLong = pos.direction === "LONG";
      const hitTP = isLong ? c.high >= pos.tp  : c.low  <= pos.tp;
      const hitSL = isLong ? c.low  <= pos.sl  : c.high >= pos.sl;
      const bars  = Math.round((t - pos.entryTime) / (15 * 60 * 1000));
      const timeExit = bars >= MAX_HOLD;

      let exitReason = null, exitPrice = null;
      if      (hitSL && hitTP) { exitReason = "SL"; exitPrice = pos.sl; }
      else if (hitSL)          { exitReason = "SL"; exitPrice = pos.sl; }
      else if (hitTP)          { exitReason = "TP"; exitPrice = pos.tp; }
      else if (timeExit)       { exitReason = "TIME"; exitPrice = c.close; }

      if (exitReason) {
        const movePct = isLong ? (exitPrice - pos.entry)/pos.entry : (pos.entry - exitPrice)/pos.entry;
        const slPct   = Math.abs(pos.entry - pos.sl) / pos.entry;
        const pnl     = slPct > 0 ? (movePct / slPct) * pos.riskUSD * leverage : 0;
        balance += pnl;
        if (balance <= 0) balance = 0;
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak * 100;
        if (dd > maxDD) maxDD = dd;
        if (peak - balance > maxDDdollar) maxDDdollar = peak - balance;
        trades.push({ sym, direction: pos.direction, entry: pos.entry, exit: exitPrice,
                      sl: pos.sl, tp: pos.tp, pnl, exitReason, signal: pos.signal,
                      entryTime: pos.entryTime, exitTime: t, balanceAfter: balance });
        delete open[sym];
      }
    }

    // 2. Check for new entries at this bar
    for (const sym of PAIRS) {
      if (open[sym]) continue;  // already in a trade on this pair
      const hit = byTime[sym]?.[t];
      if (!hit) continue;
      const sig = allSignals[sym][hit.idx];
      if (!sig) continue;

      // Size the trade
      const riskUSD = balance * riskPct;

      const slDist  = Math.abs(sig.entry - sig.sl);
      const sizeUSD = (riskUSD / slDist) * sig.entry;

      open[sym] = { ...sig, entryTime: t, riskUSD, sizeUSD };
    }
  }

  // Close anything still open at end (time exit at last candle close)
  for (const [sym, pos] of Object.entries(open)) {
    const lastCandles = allCandles[sym];
    const lastC = lastCandles[lastCandles.length - 1];
    const isLong = pos.direction === "LONG";
    const movePct = isLong ? (lastC.close - pos.entry)/pos.entry : (pos.entry - lastC.close)/pos.entry;
    const slPct   = Math.abs(pos.entry - pos.sl) / pos.entry;
    const pnl     = slPct > 0 ? (movePct / slPct) * pos.riskUSD * leverage : 0;
    balance += pnl;
    trades.push({ sym, direction: pos.direction, entry: pos.entry, exit: lastC.close,
                  sl: pos.sl, tp: pos.tp, pnl, exitReason: "TIME", signal: pos.signal,
                  entryTime: pos.entryTime, exitTime: lastC.time, balanceAfter: balance });
  }

  return { balance, maxDD, maxDDdollar, trades };
}

// ─── Stats printer ────────────────────────────────────────────────────────────

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function printStats(label, result, riskPct, leverage) {
  const { balance, maxDD, maxDDdollar, trades } = result;
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalReturn = ((balance - START_BAL) / START_BAL * 100).toFixed(1);
  const wr  = (wins.length / trades.length * 100).toFixed(1);
  const pf  = losses.reduce((s,t)=>s+Math.abs(t.pnl),0) > 0
              ? (wins.reduce((s,t)=>s+t.pnl,0) / Math.abs(losses.reduce((s,t)=>s+t.pnl,0))).toFixed(2)
              : "∞";
  const tpC   = trades.filter(t=>t.exitReason==="TP").length;
  const slC   = trades.filter(t=>t.exitReason==="SL").length;
  const timeC = trades.filter(t=>t.exitReason==="TIME").length;

  const perPair = {};
  for (const sym of PAIRS) perPair[sym] = trades.filter(t=>t.sym===sym);

  // ── Monthly breakdown ───────────────────────────────────────────────────────
  // Group trades by exit month; track running balance at start of each month
  const monthlyMap = {};
  for (const t of trades) {
    const d   = new Date(t.exitTime);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
    if (!monthlyMap[key]) monthlyMap[key] = { trades: [], month: d.getUTCMonth(), year: d.getUTCFullYear() };
    monthlyMap[key].trades.push(t);
  }

  // Reconstruct month-start balances by walking the trade list in order
  const sortedTrades = [...trades].sort((a,b) => (a.exitTime||0)-(b.exitTime||0));
  let runBal = START_BAL;
  const monthStartBal = {};
  let lastKey = null;
  for (const t of sortedTrades) {
    const d   = new Date(t.exitTime);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
    if (key !== lastKey) { monthStartBal[key] = runBal; lastKey = key; }
    runBal += t.pnl;
  }

  console.log(`\n${"═".repeat(62)}`);
  console.log(`  ${label}`);
  console.log(`${"═".repeat(62)}`);
  console.log(`  Start balance:  $${START_BAL.toLocaleString()}  →  End: $${balance.toFixed(2)}`);
  console.log(`  Total return:   ${totalReturn >= 0 ? "+" : ""}${totalReturn}%   (${DAYS} days @ ${leverage}x lev, ${(riskPct*100).toFixed(1)}% risk/trade)`);
  console.log(`  Max drawdown:   ${maxDD.toFixed(1)}%  ($${maxDDdollar.toFixed(2)})`);
  console.log(``);
  console.log(`  Total trades:   ${trades.length}  (~${(trades.length/DAYS*7).toFixed(1)}/week)`);
  console.log(`  Win rate:       ${wr}%  (${wins.length}W / ${losses.length}L)`);
  console.log(`  Profit factor:  ${pf}`);
  console.log(`  Exits:          TP ${tpC} | SL ${slC} | TIME ${timeC}`);

  // ── Monthly P&L table ───────────────────────────────────────────────────────
  console.log(`\n  ── Monthly P&L ─────────────────────────────────────────────`);
  console.log(`  ${"Month".padEnd(9)} ${"Trades".padEnd(8)} ${"W".padEnd(5)} ${"L".padEnd(5)} ${"WR%".padEnd(7)} ${"P&L $".padEnd(10)} ${"Return%".padEnd(9)} ${"End Bal"}`);
  console.log(`  ${"─".repeat(59)}`);

  const sortedKeys = Object.keys(monthlyMap).sort();
  for (const key of sortedKeys) {
    const { trades: mt, month, year } = monthlyMap[key];
    const mw  = mt.filter(t=>t.pnl>0);
    const ml  = mt.filter(t=>t.pnl<=0);
    const mpnl = mt.reduce((s,t)=>s+t.pnl, 0);
    const mwr  = mt.length ? (mw.length/mt.length*100).toFixed(0) : "-";
    const startB = monthStartBal[key] || START_BAL;
    const retPct  = ((mpnl / startB) * 100).toFixed(1);
    const endBal  = sortedTrades.filter(t => {
      const d = new Date(t.exitTime);
      const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
      return k === key;
    }).reduce((s,t)=>s+t.pnl, startB);

    const sign  = mpnl >= 0 ? "+" : "";
    const label2 = `${MONTH_NAMES[month]} ${year}`;
    console.log(
      `  ${label2.padEnd(9)} ${String(mt.length).padEnd(8)} ${String(mw.length).padEnd(5)} ${String(ml.length).padEnd(5)} ` +
      `${(mwr+"%").padEnd(7)} ${(sign+mpnl.toFixed(2)).padEnd(10)} ${(sign+retPct+"%").padEnd(9)} $${endBal.toFixed(2)}`
    );
  }

  // ── Per-pair breakdown ──────────────────────────────────────────────────────
  console.log(`\n  ── Per-pair ────────────────────────────────────────────────`);
  for (const sym of PAIRS) {
    const pt  = perPair[sym];
    const pw  = pt.filter(t=>t.pnl>0);
    const pwr = pt.length ? (pw.length/pt.length*100).toFixed(0) : "-";
    const ppnl = pt.reduce((s,t)=>s+t.pnl,0);
    const sign = ppnl >= 0 ? "+" : "";
    console.log(`    ${sym.padEnd(10)}  ${pt.length} trades  ${pwr}% WR  P&L: ${sign}$${ppnl.toFixed(2)}`);
  }
  console.log(`${"═".repeat(62)}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log(`\nFetching ${DAYS}-day candles for ${PAIRS.length} pairs...`);

const allCandles = {};
const allSignals = {};

for (const sym of PAIRS) {
  process.stdout.write(`  ${sym}... `);
  allCandles[sym] = await fetchAllCandles(sym, DAYS);
  allSignals[sym] = computeSignals(sym, allCandles[sym]);
  const sigCount = allSignals[sym].filter(Boolean).length;
  console.log(`${allCandles[sym].length} candles  (${sigCount} signals)`);
}

// ─── Combo comparison ─────────────────────────────────────────────────────────
// 4 combinations: (risk%, leverage)
const COMBOS = [
  { riskPct: 0.008, leverage: 3, label: "0.8% risk  × 3x lev  (BASELINE)"    },
  { riskPct: 0.010, leverage: 3, label: "1.0% risk  × 3x lev  (+25% eff risk)" },
  { riskPct: 0.008, leverage: 5, label: "0.8% risk  × 5x lev  (+67% eff risk)" },
  { riskPct: 0.010, leverage: 5, label: "1.0% risk  × 5x lev  (+108% eff risk)"},
];

console.log(`\nRunning ${COMBOS.length} portfolio simulations...\n`);

const results = [];
for (const combo of COMBOS) {
  process.stdout.write(`  ${combo.label}... `);
  const r = simulate(allCandles, allSignals, combo.riskPct, combo.leverage);
  results.push({ ...combo, result: r });
  console.log(`done  →  $${r.balance.toFixed(2)}`);
}

// Detailed output for each combo
for (const { label, riskPct, leverage, result } of results) {
  printStats(label, result, riskPct, leverage);
}

// ── Summary comparison table ────────────────────────────────────────────────
console.log(`\n${"═".repeat(72)}`);
console.log(`  COMPARISON SUMMARY  (${DAYS} days, $${START_BAL.toLocaleString()} start)`);
console.log(`${"═".repeat(72)}`);
console.log(`  ${"Combo".padEnd(32)} ${"End Bal".padEnd(12)} ${"Return".padEnd(10)} ${"Max DD".padEnd(10)} Eff.Risk`);
console.log(`  ${"─".repeat(68)}`);
for (const { label, riskPct, leverage, result } of results) {
  const ret  = ((result.balance - START_BAL) / START_BAL * 100).toFixed(1);
  const sign = ret >= 0 ? "+" : "";
  const effRisk = (riskPct * leverage * 100).toFixed(1);
  console.log(
    `  ${label.padEnd(32)} ` +
    `$${result.balance.toFixed(2).padEnd(11)} ` +
    `${(sign+ret+"%").padEnd(10)} ` +
    `${(result.maxDD.toFixed(1)+"%").padEnd(10)} ` +
    `${effRisk}%`
  );
}
console.log(`${"═".repeat(72)}\n`);
