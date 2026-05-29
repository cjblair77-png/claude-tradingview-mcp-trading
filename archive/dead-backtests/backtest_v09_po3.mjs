/**
 * backtest_v09_po3.mjs — PO3 Limit Entry vs Market Entry
 *
 * Tests the PO3 (Power of 3) concept from ICT/YouTube applied to v09 signals:
 * instead of entering at the open of the next bar after a signal, place a
 * limit order at the 50% midpoint of the signal candle's range and wait up
 * to 2 bars for a fill. If the candle never pulls back to that level, skip.
 *
 * The expected improvement:
 *   - Better entry price (buying the dip, not chasing)
 *   - Same SL% → smaller dollar SL → better risk/reward
 *   - Fewer trades (some signals won't pull back — that's fine, they were
 *     probably momentum entries that streak away without us)
 *
 * Runs 2 simulations with identical signal logic:
 *   A) Market  — enter at next bar's open (current v09 behaviour)
 *   B) PO3     — limit at signal candle 50% midpoint, 2-bar fill window
 *
 * Run: node backtest_v09_po3.mjs [DAYS] [START_BAL]
 *      node backtest_v09_po3.mjs 365 5000
 */

import https from 'https';

// ─── Config ───────────────────────────────────────────────────────────────────

const DAYS      = parseInt(process.argv[2] || '365');
const CAPITAL   = parseFloat(process.argv[3] || '5000');
const INTERVAL  = '4h';
const MAX_POS   = 10;
const RISK_PCT  = 0.008;   // 0.8% per trade
const SL_PCT    = 0.065;   // 6.5%
const TP_PCT    = 0.23;    // 23%
const REB_SL    = 0.035;   // rebound SL 3.5%
const REB_TP    = 0.22;    // rebound TP 22%
const LIMIT_BARS = 2;      // bars to wait for PO3 fill (2 × 4H = 8hr window)

// PO3 fill level: 0 = signal candle low, 0.5 = midpoint, 1 = high
// At 0.50 you're buying the midpoint of the signal candle (classic PO3)
const PO3_LEVEL = 0.50;

const PAIRS = [
  'KAIAUSDT','SUSDT',   'FILUSDT', 'ARUSDT',    'PLUMEUSDT',
  'FIDAUSDT','GMTUSDT', 'ENAUSDT', 'TIAUSDT',   'TURBOUSDT',
  'WIFUSDT', 'SHIBUSDT','BCHUSDT', 'VETUSDT',   'ONDOUSDT',
  'THETAUSDT','HBARUSDT','RUNEUSDT','IOTAUSDT',  'JUPUSDT',
  'FLUXUSDT','WUSDT',   'CATIUSDT','ZKUSDT',    'KAITOUSDT',
  'WLDUSDT', 'AIXBTUSDT','LAUSDT',  'JASMYUSDT', 'HOMEUSDT',
];

// ─── Fetch ────────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol) {
  const end   = Date.now();
  const start = end - (DAYS + 60) * 24 * 60 * 60 * 1000; // extra buffer for indicators
  const bars  = [];
  let from = start;
  while (from < end) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&startTime=${from}&endTime=${end}&limit=1000`;
    const page = await new Promise((res, rej) => {
      https.get(url, r => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => { try { res(JSON.parse(d)); } catch(e) { rej(e); } });
      }).on('error', rej);
    });
    if (!Array.isArray(page) || !page.length) break;
    bars.push(...page);
    from = page[page.length-1][0] + 1;
    if (page.length < 1000) break;
    await delay(80);
  }
  return bars.map(k => ({
    time:   parseInt(k[0]),
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function ema(v, p) {
  const k = 2/(p+1), r = [v[0]];
  for (let i = 1; i < v.length; i++) r.push(v[i]*k + r[i-1]*(1-k));
  return r;
}
function sma(v, p) {
  return v.map((_, i) => i < p-1 ? null : v.slice(i-p+1,i+1).reduce((a,b)=>a+b,0)/p);
}
function rsiSeries(closes, p=14) {
  const r = new Array(closes.length).fill(null);
  for (let i = p; i < closes.length; i++) {
    let g=0, l=0;
    for (let j=i-p+1; j<=i; j++) { const d=closes[j]-closes[j-1]; d>0?g+=d:l-=d; }
    r[i] = l===0 ? 100 : 100 - 100/(1+(g/p)/(l/p));
  }
  return r;
}
function macdSeries(closes, f=12, s=26, sig=9) {
  const fast=ema(closes,f), slow=ema(closes,s);
  const ml=closes.map((_,i)=>fast[i]-slow[i]);
  const sl=[ml[0]]; const k=2/(sig+1);
  for (let i=1; i<closes.length; i++) sl.push(ml[i]*k+sl[i-1]*(1-k));
  return { hist: ml.map((v,i)=>v-sl[i]) };
}

// ─── Regime ───────────────────────────────────────────────────────────────────

function getRegime(i, closes, e21, e50, e200) {
  if (!e200[i]) return 'neutral';
  const c = closes[i]; let s = 0;
  if (c > e200[i]) s++; else s--;
  if (c > e50[i])  s++; else s--;
  if (c > e21[i])  s++; else s--;
  if (e21[i] > e50[i])  s++; else s--;
  if (e50[i] > e200[i]) s++; else s--;
  return s >= 4 ? 'bull' : s <= -4 ? 'bear' : 'neutral';
}

function riskDollars(balance, reg, dir) {
  const base = Math.max(balance * RISK_PCT, 2);
  if (reg === 'neutral') return base * 0.75;
  const withTrend = (reg==='bull'&&dir==='LONG') || (reg==='bear'&&dir==='SHORT');
  return withTrend ? base : base * 0.5;
}

// ─── Signals (identical to v09) ───────────────────────────────────────────────

function getSignals(i, candles, closes, e21, e50, e200, rsi14, mc, vsma) {
  if (i < 31) return null;
  const rNow = rsi14[i], rPrv = rsi14[i-1];
  const vol  = candles[i].volume;
  if (rNow==null||rPrv==null||vsma[i]==null) return null;

  const c   = closes[i];
  const reg = getRegime(i, closes, e21, e50, e200);

  // LONG: structural breakout
  const high30   = Math.max(...closes.slice(i-30, i));
  const breakout = c > high30;
  const trendUp  = e21[i]>e50[i] && e21[i]>e21[i-1] && e21[i-1]>e21[i-3];
  const rsiLong  = rNow>=54 && rNow<=65;
  const volLong  = vol > vsma[i] * 1.5;
  const long     = breakout && trendUp && rsiLong && volLong;

  // SHORT: overbought breakdown
  const wasOB   = [1,2,3,4,5].some(k => rsi14[i-k]!=null && rsi14[i-k]>=65);
  const rsiBrk  = rPrv>=58 && rNow<58;
  const macdBrk = mc.hist[i-1]>=0 && mc.hist[i]<0;
  const volShrt = vol > vsma[i] * 1.2;
  const short   = wasOB && (rsiBrk||macdBrk) && c<e21[i] && rNow>35 && volShrt;

  // LONG REBOUND: RSI extreme oversold
  const wasOversold  = [1,2,3].some(k => rsi14[i-k]!=null && rsi14[i-k]<=20);
  const rsiUp        = rPrv<=30 && rNow>30;
  const notFalling   = c > e21[i]*0.92;
  const longRebound  = wasOversold && rsiUp && reg==='bull' && notFalling && vol>vsma[i]*1.0 && !long;

  // SHORT REBOUND: RSI extreme overbought
  const wasOverbought = [1,2,3].some(k => rsi14[i-k]!=null && rsi14[i-k]>=80);
  const rsiDown       = rPrv>=70 && rNow<70;
  const notMelting    = c < e21[i]*1.08;
  const shortRebound  = wasOverbought && rsiDown && reg!=='bull' && notMelting && vol>vsma[i]*1.0 && !short;

  if (!long && !short && !longRebound && !shortRebound) return null;

  // Determine direction + signal type
  let dir = null, type = null;
  if (long)          { dir='LONG';  type='BREAKOUT'; }
  else if (short)    { dir='SHORT'; type='BREAKDOWN'; }
  else if (longRebound)  { dir='LONG';  type='REBOUND'; }
  else if (shortRebound) { dir='SHORT'; type='REBOUND'; }

  return { dir, type, reg };
}

// ─── Simulation ───────────────────────────────────────────────────────────────

function runSim(allData, mode) {
  // mode: 'market' or 'po3'

  let balance = CAPITAL;
  const open  = new Map();   // sym → position
  const pending = new Map(); // sym → { dir, type, reg, limitPrice, slPct, tpPct, riskDollar, expiry }
  const trades = [];
  const monthly = {};

  // Build unified timeline sorted by bar open time
  const timeline = [];
  for (const d of allData)
    for (let i = 0; i < d.candles.length; i++)
      timeline.push({ sym: d.symbol, i, time: d.candles[i].time });
  timeline.sort((a,b) => a.time - b.time);

  // Clip to DAYS
  const cutoff = Date.now() - DAYS * 86400000;
  const entries = timeline.filter(e => e.time >= cutoff);

  for (const { sym, i, time } of entries) {
    const d   = allData.find(x => x.symbol===sym);
    const bar = d.candles[i];
    const ym  = new Date(time).toISOString().slice(0,7);
    if (!monthly[ym]) monthly[ym] = { pnl: 0, trades: 0 };

    // ── 1. Check existing position exits ─────────────────────────────────
    if (open.has(sym)) {
      const pos = open.get(sym);
      const { dir, entry, sl, tp, size, slPct, tpPct } = pos;
      let closed=false, won=false, pnlDollar=0;

      if (dir==='LONG') {
        if      (bar.open<=sl) { pnlDollar=-(size*slPct); closed=true; }
        else if (bar.open>=tp) { pnlDollar= (size*tpPct); closed=true; won=true; }
        else if (bar.low <=sl) { pnlDollar=-(size*slPct); closed=true; }
        else if (bar.high>=tp) { pnlDollar= (size*tpPct); closed=true; won=true; }
      } else {
        if      (bar.open>=sl) { pnlDollar=-(size*slPct); closed=true; }
        else if (bar.open<=tp) { pnlDollar= (size*tpPct); closed=true; won=true; }
        else if (bar.high>=sl) { pnlDollar=-(size*slPct); closed=true; }
        else if (bar.low <=tp) { pnlDollar= (size*tpPct); closed=true; won=true; }
      }

      if (closed) {
        balance += pnlDollar;
        trades.push({ sym, dir, won, pnl: pnlDollar, type: pos.type });
        monthly[ym].pnl += pnlDollar;
        monthly[ym].trades++;
        open.delete(sym);
      }
    }

    // ── 2. Check pending limit orders (PO3 mode only) ────────────────────
    if (mode==='po3' && pending.has(sym) && !open.has(sym)) {
      const pend = pending.get(sym);
      const { dir, limitPrice, slPct, tpPct, riskDollar, expiry, type } = pend;

      // Check if this bar fills the limit
      const filled = dir==='LONG'  ? bar.low  <= limitPrice
                   :                  bar.high >= limitPrice;

      if (filled && i <= expiry) {
        // Entry filled at limit price
        const entry = limitPrice;
        const sl    = dir==='LONG'  ? entry*(1-slPct) : entry*(1+slPct);
        const tp    = dir==='LONG'  ? entry*(1+tpPct) : entry*(1-tpPct);
        const size  = riskDollar / slPct;
        open.set(sym, { dir, entry, sl, tp, size, slPct, tpPct, type });
        pending.delete(sym);
      } else if (i > expiry) {
        // Order expired
        pending.delete(sym);
      }
    }

    // ── 3. Detect new signals ─────────────────────────────────────────────
    const canFade = !open.has(sym) && !pending.has(sym) && open.size < MAX_POS && balance > 10;
    if (canFade && i > 0) {
      const { closes, e21, e50, e200, rsi14, mc, vsma } = d;
      const sig = getSignals(i, d.candles, closes, e21, e50, e200, rsi14, mc, vsma);

      if (sig) {
        const { dir, type, reg } = sig;
        const slPct_ = type==='REBOUND' ? REB_SL : SL_PCT;
        const tpPct_ = type==='REBOUND' ? REB_TP : TP_PCT;
        const risk   = riskDollars(balance, reg, dir);

        if (mode==='market') {
          // Enter at next bar open
          const nextBar = d.candles[i+1];
          if (!nextBar) continue;
          const entry = nextBar.open;
          const sl    = dir==='LONG'  ? entry*(1-slPct_) : entry*(1+slPct_);
          const tp    = dir==='LONG'  ? entry*(1+tpPct_) : entry*(1-tpPct_);
          const size  = risk / slPct_;
          open.set(sym, { dir, entry, sl, tp, size, slPct: slPct_, tpPct: tpPct_, type });

        } else {
          // PO3: place limit at 50% of signal candle's range
          const sigCandle  = d.candles[i];
          const range      = sigCandle.high - sigCandle.low;
          // LONG: we expect next bar to dip → buy at midpoint (50% from low)
          // SHORT: we expect next bar to bounce → sell at midpoint (50% from high = same price)
          const limitPrice = sigCandle.low + range * PO3_LEVEL;
          pending.set(sym, {
            dir, type, reg,
            limitPrice,
            slPct: slPct_, tpPct: tpPct_,
            riskDollar: risk,
            expiry: i + LIMIT_BARS,
          });
        }
      }
    }
  }

  // Close remaining open positions at last price
  for (const [sym, pos] of open) {
    const d    = allData.find(x => x.symbol===sym);
    const last = d.candles[d.candles.length-1];
    const { dir, entry, size, slPct, tpPct } = pos;
    const pnl  = dir==='LONG'
      ? (last.close - entry)/entry * size
      : (entry - last.close)/entry * size;
    balance += pnl;
    trades.push({ sym, dir, won: pnl>0, pnl, type: pos.type });
  }

  const wins   = trades.filter(t=>t.won).length;
  const wr     = trades.length ? wins/trades.length*100 : 0;
  const pnl    = balance - CAPITAL;
  const ret    = pnl/CAPITAL*100;
  const gw     = trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
  const gl     = Math.abs(trades.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0));
  const pf     = gl ? gw/gl : gw>0 ? Infinity : 0;

  let peak=CAPITAL, dd=0, run=CAPITAL;
  for (const t of trades) {
    run += t.pnl;
    if (run>peak) peak=run;
    const d=(peak-run)/peak*100;
    if (d>dd) dd=d;
  }

  // Break down by signal type
  const byType = {};
  for (const t of trades) {
    if (!byType[t.type]) byType[t.type] = { trades:0, wins:0, pnl:0 };
    byType[t.type].trades++;
    byType[t.type].wins += t.won?1:0;
    byType[t.type].pnl  += t.pnl;
  }

  return { balance, pnl, ret, trades: trades.length, wins, wr, pf, dd, monthly, byType };
}

// ─── Display ──────────────────────────────────────────────────────────────────

const $  = n => (n>=0?'+$':'-$')+Math.abs(n).toFixed(0);
const pc = n => (n>=0?'+':'')+n.toFixed(1)+'%';
const bar = '═'.repeat(72);

function printCompare(mkt, po3) {
  console.log(`\n${bar}`);
  console.log(`  PO3 LIMIT ENTRY vs MARKET ENTRY  —  ${DAYS}d  $${CAPITAL.toLocaleString()}`);
  console.log(bar);

  const col = 22;
  const h   = s => String(s).padEnd(col);
  console.log(`\n  ${'Metric'.padEnd(26)}${h('Market (current)')}${h('PO3 50% limit')}`);
  console.log(`  ${'─'.repeat(68)}`);

  const rows = [
    ['Final balance',   `$${mkt.balance.toFixed(0)}`,       `$${po3.balance.toFixed(0)}`],
    ['Return',         pc(mkt.ret),                         pc(po3.ret)],
    ['P&L',            $(mkt.pnl),                          $(po3.pnl)],
    ['Total trades',   String(mkt.trades),                  String(po3.trades)],
    ['Win rate',       mkt.wr.toFixed(1)+'%',               po3.wr.toFixed(1)+'%'],
    ['Profit factor',  mkt.pf.toFixed(2),                   po3.pf.toFixed(2)],
    ['Max drawdown',   mkt.dd.toFixed(1)+'%',               po3.dd.toFixed(1)+'%'],
  ];
  for (const [label, a, b] of rows) {
    const valA = parseFloat(a), valB = parseFloat(b);
    const arrow = !isNaN(valA)&&!isNaN(valB) ? (valB>valA+0.1?'  ✅ better':(valB<valA-0.1?'  ❌ worse':'  →')) : '';
    console.log(`  ${label.padEnd(26)}${h(a)}${h(b)}${arrow}`);
  }

  // Signal type breakdown
  console.log(`\n  SIGNAL TYPE BREAKDOWN`);
  console.log(`  ${'Type'.padEnd(12)}${'MKT trades'.padEnd(14)}${'MKT WR'.padEnd(10)}${'MKT P&L'.padEnd(14)}${'PO3 trades'.padEnd(14)}${'PO3 WR'.padEnd(10)}${'PO3 P&L'}`);
  console.log(`  ${'─'.repeat(82)}`);
  const types = new Set([...Object.keys(mkt.byType), ...Object.keys(po3.byType)]);
  for (const t of types) {
    const m = mkt.byType[t] || { trades:0, wins:0, pnl:0 };
    const p = po3.byType[t] || { trades:0, wins:0, pnl:0 };
    const mwr = m.trades ? (m.wins/m.trades*100).toFixed(0)+'%' : '-';
    const pwr = p.trades ? (p.wins/p.trades*100).toFixed(0)+'%' : '-';
    console.log(`  ${t.padEnd(12)}${String(m.trades).padEnd(14)}${mwr.padEnd(10)}${$(m.pnl).padEnd(14)}${String(p.trades).padEnd(14)}${pwr.padEnd(10)}${$(p.pnl)}`);
  }

  // Monthly comparison
  console.log(`\n  MONTHLY P&L COMPARISON`);
  console.log(`  ${'Month'.padEnd(10)}${'Market'.padEnd(14)}${'PO3'.padEnd(14)}Diff`);
  console.log(`  ${'─'.repeat(52)}`);
  const allMonths = new Set([...Object.keys(mkt.monthly), ...Object.keys(po3.monthly)]);
  let mktTotal=0, po3Total=0;
  for (const ym of [...allMonths].sort()) {
    const mp = mkt.monthly[ym]?.pnl||0;
    const pp = po3.monthly[ym]?.pnl||0;
    mktTotal+=mp; po3Total+=pp;
    const diff = pp-mp;
    const icon = diff>0?'✅':(diff<0?'❌':'→');
    console.log(`  ${ym.padEnd(10)}${$(mp).padEnd(14)}${$(pp).padEnd(14)}${$(diff)} ${icon}`);
  }
  console.log(`  ${'─'.repeat(52)}`);
  console.log(`  ${'TOTAL'.padEnd(10)}${$(mktTotal).padEnd(14)}${$(po3Total).padEnd(14)}${$(po3Total-mktTotal)} ${po3Total>mktTotal?'✅':'❌'}`);

  console.log(`\n${bar}`);
  const verdict = po3.pnl > mkt.pnl;
  console.log(`  VERDICT: PO3 limit entry ${verdict ? '✅ BETTER' : '❌ WORSE'} than market entry`);
  if (verdict) {
    const pnlGain = po3.pnl - mkt.pnl;
    const wrGain  = po3.wr - mkt.wr;
    console.log(`  Extra P&L: ${$(pnlGain)}   WR shift: ${wrGain>=0?'+':''}${wrGain.toFixed(1)}%`);
    const fillRate = (po3.trades/mkt.trades*100).toFixed(0);
    console.log(`  Fill rate: ${po3.trades}/${mkt.trades} signals filled (${fillRate}%) — missed ${mkt.trades-po3.trades} entries`);
  } else {
    const pnlLoss  = mkt.pnl - po3.pnl;
    const missedT  = mkt.trades - po3.trades;
    console.log(`  Missed ${missedT} entries that would have profited at market`);
    console.log(`  Market entry outperforms by ${$(pnlLoss)}`);
  }
  console.log(bar+'\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\n${bar}`);
  console.log(`  v09 PO3 LIMIT ENTRY BACKTEST`);
  console.log(`  ${DAYS}d  |  $${CAPITAL.toLocaleString()} start  |  ${PAIRS.length} pairs  |  SL ${SL_PCT*100}%  |  TP ${TP_PCT*100}%`);
  console.log(`  PO3 level: ${PO3_LEVEL*100}% of signal candle  |  Fill window: ${LIMIT_BARS} bars (${LIMIT_BARS*4}hr)`);
  console.log(bar);

  console.log(`\n  Fetching ${PAIRS.length} pairs...\n`);
  const allData = [];
  for (const symbol of PAIRS) {
    try {
      const candles = await fetchKlines(symbol);
      if (candles.length < 100) { console.log(`  ${symbol.padEnd(14)} ⚠️  insufficient data`); continue; }
      const closes = candles.map(c=>c.close);
      const vols   = candles.map(c=>c.volume);
      const e21    = ema(closes,21);
      const e50    = ema(closes,50);
      const e200   = ema(closes,200);
      const rsi14  = rsiSeries(closes,14);
      const mc     = macdSeries(closes);
      const vsma   = sma(vols,20);
      allData.push({ symbol, candles, closes, e21, e50, e200, rsi14, mc, vsma });
      process.stdout.write(`  ${symbol.padEnd(14)} ${candles.length} bars ✓\n`);
    } catch(e) {
      console.log(`  ${symbol.padEnd(14)} ❌ ${e.message}`);
    }
    await delay(60);
  }

  console.log(`\n  Running market entry simulation...`);
  const mkt = runSim(allData, 'market');

  console.log(`  Running PO3 limit entry simulation...`);
  const po3 = runSim(allData, 'po3');

  printCompare(mkt, po3);
})().catch(console.error);
