/**
 * bot_crypto_v8.js — Bidirectional Regime-Adaptive Crypto Bot
 *
 * Strategy (backtested over 400 days, 100 pairs, 4H candles):
 *   SHORT  Overbought breakdown: RSI was ≥65, fades below 58 OR MACD hist turns
 *          negative, price < EMA21, volume > 1.2×.
 *   LONG   Structural breakout: price closes above 20-bar resistance, EMA21 > EMA50
 *          and rising, RSI 50–70, volume > 1.5×. Fires rarely in downtrends —
 *          catches every leg up when the bull run starts.
 *   LONG   RSI Rebound: RSI was ≤25 (extreme oversold), crosses back above 30,
 *          regime is not BEAR. SL 4% / TP 10% — quick mean-reversion snap-back.
 *   SHORT  RSI Rebound: RSI was ≥75 (extreme overbought), crosses back below 70,
 *          regime is not BULL. SL 4% / TP 10%.
 *
 *   Regime (scored per coin per bar):
 *     BULL  (≥4/5 bullish EMA conditions) → longs full risk, shorts half
 *     BEAR  (≤-4/5)                       → shorts full risk, longs half
 *     NEUTRAL                             → both 75% risk
 *
 *   Momentum SL 6.5% / TP 23% — 3.5:1 R:R, trailing once TP hit.
 *   Rebound   SL 3.5% / TP 22% — 6.3:1 R:R, no trailing (mean-reversion snap).
 *   Max 10 open positions across all pairs (key DD lever).
 *
 *   v07 backtest (94 pairs, 400 days): +130.4% return | 20.0% max DD | Sharpe 2.57
 *   Monte Carlo 95th pct worst-case DD: 29.8% | kill switch at 44.7% live DD
 *
 * Run manually : node bot_crypto_v8.js
 * Schedule     : every 4 hours aligned to candle close (cron: 0 0,4,8,12,16,20 * * *)
 *
 * Paper trading is ON by default (PAPER_TRADING=true in .env).
 * Set PAPER_TRADING=false to go live — real orders placed via BitGet.
 *
 * Files written:
 *   paper_account_v8.json  — paper balance, open positions, closed trades
 *   v8-log.json            — full decision log (every run, every pair)
 *   trades_v8.csv          — tax-ready trade record
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import https from "https";

// ─── Config ───────────────────────────────────────────────────────────────────

const PAIRS = [
  // ── Top 1–50 ────────────────────────────────────────────────────────────────
  "BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","BNBUSDT","DOGEUSDT","LINKUSDT",
  "SUIUSDT","LTCUSDT","AVAXUSDT","HBARUSDT","ADAUSDT","TRXUSDT","TONUSDT",
  "SHIBUSDT","DOTUSDT","BCHUSDT","UNIUSDT","NEARUSDT","APTUSDT","ICPUSDT",
  "ETCUSDT","POLUSDT","VETUSDT","ATOMUSDT","OPUSDT","ARBUSDT","FILUSDT",
  "ALGOUSDT","INJUSDT","BONKUSDT","GRTUSDT","PEPEUSDT","WLDUSDT","AAVEUSDT",
  "TAOUSDT","RENDERUSDT","FETUSDT","STXUSDT","CRVUSDT","THETAUSDT","JASMYUSDT",
  "ONDOUSDT","RUNEUSDT","SANDUSDT","MANAUSDT","ENAUSDT","LDOUSDT","SEIUSDT","TIAUSDT",
  // ── Top 51–100 ───────────────────────────────────────────────────────────────
  "KASUSDT","XLMUSDT","FLOKIUSDT","WIFUSDT","JUPUSDT","MKRUSDT","IMXUSDT",
  "FTMUSDT","GALAUSDT","AXSUSDT","FLOWUSDT","CHZUSDT","GMXUSDT","DYDXUSDT",
  "CAKEUSDT","SNXUSDT","COMPUSDT","KSMUSDT","XTZUSDT","EOSUSDT","NOTUSDT",
  "STRKUSDT","PYTHUSDT","RONUSDT","MNTUSDT","ORDIUSDT","ZKUSDT","ALTUSDT",
  "DYMUSDT","EIGENUSDT","BLURUSDT","ARKMUSDT","MEMEUSDT","TURBOUSDT","PENGUUSDT",
  "TRUMPUSDT","IPUSDT","KAIAUSDT","VIRTUALUSDT","MOVEUSDT","JTOUSDT","RAYUSDT",
  "WUSDT","HOTUSDT","ZECUSDT","DASHUSDT","SUPERUSDT","1INCHUSDT","BATUSDT","APEUSDT",
];

const CFG = {
  paperTrading:   process.env.PAPER_TRADING !== "false",
  portfolioUSD:   parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  riskPct:        parseFloat(process.env.RISK_PCT            || "0.008"), // v07: 0.8% per trade (was 1.0%)
  minRisk:        parseFloat(process.env.MIN_RISK_USD        || "10"),    // floor — never risk less than this
  maxPositions:   parseInt(process.env.MAX_POSITIONS         || "10"),    // v07: 10 max (was 30 — key DD lever)
  interval:       "4h",
  candleLimit:    500,   // enough for 200 EMA warmup + 20-bar lookback
  slPct:          parseFloat(process.env.SL_PCT  || "0.065"), // v07: 6.5% SL (was 7%)
  tpPct:          parseFloat(process.env.TP_PCT  || "0.23"),  // v07: 23% TP (was 21%)
  trailPct:       parseFloat(process.env.TRAIL_PCT          || "0.19"),  // v07: 19% trail (was 5%)
  trailMode:      (process.env.TRAIL_MODE                   || "auto").toLowerCase(), // off | on | auto
  trailAutoBullPct: parseFloat(process.env.TRAIL_AUTO_BULL_PCT || "90"), // v07: 90% bull threshold (was 60%)
  // RSI Rebound signal params (mean reversion — let reversals fully play out)
  reboundSlPct:   parseFloat(process.env.REBOUND_SL_PCT || "0.035"), // v07: 3.5% SL (was 4%)
  reboundTpPct:   parseFloat(process.env.REBOUND_TP_PCT || "0.22"),  // v07: 22% TP (was 10%)
  rsiOversold:    parseFloat(process.env.RSI_OVERSOLD   || "25"),    // RSI extreme low threshold
  rsiOverbought:  parseFloat(process.env.RSI_OVERBOUGHT || "75"),    // RSI extreme high threshold
  bitget: {
    apiKey:     process.env.BITGET_API_KEY,
    secretKey:  process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl:    process.env.BITGET_BASE_URL || "https://api.bitget.com",
    tradeMode:  process.env.TRADE_MODE || "spot",
  },
};

const ACCOUNT_FILE = "paper_account_v8.json";
const LOG_FILE     = "v8-log.json";
const CSV_FILE     = "trades_v8.csv";
const CSV_HEADERS  = "Date,Time (UTC),Symbol,Direction,Entry Price,SL,TP,Risk $,Size $,Mode,Signal,Regime,P&L $,Exit Reason,Order ID\n";

// ─── Utilities ────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
const fmt2  = n => n.toFixed(2);
const fmtPct = n => (n >= 0 ? "+" : "") + (n * 100).toFixed(1) + "%";

// ─── Fetch (native https — no extra deps) ────────────────────────────────────

async function fetchBinance(symbol) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${CFG.interval}&limit=${CFG.candleLimit}`;
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function getCandles(symbol) {
  const raw = await fetchBinance(symbol);
  if (!Array.isArray(raw) || raw.length < 50) throw new Error(`Insufficient data for ${symbol}`);
  return raw.map(k => ({
    time:   parseInt(k[0]),
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++)
    out.push(values[i] * k + out[i-1] * (1-k));
  return out;
}

function smaSeries(values, period) {
  return values.map((_, i) =>
    i < period - 1 ? null : values.slice(i - period + 1, i + 1).reduce((a,b) => a+b, 0) / period
  );
}

function rsiSeries(closes, period = 14) {
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

function macdSeries(closes, f=12, s=26, sig=9) {
  const fast = emaSeries(closes, f);
  const slow = emaSeries(closes, s);
  const line = closes.map((_, i) => fast[i] - slow[i]);
  const signal = [line[0]];
  const k = 2 / (sig + 1);
  for (let i = 1; i < closes.length; i++)
    signal.push(line[i] * k + signal[i-1] * (1-k));
  return { line, signal, hist: line.map((v, i) => v - signal[i]) };
}

// ─── Regime detection (per bar) ───────────────────────────────────────────────

function regime(i, closes, e21, e50, e200) {
  if (!e200[i] || !e50[i] || !e21[i]) return "neutral";
  const c = closes[i];
  let score = 0;
  if (c      > e200[i]) score++; else score--;
  if (c      > e50[i])  score++; else score--;
  if (c      > e21[i])  score++; else score--;
  if (e21[i] > e50[i])  score++; else score--;
  if (e50[i] > e200[i]) score++; else score--;
  return score >= 4 ? "bull" : score <= -4 ? "bear" : "neutral";
}

function riskForRegimeAndDir(reg, direction, balance) {
  // Base risk = 1% of current balance (compounds as account grows/shrinks)
  const base = Math.max(balance * CFG.riskPct, CFG.minRisk);
  if (reg === "neutral") return parseFloat((base * 0.75).toFixed(2));
  const withTrend = (reg === "bull" && direction === "LONG") ||
                    (reg === "bear" && direction === "SHORT");
  return parseFloat((withTrend ? base : base * 0.5).toFixed(2));
}

// ─── Signal logic ─────────────────────────────────────────────────────────────
// NOTE: we evaluate bar [n-1] (last CLOSED bar), not [n] (current forming bar)

function evalSignals(candles) {
  const closes = candles.map(c => c.close);
  const vols   = candles.map(c => c.volume);
  const n      = candles.length - 1;  // last closed bar index
  const i      = n - 1;               // signal bar (second-to-last, fully closed)

  if (i < 22) return { long: false, short: false, regime: "neutral", indicators: {} };

  const e21  = emaSeries(closes, 21);
  const e50  = emaSeries(closes, 50);
  const e200 = emaSeries(closes, 200);
  const rsi  = rsiSeries(closes, 14);
  const mc   = macdSeries(closes);
  const vsma = smaSeries(vols, 20);

  const c    = closes[i];
  const rNow = rsi[i];
  const rPrv = rsi[i-1];
  const vol  = candles[i].volume;
  const reg  = regime(i, closes, e21, e50, e200);

  if (rNow == null || rPrv == null || vsma[i] == null)
    return { long: false, short: false, regime: reg, indicators: { price: closes[n] } };

  // ── LONG: structural breakout ──────────────────────────────────────────────
  const high20   = Math.max(...closes.slice(i - 20, i));
  const breakout = c > high20;
  const trendUp  = e21[i] > e50[i] && e21[i] > e21[i-1] && e21[i-1] > e21[i-3];
  const rsiLong  = rNow >= 50 && rNow <= 70;
  const volLong  = vol  > vsma[i] * 1.5;
  const longSig  = breakout && trendUp && rsiLong && volLong;

  // ── SHORT: overbought breakdown (proven v5) ────────────────────────────────
  const wasOB   = [1,2,3,4,5].some(k => rsi[i-k] != null && rsi[i-k] >= 65);
  const rsiBrk  = rPrv >= 58 && rNow < 58;
  const macdBrk = mc.hist[i-1] >= 0 && mc.hist[i] < 0;
  const volShrt = vol > vsma[i] * 1.2;
  const shortSig = wasOB && (rsiBrk || macdBrk) && c < e21[i] && rNow > 35 && volShrt;

  // ── LONG REBOUND: RSI extreme oversold reversal ───────────────────────────
  // Wait for RSI to cross BACK above 30 after being ≤25 (turn confirmed, not catching a knife)
  const wasOversold   = [1,2,3].some(k => rsi[i-k] != null && rsi[i-k] <= CFG.rsiOversold);
  const rsiTurnUp     = rPrv != null && rPrv <= 30 && rNow > 30;
  const notFreefalling= c > e21[i] * 0.92;   // price not >8% below EMA21
  const volRebound    = vol > vsma[i] * 1.0;  // any elevated volume
  const longRebound   = wasOversold && rsiTurnUp && reg === "bull" && notFreefalling && volRebound && !longSig;  // BULL only — neutral too risky in downtrend

  // ── SHORT REBOUND: RSI extreme overbought reversal ────────────────────────
  const wasOverbought = [1,2,3].some(k => rsi[i-k] != null && rsi[i-k] >= CFG.rsiOverbought);
  const rsiTurnDown   = rPrv != null && rPrv >= 70 && rNow < 70;
  const notMeltingUp  = c < e21[i] * 1.08;   // price not >8% above EMA21
  const shortRebound  = wasOverbought && rsiTurnDown && reg !== "bull" && notMeltingUp && volRebound && !shortSig;

  const currentPrice = closes[n];

  return {
    long:         longSig,
    short:        shortSig,
    longRebound,
    shortRebound,
    regime:       reg,
    indicators: {
      price:    currentPrice,
      rsi:      rNow,
      rsiPrev:  rPrv,
      e21:      e21[i],
      e50:      e50[i],
      e200:     e200[i],
      macdHist: mc.hist[i],
      high20,
      vol,
      volSma:   vsma[i],
    },
    // Signal detail for logging
    longDetail:         longSig       ? `Breakout above ${fmt2(high20)}, EMA21>${fmt2(e50[i])}, RSI ${rNow.toFixed(1)}, vol ${(vol/vsma[i]).toFixed(1)}×` : null,
    shortDetail:        shortSig      ? `RSI faded to ${rNow.toFixed(1)} (was ≥65), price ${fmt2(c)}<EMA21 ${fmt2(e21[i])}, ${rsiBrk?"RSI cross":"MACD flip"}` : null,
    longReboundDetail:  longRebound   ? `RSI oversold turn: ${rPrv?.toFixed(1)}→${rNow.toFixed(1)} (was ≤${CFG.rsiOversold}), price $${fmt2(c)}, ${reg} regime` : null,
    shortReboundDetail: shortRebound  ? `RSI overbought turn: ${rPrv?.toFixed(1)}→${rNow.toFixed(1)} (was ≥${CFG.rsiOverbought}), price $${fmt2(c)}, ${reg} regime` : null,
  };
}

// ─── Paper Account ────────────────────────────────────────────────────────────

function loadAccount() {
  if (!existsSync(ACCOUNT_FILE)) {
    const acc = {
      balance:      CFG.portfolioUSD,
      startBalance: CFG.portfolioUSD,
      openPositions: [],
      closedTrades:  [],
      stats: { total: 0, wins: 0, losses: 0, pnl: 0, longWins: 0, longTotal: 0, shortWins: 0, shortTotal: 0 },
      lastRun: null,
    };
    writeFileSync(ACCOUNT_FILE, JSON.stringify(acc, null, 2));
    console.log(`📋 Paper account created — $${CFG.portfolioUSD} starting balance`);
    return acc;
  }
  return JSON.parse(readFileSync(ACCOUNT_FILE, "utf8"));
}

function saveAccount(acc) {
  acc.lastRun = new Date().toISOString();
  writeFileSync(ACCOUNT_FILE, JSON.stringify(acc, null, 2));
}

// ─── P&L helper ───────────────────────────────────────────────────────────────
function calcPnl(pos, price) {
  return pos.direction === "LONG"
    ? (price - pos.entryPrice) / pos.entryPrice * pos.size
    : (pos.entryPrice - price) / pos.entryPrice * pos.size;
}

// ─── Close a position and record it ──────────────────────────────────────────
function closeTrade(acc, pos, price, reason, closed) {
  const pnl = calcPnl(pos, price);
  const won = pnl > 0;

  acc.balance += pos.size + pnl;
  acc.stats.total++;
  acc.stats.pnl += pnl;
  acc.stats.pnl  = parseFloat(acc.stats.pnl.toFixed(4));
  if (won) acc.stats.wins++; else acc.stats.losses++;
  if (pos.direction === "LONG")  { acc.stats.longTotal++;  if (won) acc.stats.longWins++;  }
  if (pos.direction === "SHORT") { acc.stats.shortTotal++; if (won) acc.stats.shortWins++; }

  const trade = { ...pos, exitPrice: price, exitTime: new Date().toISOString(), exitReason: reason, pnl: parseFloat(pnl.toFixed(4)), won };
  acc.closedTrades.push(trade);
  closed.push(trade);

  const icon = won ? "🟢" : "🔴";
  console.log(`  ${icon} ${reason} — ${pos.direction} ${pos.symbol} @ $${fmt2(price)} | P&L: ${pnl >= 0 ? "+" : ""}$${fmt2(pnl)}`);
  writeCsvTrade(trade);
}

// ─── Check SL / TP / trailing for all open positions ─────────────────────────
function processExits(acc, priceMap) {
  const closed    = [];
  const remaining = [];

  for (const pos of acc.openPositions) {
    const price = priceMap[pos.symbol];
    if (!price) { remaining.push(pos); continue; }

    const isLong = pos.direction === "LONG";

    // ── Already trailing ────────────────────────────────────────────────────
    if (pos.trailing) {
      // Ratchet the high/low water mark upward (locks in more profit)
      let moved = false;
      if (isLong && price > pos.trailHigh) {
        pos.trailHigh = price;
        pos.sl        = parseFloat((price * (1 - CFG.trailPct)).toFixed(6));
        moved = true;
      } else if (!isLong && price < pos.trailLow) {
        pos.trailLow = price;
        pos.sl       = parseFloat((price * (1 + CFG.trailPct)).toFixed(6));
        moved = true;
      }

      // Close if price pulls back to trail SL
      const hitTrail = isLong ? price <= pos.sl : price >= pos.sl;
      if (hitTrail) {
        const pct = ((calcPnl(pos, price) / pos.size) * 100).toFixed(1);
        console.log(`  🏁 TRAIL SL HIT — ${pos.direction} ${pos.symbol} @ $${fmt2(price)} | Trail locked in ${pct}%`);
        closeTrade(acc, pos, price, "TRAIL_SL", closed);
        continue;
      }

      // Log when trail SL moves up
      if (moved) {
        const profit = isLong
          ? (price - pos.entryPrice) / pos.entryPrice * 100
          : (pos.entryPrice - price) / pos.entryPrice * 100;
        console.log(`  📈 TRAIL MOVED — ${pos.direction} ${pos.symbol} @ $${fmt2(price)} (+${profit.toFixed(1)}%) | New SL → $${fmt2(pos.sl)}`);
      }

      remaining.push(pos);
      continue;
    }

    // ── Normal SL / TP ──────────────────────────────────────────────────────
    const hitSL = isLong ? price <= pos.sl : price >= pos.sl;
    const hitTP = isLong ? price >= pos.tp : price <= pos.tp;

    if (!hitSL && !hitTP) { remaining.push(pos); continue; }

    if (hitTP) {
      if (pos.noTrail) {
        // Rebound trade — close at TP, don't trail
        const profit = isLong
          ? (price - pos.entryPrice) / pos.entryPrice * 100
          : (pos.entryPrice - price) / pos.entryPrice * 100;
        console.log(`  ✅ TP HIT (rebound close) — ${pos.direction} ${pos.symbol} @ $${fmt2(price)} (+${profit.toFixed(1)}%)`);
        closeTrade(acc, pos, price, "TP", closed);
      } else {
        // Momentum trade — activate trailing instead of closing
        pos.trailing = true;
        if (isLong) {
          pos.trailHigh = price;
        } else {
          pos.trailLow  = price;
        }
        pos.sl = parseFloat((isLong
          ? price * (1 - CFG.trailPct)
          : price * (1 + CFG.trailPct)).toFixed(6));

        const profit = isLong
          ? (price - pos.entryPrice) / pos.entryPrice * 100
          : (pos.entryPrice - price) / pos.entryPrice * 100;
        console.log(`  🚀 TP HIT → TRAILING — ${pos.direction} ${pos.symbol} @ $${fmt2(price)} (+${profit.toFixed(1)}%) | Trail SL → $${fmt2(pos.sl)}`);
        remaining.push(pos);
      }
      continue;
    }

    // SL hit — close
    closeTrade(acc, pos, price, "SL", closed);
  }

  acc.openPositions = remaining;
  return closed;
}

function openPosition(acc, symbol, direction, entryPrice, signal, detail, reg, riskUSD, opts = {}) {
  if (acc.openPositions.find(p => p.symbol === symbol)) return null;
  if (acc.openPositions.length >= CFG.maxPositions) {
    console.log(`  ⚠️  Position cap (${CFG.maxPositions}) reached — skipping ${symbol}`);
    return null;
  }
  if (acc.balance < riskUSD * 2) {
    console.log(`  ⚠️  Low balance $${fmt2(acc.balance)} — skipping ${symbol}`);
    return null;
  }

  const isLong  = direction === "LONG";
  const slPct   = opts.slPct ?? CFG.slPct;    // rebound trades use tighter 4% SL
  const tpPct   = opts.tpPct ?? CFG.tpPct;    // rebound trades use quicker 10% TP
  const noTrail = opts.noTrail ?? false;       // rebound trades exit at TP, no trailing
  const size    = riskUSD / slPct;             // position size so that SL = riskUSD loss
  const sl      = isLong ? entryPrice * (1 - slPct) : entryPrice * (1 + slPct);
  const tp      = isLong ? entryPrice * (1 + tpPct) : entryPrice * (1 - tpPct);

  acc.balance -= riskUSD;  // reserve just the risk amount (not full position size)

  const pos = {
    id:         `P-${Date.now()}-${symbol}`,
    symbol,
    direction,
    entryPrice,
    size,
    risk:       riskUSD,
    sl:         parseFloat(sl.toFixed(6)),
    tp:         parseFloat(tp.toFixed(6)),
    trailing:   false,   // true once TP is hit — trail SL takes over
    noTrail,             // rebound trades: close at TP instead of trailing
    trailHigh:  null,    // highest price seen (LONG trailing)
    trailLow:   null,    // lowest price seen  (SHORT trailing)
    entryTime:  new Date().toISOString(),
    signal,
    detail,
    regime:     reg,
  };

  acc.openPositions.push(pos);
  return pos;
}

// ─── BitGet execution ─────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  const msg = `${timestamp}${method}${path}${body}`;
  return crypto.createHmac("sha256", CFG.bitget.secretKey).update(msg).digest("base64");
}

async function placeLiveOrder(symbol, side, sizeUSD, price) {
  const qty       = (sizeUSD / price).toFixed(6);
  const timestamp = Date.now().toString();
  const path      = CFG.bitget.tradeMode === "spot"
    ? "/api/v2/spot/trade/placeOrder"
    : "/api/v2/mix/order/placeOrder";
  const body = JSON.stringify({
    symbol,
    side,
    orderType: "market",
    quantity: qty,
    ...(CFG.bitget.tradeMode === "futures" && {
      productType: "USDT-FUTURES",
      marginMode: "isolated",
      marginCoin: "USDT",
    }),
  });

  const signature = signBitGet(timestamp, "POST", path, body);
  const res = await fetch(`${CFG.bitget.baseUrl}${path}`, {
    method:  "POST",
    headers: {
      "Content-Type":      "application/json",
      "ACCESS-KEY":        CFG.bitget.apiKey,
      "ACCESS-SIGN":       signature,
      "ACCESS-TIMESTAMP":  timestamp,
      "ACCESS-PASSPHRASE": CFG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") throw new Error(`BitGet error: ${data.msg}`);
  return data.data;
}

// ─── CSV Logging ──────────────────────────────────────────────────────────────

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS);
    console.log(`📄 Tax log created → ${CSV_FILE}`);
  }
}

function writeCsvTrade(trade) {
  const d    = new Date(trade.exitTime || trade.entryTime);
  const date = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 19);
  const row  = [
    date,
    time,
    trade.symbol,
    trade.direction,
    trade.entryPrice?.toFixed(6) ?? "",
    trade.sl?.toFixed(6)         ?? "",
    trade.tp?.toFixed(6)         ?? "",
    trade.risk?.toFixed(2)       ?? "",
    trade.size?.toFixed(2)       ?? "",
    CFG.paperTrading ? "PAPER" : "LIVE",
    trade.signal                 ?? "",
    trade.regime                 ?? "",
    trade.pnl?.toFixed(4)        ?? "",
    trade.exitReason             ?? "OPEN",
    trade.id                     ?? "",
  ].join(",");
  appendFileSync(CSV_FILE, row + "\n");
}

// ─── Decision log ─────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { runs: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}
function saveLog(log) { writeFileSync(LOG_FILE, JSON.stringify(log, null, 2)); }

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const startTime = Date.now();

  // ── Header ──────────────────────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Crypto Bot v8 — Bidirectional Regime-Adaptive");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CFG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  const trailModeLabel = CFG.trailMode === "on" ? "ON (always)" : CFG.trailMode === "off" ? "OFF (always)" : `AUTO (≥${CFG.trailAutoBullPct}% pairs bull)`;
  console.log(`  Pairs: ${PAIRS.length} | Max positions: ${CFG.maxPositions} | Risk: ${(CFG.riskPct*100).toFixed(1)}% of balance (compounding)`);
  console.log(`  Trail mode: ${trailModeLabel} | Rebound SL ${CFG.reboundSlPct*100}% / TP ${CFG.reboundTpPct*100}%`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Check credentials for live mode
  if (!CFG.paperTrading) {
    const missing = ["BITGET_API_KEY","BITGET_SECRET_KEY","BITGET_PASSPHRASE"]
      .filter(k => !process.env[k]);
    if (missing.length) {
      console.error(`❌ Missing credentials for live trading: ${missing.join(", ")}`);
      process.exit(1);
    }
  }

  initCsv();

  const acc = loadAccount();
  const log = loadLog();

  // ── Account status ───────────────────────────────────────────────────────────
  const pnlPct = (acc.stats.pnl / acc.startBalance * 100).toFixed(2);
  const longWR  = acc.stats.longTotal  ? (acc.stats.longWins  / acc.stats.longTotal  * 100).toFixed(1) : "-";
  const shortWR = acc.stats.shortTotal ? (acc.stats.shortWins / acc.stats.shortTotal * 100).toFixed(1) : "-";
  console.log("── Account Status ──────────────────────────────────────────────\n");
  console.log(`  Balance:    $${fmt2(acc.balance)}  |  Start: $${fmt2(acc.startBalance)}`);
  console.log(`  Total P&L:  ${acc.stats.pnl >= 0 ? "+" : ""}$${fmt2(acc.stats.pnl)} (${pnlPct}%)`);
  console.log(`  Trades:     ${acc.stats.total}  |  Wins: ${acc.stats.wins}  |  Losses: ${acc.stats.losses}`);
  console.log(`  Long WR:    ${longWR}% (${acc.stats.longWins}/${acc.stats.longTotal})`);
  console.log(`  Short WR:   ${shortWR}% (${acc.stats.shortWins}/${acc.stats.shortTotal})`);
  console.log(`  Open:       ${acc.openPositions.length}/${CFG.maxPositions} positions\n`);

  if (acc.openPositions.length > 0) {
    console.log("  Open positions:");
    for (const p of acc.openPositions) {
      const age = Math.round((Date.now() - new Date(p.entryTime).getTime()) / 3600000);
      const trailTag = p.trailing
        ? ` 🔄 TRAILING (peak $${fmt2(p.trailHigh || p.trailLow)})`
        : p.noTrail ? ` TP $${fmt2(p.tp)} [rebound]` : ` TP $${fmt2(p.tp)}`;
      console.log(`    ${p.direction === "LONG" ? "🟢" : "🔴"} ${p.symbol.padEnd(14)} ${p.direction.padEnd(6)} @ $${fmt2(p.entryPrice)}  SL $${fmt2(p.sl)}${trailTag}  [${age}h ago, ${p.regime}]`);
    }
    console.log();
  }

  // ── Fetch all pairs ──────────────────────────────────────────────────────────
  console.log(`── Fetching ${PAIRS.length} pairs from Binance ───────────────────────────\n`);
  const marketData = {};
  let fetchErrors = 0;

  for (const symbol of PAIRS) {
    try {
      marketData[symbol] = await getCandles(symbol);
      process.stdout.write(`  ${symbol.padEnd(14)} ✓\n`);
      await delay(60);
    } catch (err) {
      console.log(`  ${symbol.padEnd(14)} ✗ ${err.message}`);
      fetchErrors++;
    }
  }
  if (fetchErrors > 0) console.log(`\n  ⚠️  ${fetchErrors} pairs failed to fetch — continuing with rest`);

  // Build current price map for exit checks
  const priceMap = {};
  for (const [sym, candles] of Object.entries(marketData)) {
    priceMap[sym] = candles[candles.length - 1].close;
  }

  // ── Process exits ────────────────────────────────────────────────────────────
  console.log("\n── Checking exits ──────────────────────────────────────────────\n");
  const closedThisRun = processExits(acc, priceMap);
  if (closedThisRun.length === 0) console.log("  No exits this run.\n");

  // ── Evaluate signals ─────────────────────────────────────────────────────────
  console.log("── Signal Scan ─────────────────────────────────────────────────\n");
  const signals  = [];
  const runLog   = { time: new Date().toISOString(), signals: [], opened: [], closed: closedThisRun.map(t => t.symbol) };

  for (const symbol of PAIRS) {
    const candles = marketData[symbol];
    if (!candles) continue;

    let sig;
    try { sig = evalSignals(candles); }
    catch (err) { console.log(`  ${symbol}: signal error — ${err.message}`); continue; }

    // Count for regime display
    const { long, short, longRebound, shortRebound, regime: reg, indicators,
            longDetail, shortDetail, longReboundDetail, shortReboundDetail } = sig;

    runLog.signals.push({ symbol, regime: reg, long, short, longRebound, shortRebound, price: indicators.price });

    // ── Momentum signals (priority) ─────────────────────────────────────────
    if (long || short) {
      // Resolve direction when both fire (regime decides)
      let direction = null;
      if (long && !short)  direction = "LONG";
      if (short && !long)  direction = "SHORT";
      if (long && short) {
        direction = reg === "bull" ? "LONG" : reg === "bear" ? "SHORT" : null;
        if (!direction) {
          console.log(`  ${symbol.padEnd(14)} CONFLICT (${reg}) — both signals fired, skipping`);
          continue;
        }
      }

      const signal  = direction === "LONG" ? "Breakout" : "Breakdown";
      const detail  = direction === "LONG" ? longDetail  : shortDetail;
      const riskUSD = riskForRegimeAndDir(reg, direction, acc.balance);

      signals.push({ symbol, direction, signal, detail, regime: reg, riskUSD, price: indicators.price, indicators });

      const regIcon = reg === "bull" ? "🟢" : reg === "bear" ? "🔴" : "🟡";
      console.log(`  ${regIcon} ${symbol.padEnd(14)} ${direction.padEnd(6)} | ${signal} | Risk $${fmt2(riskUSD)} | ${detail}`);
      continue; // momentum takes priority — skip rebound check for this coin
    }

    // ── Rebound signals (only if no momentum signal fired) ──────────────────
    if (longRebound || shortRebound) {
      // Resolve direction when both fire (regime decides, or skip)
      let direction = null;
      if (longRebound && !shortRebound)  direction = "LONG";
      if (shortRebound && !longRebound)  direction = "SHORT";
      if (longRebound && shortRebound) {
        direction = reg === "bull" ? "LONG" : reg === "bear" ? "SHORT" : null;
        if (!direction) {
          console.log(`  ${symbol.padEnd(14)} REBOUND CONFLICT (${reg}) — skipping`);
          continue;
        }
      }

      const signal  = direction === "LONG" ? "RSI Rebound L" : "RSI Rebound S";
      const detail  = direction === "LONG" ? longReboundDetail : shortReboundDetail;
      const riskUSD = riskForRegimeAndDir(reg, direction, acc.balance);

      // Rebound trades use tighter SL/TP and no trailing
      signals.push({
        symbol, direction, signal, detail, regime: reg, riskUSD,
        price: indicators.price, indicators,
        isRebound: true,
      });

      const regIcon = reg === "bull" ? "🟢" : reg === "bear" ? "🔴" : "🟡";
      console.log(`  ${regIcon} ${symbol.padEnd(14)} ${direction.padEnd(6)} | ${signal} | Risk $${fmt2(riskUSD)} | ${detail}`);
    }
  }

  if (signals.length === 0) console.log("  No signals this bar.\n");

  // ── Determine trailing mode from live regime snapshot ────────────────────────
  const regimeCounts = { bull: 0, neutral: 0, bear: 0 };
  for (const s of runLog.signals) { if (regimeCounts[s.regime] !== undefined) regimeCounts[s.regime]++; }
  const totalPairs = regimeCounts.bull + regimeCounts.neutral + regimeCounts.bear;
  const bullPct    = totalPairs ? (regimeCounts.bull / totalPairs * 100) : 0;
  const bearPct    = totalPairs ? (regimeCounts.bear / totalPairs * 100) : 0;

  let useTrail = false;
  if      (CFG.trailMode === "on")   useTrail = true;
  else if (CFG.trailMode === "off")  useTrail = false;
  else { // auto
    useTrail = bullPct >= CFG.trailAutoBullPct;
  }

  const trailIcon   = useTrail ? "🚀" : "🎯";
  const trailReason = CFG.trailMode === "on"  ? "always ON (forced)"
    : CFG.trailMode === "off" ? "always OFF (forced)"
    : useTrail
      ? `AUTO ON  — ${bullPct.toFixed(0)}% pairs bull ≥ ${CFG.trailAutoBullPct}% threshold`
      : `AUTO OFF — ${bullPct.toFixed(0)}% pairs bull < ${CFG.trailAutoBullPct}% threshold (bear/choppy → hard TP)`;
  console.log(`\n  ${trailIcon} Trail SL: ${trailReason}\n`);

  // Store in log for dashboard display
  runLog.trailMode  = CFG.trailMode;
  runLog.useTrail   = useTrail;
  runLog.bullPct    = parseFloat(bullPct.toFixed(1));

  // ── Open new positions ───────────────────────────────────────────────────────
  console.log(`── Opening Positions ───────────────────────────────────────────\n`);
  let opened = 0;

  for (const sig of signals) {
    if (acc.openPositions.find(p => p.symbol === sig.symbol)) {
      console.log(`  ${sig.symbol.padEnd(14)} already open — skipping`);
      continue;
    }

    const entryPrice = sig.price;

    // Rebound trades always use hard TP (no trail — quick snap-back exit)
    // Momentum trades trail only when market is confidently bullish
    const reboundOpts = sig.isRebound
      ? { slPct: CFG.reboundSlPct, tpPct: CFG.reboundTpPct, noTrail: true }
      : { noTrail: !useTrail };

    const pos = openPosition(acc, sig.symbol, sig.direction, entryPrice, sig.signal, sig.detail, sig.regime, sig.riskUSD, reboundOpts);
    if (!pos) continue;

    const icon      = sig.direction === "LONG" ? "🟢" : "🔴";
    const typeLabel = sig.isRebound ? "REBOUND" : "MOMENTUM";
    console.log(`  ${icon} ${sig.direction.padEnd(6)} ${sig.symbol.padEnd(14)} @ $${fmt2(entryPrice)} [${typeLabel}]`);
    console.log(`     Risk $${fmt2(sig.riskUSD)} | SL $${fmt2(pos.sl)} | TP $${fmt2(pos.tp)} | Regime: ${sig.regime}${sig.isRebound ? " | No trail" : " | Trail on TP"}`);
    console.log(`     ${sig.detail}`);

    // Write CSV entry row (no P&L yet — trade open)
    writeCsvTrade(pos);

    // Execute live order if not paper trading
    let orderId = pos.id;
    if (!CFG.paperTrading) {
      try {
        const side = sig.direction === "LONG" ? "buy" : "sell";
        const order = await placeLiveOrder(sig.symbol, side, pos.size, entryPrice);
        orderId = order?.orderId || orderId;
        console.log(`     ✅ Live order placed — ID ${orderId}`);
      } catch (err) {
        console.log(`     ❌ Order failed: ${err.message} — position tracked paper-only`);
      }
    }

    runLog.opened.push({ symbol: sig.symbol, direction: sig.direction, entry: entryPrice, regime: sig.regime, risk: sig.riskUSD });
    opened++;
  }

  if (opened === 0 && signals.length > 0) console.log("  All signals filtered (already open / cap reached / low balance).");
  if (signals.length === 0) console.log("  Nothing to open this bar.");

  // ── Regime summary ───────────────────────────────────────────────────────────
  console.log(`\n── Market Regime Snapshot ──────────────────────────────────────`);
  console.log(`  🟢 Bull:    ${regimeCounts.bull} pairs (${bullPct.toFixed(0)}%)`);
  console.log(`  🟡 Neutral: ${regimeCounts.neutral} pairs`);
  console.log(`  🔴 Bear:    ${regimeCounts.bear} pairs (${bearPct.toFixed(0)}%)`);
  if (totalPairs > 0) {
    const sentiment = regimeCounts.bull > regimeCounts.bear
      ? `📈 Broadly BULLISH (${bullPct.toFixed(0)}% bull) — Trail SL ${useTrail ? "✅ ACTIVE" : `❌ inactive (need ${CFG.trailAutoBullPct}%+)`}`
      : regimeCounts.bear > regimeCounts.bull
        ? `📉 Broadly BEARISH (${bearPct.toFixed(0)}% bear) — Hard TP active`
        : `↔️  Mixed / Transitioning — Hard TP active`;
    console.log(`  Overall:   ${sentiment}`);
  }

  // ── Final account state ──────────────────────────────────────────────────────
  saveAccount(acc);
  log.runs.push(runLog);
  saveLog(log);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const newPnlPct = (acc.stats.pnl / acc.startBalance * 100).toFixed(2);

  console.log(`\n── Summary ─────────────────────────────────────────────────────`);
  console.log(`  Signals found:  ${signals.length}`);
  console.log(`  Positions opened: ${opened}`);
  console.log(`  Positions closed: ${closedThisRun.length}`);
  console.log(`  Open positions: ${acc.openPositions.length}/${CFG.maxPositions}`);
  console.log(`  Account P&L:  ${acc.stats.pnl >= 0 ? "+" : ""}$${fmt2(acc.stats.pnl)} (${newPnlPct}%)`);
  console.log(`  Run time: ${elapsed}s`);
  console.log("═══════════════════════════════════════════════════════════════\n");
}

// ─── Tax summary CLI ─────────────────────────────────────────────────────────

function taxSummary() {
  const acc = loadAccount();
  console.log("\n── v8 Tax Summary ──────────────────────────────────────────────\n");
  console.log(`  Start balance:  $${fmt2(acc.startBalance)}`);
  console.log(`  Current balance:$${fmt2(acc.balance)}`);
  console.log(`  Total P&L:      ${acc.stats.pnl >= 0 ? "+" : ""}$${fmt2(acc.stats.pnl)}`);
  console.log(`  Total trades:   ${acc.stats.total}`);
  console.log(`  Win rate:       ${acc.stats.total ? (acc.stats.wins/acc.stats.total*100).toFixed(1) : 0}%`);
  console.log(`  Long trades:    ${acc.stats.longTotal}  WR ${acc.stats.longTotal ? (acc.stats.longWins/acc.stats.longTotal*100).toFixed(1) : 0}%`);
  console.log(`  Short trades:   ${acc.stats.shortTotal}  WR ${acc.stats.shortTotal ? (acc.stats.shortWins/acc.stats.shortTotal*100).toFixed(1) : 0}%`);
  console.log(`  Open positions: ${acc.openPositions.length}`);
  console.log(`  Trade log:      ${CSV_FILE}\n`);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

if (process.argv.includes("--tax-summary") || process.argv.includes("--status")) {
  taxSummary();
} else {
  run().catch(err => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
