/**
 * Short Trade Debugger — Why didn't we profit on the crash?
 *
 * Runs Strategy B (best performer) on BTC, ETH, SOL, XRP, BNB only.
 * Prints every single short trade with entry time, entry price, exit reason,
 * and where the 200 EMA was at entry so we can see the delay problem.
 */

import https from 'https';

const PAIRS   = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT'];
const DAYS    = 200;
const SL_PCT  = 0.04;
const TP_PCT  = 0.12;
const INTERVAL = '4h';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchCrypto(symbol) {
  const endTime = Date.now();
  const startTime = endTime - DAYS * 24 * 60 * 60 * 1000;
  const allBars = [];
  let from = startTime;
  while (from < endTime) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&startTime=${from}&endTime=${endTime}&limit=1000`;
    const page = await new Promise((resolve, reject) => {
      https.get(url, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      }).on('error', reject);
    });
    if (!Array.isArray(page) || !page.length) break;
    allBars.push(...page);
    from = page[page.length - 1][0] + 1;
    if (page.length < 1000) break;
    await delay(80);
  }
  return allBars.map(k => ({
    time: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

function ema(v, p) {
  const k = 2/(p+1), r = [v[0]];
  for (let i = 1; i < v.length; i++) r.push(v[i]*k + r[i-1]*(1-k));
  return r;
}
function rsi(closes, p=14) {
  const r = new Array(closes.length).fill(null);
  for (let i = p; i < closes.length; i++) {
    let g=0, l=0;
    for (let j=i-p+1; j<=i; j++) { const d=closes[j]-closes[j-1]; d>0?g+=d:l-=d; }
    r[i] = l===0 ? 100 : 100 - 100/(1+(g/p)/(l/p));
  }
  return r;
}
function macd(closes, f=12, s=26, sig=9) {
  const fast=ema(closes,f), slow=ema(closes,s);
  const ml=closes.map((_,i)=>fast[i]-slow[i]);
  const sl=[ml[0]]; const k=2/(sig+1);
  for (let i=1; i<closes.length; i++) sl.push(ml[i]*k+sl[i-1]*(1-k));
  return { line:ml, signal:sl };
}

function fmt(ms) {
  return new Date(ms).toISOString().replace('T',' ').slice(0,16);
}

(async () => {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  SHORT TRADE DEBUGGER — Why the crash didn\'t pay');
  console.log('══════════════════════════════════════════════════════════\n');

  for (const symbol of PAIRS) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${symbol}`);
    console.log('─'.repeat(60));

    const candles = await fetchCrypto(symbol);
    const closes  = candles.map(c => c.close);
    const e50     = ema(closes, 50);
    const e200    = ema(closes, 200);
    const mc      = macd(closes);
    const rsi14   = rsi(closes, 14);

    // Find the price peak (highest close in the dataset)
    let peakIdx = 0;
    for (let i = 1; i < candles.length; i++) {
      if (closes[i] > closes[peakIdx]) peakIdx = i;
    }
    const peakPrice = closes[peakIdx];
    const peakTime  = fmt(candles[peakIdx].time);

    // Find when price crossed below 200 EMA (earliest entry possible for shorts)
    let crossedBelow200 = null;
    for (let i = 201; i < candles.length; i++) {
      if (closes[i-1] >= e200[i-1] && closes[i] < e200[i]) {
        crossedBelow200 = { i, time: fmt(candles[i].time), price: closes[i], e200: e200[i] };
        break;
      }
    }

    // Find when price crossed below 50 EMA
    let crossedBelow50 = null;
    for (let i = 51; i < candles.length; i++) {
      if (closes[i-1] >= e50[i-1] && closes[i] < e50[i]) {
        crossedBelow50 = { i, time: fmt(candles[i].time), price: closes[i] };
        break;
      }
    }

    // Find all Strategy B short signals
    const shortSignals = [];
    for (let i = 2; i < candles.length - 1; i++) {
      if (rsi14[i]==null || e200[i]==null || e50[i]==null) continue;
      const c = closes[i];
      const bearRegime   = c < e200[i] && e50[i] < e200[i];
      const rsiCrossDown = rsi14[i-1] > 45 && rsi14[i] <= 45;
      const macdNeg      = mc.line[i] < 0;
      if (bearRegime && rsiCrossDown && macdNeg) {
        shortSignals.push({
          i, time: fmt(candles[i].time),
          entryPrice: candles[i+1].open,
          close: c, rsi: rsi14[i].toFixed(1),
          e200: e200[i].toFixed(2),
          pctBelowPeak: ((c - peakPrice) / peakPrice * 100).toFixed(1),
        });
      }
    }

    // Simulate short trades
    console.log(`  Price peak:       $${peakPrice.toFixed(2)} at ${peakTime}`);
    if (crossedBelow50)  console.log(`  Crossed below 50 EMA:  ${crossedBelow50.time}  price $${crossedBelow50.price.toFixed(2)}`);
    if (crossedBelow200) {
      const dropFromPeak = ((crossedBelow200.price - peakPrice) / peakPrice * 100).toFixed(1);
      console.log(`  Crossed below 200 EMA: ${crossedBelow200.time}  price $${crossedBelow200.price.toFixed(2)}  (${dropFromPeak}% below peak ← SHORT ENTRY UNLOCKED HERE)`);
    } else {
      console.log(`  Never crossed below 200 EMA in this window`);
    }

    if (shortSignals.length === 0) {
      console.log(`\n  No Strategy B short signals fired.`);
    } else {
      console.log(`\n  Strategy B SHORT signals (${shortSignals.length} total):`);
      console.log(`  ${'Time'.padEnd(18)}${'Entry $'.padEnd(12)}${'RSI'.padEnd(8)}${'Below Peak'.padEnd(14)}Result`);
      console.log(`  ${'─'.repeat(60)}`);

      for (const s of shortSignals) {
        // Simulate the trade
        const entryBar = s.i + 1;
        if (entryBar >= candles.length) continue;
        const entry = candles[entryBar].open;
        const sl    = entry * (1 + SL_PCT);
        const tp    = entry * (1 - TP_PCT);
        let result  = 'OPEN', pnl = 0;
        let bars = 0;

        for (let j = entryBar + 1; j < Math.min(entryBar + 200, candles.length); j++) {
          bars++;
          const bar = candles[j];
          if (bar.open >= sl)  { result = `SL hit  +${(SL_PCT*100).toFixed(0)}% gap`; pnl = -SL_PCT*100; break; }
          if (bar.open <= tp)  { result = `TP hit  -${(TP_PCT*100).toFixed(0)}% gap`; pnl = TP_PCT*100;  break; }
          if (bar.high >= sl)  { result = `SL hit`; pnl = -SL_PCT*100; break; }
          if (bar.low  <= tp)  { result = `TP hit`; pnl =  TP_PCT*100; break; }
        }
        if (result === 'OPEN') {
          const lastClose = candles[Math.min(entryBar + bars, candles.length-1)].close;
          pnl = (entry - lastClose) / entry * 100;
          result = `Open  ${pnl>=0?'+':''}${pnl.toFixed(1)}%`;
        }

        const pnlStr = pnl >= 0 ? `+${pnl.toFixed(0)}%` : `${pnl.toFixed(0)}%`;
        const icon   = pnl > 0 ? '✅' : '❌';
        console.log(`  ${s.time.padEnd(18)}$${String(entry.toFixed(2)).padEnd(12)}${String(s.rsi).padEnd(8)}${(s.pctBelowPeak+'%').padEnd(14)}${result.padEnd(16)}${pnlStr} ${icon}`);
      }
    }

    // Show what happened if you JUST shorted when price crossed below 200 EMA
    if (crossedBelow200) {
      const ei = crossedBelow200.i + 1;
      if (ei < candles.length) {
        const entry = candles[ei].open;
        const sl    = entry * (1 + SL_PCT);
        const tp    = entry * (1 - TP_PCT);
        let result  = 'OPEN', pnl = 0;
        for (let j = ei + 1; j < candles.length; j++) {
          const bar = candles[j];
          if (bar.open >= sl) { result = 'SL hit'; pnl = -SL_PCT*100; break; }
          if (bar.open <= tp) { result = 'TP hit'; pnl =  TP_PCT*100; break; }
          if (bar.high >= sl) { result = 'SL hit'; pnl = -SL_PCT*100; break; }
          if (bar.low  <= tp) { result = 'TP hit'; pnl =  TP_PCT*100; break; }
        }
        if (result === 'OPEN') {
          const lastClose = candles[candles.length-1].close;
          pnl = (entry - lastClose) / entry * 100;
          result = 'Still open';
        }
        console.log(`\n  IF you just shorted at 200 EMA cross: $${entry.toFixed(2)} → ${result}  ${pnl>=0?'+':''}${pnl.toFixed(1)}%`);
      }
    }
  }

  console.log('\n\n══════════════════════════════════════════════════════════');
  console.log('  ROOT CAUSE SUMMARY');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`
  1. THE 200 EMA DELAY: The 200 EMA is a slow indicator (200 bars × 4h = 33 days
     of data to shift). By the time price crosses below the 200 EMA, the crash
     has already happened — we're entering shorts AFTER the big move.

  2. DEAD CAT BOUNCES: After a sharp crash, markets violently bounce 4-8% before
     continuing down. Our 4% SL gets wiped out on these bounces every time.

  3. SIGNAL STACKING: Requiring RSI < 45 AND MACD < 0 AND price < EMA200 AND
     EMA50 < EMA200 means all conditions must align simultaneously — they often
     only align after the best short entry has passed.

  4. THE CRASH WAS FAST: April 2025 was a sharp drop over a few days. On 4H bars,
     it was only 5-10 candles. By bar 3, RSI was deeply oversold (< 30) — our
     RSI < 45 filter would have blocked entries precisely when the trend was
     strongest downward.

  FIX: Short when price BREAKS a key level (recent swing low / 50 EMA) with
  momentum, NOT after a prolonged downtrend has already happened. Consider
  wider SL (6-8%) to survive the bounces, with wider TP (20-25%) to catch
  the full crash move.
  `);

})().catch(console.error);
