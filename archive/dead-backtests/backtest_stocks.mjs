/**
 * US Stock Strategy Backtest — 1H Candles × Top 100 S&P 500 Stocks
 *
 * Data source: Yahoo Finance (free, no API key)
 * ~60 days of 1H data per stock (market hours only: 9:30–16:00 ET)
 *
 * Same signals as crypto bot:
 *   P1: SuperTrend bullish flip              → LONG
 *   P2: ST bearish + MACD<0 + RSI(14)>70    → SHORT
 *   P4: BB Recovery (price > BB1 lower)      → LONG
 *   P5: VWAP + EMA20 + RSI(14)               → L/S
 *   P3: BB Breakdown                         → OFF
 *
 * Tests current settings: 5% SL / 15% TP
 * Also tests tighter 2% SL / 4% TP for stocks (stocks move slower than crypto)
 */

import https from 'https';

// Top 100 US stocks by market cap (S&P 500)
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
  'CL','MMC','ABNB','UBER','SNOW','CRWD','MSTR','PLTR','ARM','COIN'
];

const TRADE_SIZE = 50;   // $ per trade (same as crypto)
const START_BAL  = 1000;
const MIN_CONF   = 65;

const CONFIGS = [
  { label: '2% SL /  4% TP (crypto default)', sl: 0.02, tp: 0.04 },
  { label: '3% SL /  9% TP (1:3)',             sl: 0.03, tp: 0.09 },
  { label: '5% SL / 15% TP (crypto optimal)',  sl: 0.05, tp: 0.15 },
];

// ── Fetch from Yahoo Finance ──────────────────────────────────────────────────

function fetchStock(symbol) {
  return new Promise((resolve, reject) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1h&range=60d`;
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
      }
    };
    https.get(url, opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          const result = json?.chart?.result?.[0];
          if (!result) return reject(new Error(`No data for ${symbol}`));

          const ts    = result.timestamp;
          const q     = result.indicators.quote[0];
          const { open, high, low, close, volume } = q;

          const candles = [];
          for (let i = 0; i < ts.length; i++) {
            if (close[i] == null || open[i] == null) continue; // skip null bars (market closed)
            candles.push({
              time:   new Date(ts[i] * 1000),
              open:   open[i],
              high:   high[i],
              low:    low[i],
              close:  close[i],
              volume: volume[i] || 0,
            });
          }
          if (candles.length < 50) return reject(new Error(`Too few bars: ${candles.length}`));
          resolve(candles);
        } catch(e) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// ── Indicators (identical to crypto bot) ─────────────────────────────────────

function ema(values, period) {
  const k = 2 / (period + 1), r = [values[0]];
  for (let i = 1; i < values.length; i++) r.push(values[i] * k + r[i-1] * (1-k));
  return r;
}

function rsiSeries(closes, period = 14) {
  const r = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let g = 0, l = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j] - closes[j-1];
      if (d > 0) g += d; else l -= d;
    }
    const avgL = l / period;
    r[i] = avgL === 0 ? 100 : 100 - 100 / (1 + (g/period) / avgL);
  }
  return r;
}

function atrSeries(candles, period) {
  const trs = candles.map((c, i) => i === 0 ? c.high - c.low :
    Math.max(c.high-c.low, Math.abs(c.high-candles[i-1].close), Math.abs(c.low-candles[i-1].close)));
  const r = new Array(candles.length).fill(null);
  r[period-1] = trs.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for (let i = period; i < candles.length; i++) r[i] = (r[i-1]*(period-1)+trs[i])/period;
  return r;
}

function stSeries(candles, atrP = 10, mult = 3) {
  const atr = atrSeries(candles, atrP);
  const r = new Array(candles.length).fill(null);
  let pUp=null, pLo=null, pDir=null;
  for (let i = atrP; i < candles.length; i++) {
    const hl2 = (candles[i].high + candles[i].low) / 2;
    let up = hl2 + mult*atr[i], lo = hl2 - mult*atr[i];
    if (pLo!==null) lo = candles[i].close > pLo ? Math.max(lo,pLo) : lo;
    if (pUp!==null) up = candles[i].close < pUp ? Math.min(up,pUp) : up;
    const dir = pDir===null ? (candles[i].close>up?1:-1)
              : pDir===-1   ? (candles[i].close>pUp?1:-1)
              :               (candles[i].close<pLo?-1:1);
    r[i] = { upper: up, lower: lo, direction: dir };
    pUp=up; pLo=lo; pDir=dir;
  }
  return r;
}

function macdSeries(closes) {
  const fast=ema(closes,12), slow=ema(closes,26);
  const macd=closes.map((_,i)=>fast[i]-slow[i]);
  const k=2/10; let s=macd[0]; const sig=[s];
  for (let i=1;i<macd.length;i++){s=macd[i]*k+s*(1-k);sig.push(s);}
  return {macd,sig};
}

function bbSeries(values, length, mult) {
  return values.map((_,i) => {
    if (i < length-1) return null;
    const sl=values.slice(i-length+1,i+1);
    const mean=sl.reduce((s,v)=>s+v,0)/length;
    const std=Math.sqrt(sl.reduce((s,v)=>s+(v-mean)**2,0)/length);
    return {upper:mean+mult*std, lower:mean-mult*std};
  });
}

// VWAP — resets each trading day (stocks trade Mon–Fri, gaps overnight)
function vwapSeries(candles) {
  const r = new Array(candles.length).fill(null);
  let cumTPV=0, cumVol=0, day=null;
  for (let i=0;i<candles.length;i++) {
    const d = candles[i].time.toISOString().slice(0,10);
    if (d!==day) { cumTPV=0; cumVol=0; day=d; }
    const tp = (candles[i].high+candles[i].low+candles[i].close)/3;
    cumTPV+=tp*candles[i].volume; cumVol+=candles[i].volume;
    r[i] = cumVol===0 ? null : cumTPV/cumVol;
  }
  return r;
}

// ── Pre-compute ───────────────────────────────────────────────────────────────

function precompute(candles) {
  const closes=candles.map(c=>c.close), opens=candles.map(c=>c.open);
  return { candles, closes,
    ema20: ema(closes,20),
    rsi14: rsiSeries(closes,14),
    vwap:  vwapSeries(candles),
    st:    stSeries(candles,10,3),
    ...macdSeries(closes),
    bb1:   bbSeries(opens,4,4),
    bb2:   bbSeries(closes,20,2),
  };
}

// ── Confidence ────────────────────────────────────────────────────────────────

function confScore(price, em, vw, rsi, stN, macdV, sigV, bbSigs, stSigs) {
  let L=0,S=0; const r=rsi??50;
  if (stN){stN.direction===1?L+=20:S+=20;}
  if (em!=null){price>em?L+=10:S+=10;}
  if (vw!=null){price>vw?L+=5:S+=5;}
  macdV>0?L+=12:S+=12;
  macdV>sigV?L+=13:S+=13;
  if(r<30)L+=25;else if(r<40)L+=15;else if(r<50)L+=5;
  if(r>70)S+=25;else if(r>60)S+=15;else if(r>50)S+=5;
  if(stSigs.includes('LONG'))L+=15;
  if(stSigs.includes('SHORT'))S+=15;
  if(bbSigs.includes('LONG'))L+=10;
  if(bbSigs.includes('SHORT'))S+=10;
  return {long:Math.min(L,100),short:Math.min(S,100)};
}

// ── Signal detection ──────────────────────────────────────────────────────────

function getSignal(i, pre) {
  const {candles,ema20,rsi14,vwap,st,macd,sig,bb1}=pre;
  const stN=st[i],stP=st[i-1];
  if(!stN||!stP||rsi14[i]==null||ema20[i]==null) return null;

  const c=candles[i].close, cP=candles[i-1].close;
  const rsi=rsi14[i], em=ema20[i], vw=vwap[i];
  const macdV=macd[i], sigV=sig[i];
  const bb1N=bb1[i], bb1P=bb1[i-1];

  const bbSigs=[], stSigs=[];

  // P1: ST Bullish Flip → LONG
  if (stP.direction===-1&&stN.direction===1) stSigs.push('LONG');

  // P2: ST bearish + MACD<0 + RSI>70 → SHORT
  if (stN.direction===-1&&macdV<0&&rsi>70) stSigs.push('SHORT');

  // P4: BB Recovery → LONG
  if (bb1N&&bb1P&&cP<bb1P.lower&&c>bb1N.lower) bbSigs.push('LONG');

  let dir=null;
  if      (stSigs.includes('LONG'))  dir='LONG';
  else if (stSigs.includes('SHORT')) dir='SHORT';
  else if (bbSigs.includes('LONG'))  dir='LONG';
  else {
    if (c>em&&(vw==null||c>vw)&&rsi<30) dir='LONG';
    else if (c<em&&(vw==null||c<vw)&&rsi>70) dir='SHORT';
  }
  if (!dir) return null;

  const cs=confScore(c,em,vw,rsi,stN,macdV,sigV,bbSigs,stSigs);
  const score=dir==='LONG'?cs.long:cs.short;
  if (score<MIN_CONF) return null;

  let source='VWAP+EMA+RSI';
  if      (stSigs.includes('LONG'))  source='ST Bullish Flip';
  else if (stSigs.includes('SHORT')) source='ST+MACD+RSI Short';
  else if (bbSigs.includes('LONG'))  source='BB Recovery';

  return {dir,score,source};
}

// ── Backtest engine ───────────────────────────────────────────────────────────

function backtest(pre, SL_PCT, TP_PCT) {
  const {candles}=pre;
  let inTrade=null, balance=START_BAL;
  const trades=[];

  for (let i=30; i<candles.length-1; i++) {
    if (inTrade) {
      const bar=candles[i], isLong=inTrade.dir==='LONG';
      let exit=null, reason=null;
      if (isLong) {
        if      (bar.open<=inTrade.sl){exit=bar.open;   reason='SL';}
        else if (bar.open>=inTrade.tp){exit=bar.open;   reason='TP';}
        else if (bar.low <=inTrade.sl){exit=inTrade.sl; reason='SL';}
        else if (bar.high>=inTrade.tp){exit=inTrade.tp; reason='TP';}
      } else {
        if      (bar.open>=inTrade.sl){exit=bar.open;   reason='SL';}
        else if (bar.open<=inTrade.tp){exit=bar.open;   reason='TP';}
        else if (bar.high>=inTrade.sl){exit=inTrade.sl; reason='SL';}
        else if (bar.low <=inTrade.tp){exit=inTrade.tp; reason='TP';}
      }
      if (exit!==null) {
        const pnlPct=isLong?(exit-inTrade.entry)/inTrade.entry*100:(inTrade.entry-exit)/inTrade.entry*100;
        const pnlUSD=pnlPct/100*TRADE_SIZE;
        balance+=TRADE_SIZE+pnlUSD;
        trades.push({...inTrade,exit,reason,pnlUSD,source:inTrade.source});
        inTrade=null;
      }
    }
    if (!inTrade) {
      const s=getSignal(i,pre);
      if (s&&balance>=TRADE_SIZE) {
        const entry=candles[i+1].open, isLong=s.dir==='LONG';
        balance-=TRADE_SIZE;
        inTrade={dir:s.dir,source:s.source,entry,
          sl:isLong?entry*(1-SL_PCT):entry*(1+SL_PCT),
          tp:isLong?entry*(1+TP_PCT):entry*(1-TP_PCT)};
      }
    }
  }
  if (inTrade) {
    const last=candles[candles.length-1], isLong=inTrade.dir==='LONG';
    const pnlPct=isLong?(last.close-inTrade.entry)/inTrade.entry*100:(inTrade.entry-last.close)/inTrade.entry*100;
    const pnlUSD=pnlPct/100*TRADE_SIZE;
    balance+=TRADE_SIZE+pnlUSD;
    trades.push({...inTrade,exit:last.close,reason:'END',pnlUSD,source:inTrade.source});
  }

  const wins=trades.filter(t=>t.pnlUSD>0);
  const losses=trades.filter(t=>t.pnlUSD<=0);
  const totalPnl=trades.reduce((s,t)=>s+t.pnlUSD,0);
  const grossWin=wins.reduce((s,t)=>s+t.pnlUSD,0);
  const grossLoss=Math.abs(losses.reduce((s,t)=>s+t.pnlUSD,0));

  const sigMap={};
  for (const t of trades) {
    if (!sigMap[t.source]) sigMap[t.source]={count:0,wins:0,pnl:0};
    sigMap[t.source].count++;
    if (t.pnlUSD>0) sigMap[t.source].wins++;
    sigMap[t.source].pnl+=t.pnlUSD;
  }

  return {
    trades:trades.length, wins:wins.length, losses:losses.length,
    winRate:trades.length?(wins.length/trades.length*100).toFixed(1):'0',
    totalPnl:parseFloat(totalPnl.toFixed(2)),
    profitFactor:grossLoss>0?parseFloat((grossWin/grossLoss).toFixed(2)):(grossWin>0?'∞':0),
    sigMap,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n'+'═'.repeat(95));
  console.log('  US STOCK BACKTEST — 1H Candles × Top 100 S&P 500 Stocks  (~60 days)');
  console.log('  Data: Yahoo Finance  |  Signals: ST Flip · BB Recovery · ST+MACD+RSI Short');
  console.log('═'.repeat(95)+'\n');

  // Fetch all stocks (with small delay to avoid rate limiting)
  const allPre=[], failed=[];
  for (const symbol of STOCKS) {
    process.stdout.write(`  Fetching ${symbol.padEnd(6)}...`);
    try {
      await new Promise(r=>setTimeout(r,120)); // ~120ms between requests
      const candles=await fetchStock(symbol);
      allPre.push({symbol, pre:precompute(candles), bars:candles.length});
      process.stdout.write(` ${candles.length} bars ✓\n`);
    } catch(e) {
      process.stdout.write(` ❌ ${e.message}\n`);
      failed.push(symbol);
    }
  }

  if (failed.length) console.log(`\n  Failed: ${failed.join(', ')}`);
  console.log(`\n  Successfully loaded: ${allPre.length} stocks\n`);

  // Run each config
  for (const cfg of CONFIGS) {
    console.log('\n'+'─'.repeat(95));
    console.log(`  CONFIG: ${cfg.label}`);
    console.log('─'.repeat(95));
    console.log(
      'Stock'.padEnd(8)+'Trades'.padEnd(8)+'Wins'.padEnd(6)+'Losses'.padEnd(8)+
      'Win%'.padEnd(8)+'PF'.padEnd(6)+'P&L $'.padEnd(12)+'Best Signal'
    );
    console.log('─'.repeat(95));

    const allSigMap={};
    let totT=0, totW=0, totPnl=0;
    const perStock=[];

    for (const {symbol,pre} of allPre) {
      const r=backtest(pre,cfg.sl,cfg.tp);
      totT+=r.trades; totW+=r.wins; totPnl+=r.totalPnl;
      perStock.push({symbol,...r});

      for (const [src,d] of Object.entries(r.sigMap)) {
        if (!allSigMap[src]) allSigMap[src]={count:0,wins:0,pnl:0};
        allSigMap[src].count+=d.count; allSigMap[src].wins+=d.wins; allSigMap[src].pnl+=d.pnl;
      }

      const pnl=`${r.totalPnl>=0?'+':''}$${r.totalPnl}`;
      const topSig=Object.entries(r.sigMap).sort((a,b)=>b[1].pnl-a[1].pnl)[0];
      const topStr=topSig?`${topSig[0].replace('SuperTrend','ST')} (${topSig[1].count}t)`:'—';
      console.log(
        symbol.padEnd(8)+String(r.trades).padEnd(8)+String(r.wins).padEnd(6)+
        String(r.losses).padEnd(8)+`${r.winRate}%`.padEnd(8)+
        String(r.profitFactor).padEnd(6)+pnl.padEnd(12)+topStr
      );
    }

    const wr=totT?(totW/totT*100).toFixed(1):'0';
    console.log('─'.repeat(95));
    console.log(
      'TOTAL'.padEnd(8)+String(totT).padEnd(8)+String(totW).padEnd(6)+
      String(totT-totW).padEnd(8)+`${wr}%`.padEnd(22)+
      `${totPnl>=0?'+':''}$${totPnl.toFixed(2)}`
    );

    // Signal breakdown
    console.log('\n  Signal breakdown:');
    for (const [src,d] of Object.entries(allSigMap).sort((a,b)=>b[1].pnl-a[1].pnl)) {
      const w=d.count?(d.wins/d.count*100).toFixed(1):'0';
      console.log(`  ${d.pnl>=0?'✅':'❌'}  ${src.padEnd(24)} ${String(d.count).padEnd(6)} trades  ${w}% win  ${d.pnl>=0?'+':''}$${d.pnl.toFixed(2)}`);
    }

    // Top 5 / Bottom 5
    const sorted=[...perStock].sort((a,b)=>b.totalPnl-a.totalPnl);
    console.log('\n  Top 5:');
    sorted.slice(0,5).forEach((r,i)=>
      console.log(`    ${i+1}. ${r.symbol.padEnd(6)} ${r.trades}t  ${r.winRate}% win  ${r.totalPnl>=0?'+':''}$${r.totalPnl}  PF ${r.profitFactor}`)
    );
    console.log('  Bottom 5:');
    sorted.slice(-5).reverse().forEach((r,i)=>
      console.log(`    ${i+1}. ${r.symbol.padEnd(6)} ${r.trades}t  ${r.winRate}% win  ${r.totalPnl>=0?'+':''}$${r.totalPnl}  PF ${r.profitFactor}`)
    );

    const avg=totPnl/allPre.length;
    console.log(`\n  Verdict: ${totPnl>0?'✅ PROFITABLE':'❌ UNPROFITABLE'}   Total P&L: ${totPnl>=0?'+':''}$${totPnl.toFixed(2)}   Avg/stock: ${avg>=0?'+':''}$${avg.toFixed(2)}`);
  }

  console.log('\n'+'═'.repeat(95)+'\n');
})().catch(console.error);
