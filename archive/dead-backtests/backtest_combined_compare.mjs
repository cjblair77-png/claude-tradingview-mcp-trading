/**
 * backtest_combined_compare.mjs — Full portfolio comparison
 *
 * Runs both strategies as they exist on Railway, month-by-month:
 *
 *   OLD PORTFOLIO:  DT (MH=8, all sessions)  +  v09 (unchanged)
 *   NEW PORTFOLIO:  DT (MH=12, no Asia)       +  v09 (unchanged)
 *
 * Each bot runs its own $5,000 starting capital (as they do on Railway).
 * Combined portfolio = $10,000 total.
 *
 * Run: node backtest_combined_compare.mjs [DAYS] [START_BAL_EACH]
 *      node backtest_combined_compare.mjs 365 5000
 */

import https from 'https';

const DAYS       = parseInt(process.argv[2]  || "365");
const START_DT   = parseFloat(process.argv[3] || "5000");   // DT bot allocation
const START_V09  = parseFloat(process.argv[4] || process.argv[3] || "5000");  // v09 allocation
const START_EACH = START_DT;   // legacy compat — DT uses this
const START_TOTAL = START_DT + START_V09;

// ══════════════════════════════════════════════════════════════════════════════
// DT BOT CONFIG  (bot_daytrading_v01.js)
// ══════════════════════════════════════════════════════════════════════════════

const DT_RISK_PCT   = 0.008;
const DT_LEVERAGE   = 5;
const DT_MAX_POS    = 6;
const DT_MAX_SL_PCT = 0.012;
const DT_RR         = 1.3;
const DT_EMA50_PAIRS = new Set(["BTCUSDT", "SUIUSDT"]);
const DT_PAIRS       = ["BTCUSDT", "BNBUSDT", "XRPUSDT", "SUIUSDT", "LTCUSDT", "AVAXUSDT"];

// ══════════════════════════════════════════════════════════════════════════════
// v09 BOT CONFIG  (bot_crypto_v09.js)
// ══════════════════════════════════════════════════════════════════════════════

const V09_RISK_PCT = 0.008;
const V09_MAX_POS  = 10;
const V09_SL_PCT   = 0.065;
const V09_TP_PCT   = 0.23;
const V09_REB_SL   = 0.035;
const V09_REB_TP   = 0.22;
const V09_INTERVAL = '4h';

const V09_PAIRS = [
  'KAIAUSDT','SUSDT',   'FILUSDT', 'ARUSDT',    'PLUMEUSDT',
  'FIDAUSDT','GMTUSDT', 'ENAUSDT', 'TIAUSDT',   'TURBOUSDT',
  'WIFUSDT', 'SHIBUSDT','BCHUSDT', 'VETUSDT',   'ONDOUSDT',
  'THETAUSDT','HBARUSDT','RUNEUSDT','IOTAUSDT',  'JUPUSDT',
  'FLUXUSDT','WUSDT',   'CATIUSDT','ZKUSDT',    'KAITOUSDT',
  'WLDUSDT', 'AIXBTUSDT','LAUSDT',  'JASMYUSDT', 'HOMEUSDT',
];

// ══════════════════════════════════════════════════════════════════════════════
// SHARED FETCH HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetch15m(symbol, days) {
  const needed  = (days + 5) * 96 + 200;
  const batches = Math.ceil(needed / 1000);
  const all     = [];
  let endTime   = Date.now();
  for (let b = 0; b < batches; b++) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=1000&endTime=${endTime}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const raw = await res.json();
      if (!Array.isArray(raw) || raw.length === 0) break;
      all.unshift(...raw.map(k => ({
        time: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
        low:  parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
      })));
      endTime = raw[0][0] - 1;
    } catch { break; }
    if (b < batches - 1) await new Promise(r => setTimeout(r, 150));
  }
  const seen = new Set();
  return all.filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
            .sort((a, b) => a.time - b.time);
}

async function fetch4h(symbol) {
  const end   = Date.now();
  const start = end - (DAYS + 60) * 24 * 60 * 60 * 1000;
  const bars  = [];
  let from = start;
  while (from < end) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${V09_INTERVAL}&startTime=${from}&endTime=${end}&limit=1000`;
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
    time:   parseInt(k[0]), open:   parseFloat(k[1]), high:   parseFloat(k[2]),
    low:    parseFloat(k[3]), close:  parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

// ══════════════════════════════════════════════════════════════════════════════
// DT INDICATORS
// ══════════════════════════════════════════════════════════════════════════════

function dtEma(vals, p) {
  const k = 2/(p+1), out = new Array(vals.length).fill(null);
  let s = vals[0];
  for (let i = 0; i < vals.length; i++) { s = i===0 ? vals[0] : vals[i]*k+s*(1-k); out[i]=s; }
  return out;
}
function dtSma(vals, p) {
  const out = new Array(vals.length).fill(null);
  for (let i = p-1; i < vals.length; i++)
    out[i] = vals.slice(i-p+1,i+1).reduce((a,b)=>a+b,0)/p;
  return out;
}
function dtRsi(vals) {
  const out = new Array(vals.length).fill(null);
  if (vals.length < 15) return out;
  let ag=0, al=0;
  for (let i=1; i<=14; i++) { const d=vals[i]-vals[i-1]; d>0?ag+=d:al-=d; }
  ag/=14; al/=14;
  out[14] = al===0?100:100-100/(1+ag/al);
  for (let i=15; i<vals.length; i++) {
    const d=vals[i]-vals[i-1];
    ag=(ag*13+Math.max(d,0))/14; al=(al*13+Math.max(-d,0))/14;
    out[i]=al===0?100:100-100/(1+ag/al);
  }
  return out;
}
function dtAdx(candles, p=14) {
  const n=candles.length, out=new Array(n).fill(null);
  if (n<p*2) return out;
  let tr=0,pdm=0,ndm=0;
  for (let i=1;i<=p;i++) {
    const c=candles[i],pv=candles[i-1];
    tr +=Math.max(c.high-c.low,Math.abs(c.high-pv.close),Math.abs(c.low-pv.close));
    pdm+=Math.max(c.high-pv.high,0)>Math.max(pv.low-c.low,0)?Math.max(c.high-pv.high,0):0;
    ndm+=Math.max(pv.low-c.low,0)>Math.max(c.high-pv.high,0)?Math.max(pv.low-c.low,0):0;
  }
  let adxVal=0; const dxArr=[];
  for (let i=p+1;i<n;i++) {
    const c=candles[i],pv=candles[i-1];
    const ctr=Math.max(c.high-c.low,Math.abs(c.high-pv.close),Math.abs(c.low-pv.close));
    const cp=Math.max(c.high-pv.high,0)>Math.max(pv.low-c.low,0)?Math.max(c.high-pv.high,0):0;
    const cn=Math.max(pv.low-c.low,0)>Math.max(c.high-pv.high,0)?Math.max(pv.low-c.low,0):0;
    tr=tr-tr/p+ctr; pdm=pdm-pdm/p+cp; ndm=ndm-ndm/p+cn;
    const pdi=tr>0?pdm/tr*100:0,ndi=tr>0?ndm/tr*100:0;
    const dx=(pdi+ndi)>0?Math.abs(pdi-ndi)/(pdi+ndi)*100:0;
    dxArr.push({i,dx});
    if (dxArr.length===p){adxVal=dxArr.reduce((s,x)=>s+x.dx,0)/p;out[i]=adxVal;}
    else if(dxArr.length>p){adxVal=(adxVal*(p-1)+dx)/p;out[i]=adxVal;}
  }
  return out;
}

const DT_SESSION_OPENS = new Set([1,8,13]);
function dtORBCalc(candles) {
  const orbs=new Array(candles.length).fill(null);
  let building=false,orbHigh=-Infinity,orbLow=Infinity,confirmed=null,bias=null;
  for (let i=0;i<candles.length;i++) {
    const c=candles[i],h=new Date(c.time).getUTCHours(),m=new Date(c.time).getUTCMinutes();
    if (DT_SESSION_OPENS.has(h)&&m===0){building=true;orbHigh=c.high;orbLow=c.low;confirmed=null;bias=null;}
    else if(building){orbHigh=Math.max(orbHigh,c.high);orbLow=Math.min(orbLow,c.low);confirmed={high:orbHigh,low:orbLow};building=false;}
    if(confirmed&&bias===null){if(c.close>confirmed.high)bias='LONG';else if(c.close<confirmed.low)bias='SHORT';}
    orbs[i]=confirmed?{...confirmed,bias}:null;
  }
  return orbs;
}

function dtPrecompute(symbol, candles) {
  const closes=candles.map(c=>c.close),vols=candles.map(c=>c.volume);
  return {symbol,candles,e21:dtEma(closes,21),e50:dtEma(closes,50),
          rsiV:dtRsi(closes),vsma:dtSma(vols,20),adx:dtAdx(candles),orbs:dtORBCalc(candles)};
}

function dtSignal(pre, i, blockAsia=false) {
  if (i<70) return null;
  const {symbol,candles,e21,e50,rsiV,vsma,adx,orbs}=pre;
  const c=candles[i],p=candles[i-1],r=rsiV[i];
  if (!r||!vsma[i]) return null;
  const h=new Date(c.time).getUTCHours();
  if (h<1||h>=22) return null;
  if (!adx[i]||adx[i]<20) return null;
  if (blockAsia&&h>=1&&h<8) return null;
  const orb=orbs[i];
  if (!orb||!orb.bias) return null;
  const volOk=c.volume>vsma[i]*1.2,tb=4;
  if (i<tb) return null;
  const e50Up=e50[i]>e50[i-tb],e50Dn=e50[i]<e50[i-tb];

  if (orb.bias==='LONG') {
    if (e50Up&&r>=40&&r<65&&volOk&&p.close<e21[i-1]&&c.close>e21[i]) {
      const sl=Math.min(...candles.slice(Math.max(0,i-3),i+1).map(x=>x.low));
      const risk=c.close-sl;
      if(risk>0&&risk/c.close<DT_MAX_SL_PCT) return {dir:"LONG",sig:"EMA21",entry:c.close,sl,tp:c.close+risk*DT_RR};
    }
    if (DT_EMA50_PAIRS.has(symbol)&&e50Up&&r>=38&&r<62&&volOk&&p.close<e50[i-1]&&c.close>e50[i]) {
      const sl=Math.min(...candles.slice(Math.max(0,i-4),i+1).map(x=>x.low));
      const risk=c.close-sl;
      if(risk>0&&risk/c.close<0.018) return {dir:"LONG",sig:"EMA50",entry:c.close,sl,tp:c.close+risk*DT_RR};
    }
  }
  if (orb.bias==='SHORT') {
    if (e50Dn&&r>35&&r<=60&&volOk&&p.close>e21[i-1]&&c.close<e21[i]) {
      const sl=Math.max(...candles.slice(Math.max(0,i-3),i+1).map(x=>x.high));
      const risk=sl-c.close;
      if(risk>0&&risk/c.close<DT_MAX_SL_PCT) return {dir:"SHORT",sig:"EMA21",entry:c.close,sl,tp:c.close-risk*DT_RR};
    }
    if (DT_EMA50_PAIRS.has(symbol)&&e50Dn&&r>38&&r<=62&&volOk&&p.close>e50[i-1]&&c.close<e50[i]) {
      const sl=Math.max(...candles.slice(Math.max(0,i-4),i+1).map(x=>x.high));
      const risk=sl-c.close;
      if(risk>0&&risk/c.close<0.018) return {dir:"SHORT",sig:"EMA50",entry:c.close,sl,tp:c.close-risk*DT_RR};
    }
  }
  return null;
}

function runDT(allCandles, allPre, opts={}) {
  const {maxHold=8, blockAsia=false} = opts;
  const allTimes=new Set();
  for (const bars of Object.values(allCandles)) for (const c of bars) allTimes.add(c.time);
  const timeline=[...allTimes].sort((a,b)=>a-b);
  const cutoff=timeline[timeline.length-1]-DAYS*86400000;
  const byTime={},byIdx={};
  for (const [sym,bars] of Object.entries(allCandles)) {
    byTime[sym]={}; byIdx[sym]={};
    bars.forEach((c,i)=>{byTime[sym][c.time]=c;byIdx[sym][c.time]=i;});
  }
  let balance=START_EACH,peak=START_EACH,maxDD=0;
  const openPos={},trades=[],monthly={};
  const ym=ts=>new Date(ts).toISOString().slice(0,7);
  const ensureM=(m,b)=>{if(!monthly[m])monthly[m]={pnl:0,trades:0,wins:0,losses:0,balEnd:b};};

  for (const t of timeline) {
    if (t<cutoff) continue;
    for (const sym of DT_PAIRS) {
      const i=byIdx[sym][t]; if(i===undefined) continue;
      const c=byTime[sym][t],pre=allPre[sym];
      if (openPos[sym]) {
        const pos=openPos[sym],isLong=pos.dir==="LONG";
        let closed=false,exitReason="",exitPrice=0;
        if(isLong){if(c.low<=pos.sl){exitPrice=pos.sl;exitReason="SL";closed=true;}else if(c.high>=pos.tp){exitPrice=pos.tp;exitReason="TP";closed=true;}}
        else{if(c.high>=pos.sl){exitPrice=pos.sl;exitReason="SL";closed=true;}else if(c.low<=pos.tp){exitPrice=pos.tp;exitReason="TP";closed=true;}}
        if(!closed&&i-pos.entryBarIdx>=maxHold){exitPrice=c.close;exitReason="TIME";closed=true;}
        if (closed) {
          const movePct=isLong?(exitPrice-pos.entry)/pos.entry:(pos.entry-exitPrice)/pos.entry;
          const slPct=isLong?(pos.entry-pos.sl)/pos.entry:(pos.sl-pos.entry)/pos.entry;
          const pnl=(movePct/slPct)*pos.riskUSD*DT_LEVERAGE;
          balance+=pnl;
          if(balance>peak)peak=balance;
          const dd=(peak-balance)/peak*100; if(dd>maxDD)maxDD=dd;
          const m=ym(c.time); ensureM(m,balance);
          monthly[m].pnl+=pnl; monthly[m].trades++; monthly[m].balEnd=balance;
          if(pnl>=0)monthly[m].wins++;else monthly[m].losses++;
          trades.push({sym,dir:pos.dir,entryTime:pos.entryTime,exitTime:c.time,exitReason,pnl});
          delete openPos[sym];
        }
      }
      if (!openPos[sym]&&Object.keys(openPos).length<DT_MAX_POS) {
        const sig=dtSignal(pre,i,blockAsia);
        if(sig){const riskUSD=balance*DT_RISK_PCT;openPos[sym]={...sig,sym,riskUSD,entryTime:c.time,entryBarIdx:i};}
      }
    }
  }
  for (const [sym,pos] of Object.entries(openPos)) {
    const bars=allCandles[sym],lastC=bars[bars.length-1];
    const isLong=pos.dir==="LONG";
    const movePct=isLong?(lastC.close-pos.entry)/pos.entry:(pos.entry-lastC.close)/pos.entry;
    const slPct=isLong?(pos.entry-pos.sl)/pos.entry:(pos.sl-pos.entry)/pos.entry;
    const pnl=(movePct/slPct)*pos.riskUSD*DT_LEVERAGE;
    balance+=pnl;
    const m=ym(lastC.time); ensureM(m,balance);
    monthly[m].pnl+=pnl; monthly[m].trades++; monthly[m].balEnd=balance;
    if(pnl>=0)monthly[m].wins++;else monthly[m].losses++;
    trades.push({sym,dir:pos.dir,entryTime:pos.entryTime,exitTime:lastC.time,exitReason:"OPEN",pnl});
  }
  // Fill balStart
  const months=Object.keys(monthly).sort(); let prev=START_EACH;
  for (const m of months){monthly[m].balStart=prev;prev=monthly[m].balEnd;}
  return {trades,monthly,finalBalance:balance,maxDD};
}

// ══════════════════════════════════════════════════════════════════════════════
// v09 INDICATORS
// ══════════════════════════════════════════════════════════════════════════════

function v9ema(v,p){const k=2/(p+1),r=[v[0]];for(let i=1;i<v.length;i++)r.push(v[i]*k+r[i-1]*(1-k));return r;}
function v9sma(v,p){return v.map((_,i)=>i<p-1?null:v.slice(i-p+1,i+1).reduce((a,b)=>a+b,0)/p);}
function v9rsi(closes,p=14){
  const r=new Array(closes.length).fill(null);
  for(let i=p;i<closes.length;i++){let g=0,l=0;for(let j=i-p+1;j<=i;j++){const d=closes[j]-closes[j-1];d>0?g+=d:l-=d;}r[i]=l===0?100:100-100/(1+(g/p)/(l/p));}
  return r;
}
function v9macd(closes,f=12,s=26,sig=9){
  const fast=v9ema(closes,f),slow=v9ema(closes,s);
  const ml=closes.map((_,i)=>fast[i]-slow[i]);
  const sl=[ml[0]];const k=2/(sig+1);
  for(let i=1;i<closes.length;i++)sl.push(ml[i]*k+sl[i-1]*(1-k));
  return{hist:ml.map((v,i)=>v-sl[i])};
}
function v9regime(i,closes,e21,e50,e200){
  if(!e200[i])return'neutral';const c=closes[i];let s=0;
  if(c>e200[i])s++;else s--;if(c>e50[i])s++;else s--;if(c>e21[i])s++;else s--;
  if(e21[i]>e50[i])s++;else s--;if(e50[i]>e200[i])s++;else s--;
  return s>=4?'bull':s<=-4?'bear':'neutral';
}
function v9risk(balance,reg,dir){
  const base=Math.max(balance*V09_RISK_PCT,2);
  if(reg==='neutral')return base*0.75;
  return((reg==='bull'&&dir==='LONG')||(reg==='bear'&&dir==='SHORT'))?base:base*0.5;
}
function v9signals(i,candles,closes,e21,e50,e200,rsi14,mc,vsma){
  if(i<31)return null;
  const rNow=rsi14[i],rPrv=rsi14[i-1],vol=candles[i].volume;
  if(rNow==null||rPrv==null||vsma[i]==null)return null;
  const c=closes[i],reg=v9regime(i,closes,e21,e50,e200);
  const high30=Math.max(...closes.slice(i-30,i));
  const long=c>high30&&e21[i]>e50[i]&&e21[i]>e21[i-1]&&e21[i-1]>e21[i-3]&&rNow>=54&&rNow<=65&&vol>vsma[i]*1.5;
  const wasOB=[1,2,3,4,5].some(k=>rsi14[i-k]!=null&&rsi14[i-k]>=65);
  const short=wasOB&&(rPrv>=58&&rNow<58||mc.hist[i-1]>=0&&mc.hist[i]<0)&&c<e21[i]&&rNow>35&&vol>vsma[i]*1.2;
  const wasOS=[1,2,3].some(k=>rsi14[i-k]!=null&&rsi14[i-k]<=20);
  const longReb=wasOS&&rPrv<=30&&rNow>30&&reg==='bull'&&c>e21[i]*0.92&&vol>vsma[i]*1.0&&!long;
  const wasOvB=[1,2,3].some(k=>rsi14[i-k]!=null&&rsi14[i-k]>=80);
  const shortReb=wasOvB&&rPrv>=70&&rNow<70&&reg!=='bull'&&c<e21[i]*1.08&&vol>vsma[i]*1.0&&!short;
  if(!long&&!short&&!longReb&&!shortReb)return null;
  if(long)return{dir:'LONG',type:'BREAKOUT',reg};
  if(short)return{dir:'SHORT',type:'BREAKDOWN',reg};
  if(longReb)return{dir:'LONG',type:'REBOUND',reg};
  return{dir:'SHORT',type:'REBOUND',reg};
}

function runV09(allData) {
  let balance=START_V09;
  const open=new Map(),trades=[],monthly={};
  const ym=ts=>new Date(ts).toISOString().slice(0,7);
  const ensureM=(m,b)=>{if(!monthly[m])monthly[m]={pnl:0,trades:0,wins:0,losses:0,balEnd:b};};

  const timeline=[];
  for(const d of allData) for(let i=0;i<d.candles.length;i++) timeline.push({sym:d.symbol,i,time:d.candles[i].time});
  timeline.sort((a,b)=>a.time-b.time);
  const cutoff=Date.now()-DAYS*86400000;
  const entries=timeline.filter(e=>e.time>=cutoff);

  for(const {sym,i,time} of entries){
    const d=allData.find(x=>x.symbol===sym);
    const bar=d.candles[i];
    const m=ym(time); ensureM(m,balance);

    if(open.has(sym)){
      const pos=open.get(sym);
      const{dir,entry,sl,tp,size,slPct,tpPct}=pos;
      let closed=false,won=false,pnlDollar=0;
      if(dir==='LONG'){
        if(bar.open<=sl){pnlDollar=-(size*slPct);closed=true;}
        else if(bar.open>=tp){pnlDollar=(size*tpPct);closed=true;won=true;}
        else if(bar.low<=sl){pnlDollar=-(size*slPct);closed=true;}
        else if(bar.high>=tp){pnlDollar=(size*tpPct);closed=true;won=true;}
      }else{
        if(bar.open>=sl){pnlDollar=-(size*slPct);closed=true;}
        else if(bar.open<=tp){pnlDollar=(size*tpPct);closed=true;won=true;}
        else if(bar.high>=sl){pnlDollar=-(size*slPct);closed=true;}
        else if(bar.low<=tp){pnlDollar=(size*tpPct);closed=true;won=true;}
      }
      if(closed){
        balance+=pnlDollar;
        monthly[m].pnl+=pnlDollar;monthly[m].trades++;monthly[m].balEnd=balance;
        if(won)monthly[m].wins++;else monthly[m].losses++;
        trades.push({sym,dir,won,pnl:pnlDollar});
        open.delete(sym);
      }
    }

    if(!open.has(sym)&&open.size<V09_MAX_POS&&balance>10&&i>0){
      const{closes,e21,e50,e200,rsi14,mc,vsma}=d;
      const sig=v9signals(i,d.candles,closes,e21,e50,e200,rsi14,mc,vsma);
      if(sig){
        const{dir,type,reg}=sig;
        const slPct_=type==='REBOUND'?V09_REB_SL:V09_SL_PCT;
        const tpPct_=type==='REBOUND'?V09_REB_TP:V09_TP_PCT;
        const risk=v9risk(balance,reg,dir);
        const next=d.candles[i+1]; if(!next) continue;
        const entry=next.open;
        const sl=dir==='LONG'?entry*(1-slPct_):entry*(1+slPct_);
        const tp=dir==='LONG'?entry*(1+tpPct_):entry*(1-tpPct_);
        const size=risk/slPct_;
        open.set(sym,{dir,entry,sl,tp,size,slPct:slPct_,tpPct:tpPct_,type});
      }
    }
  }

  for(const [sym,pos] of open){
    const d=allData.find(x=>x.symbol===sym);
    const last=d.candles[d.candles.length-1];
    const{dir,entry,size}=pos;
    const pnl=dir==='LONG'?(last.close-entry)/entry*size:(entry-last.close)/entry*size;
    balance+=pnl;
    const m=ym(last.time); ensureM(m,balance);
    monthly[m].pnl+=pnl;monthly[m].trades++;monthly[m].balEnd=balance;
    if(pnl>0)monthly[m].wins++;else monthly[m].losses++;
    trades.push({sym,dir,won:pnl>0,pnl});
  }

  let peak=START_V09,maxDD=0,run=START_V09;
  for(const t of trades){run+=t.pnl;if(run>peak)peak=run;const d=(peak-run)/peak*100;if(d>maxDD)maxDD=d;}

  const months=Object.keys(monthly).sort(); let prev=START_V09;
  for(const m of months){monthly[m].balStart=prev;prev=monthly[m].balEnd;}

  return{trades,monthly,finalBalance:balance,maxDD};
}

// ══════════════════════════════════════════════════════════════════════════════
// COMBINED MONTHLY MERGE
// ══════════════════════════════════════════════════════════════════════════════

function combineMonthly(dtMonthly, v09Monthly, dtStart, v09Start) {
  const allM=[...new Set([...Object.keys(dtMonthly),...Object.keys(v09Monthly)])].sort();
  const combined={};
  let dtBal=dtStart, v09Bal=v09Start;
  for(const m of allM){
    const dt=dtMonthly[m]||{pnl:0,trades:0,wins:0,losses:0,balEnd:dtBal};
    const v9=v09Monthly[m]||{pnl:0,trades:0,wins:0,losses:0,balEnd:v09Bal};
    dtBal=dt.balEnd??dtBal; v09Bal=v9.balEnd??v09Bal;
    combined[m]={
      pnl:dt.pnl+v9.pnl, trades:dt.trades+v9.trades,
      wins:dt.wins+v9.wins, losses:dt.losses+v9.losses,
      dtPnl:dt.pnl, v9Pnl:v9.pnl,
      dtBal, v09Bal, totalBal:dtBal+v09Bal,
      dtTrades:dt.trades, v9Trades:v9.trades,
    };
  }
  return combined;
}

// ══════════════════════════════════════════════════════════════════════════════
// FORMATTING
// ══════════════════════════════════════════════════════════════════════════════

const MN=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmtMon=ym=>{const[yr,mo]=ym.split("-");return`${MN[parseInt(mo)-1]} ${yr}`;};
const fmtB=n=>"$"+n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,",");
const fmtU=n=>(n>=0?"+$":"-$")+Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,",");
const fmtP=n=>(n>=0?"+":"")+n.toFixed(1)+"%";
const pStr=p=>(p>=0?"+$":"-$")+Math.abs(p).toFixed(0);

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

(async()=>{
  const BAR="═".repeat(132);
  console.log(`\n${BAR}`);
  console.log(`  COMBINED PORTFOLIO BACKTEST — Old vs New  |  ${DAYS} days  |  $${START_EACH.toLocaleString()}/bot ($${START_TOTAL.toLocaleString()} total)`);
  console.log(`  OLD: DT (MH=8, all sessions)  +  v09 (unchanged)`);
  console.log(`  NEW: DT (MH=12, no Asia)       +  v09 (unchanged)`);
  console.log(`${BAR}\n`);

  // ── Fetch DT candles ────────────────────────────────────────────────────────
  console.log(`Fetching 15m candles (DT pairs)...`);
  const dtCandles={};
  for(const sym of DT_PAIRS){
    process.stdout.write(`  ${sym.padEnd(10)}`);
    dtCandles[sym]=await fetch15m(sym,DAYS);
    console.log(`${dtCandles[sym].length} bars`);
  }
  const dtPre={};
  for(const sym of DT_PAIRS) dtPre[sym]=dtPrecompute(sym,dtCandles[sym]);

  // ── Fetch v09 candles ────────────────────────────────────────────────────────
  console.log(`\nFetching 4H candles (v09 pairs)...`);
  const v09Data=[];
  for(const sym of V09_PAIRS){
    process.stdout.write(`  ${sym.padEnd(14)}`);
    try{
      const candles=await fetch4h(sym);
      if(candles.length<50){console.log(`skip`);continue;}
      const closes=candles.map(c=>c.close),vols=candles.map(c=>c.volume);
      v09Data.push({symbol:sym,candles,closes,
        e21:v9ema(closes,21),e50:v9ema(closes,50),e200:v9ema(closes,200),
        rsi14:v9rsi(closes),mc:v9macd(closes),vsma:v9sma(vols,20)});
      console.log(`${candles.length} bars`);
    }catch(e){console.log(`error`);}
    await delay(100);
  }

  // ── Run simulations ─────────────────────────────────────────────────────────
  console.log(`\nRunning simulations...`);
  process.stdout.write(`  DT OLD (MH=8, all sessions)...  `);
  const dtOld=runDT(dtCandles,dtPre,{maxHold:8,blockAsia:false});
  console.log(`${dtOld.trades.length} trades → ${fmtB(dtOld.finalBalance)} (${fmtP((dtOld.finalBalance-START_EACH)/START_EACH*100)})`);

  process.stdout.write(`  DT NEW (MH=12, no Asia)...      `);
  const dtNew=runDT(dtCandles,dtPre,{maxHold:12,blockAsia:true});
  console.log(`${dtNew.trades.length} trades → ${fmtB(dtNew.finalBalance)} (${fmtP((dtNew.finalBalance-START_EACH)/START_EACH*100)})`);

  process.stdout.write(`  v09 (unchanged both)...         `);
  const v09=runV09(v09Data);
  console.log(`${v09.trades.length} trades → ${fmtB(v09.finalBalance)} (${fmtP((v09.finalBalance-START_V09)/START_V09*100)})`);

  // Combine
  const oldCombined=combineMonthly(dtOld.monthly,v09.monthly,START_DT,START_V09);
  const newCombined=combineMonthly(dtNew.monthly,v09.monthly,START_DT,START_V09);
  const oldFinal=dtOld.finalBalance+v09.finalBalance;
  const newFinal=dtNew.finalBalance+v09.finalBalance;

  // ══════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n${BAR}`);
  console.log("  PORTFOLIO SUMMARY");
  console.log(`${BAR}`);
  console.log(`\n  ${"".padEnd(28)} ${"OLD PORTFOLIO".padEnd(26)} ${"NEW PORTFOLIO".padEnd(26)}`);
  console.log(`  ${"─".repeat(82)}`);

  const oV9W=v09.trades.filter(t=>t.won).length,nV9W=oV9W;
  const oV9gw=v09.trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
  const oV9gl=Math.abs(v09.trades.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0));
  const v09PF=oV9gl?oV9gw/oV9gl:Infinity;

  const odW=dtOld.trades.filter(t=>t.pnl>=0).length,ndW=dtNew.trades.filter(t=>t.pnl>=0).length;
  const odGW=dtOld.trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
  const odGL=Math.abs(dtOld.trades.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0));
  const ndGW=dtNew.trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
  const ndGL=Math.abs(dtNew.trades.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0));

  const oAllT=dtOld.trades.length+v09.trades.length,nAllT=dtNew.trades.length+v09.trades.length;
  const oAllW=odW+oV9W,nAllW=ndW+nV9W;
  const oGW=odGW+oV9gw,oGL=odGL+oV9gl,nGW=ndGW+oV9gw,nGL=ndGL+oV9gl;

  const rows=[
    ["Total starting capital",   fmtB(START_TOTAL),                     fmtB(START_TOTAL)],
    ["DT final balance",         fmtB(dtOld.finalBalance),               fmtB(dtNew.finalBalance)],
    ["v09 final balance",        fmtB(v09.finalBalance),                 fmtB(v09.finalBalance)],
    ["Combined final balance",   fmtB(oldFinal),                         fmtB(newFinal)],
    ["Combined P&L",             fmtU(oldFinal-START_TOTAL),             fmtU(newFinal-START_TOTAL)],
    ["Combined return",          fmtP((oldFinal-START_TOTAL)/START_TOTAL*100), fmtP((newFinal-START_TOTAL)/START_TOTAL*100)],
    ["Total trades",             String(oAllT),                          String(nAllT)],
    ["Combined win rate",        (oAllW/oAllT*100).toFixed(1)+"%",       (nAllW/nAllT*100).toFixed(1)+"%"],
    ["Combined profit factor",   (oGW/oGL).toFixed(2),                   (nGW/nGL).toFixed(2)],
    ["DT max drawdown",          dtOld.maxDD.toFixed(1)+"%",             dtNew.maxDD.toFixed(1)+"%"],
    ["v09 max drawdown",         v09.maxDD.toFixed(1)+"%",               v09.maxDD.toFixed(1)+"%"],
  ];
  for(const [label,a,b] of rows){
    const vA=parseFloat(a.replace(/[+$,%]/g,"")),vB=parseFloat(b.replace(/[+$,%]/g,""));
    const better=!label.includes("drawdown")&&!label.includes("SL");
    const arrow=(!isNaN(vA)&&!isNaN(vB)&&Math.abs(vB-vA)>0.05)?((better?vB>vA:vB<vA)?"  ✅":"  ❌"):"";
    console.log(`  ${label.padEnd(28)} ${String(a).padEnd(26)} ${String(b).padEnd(26)}${arrow}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MONTH-BY-MONTH
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n\n${BAR}`);
  console.log("  MONTH-BY-MONTH — COMBINED PORTFOLIO");
  console.log(`${BAR}`);

  const allMonths=[...new Set([...Object.keys(oldCombined),...Object.keys(newCombined)])].sort();

  console.log(`
  ${"".padEnd(10)} ${"──── OLD PORTFOLIO ($10k) ──────────────────────────────────────────────────────────"}  │  ${"──── NEW PORTFOLIO ($10k) ────────────────────────────────────────────────────────────"}
  ${"Month".padEnd(10)} ${"Tr".padStart(4)} ${"W".padStart(3)} ${"DT P&L".padStart(10)} ${"v09 P&L".padStart(10)} ${"Total P&L".padStart(11)} ${"Mon%".padStart(6)} ${"Portfolio".padStart(12)} ${"CumRet%".padStart(9)}  │  ${"Tr".padStart(4)} ${"W".padStart(3)} ${"DT P&L".padStart(10)} ${"v09 P&L".padStart(10)} ${"Total P&L".padStart(11)} ${"Mon%".padStart(6)} ${"Portfolio".padStart(12)} ${"CumRet%".padStart(9)}  │ Diff`);
  console.log("  "+"─".repeat(129));

  let oBal=START_TOTAL,nBal=START_TOTAL;
  let oTotPnl=0,nTotPnl=0,oTotTr=0,nTotTr=0,oTotW=0,nTotW=0;

  for(const m of allMonths){
    const O=oldCombined[m]||{pnl:0,trades:0,wins:0,dtPnl:0,v9Pnl:0,totalBal:oBal};
    const N=newCombined[m]||{pnl:0,trades:0,wins:0,dtPnl:0,v9Pnl:0,totalBal:nBal};
    const oMonBal=O.totalBal??oBal, nMonBal=N.totalBal??nBal;
    const oPct=oBal>0?(O.pnl/oBal*100):0, nPct=nBal>0?(N.pnl/nBal*100):0;
    const oCum=(oMonBal-START_TOTAL)/START_TOTAL*100, nCum=(nMonBal-START_TOTAL)/START_TOTAL*100;
    oBal=oMonBal; nBal=nMonBal;
    oTotPnl+=O.pnl; nTotPnl+=N.pnl;
    oTotTr+=O.trades; nTotTr+=N.trades;
    oTotW+=O.wins; nTotW+=N.wins;
    const diff=N.pnl-O.pnl;
    const diffIcon=diff>100?" ✅":diff<-100?" ❌":"  →";

    console.log(
      `  ${fmtMon(m).padEnd(10)}`
      +` ${String(O.trades).padStart(4)} ${String(O.wins).padStart(3)}`
      +` ${pStr(O.dtPnl).padStart(10)} ${pStr(O.v9Pnl).padStart(10)} ${pStr(O.pnl).padStart(11)}`
      +` ${fmtP(oPct).padStart(6)} ${fmtB(oMonBal).padStart(12)} ${fmtP(oCum).padStart(9)}`
      +`  │  `
      +` ${String(N.trades).padStart(4)} ${String(N.wins).padStart(3)}`
      +` ${pStr(N.dtPnl).padStart(10)} ${pStr(N.v9Pnl).padStart(10)} ${pStr(N.pnl).padStart(11)}`
      +` ${fmtP(nPct).padStart(6)} ${fmtB(nMonBal).padStart(12)} ${fmtP(nCum).padStart(9)}`
      +`  │ ${pStr(diff)}${diffIcon}`
    );
  }

  console.log("  "+"─".repeat(129));
  const oFCum=(oBal-START_TOTAL)/START_TOTAL*100, nFCum=(nBal-START_TOTAL)/START_TOTAL*100;
  console.log(
    `  ${"TOTAL".padEnd(10)}`
    +` ${String(oTotTr).padStart(4)} ${String(oTotW).padStart(3)}`
    +` ${"".padStart(10)} ${"".padStart(10)} ${fmtU(oTotPnl).padStart(11)}`
    +` ${fmtP(oFCum).padStart(6)} ${fmtB(oBal).padStart(12)} ${fmtP(oFCum).padStart(9)}`
    +`  │  `
    +` ${String(nTotTr).padStart(4)} ${String(nTotW).padStart(3)}`
    +` ${"".padStart(10)} ${"".padStart(10)} ${fmtU(nTotPnl).padStart(11)}`
    +` ${fmtP(nFCum).padStart(6)} ${fmtB(nBal).padStart(12)} ${fmtP(nFCum).padStart(9)}`
    +`  │ ${fmtU(nTotPnl-oTotPnl)}${nTotPnl>oTotPnl?" ✅":" ❌"}`
  );

  // ══════════════════════════════════════════════════════════════════════════
  // PER-BOT BREAKDOWN
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n\n${BAR}`);
  console.log("  PER-BOT BREAKDOWN");
  console.log(`${BAR}`);
  console.log(`\n  ${"Bot".padEnd(12)} ${"Trades".padStart(7)} ${"WR%".padStart(6)} ${"PF".padStart(6)} ${"Return%".padStart(9)} ${"P&L".padStart(12)} ${"Final Bal".padStart(12)}`);
  console.log(`  ${"─".repeat(70)}`);
  for(const [label,sim,start] of [["DT OLD",dtOld,START_DT],["DT NEW",dtNew,START_DT],["v09",v09,START_V09]]){
    const w=sim.trades.filter(t=>t.pnl!=null?t.pnl>=0:t.won).length;
    const gw=sim.trades.filter(t=>(t.pnl!=null?t.pnl:0)>0).reduce((s,t)=>s+(t.pnl||0),0);
    const gl=Math.abs(sim.trades.filter(t=>(t.pnl!=null?t.pnl:0)<0).reduce((s,t)=>s+(t.pnl||0),0));
    const wr=sim.trades.length?(w/sim.trades.length*100).toFixed(1)+"%":"-";
    const pf=gl?(gw/gl).toFixed(2):"∞";
    const ret=((sim.finalBalance-start)/start*100).toFixed(1)+"%";
    const pnl=fmtU(sim.finalBalance-start);
    console.log(`  ${label.padEnd(12)} ${String(sim.trades.length).padStart(7)} ${wr.padStart(6)} ${pf.padStart(6)} ${(ret.startsWith("+")?ret:ret).padStart(9)} ${pnl.padStart(12)} ${fmtB(sim.finalBalance).padStart(12)}`);
  }

  console.log(`\n${BAR}\n`);
})();
