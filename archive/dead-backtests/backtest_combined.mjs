/**
 * Combined Backtest — All 50 Crypto + All 99 Stocks
 *
 * 3 sims: Cap 10 | Cap 15 | No Cap  (all share same $10,000 starting balance)
 * Crypto + Stocks: ST Bullish Flip (L) · BB Recovery (L) · ST+MACD+RSI Short (S)
 * SL: 5%  TP: 15%  Min confidence: 65%
 */

import https from 'https';

const CRYPTO = [
  'BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT',
  'DOGEUSDT','LINKUSDT','SUIUSDT','LTCUSDT','AVAXUSDT','HBARUSDT',
  'ADAUSDT','TRXUSDT','TONUSDT','SHIBUSDT','DOTUSDT','BCHUSDT',
  'UNIUSDT','NEARUSDT','APTUSDT','ICPUSDT','ETCUSDT','POLUSDT',
  'VETUSDT','ATOMUSDT','OPUSDT','ARBUSDT','FILUSDT','ALGOUSDT',
  'INJUSDT','BONKUSDT','GRTUSDT','PEPEUSDT','WLDUSDT','AAVEUSDT',
  'TAOUSDT','RENDERUSDT','FETUSDT','STXUSDT','CRVUSDT','THETAUSDT',
  'JASMYUSDT','ONDOUSDT','RUNEUSDT','SANDUSDT','MANAUSDT','ENAUSDT',
  'LDOUSDT','SEIUSDT','TIAUSDT',
];

const STOCKS = [
  'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','AVGO','JPM','LLY',
  'V','UNH','XOM','MA','ORCL','COST','HD','PG','NFLX','JNJ',
  'BAC','CRM','WMT','ABBV','CSCO','AMD','CVX','NOW','IBM','GE',
  'TXN','AMGN','ISRG','PM','RTX','NEE','PFE','MU','INTU','QCOM',
  'AMAT','BKNG','TMO','DHR','GS','AXP','BLK','SPGI','HON','T',
  'DE','GILD','LOW','CAT','VRTX','MDT','LIN','BA','UPS','SCHW',
  'TMUS','SO','DUK','PLD','CB','ETN','C','MS','TJX','CI',
  'PANW','MCD','ADI','PH','ICE','LRCX','KLAC','REGN','SYK','ZTS',
  'CME','PYPL','SBUX','ELV','AON','MDLZ','NOC','WFC','GD','HUM',
  'CL','ABNB','UBER','SNOW','CRWD','MSTR','PLTR','ARM','COIN',
];

const START_BAL  = 10000;
const TRADE_SIZE = 50;
const SL_PCT     = 0.05;
const TP_PCT     = 0.15;
const MIN_CONF   = 65;
const DELAY_MS   = 150;
const DAYS       = 200;             // lookback window
const CAPS       = [25, 30, 50];    // middle ground between cap 15 and no cap

// ─── Fetchers ─────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchOnePage(symbol, startTime, endTime) {
  return new Promise((resolve, reject) => {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&startTime=${startTime}&endTime=${endTime}&limit=1000`;
    https.get(url, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const raw = JSON.parse(d);
          if (!Array.isArray(raw)) return reject(new Error(`Bad response for ${symbol}`));
          resolve(raw);
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function fetchCrypto(symbol) {
  const endTime   = Date.now();
  const startTime = endTime - DAYS * 24 * 60 * 60 * 1000;
  const allBars   = [];
  let from = startTime;
  while (from < endTime) {
    const page = await fetchOnePage(symbol, from, endTime);
    if (!page.length) break;
    allBars.push(...page);
    from = page[page.length - 1][0] + 3_600_000;  // next hour
    if (page.length < 1000) break;
    await delay(80);
  }
  return allBars.map(k => ({
    time: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
    low:  parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

function fetchStock(symbol) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'query1.finance.yahoo.com',
      path: `/v8/finance/chart/${symbol}?interval=1h&range=${DAYS}d&includePrePost=false`,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    };
    https.get(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json   = JSON.parse(d);
          const result = json?.chart?.result?.[0];
          if (!result) return reject(new Error(`No data for ${symbol}`));
          const ts = result.timestamp || [];
          const q  = result.indicators.quote[0];
          resolve(ts.map((t, i) => ({
            time: t * 1000, open: q.open[i] ?? null, high: q.high[i] ?? null,
            low:  q.low[i] ?? null, close: q.close[i] ?? null, volume: q.volume[i] ?? 0,
          })).filter(c => c.open && c.high && c.low && c.close));
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcEMASeries(v, p) {
  const k = 2/(p+1), r = [v[0]];
  for (let i = 1; i < v.length; i++) r.push(v[i]*k + r[i-1]*(1-k));
  return r;
}

function calcRSISeries(closes, period = 14) {
  const r = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let g = 0, l = 0;
    for (let j = i-period+1; j <= i; j++) { const d = closes[j]-closes[j-1]; d>0?g+=d:l-=d; }
    const ag = g/period, al = l/period;
    r[i] = al === 0 ? 100 : 100 - 100/(1 + ag/al);
  }
  return r;
}

function calcATR(candles, period) {
  const trs = candles.map((c,i) => i===0 ? c.high-c.low :
    Math.max(c.high-c.low, Math.abs(c.high-candles[i-1].close), Math.abs(c.low-candles[i-1].close)));
  const atr = new Array(candles.length).fill(null);
  atr[period-1] = trs.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for (let i = period; i < candles.length; i++) atr[i] = (atr[i-1]*(period-1)+trs[i])/period;
  return atr;
}

function calcST(candles, atrP=10, mult=3) {
  const atr = calcATR(candles, atrP);
  const r   = new Array(candles.length).fill(null);
  let pUp=null, pLo=null, pDir=null;
  for (let i = atrP; i < candles.length; i++) {
    const hl2 = (candles[i].high+candles[i].low)/2;
    let up = hl2+mult*atr[i], lo = hl2-mult*atr[i];
    if (pLo!==null) lo = candles[i].close>pLo ? Math.max(lo,pLo) : lo;
    if (pUp!==null) up = candles[i].close<pUp ? Math.min(up,pUp) : up;
    let dir = pDir===null ? (candles[i].close>up?1:-1) :
              pDir===-1   ? (candles[i].close>pUp?1:-1) :
                            (candles[i].close<pLo?-1:1);
    r[i] = { upper:up, lower:lo, direction:dir, line:dir===1?lo:up };
    pUp=up; pLo=lo; pDir=dir;
  }
  return r;
}

function calcMACD(closes, fast=12, slow=26, signal=9) {
  const f = calcEMASeries(closes,fast), s = calcEMASeries(closes,slow);
  const ml = closes.map((_,i) => f[i]-s[i]);
  const sl = [ml[0]]; const k = 2/(signal+1);
  for (let i = 1; i < closes.length; i++) sl.push(ml[i]*k + sl[i-1]*(1-k));
  return { macdLine:ml, sigLine:sl };
}

function calcBB(values, length, mult) {
  return values.map((_,i) => {
    if (i < length-1) return null;
    const slice = values.slice(i-length+1, i+1);
    const mean  = slice.reduce((s,v)=>s+v,0)/length;
    const std   = Math.sqrt(slice.reduce((s,v)=>s+(v-mean)**2,0)/length);
    return { mid:mean, upper:mean+mult*std, lower:mean-mult*std };
  });
}

function calcVWAPCrypto(candles) {
  const r = new Array(candles.length).fill(null);
  let cumTPV=0, cumVol=0, day=null;
  for (let i = 0; i < candles.length; i++) {
    const d = new Date(candles[i].time).toISOString().slice(0,10);
    if (d!==day) { cumTPV=0; cumVol=0; day=d; }
    const tp = (candles[i].high+candles[i].low+candles[i].close)/3;
    cumTPV += tp*candles[i].volume; cumVol += candles[i].volume;
    r[i] = cumVol===0 ? null : cumTPV/cumVol;
  }
  return r;
}

function nthSunday(year,month,n) {
  const d = new Date(Date.UTC(year,month,1));
  d.setUTCDate(1+((7-d.getUTCDay())%7)+(n-1)*7); return d;
}
function etOffset(ms) {
  const d = new Date(ms), yr = d.getUTCFullYear();
  return d>=nthSunday(yr,2,2)&&d<nthSunday(yr,10,1) ? -4 : -5;
}
function marketOpenMs(barMs) {
  const et = etOffset(barMs), d = new Date(barMs);
  const etDate = new Date(d.getTime()+et*3600000);
  return Date.UTC(etDate.getUTCFullYear(),etDate.getUTCMonth(),etDate.getUTCDate(),9-et,30,0,0);
}
function calcVWAPStock(candles) {
  const r = new Array(candles.length).fill(null);
  let cumTPV=0, cumVol=0, openMs=null;
  for (let i = 0; i < candles.length; i++) {
    const mo = marketOpenMs(candles[i].time);
    if (mo!==openMs) { cumTPV=0; cumVol=0; openMs=mo; }
    const tp = (candles[i].high+candles[i].low+candles[i].close)/3;
    cumTPV += tp*candles[i].volume; cumVol += candles[i].volume;
    r[i] = cumVol===0 ? null : cumTPV/cumVol;
  }
  return r;
}

// ─── Confidence ───────────────────────────────────────────────────────────────

function calcConf(price, ema, vwap, rsi, st, macd, sig, bbSigs, stSigs, direction) {
  const r = rsi??50; let L=0, S=0;
  if (st)   { st.direction===1 ? L+=20 : S+=20; }
  if (ema)  { price>ema  ? L+=10 : S+=10; }
  if (vwap) { price>vwap ? L+=5  : S+=5;  }
  if (macd!=null&&sig!=null) { macd>0?L+=12:S+=12; macd>sig?L+=13:S+=13; }
  if (r<30) L+=25; else if (r<40) L+=15; else if (r<50) L+=5;
  if (r>70) S+=25; else if (r>60) S+=15; else if (r>50) S+=5;
  if (stSigs.includes('LONG'))  L+=15;
  if (stSigs.includes('SHORT')) S+=15;
  if (bbSigs.includes('LONG'))  L+=10;
  if (bbSigs.includes('SHORT')) S+=10;
  return direction==='LONG' ? Math.min(L,100) : Math.min(S,100);
}

// ─── Signal detection ─────────────────────────────────────────────────────────

function getSignal(i, candles, ema20s, rsi14s, vwaps, sts, macdLine, sigLine, bb1s, isCrypto) {
  const st=sts[i], stP=sts[i-1];
  if (!st||!stP||rsi14s[i]==null||ema20s[i]==null) return null;
  const c=candles[i].close, cP=candles[i-1].close;
  const bb1=bb1s[i], bb1P=bb1s[i-1];
  const macd=macdLine[i], sig=sigLine[i], rsi=rsi14s[i];
  const bbSigs=[], stSigs=[];

  if (stP.direction===-1 && st.direction===1)           stSigs.push('LONG');
  if (isCrypto && st.direction===-1 && macd<0 && rsi>70) stSigs.push('SHORT');  // crypto only
  if (bb1&&bb1P&&cP<bb1P.lower&&c>bb1.lower)           bbSigs.push('LONG');

  let direction=null;
  if      (stSigs.includes('LONG'))  direction='LONG';
  else if (stSigs.includes('SHORT')) direction='SHORT';
  else if (bbSigs.includes('LONG'))  direction='LONG';
  if (!direction) return null;

  const score = calcConf(c,ema20s[i],vwaps[i],rsi,st,macd,sig,bbSigs,stSigs,direction);
  if (score < MIN_CONF) return null;

  let source='VWAP+EMA+RSI';
  if (stSigs.includes('LONG'))  source='ST Bullish Flip';
  else if (stSigs.includes('SHORT')) source='ST+MACD+RSI Short';
  else if (bbSigs.includes('LONG'))  source='BB Recovery';
  return { direction, score, source };
}

// ─── Simulation ───────────────────────────────────────────────────────────────

function createSim() {
  return { balance:START_BAL, peakBalance:START_BAL, maxDrawdown:0,
           minBalance:START_BAL, openPositions:{}, trades:[], equitySnaps:[] };
}

function enter(sim, symbol, direction, entryPrice, signal, time, cap) {
  if (sim.openPositions[symbol]) return;
  if (Object.keys(sim.openPositions).length >= cap) return;
  if (sim.balance < TRADE_SIZE) return;
  const isLong = direction==='LONG';
  const sl = isLong ? entryPrice*(1-SL_PCT) : entryPrice*(1+SL_PCT);
  const tp = isLong ? entryPrice*(1+TP_PCT) : entryPrice*(1-TP_PCT);
  sim.balance -= TRADE_SIZE;
  sim.openPositions[symbol] = {symbol,direction,entryPrice,size:TRADE_SIZE,sl,tp,signal,time};
}

function update(sim, symbol, bar) {
  const pos = sim.openPositions[symbol]; if (!pos) return;
  const isLong = pos.direction==='LONG';
  let exitPrice=null, exitReason=null;
  if (isLong) {
    if      (bar.open<=pos.sl){exitPrice=bar.open;exitReason='STOP_LOSS';}
    else if (bar.open>=pos.tp){exitPrice=bar.open;exitReason='TAKE_PROFIT';}
    else if (bar.low <=pos.sl){exitPrice=pos.sl;  exitReason='STOP_LOSS';}
    else if (bar.high>=pos.tp){exitPrice=pos.tp;  exitReason='TAKE_PROFIT';}
  } else {
    if      (bar.open>=pos.sl){exitPrice=bar.open;exitReason='STOP_LOSS';}
    else if (bar.open<=pos.tp){exitPrice=bar.open;exitReason='TAKE_PROFIT';}
    else if (bar.high>=pos.sl){exitPrice=pos.sl;  exitReason='STOP_LOSS';}
    else if (bar.low <=pos.tp){exitPrice=pos.tp;  exitReason='TAKE_PROFIT';}
  }
  if (exitPrice !== null) {
    const pnlPct = isLong
      ? (exitPrice-pos.entryPrice)/pos.entryPrice*100
      : (pos.entryPrice-exitPrice)/pos.entryPrice*100;
    const pnlUSD = pnlPct/100 * pos.size;
    sim.balance += pos.size + pnlUSD;
    if (sim.balance > sim.peakBalance) sim.peakBalance = sim.balance;
    if (sim.balance < sim.minBalance)  sim.minBalance  = sim.balance;
    const dd = (sim.peakBalance-sim.balance)/sim.peakBalance*100;
    if (dd > sim.maxDrawdown) sim.maxDrawdown = dd;
    sim.trades.push({...pos, exitPrice, exitReason, pnlPct, pnlUSD});
    delete sim.openPositions[symbol];
  }
}

function closeAll(sim, allData) {
  for (const symbol of Object.keys(sim.openPositions)) {
    const pos  = sim.openPositions[symbol];
    const d    = allData[symbol]; if (!d) continue;
    const last = d.candles[d.candles.length-1];
    const isLong = pos.direction==='LONG';
    const pnlPct = isLong
      ? (last.close-pos.entryPrice)/pos.entryPrice*100
      : (pos.entryPrice-last.close)/pos.entryPrice*100;
    const pnlUSD = pnlPct/100 * pos.size;
    sim.balance += pos.size + pnlUSD;
    sim.trades.push({...pos, exitPrice:last.close, exitReason:'END_OF_DATA', pnlPct, pnlUSD});
    delete sim.openPositions[symbol];
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n'+'═'.repeat(90));
  console.log(`  COMBINED BACKTEST — 50 Crypto + 99 Stocks  |  $50/trade  |  ${DAYS} days  |  Shorts: Crypto only`);
  console.log(`  Starting balance: $${START_BAL.toLocaleString()}  |  SL ${SL_PCT*100}%  |  TP ${TP_PCT*100}%  |  Min confidence: ${MIN_CONF}%`);
  console.log(`  Running 3 sims: Cap ${CAPS[0]}  |  Cap ${CAPS[1]}  |  Cap ${CAPS[2]}`);
  console.log('═'.repeat(90)+'\n');

  const allData = {};

  // ── Fetch crypto ───────────────────────────────────────────────────────────
  console.log('── Fetching Crypto (Binance) ─────────────────────────────────────────────────\n');
  for (const symbol of CRYPTO) {
    process.stdout.write(`  ${symbol.padEnd(14)}...`);
    try {
      const candles = await fetchCrypto(symbol);
      const closes  = candles.map(c=>c.close), opens = candles.map(c=>c.open);
      const macd    = calcMACD(closes);
      allData[symbol] = {
        candles, isCrypto:true,
        ema20s: calcEMASeries(closes,20), rsi14s: calcRSISeries(closes),
        vwaps:  calcVWAPCrypto(candles),  sts:    calcST(candles),
        macdLine:macd.macdLine, sigLine:macd.sigLine,
        bb1s: calcBB(opens,4,4),
      };
      process.stdout.write(` ${candles.length} bars ✓\n`);
    } catch(e) { console.log(` ❌ ${e.message}`); }
  }

  // ── Fetch stocks ───────────────────────────────────────────────────────────
  console.log('\n── Fetching Stocks (Yahoo Finance) ───────────────────────────────────────────\n');
  let stockOk=0, stockFail=0;
  for (const symbol of STOCKS) {
    process.stdout.write(`  ${symbol.padEnd(6)}...`);
    try {
      const candles = await fetchStock(symbol);
      if (candles.length < 30) { console.log(` only ${candles.length} bars — skip`); stockFail++; continue; }
      const closes  = candles.map(c=>c.close), opens = candles.map(c=>c.open);
      const macd    = calcMACD(closes);
      allData[symbol] = {
        candles, isCrypto:false,
        ema20s: calcEMASeries(closes,20), rsi14s: calcRSISeries(closes),
        vwaps:  calcVWAPStock(candles),   sts:    calcST(candles),
        macdLine:macd.macdLine, sigLine:macd.sigLine,
        bb1s: calcBB(opens,4,4),
      };
      process.stdout.write(` ${candles.length} bars ✓\n`);
      stockOk++;
    } catch(e) { console.log(` ❌ ${e.message}`); stockFail++; }
    await delay(DELAY_MS);
  }

  const totalAssets = Object.keys(allData).length;
  console.log(`\n  Crypto: ${CRYPTO.filter(s=>allData[s]).length}/${CRYPTO.length}  |  Stocks: ${stockOk}/${STOCKS.length}  |  Total: ${totalAssets}`);

  // ── Timeline ───────────────────────────────────────────────────────────────
  const timeSet = new Set();
  for (const d of Object.values(allData)) d.candles.forEach(c => timeSet.add(c.time));
  const timeline = [...timeSet].sort((a,b) => a-b);
  for (const [sym,d] of Object.entries(allData)) {
    d.timeIndex = {};
    d.candles.forEach((c,i) => { d.timeIndex[c.time] = i; });
  }

  // ── Run simulations ────────────────────────────────────────────────────────
  console.log(`\n── Running ${CAPS.length} simulations across ${timeline.length.toLocaleString()} hourly bars (~${DAYS} days) ──────────\n`);

  const sims = CAPS.map(cap => ({ ...createSim(), cap }));

  for (const t of timeline) {
    const dateStr = new Date(t).toISOString().slice(0,7);
    for (const sim of sims) {
      if (!sim._lastMonth || sim._lastMonth !== dateStr) {
        sim._lastMonth = dateStr;
        sim.equitySnaps.push({ date:dateStr, balance:sim.balance, open:Object.keys(sim.openPositions).length, trades:sim.trades.length });
      }
    }

    for (const [symbol, d] of Object.entries(allData)) {
      const i = d.timeIndex[t];
      if (i==null || i<31) continue;
      const sig = getSignal(i-1, d.candles, d.ema20s, d.rsi14s, d.vwaps, d.sts, d.macdLine, d.sigLine, d.bb1s, d.isCrypto);
      for (const sim of sims) {
        update(sim, symbol, d.candles[i]);
        if (sig && i+1 < d.candles.length) enter(sim, symbol, sig.direction, d.candles[i].open, sig.source, t, sim.cap);
      }
    }
  }
  for (const sim of sims) closeAll(sim, allData);

  // ── Helper stats ───────────────────────────────────────────────────────────
  function simStats(sim) {
    const trades  = sim.trades;
    const wins    = trades.filter(t=>t.pnlUSD>0);
    const losses  = trades.filter(t=>t.pnlUSD<=0);
    const pnl     = trades.reduce((s,t)=>s+t.pnlUSD,0);
    const gWin    = wins.reduce((s,t)=>s+t.pnlUSD,0);
    const gLoss   = Math.abs(losses.reduce((s,t)=>s+t.pnlUSD,0));
    const wr      = trades.length ? (wins.length/trades.length*100).toFixed(1) : '0';
    const pf      = gLoss>0 ? (gWin/gLoss).toFixed(2) : (gWin>0?'∞':'0');
    const ret     = ((sim.balance-START_BAL)/START_BAL*100).toFixed(2);
    const annRet  = (parseFloat(ret)/DAYS*365).toFixed(1);

    const cryptoT = trades.filter(t=>allData[t.symbol]?.isCrypto);
    const stockT  = trades.filter(t=>!allData[t.symbol]?.isCrypto);
    const sigMap  = {};
    for (const t of trades) {
      if (!sigMap[t.signal]) sigMap[t.signal]={count:0,wins:0,pnl:0};
      sigMap[t.signal].count++;
      if (t.pnlUSD>0) sigMap[t.signal].wins++;
      sigMap[t.signal].pnl += t.pnlUSD;
    }
    const bySymbol = {};
    for (const t of trades) {
      if (!bySymbol[t.symbol]) bySymbol[t.symbol]={trades:0,wins:0,pnl:0,type:allData[t.symbol]?.isCrypto?'Crypto':'Stock'};
      bySymbol[t.symbol].trades++;
      if (t.pnlUSD>0) bySymbol[t.symbol].wins++;
      bySymbol[t.symbol].pnl += t.pnlUSD;
    }
    return { trades, wins, losses, pnl, wr, pf, ret, annRet, cryptoT, stockT, sigMap,
             sorted: Object.entries(bySymbol).sort((a,b)=>b[1].pnl-a[1].pnl) };
  }

  // ── COMPARISON SUMMARY ────────────────────────────────────────────────────
  console.log('\n'+'═'.repeat(90));
  console.log('  COMPARISON SUMMARY  (Shorts enabled on ALL assets)');
  console.log('═'.repeat(90));
  console.log(`\n  ${'Metric'.padEnd(28)}${'Cap 10'.padEnd(22)}${'Cap 15'.padEnd(22)}No Cap`);
  console.log('  '+'─'.repeat(80));

  const allStats = sims.map(sim => simStats(sim));
  const labels = ['Cap 10','Cap 15','No Cap'];

  const rows = [
    ['Final balance',    s => `$${s.sim.balance.toFixed(2)}`],
    ['Total P&L',        s => `${s.st.pnl>=0?'+':''}$${s.st.pnl.toFixed(2)}`],
    [`Return (${DAYS}d)`, s => `${s.st.ret>=0?'+':''}${s.st.ret}%`],
    ['Ann. return',      s => `${s.st.annRet>=0?'+':''}${s.st.annRet}%`],
    ['Total trades',     s => s.st.trades.length],
    ['Win rate',         s => `${s.st.wr}%`],
    ['Profit factor',    s => s.st.pf],
    ['Max drawdown',     s => `${s.sim.maxDrawdown.toFixed(2)}%`],
    ['Lowest balance',   s => `$${s.sim.minBalance.toFixed(2)}`],
    ['Max open at once', s => `${s.sim.cap}`],
  ];

  const pairs = sims.map((sim,i)=>({ sim, st:allStats[i] }));
  for (const [label, fn] of rows) {
    const cols = pairs.map(p => String(fn(p)).padEnd(22));
    console.log(`  ${label.padEnd(28)}${cols.join('')}`);
  }

  // ── PER-SIM DETAIL ────────────────────────────────────────────────────────
  for (let ci = 0; ci < sims.length; ci++) {
    const sim = sims[ci];
    const st  = allStats[ci];
    const capLabel = sim.cap === 999 ? 'No Cap' : `Cap ${sim.cap}`;

    console.log('\n\n'+'═'.repeat(90));
    console.log(`  DETAIL — ${capLabel}  |  Final: $${sim.balance.toFixed(2)}  |  P&L: ${st.pnl>=0?'+':''}$${st.pnl.toFixed(2)}  |  DD: ${sim.maxDrawdown.toFixed(1)}%`);
    console.log('═'.repeat(90));

    // Asset split
    const cPnl = st.cryptoT.reduce((s,t)=>s+t.pnlUSD,0);
    const sPnl = st.stockT.reduce((s,t)=>s+t.pnlUSD,0);
    const cWr  = st.cryptoT.length?(st.cryptoT.filter(t=>t.pnlUSD>0).length/st.cryptoT.length*100).toFixed(1):'0';
    const sWr  = st.stockT.length?(st.stockT.filter(t=>t.pnlUSD>0).length/st.stockT.length*100).toFixed(1):'0';
    console.log(`\n  By type:  Crypto ${st.cryptoT.length}t / ${cWr}% wr / ${cPnl>=0?'+':''}$${cPnl.toFixed(2)}   |   Stocks ${st.stockT.length}t / ${sWr}% wr / ${sPnl>=0?'+':''}$${sPnl.toFixed(2)}`);

    // Signal breakdown
    console.log(`\n  ${'Signal'.padEnd(28)}${'Trades'.padEnd(8)}${'Win%'.padEnd(8)}P&L`);
    console.log('  '+'─'.repeat(55));
    for (const [sig,d] of Object.entries(st.sigMap).sort((a,b)=>b[1].pnl-a[1].pnl)) {
      const swr = d.count?(d.wins/d.count*100).toFixed(1):'0';
      console.log(`  ${sig.padEnd(28)}${String(d.count).padEnd(8)}${`${swr}%`.padEnd(8)}${d.pnl>=0?'+':''}$${d.pnl.toFixed(2)}  ${d.pnl>0?'✅':'❌'}`);
    }

    // Equity curve
    console.log(`\n  ${'Month'.padEnd(10)}${'Balance'.padEnd(14)}${'Open'.padEnd(8)}${'Trades'.padEnd(10)}vs Start`);
    console.log('  '+'─'.repeat(55));
    for (const s of sim.equitySnaps) {
      const diff = s.balance - START_BAL;
      console.log(`  ${s.date.padEnd(10)}$${s.balance.toFixed(2).padEnd(13)}${String(s.open).padEnd(8)}${String(s.trades).padEnd(10)}${diff>=0?'+':''}$${diff.toFixed(2)}  ${s.balance>=sim.equitySnaps[0].balance?'📈':'📉'}`);
    }
    console.log('  '+'─'.repeat(55));
    console.log(`  ${'FINAL'.padEnd(10)}$${sim.balance.toFixed(2).padEnd(13)}${'—'.padEnd(8)}${String(st.trades.length).padEnd(10)}${st.pnl>=0?'+':''}$${st.pnl.toFixed(2)}`);

    // Top 10 / Bottom 10
    console.log(`\n  TOP 10:`);
    st.sorted.slice(0,10).forEach(([sym,d],i)=>{
      const wr2=d.trades?(d.wins/d.trades*100).toFixed(0):'0';
      console.log(`    #${String(i+1).padEnd(3)}${sym.padEnd(12)}[${d.type}]  ${String(d.trades).padEnd(4)}t  ${String(wr2).padEnd(5)}% win  ${d.pnl>=0?'+':''}$${d.pnl.toFixed(2)}`);
    });
    console.log(`\n  BOTTOM 10:`);
    st.sorted.slice(-10).reverse().forEach(([sym,d],i)=>{
      const wr2=d.trades?(d.wins/d.trades*100).toFixed(0):'0';
      console.log(`    #${String(i+1).padEnd(3)}${sym.padEnd(12)}[${d.type}]  ${String(d.trades).padEnd(4)}t  ${String(wr2).padEnd(5)}% win  ${d.pnl>=0?'+':''}$${d.pnl.toFixed(2)}`);
    });
  }

  console.log('\n'+'═'.repeat(90));
  console.log('  RECOMMENDATION');
  console.log('═'.repeat(90));
  const best = pairs.reduce((a,b) => parseFloat(a.st.ret) >= parseFloat(b.st.ret) ? a : b);
  const safest = pairs.reduce((a,b) => a.sim.maxDrawdown <= b.sim.maxDrawdown ? a : b);
  const bestLabel  = `Cap ${best.sim.cap}`;
  const safeLabel  = `Cap ${safest.sim.cap}`;
  console.log(`\n  Best return    : ${bestLabel}  →  ${best.st.ret>=0?'+':''}${best.st.ret}%  (ann. ${best.st.annRet>=0?'+':''}${best.st.annRet}%)`);
  console.log(`  Safest (low DD): ${safeLabel}  →  ${safest.sim.maxDrawdown.toFixed(2)}% max drawdown  (low $${safest.sim.minBalance.toFixed(2)})`);
  console.log('\n'+'═'.repeat(90)+'\n');

})().catch(console.error);
