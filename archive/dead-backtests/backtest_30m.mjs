/**
 * 30-Minute Strategy Backtest — ~2000 x 30m Candles × 50 Coins (~41 days)
 *
 * Signals active (mirrors current live bot):
 *   P1: SuperTrend bullish flip              → LONG
 *   P2: ST bearish + MACD<0 + RSI(14)>70    → SHORT
 *   P4: BB Recovery (price > BB1 lower)      → LONG
 *   P5: VWAP + EMA20 + RSI(14) original      → L/S
 *   P3: BB Breakdown                         → OFF (confirmed loser)
 *
 * VWAP resets at midnight UTC (same as live bot)
 * Trade management: $50/trade · 65% min confidence
 * Tests both current (5%/15%) and original (2%/4%) SL/TP for comparison
 */

import https from 'https';

const COINS = [
  'BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT',
  'DOGEUSDT','LINKUSDT','SUIUSDT','LTCUSDT','AVAXUSDT','HBARUSDT',
  'ADAUSDT','TRXUSDT','TONUSDT','SHIBUSDT','DOTUSDT','BCHUSDT',
  'UNIUSDT','NEARUSDT','APTUSDT','ICPUSDT','ETCUSDT','POLUSDT',
  'VETUSDT','ATOMUSDT','OPUSDT','ARBUSDT','FILUSDT','ALGOUSDT',
  'INJUSDT','BONKUSDT','GRTUSDT','PEPEUSDT','WLDUSDT','AAVEUSDT',
  'TAOUSDT','RENDERUSDT','FETUSDT','STXUSDT','CRVUSDT','THETAUSDT',
  'JASMYUSDT','ONDOUSDT','RUNEUSDT','SANDUSDT','MANAUSDT','ENAUSDT',
  'LDOUSDT','SEIUSDT','TIAUSDT'
];

const TRADE_SIZE = 50;
const START_BAL  = 1000;
const MIN_CONF   = 65;

// SL/TP configs to compare
const CONFIGS = [
  { label: '2% SL / 4% TP  (old)',      sl: 0.02, tp: 0.04 },
  { label: '5% SL / 15% TP (current)',  sl: 0.05, tp: 0.15 },
];

// ── Fetch — paginated to get ~2000 candles (~41 days of 30m) ─────────────────

function fetchPage(symbol, limit, endTime) {
  return new Promise((resolve, reject) => {
    const qs = `symbol=${symbol}&interval=30m&limit=${limit}${endTime ? `&endTime=${endTime}` : ''}`;
    https.get(`https://api.binance.com/api/v3/klines?${qs}`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const raw = JSON.parse(d);
          if (!Array.isArray(raw)) return reject(new Error(`Bad response: ${d.slice(0,60)}`));
          resolve(raw.map(k => ({
            time:   new Date(k[0]),
            open:   parseFloat(k[1]),
            high:   parseFloat(k[2]),
            low:    parseFloat(k[3]),
            close:  parseFloat(k[4]),
            volume: parseFloat(k[5]),
          })));
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function fetchCandles(symbol) {
  // Two requests: oldest first, then newer, concatenated
  const recent = await fetchPage(symbol, 1000);
  const older  = await fetchPage(symbol, 1000, recent[0].time.getTime() - 1);
  return [...older, ...recent];
}

// ── Indicators ────────────────────────────────────────────────────────────────

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
  return {macd, sig};
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

function vwapSeries(candles) {
  const r=new Array(candles.length).fill(null);
  let cumTPV=0, cumVol=0, day=null;
  for (let i=0;i<candles.length;i++) {
    const d=candles[i].time.toISOString().slice(0,10);
    if (d!==day){cumTPV=0;cumVol=0;day=d;}
    const tp=(candles[i].high+candles[i].low+candles[i].close)/3;
    cumTPV+=tp*candles[i].volume; cumVol+=candles[i].volume;
    r[i]=cumVol===0?null:cumTPV/cumVol;
  }
  return r;
}

// ── Pre-compute all indicators once per coin ──────────────────────────────────

function precompute(candles) {
  const closes=candles.map(c=>c.close), opens=candles.map(c=>c.open);
  return { candles, closes,
    ema20:  ema(closes,20),
    rsi14:  rsiSeries(closes,14),
    vwap:   vwapSeries(candles),
    st:     stSeries(candles,10,3),
    ...macdSeries(closes),
    bb1:    bbSeries(opens,4,4),
    bb2:    bbSeries(closes,20,2),
  };
}

// ── Confidence ────────────────────────────────────────────────────────────────

function conf(price, em, vw, rsi, st, macdV, sigV, bbSigs, stSigs) {
  let L=0,S=0; const r=rsi??50;
  if (st){st.direction===1?L+=20:S+=20;}
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
  const {candles,ema20,rsi14,vwap,st,macd,sig,bb1,bb2}=pre;
  const stN=st[i],stP=st[i-1];
  if(!stN||!stP||rsi14[i]==null||ema20[i]==null) return null;

  const c=candles[i].close, cP=candles[i-1].close;
  const rsi=rsi14[i], em=ema20[i], vw=vwap[i];
  const macdV=macd[i], sigV=sig[i];
  const bb1N=bb1[i], bb1P=bb1[i-1];

  const bbSigs=[], stSigs=[];

  // P1: ST Bullish Flip
  if (stP.direction===-1&&stN.direction===1) stSigs.push('LONG');

  // P2: ST bearish + MACD<0 + RSI>70
  if (stN.direction===-1&&macdV<0&&rsi>70) stSigs.push('SHORT');

  // P3: BB Breakdown — OFF
  // P4: BB Recovery
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

  const c2=conf(c,em,vw,rsi,stN,macdV,sigV,bbSigs,stSigs);
  const score=dir==='LONG'?c2.long:c2.short;
  if (score<MIN_CONF) return null;

  let source='VWAP+EMA+RSI';
  if (stSigs.includes('LONG'))  source='ST Bullish Flip';
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
  // Close open trade at last bar
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

  // Signal breakdown
  const sigMap={};
  for (const t of trades) {
    if (!sigMap[t.source]) sigMap[t.source]={count:0,wins:0,pnl:0};
    sigMap[t.source].count++;
    if (t.pnlUSD>0) sigMap[t.source].wins++;
    sigMap[t.source].pnl+=t.pnlUSD;
  }

  return {
    trades:      trades.length,
    wins:        wins.length,
    losses:      losses.length,
    winRate:     trades.length?(wins.length/trades.length*100).toFixed(1):'0',
    totalPnl:    parseFloat(totalPnl.toFixed(2)),
    profitFactor:grossLoss>0?parseFloat((grossWin/grossLoss).toFixed(2)):(grossWin>0?'∞':0),
    sigMap,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n'+'═'.repeat(90));
  console.log('  30-MINUTE STRATEGY BACKTEST — ~2000 candles × 50 Coins  (~41 days)');
  console.log('  Signals: ST Bullish Flip · BB Recovery · ST+MACD+RSI Short  |  BB Breakdown: OFF');
  console.log('═'.repeat(90)+'\n');

  // Fetch all candles once
  const allPre=[];
  for (const symbol of COINS) {
    process.stdout.write(`  Fetching ${symbol}...`);
    try {
      const candles=await fetchCandles(symbol);
      allPre.push({symbol, pre:precompute(candles), start:candles[0].time.toISOString().slice(0,10), end:candles[candles.length-1].time.toISOString().slice(0,10), total:candles.length});
      process.stdout.write(` ${candles.length} candles ✓\n`);
    } catch(e) { process.stdout.write(` ❌ ${e.message}\n`); }
  }

  const dateRange=`${allPre[0].start} → ${allPre[0].end}`;
  console.log(`\n  Date range: ${dateRange}\n`);

  for (const cfg of CONFIGS) {
    console.log('\n'+'─'.repeat(90));
    console.log(`  CONFIG: ${cfg.label}   SL=${cfg.sl*100}%  TP=${cfg.tp*100}%`);
    console.log('─'.repeat(90));
    console.log(
      'Coin'.padEnd(8)+'Trades'.padEnd(8)+'Wins'.padEnd(6)+'Losses'.padEnd(8)+
      'Win%'.padEnd(8)+'PF'.padEnd(6)+'P&L $'.padEnd(12)+'Top Signal'
    );
    console.log('─'.repeat(90));

    const allSigMap={};
    let totTrades=0,totWins=0,totPnl=0;

    for (const {symbol,pre} of allPre) {
      const r=backtest(pre,cfg.sl,cfg.tp);
      totTrades+=r.trades; totWins+=r.wins; totPnl+=r.totalPnl;

      // Accumulate signal breakdown
      for (const [src,d] of Object.entries(r.sigMap)) {
        if (!allSigMap[src]) allSigMap[src]={count:0,wins:0,pnl:0};
        allSigMap[src].count+=d.count; allSigMap[src].wins+=d.wins; allSigMap[src].pnl+=d.pnl;
      }

      const pnlStr=`${r.totalPnl>=0?'+':''}$${r.totalPnl}`;
      const topSig=Object.entries(r.sigMap).sort((a,b)=>b[1].pnl-a[1].pnl)[0];
      const topStr=topSig?`${topSig[0]} (${topSig[1].count}t)`:'—';
      console.log(
        symbol.replace('USDT','').padEnd(8)+
        String(r.trades).padEnd(8)+String(r.wins).padEnd(6)+String(r.losses).padEnd(8)+
        `${r.winRate}%`.padEnd(8)+String(r.profitFactor).padEnd(6)+
        pnlStr.padEnd(12)+topStr
      );
    }

    // Totals
    const wr=totTrades?(totWins/totTrades*100).toFixed(1):'0';
    const totStr=`${totPnl>=0?'+':''}$${totPnl.toFixed(2)}`;
    console.log('─'.repeat(90));
    console.log(
      'TOTAL'.padEnd(8)+String(totTrades).padEnd(8)+String(totWins).padEnd(6)+
      String(totTrades-totWins).padEnd(8)+`${wr}%`.padEnd(8)+''.padEnd(6)+totStr
    );

    // Signal breakdown
    console.log('\n  Signal breakdown:');
    for (const [src,d] of Object.entries(allSigMap).sort((a,b)=>b[1].pnl-a[1].pnl)) {
      const wr2=d.count?(d.wins/d.count*100).toFixed(1):'0';
      const icon=d.pnl>0?'✅':'❌';
      console.log(`  ${icon}  ${src.padEnd(26)} ${String(d.count).padEnd(7)} trades  ${wr2}%  win    ${d.pnl>=0?'+':''}$${d.pnl.toFixed(2)}`);
    }

    const avgCoin = totPnl / allPre.length;
    const avgStr  = `${avgCoin>=0?'+':''}$${avgCoin.toFixed(2)}`;
    console.log(`\n  Verdict: ${totPnl>0?'✅ PROFITABLE':'❌ UNPROFITABLE'}   Total P&L: ${totStr}   Avg/coin: ${avgStr}`);
  }

  console.log('\n'+'═'.repeat(90)+'\n');
})().catch(console.error);
