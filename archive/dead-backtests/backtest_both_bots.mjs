/**
 * backtest_both_bots.mjs — v09 (4H) + DT v01 (15m) from one shared pool
 *
 * Both bots run concurrently, drawing from the same balance.
 *
 * v09 : Top-30 curated · 4H candles · 1.5x leverage · max 10 positions
 *       Signals: Breakout LONG · Breakdown SHORT · RSI Rebound
 *       SL 6.5% / TP 23%   (Rebound: SL 3.5% / TP 22%)
 *
 * DT  : BTC BNB XRP SUI · 15m candles · 5x leverage · max 4 positions
 *       Signals: EMA21 Recapture/Rejection + EMA50 Bounce (BTC/SUI only)
 *       SL swing low/high (max 1.2%) · TP 1.3× risk · max 8 bars
 *
 * Run : node backtest_both_bots.mjs [DAYS] [START_BAL]
 *    eg: node backtest_both_bots.mjs 365 5000
 */

const DAYS      = parseInt(process.argv[2]  || "365");
const START_BAL = parseFloat(process.argv[3] || "5000");

// ── v09 config ────────────────────────────────────────────────────────────────
const V09_RISK_PCT       = 0.008;
const V09_LEVERAGE       = 1.5;
const V09_MAX_POS        = 10;
const V09_SL_PCT         = 0.065;
const V09_TP_PCT         = 0.23;
const V09_TRAIL_PCT      = 0.19;
const V09_REB_SL_PCT     = 0.035;
const V09_REB_TP_PCT     = 0.22;
const V09_BO_RSI_MIN     = 54;
const V09_BO_RSI_MAX     = 65;
const V09_BO_LOOKBACK    = 30;
const V09_TRAIL_BULL_PCT = 60;

const V09_PAIRS = [
  "KAIAUSDT","SUSDT","FILUSDT","ARUSDT","PLUMEUSDT","FIDAUSDT","GMTUSDT",
  "ENAUSDT","TIAUSDT","TURBOUSDT","WIFUSDT","SHIBUSDT","BCHUSDT","VETUSDT",
  "ONDOUSDT","THETAUSDT","HBARUSDT","RUNEUSDT","IOTAUSDT","JUPUSDT",
  "FLUXUSDT","WUSDT","CATIUSDT","ZKUSDT","KAITOUSDT","WLDUSDT","AIXBTUSDT",
  "LAUSDT","JASMYUSDT","HOMEUSDT",
];

// ── DT config ─────────────────────────────────────────────────────────────────
const DT_RISK_PCT    = 0.008;
const DT_LEVERAGE    = 5;
const DT_MAX_POS     = 6;
const DT_MAX_SL_PCT  = 0.012;
const DT_RR          = 1.3;
const DT_MAX_HOLD    = 8;
const DT_EMA50_PAIRS = new Set(["BTCUSDT","SUIUSDT"]);
const DT_PAIRS       = ["BTCUSDT","BNBUSDT","XRPUSDT","SUIUSDT","LTCUSDT","AVAXUSDT"];

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, days) {
  const msPerBar = interval === "4h" ? 4*60*60*1000 : 15*60*1000;
  const bpd      = interval === "4h" ? 6 : 96;
  const needed   = days * bpd;
  const batches  = Math.ceil(needed / 1000);
  const all      = [];
  let   endTime  = Date.now();
  for (let b = 0; b < batches; b++) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1000&endTime=${endTime}`;
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

// ─── Indicators ───────────────────────────────────────────────────────────────

function ema(values, period) {
  const k = 2/(period+1), out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i]*k + out[i-1]*(1-k));
  return out;
}
function sma(values, period) {
  return values.map((_, i) =>
    i < period-1 ? null : values.slice(i-period+1, i+1).reduce((a,b)=>a+b,0)/period);
}
function rsi14(closes) {
  const out = new Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i <= 14; i++) { const d = closes[i]-closes[i-1]; d>0?g+=d:l-=d; }
  out[14] = l===0?100:100-100/(1+g/l);
  for (let i = 15; i < closes.length; i++) {
    const d = closes[i]-closes[i-1];
    if (d>0){g=(g*13+d)/14;l=l*13/14;}else{g=g*13/14;l=(l*13-d)/14;}
    out[i] = l===0?100:100-100/(1+g/l);
  }
  return out;
}
function macdCalc(closes) {
  const fast=ema(closes,12), slow=ema(closes,26);
  const line=closes.map((_,i)=>fast[i]-slow[i]);
  const sig=[line[0]], k=2/10;
  for (let i=1; i<closes.length; i++) sig.push(line[i]*k+sig[i-1]*(1-k));
  return { line, signal:sig, hist:line.map((v,i)=>v-sig[i]) };
}
function vwapCalc(candles) {
  const out=[]; let cumPV=0, cumVol=0;
  let day=new Date(candles[0].time); day.setUTCHours(0,0,0,0);
  for (const c of candles) {
    const cd=new Date(c.time); cd.setUTCHours(0,0,0,0);
    if (cd.getTime()!==day.getTime()){cumPV=0;cumVol=0;day=cd;}
    const tp=(c.high+c.low+c.close)/3;
    cumPV+=tp*c.volume; cumVol+=c.volume;
    out.push(cumVol>0?cumPV/cumVol:c.close);
  }
  return out;
}
// ADX (Wilder, period=14) — measures trend strength, not direction.
// Values > 20 = trending market. Values < 20 = choppy/ranging.
function adxCalc(candles, period=14) {
  const n=candles.length, out=new Array(n).fill(null);
  const tr=[],pdm=[],ndm=[];
  for (let i=1;i<n;i++){
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

// ─── v09 indicator + signal ───────────────────────────────────────────────────

function v09Precompute(candles) {
  const closes=candles.map(c=>c.close), vols=candles.map(c=>c.volume);
  return { closes, vols, candles,
    e21:ema(closes,21), e50:ema(closes,50), e200:ema(closes,200),
    rsiV:rsi14(closes), mc:macdCalc(closes), vsma:sma(vols,20) };
}

function v09Regime(i, pre) {
  const {closes,e21,e50,e200}=pre;
  if(!e200[i]||!e50[i]||!e21[i]) return "neutral";
  const c=closes[i]; let s=0;
  if(c>e200[i])s++;else s--; if(c>e50[i])s++;else s--; if(c>e21[i])s++;else s--;
  if(e21[i]>e50[i])s++;else s--; if(e50[i]>e200[i])s++;else s--;
  return s>=4?"bull":s<=-4?"bear":"neutral";
}

function v09Signal(pre, i) {
  if (i < 210) return null;
  const {closes,vols,e21,e50,rsiV,mc,vsma}=pre;
  const c=closes[i], rNow=rsiV[i], rPrv=rsiV[i-1], vol=vols[i];
  if (rNow==null||rPrv==null||vsma[i]==null) return null;
  const reg=v09Regime(i,pre);
  const highN=Math.max(...closes.slice(Math.max(0,i-V09_BO_LOOKBACK),i));
  const trendUp=e21[i]>e50[i]&&e21[i]>e21[i-1]&&e21[i-1]>e21[i-3];
  const longSig=c>highN&&trendUp&&rNow>=V09_BO_RSI_MIN&&rNow<=V09_BO_RSI_MAX&&vol>vsma[i]*1.5;
  const wasOB=[1,2,3,4,5].some(k=>rsiV[i-k]!=null&&rsiV[i-k]>=65);
  const rsiBrk=rPrv>=58&&rNow<58, macdBrk=mc.hist[i-1]>=0&&mc.hist[i]<0;
  const shortSig=wasOB&&(rsiBrk||macdBrk)&&c<e21[i]&&rNow>35&&vol>vsma[i]*1.2;
  const wasOS=[1,2,3].some(k=>rsiV[i-k]!=null&&rsiV[i-k]<=20);
  const longReb=wasOS&&rPrv<=30&&rNow>30&&reg==="bull"&&c>e21[i]*0.92&&vol>vsma[i]&&!longSig;
  const wasOvrt=[1,2,3].some(k=>rsiV[i-k]!=null&&rsiV[i-k]>=80);
  const shortReb=wasOvrt&&rPrv>=70&&rNow<70&&reg!=="bull"&&c<e21[i]*1.08&&vol>vsma[i]&&!shortSig;
  return { longSig, shortSig, longReb, shortReb, regime:reg, price:c };
}

// ─── DT indicator + signal ────────────────────────────────────────────────────

// Session ORB bias: track first ORB break per session to get directional bias
const DT_ORB_OPENS = new Set([1, 8, 13]);
function dtORBBias(candles) {
  const out=new Array(candles.length).fill(null);
  let building=false, orbH=-Infinity, orbL=Infinity, confirmed=null, bias=null;
  for (let j=0;j<candles.length;j++) {
    const c=candles[j], h=new Date(c.time).getUTCHours(), m=new Date(c.time).getUTCMinutes();
    if (DT_ORB_OPENS.has(h)&&m===0) { building=true; orbH=c.high; orbL=c.low; confirmed=null; bias=null; }
    else if (building) { orbH=Math.max(orbH,c.high); orbL=Math.min(orbL,c.low); confirmed={high:orbH,low:orbL}; building=false; }
    if (confirmed&&bias===null) { if(c.close>confirmed.high) bias='LONG'; else if(c.close<confirmed.low) bias='SHORT'; }
    out[j]=confirmed?bias:null;
  }
  return out;
}

function dtPrecompute(symbol, candles) {
  const closes=candles.map(c=>c.close), vols=candles.map(c=>c.volume);
  return { symbol, closes, candles,
    e21:ema(closes,21), e50:ema(closes,50),
    rsiV:rsi14(closes), vsma:sma(vols,20),
    adx:adxCalc(candles), orbBias:dtORBBias(candles) };
}

function dtSignal(pre, i) {
  if (i < 70) return null;
  const {symbol,candles,e21,e50,rsiV,vsma,adx,orbBias}=pre;
  const c=candles[i], p=candles[i-1], r=rsiV[i];
  if (!r||!vsma[i]) return null;
  const h=new Date(c.time).getUTCHours();
  if (!(h>=1&&h<22)) return null;
  if (!adx[i] || adx[i] < 20) return null;
  // Session ORB bias: skip if no bias yet (session still inside ORB range)
  const bias=orbBias[i];
  if (!bias) return null;
  const volOk=c.volume>vsma[i]*1.2;
  const tb=4;
  if(i<tb) return null;
  const e50Up=e50[i]>e50[i-tb], e50Dn=e50[i]<e50[i-tb];
  if(bias==='LONG') {
    if(e50Up&&r>=40&&r<65&&volOk&&p.close<e21[i-1]&&c.close>e21[i]){
      const sl=Math.min(...candles.slice(Math.max(0,i-3),i+1).map(x=>x.low));
      const risk=c.close-sl;
      if(risk>0&&risk/c.close<DT_MAX_SL_PCT)
        return{direction:"LONG",signal:"EMA21",entry:c.close,sl,tp:c.close+risk*DT_RR};
    }
    if(DT_EMA50_PAIRS.has(symbol)&&e50Up&&r>=38&&r<62&&volOk&&p.close<e50[i-1]&&c.close>e50[i]){
      const sl=Math.min(...candles.slice(Math.max(0,i-4),i+1).map(x=>x.low));
      const risk=c.close-sl;
      if(risk>0&&risk/c.close<0.018)
        return{direction:"LONG",signal:"EMA50",entry:c.close,sl,tp:c.close+risk*DT_RR};
    }
  }
  if(bias==='SHORT') {
    if(e50Dn&&r>35&&r<=60&&volOk&&p.close>e21[i-1]&&c.close<e21[i]){
      const sl=Math.max(...candles.slice(Math.max(0,i-3),i+1).map(x=>x.high));
      const risk=sl-c.close;
      if(risk>0&&risk/c.close<DT_MAX_SL_PCT)
        return{direction:"SHORT",signal:"EMA21",entry:c.close,sl,tp:c.close-risk*DT_RR};
    }
    if(DT_EMA50_PAIRS.has(symbol)&&e50Dn&&r>38&&r<=62&&volOk&&p.close>e50[i-1]&&c.close<e50[i]){
      const sl=Math.max(...candles.slice(Math.max(0,i-4),i+1).map(x=>x.high));
      const risk=sl-c.close;
      if(risk>0&&risk/c.close<0.018)
        return{direction:"SHORT",signal:"EMA50",entry:c.close,sl,tp:c.close-risk*DT_RR};
    }
  }
  return null;
}

// ─── Combined simulation ───────────────────────────────────────────────────────

function simulate(v09Candles, v09Pre, dtCandles, dtSignals) {
  const MS_4H=4*60*60*1000, MS_15M=15*60*1000;

  // Index all candles by time
  const v09ByTime={}, v09Idx={};
  for (const [sym,bars] of Object.entries(v09Candles)) {
    v09ByTime[sym]={}; v09Idx[sym]={};
    bars.forEach((c,i)=>{v09ByTime[sym][c.time]=c;v09Idx[sym][c.time]=i;});
  }
  const dtByTime={}, dtIdx={};
  for (const [sym,bars] of Object.entries(dtCandles)) {
    dtByTime[sym]={}; dtIdx[sym]={};
    bars.forEach((c,i)=>{dtByTime[sym][c.time]=c;dtIdx[sym][c.time]=i;});
  }

  // Build 15m timeline
  const allTimes=new Set();
  for (const bars of Object.values(dtCandles)) for (const c of bars) allTimes.add(c.time);
  const sortedTimes=[...allTimes].sort((a,b)=>a-b);

  let balance=START_BAL, peak=START_BAL, maxDD=0, maxDDdollar=0;
  const v09Open={}, dtOpen={}, trades=[];

  function updateDD(){
    if(balance>peak)peak=balance;
    const dd=(peak-balance)/peak*100;
    if(dd>maxDD)maxDD=dd;
    if(peak-balance>maxDDdollar)maxDDdollar=peak-balance;
  }

  let bullPct=0;

  for (const t of sortedTimes) {

    // ── DT exits ──────────────────────────────────────────────────────────────
    for (const [sym,pos] of Object.entries(dtOpen)) {
      const c=dtByTime[sym]?.[t]; if(!c) continue;
      const isL=pos.direction==="LONG";
      const hitTP=isL?c.high>=pos.tp:c.low<=pos.tp;
      const hitSL=isL?c.low<=pos.sl:c.high>=pos.sl;
      const bars=Math.round((t-pos.entryTime)/MS_15M);
      let xr=null,xp=null;
      if(hitSL&&hitTP){xr="SL";xp=pos.sl;}
      else if(hitSL){xr="SL";xp=pos.sl;}
      else if(hitTP){xr="TP";xp=pos.tp;}
      else if(bars>=DT_MAX_HOLD){xr="TIME";xp=c.close;}
      if(xr){
        const movePct=isL?(xp-pos.entry)/pos.entry:(pos.entry-xp)/pos.entry;
        const slPct=Math.abs(pos.entry-pos.sl)/pos.entry;
        const pnl=slPct>0?(movePct/slPct)*pos.riskUSD*DT_LEVERAGE:0;
        balance+=pnl; updateDD();
        trades.push({strategy:"DT",sym,dir:pos.direction,signal:pos.signal,
          entry:pos.entry,exit:xp,pnl,exitReason:xr,ts:t});
        delete dtOpen[sym];
      }
    }

    // ── DT entries ────────────────────────────────────────────────────────────
    if(Object.keys(dtOpen).length<DT_MAX_POS){
      for (const sym of DT_PAIRS){
        if(dtOpen[sym]) continue;
        const idx=dtIdx[sym]?.[t]; if(idx==null) continue;
        const sig=dtSignals[sym][idx]; if(!sig) continue;
        dtOpen[sym]={...sig,riskUSD:balance*DT_RISK_PCT,entryTime:t};
      }
    }

    // ── Only process v09 at 4H boundaries ─────────────────────────────────────
    if((t+MS_15M)%MS_4H!==0) continue;
    const fourHOpen=t+MS_15M-MS_4H;

    // Recompute bull pct
    let bulls=0,tot=0;
    for(const sym of Object.keys(v09Candles)){
      const idx4=v09Idx[sym]?.[fourHOpen]; if(idx4==null||idx4<210) continue;
      tot++;
      const sig=v09Signal(v09Pre[sym],idx4);
      if(sig?.regime==="bull") bulls++;
    }
    bullPct=tot>0?bulls/tot*100:0;
    const useTrail=bullPct>=V09_TRAIL_BULL_PCT;

    // ── v09 exits ─────────────────────────────────────────────────────────────
    for (const [sym,pos] of Object.entries(v09Open)){
      const c4=v09ByTime[sym]?.[fourHOpen]; if(!c4) continue;
      const isL=pos.dir==="LONG";
      if(pos.trailing){
        if(isL&&c4.high>pos.trailHigh){pos.trailHigh=c4.high;pos.sl=c4.high*(1-V09_TRAIL_PCT);}
        else if(!isL&&c4.low<pos.trailLow){pos.trailLow=c4.low;pos.sl=c4.low*(1+V09_TRAIL_PCT);}
      }
      const hitSL=isL?c4.low<=pos.sl:c4.high>=pos.sl;
      const hitTP=!pos.trailing&&(isL?c4.high>=pos.tp:c4.low<=pos.tp);
      if(hitSL){
        const pnl=isL?(pos.sl-pos.entry)/pos.entry*pos.size*V09_LEVERAGE
                     :(pos.entry-pos.sl)/pos.entry*pos.size*V09_LEVERAGE;
        balance+=pnl; updateDD();
        trades.push({strategy:"V09",sym,dir:pos.dir,signal:pos.signal,
          entry:pos.entry,exit:pos.sl,pnl,exitReason:pos.trailing?"TRAIL_SL":"SL",ts:t});
        delete v09Open[sym];
      } else if(hitTP){
        if(!useTrail||pos.noTrail){
          const pnl=isL?(pos.tp-pos.entry)/pos.entry*pos.size*V09_LEVERAGE
                       :(pos.entry-pos.tp)/pos.entry*pos.size*V09_LEVERAGE;
          balance+=pnl; updateDD();
          trades.push({strategy:"V09",sym,dir:pos.dir,signal:pos.signal,
            entry:pos.entry,exit:pos.tp,pnl,exitReason:"TP",ts:t});
          delete v09Open[sym];
        } else {
          pos.trailing=true; pos.trailHigh=c4.close; pos.trailLow=c4.close;
          pos.sl=isL?c4.close*(1-V09_TRAIL_PCT):c4.close*(1+V09_TRAIL_PCT);
        }
      }
    }

    // ── v09 entries ───────────────────────────────────────────────────────────
    if(Object.keys(v09Open).length<V09_MAX_POS){
      const sigs=[];
      for(const sym of Object.keys(v09Candles)){
        if(v09Open[sym]) continue;
        const idx4=v09Idx[sym]?.[fourHOpen]; if(idx4==null||idx4<210) continue;
        const sig=v09Signal(v09Pre[sym],idx4); if(sig) sigs.push({sym,...sig});
      }
      for(const sig of sigs){
        if(Object.keys(v09Open).length>=V09_MAX_POS) break;
        if(v09Open[sig.sym]) continue;
        let dir=null,signal=null,slPct=V09_SL_PCT,tpPct=V09_TP_PCT,noTrail=false;
        if(sig.longSig){dir="LONG";signal="Breakout";}
        else if(sig.shortSig){dir="SHORT";signal="Breakdown";}
        else if(sig.longReb){dir="LONG";signal="Rebound";slPct=V09_REB_SL_PCT;tpPct=V09_REB_TP_PCT;noTrail=true;}
        else if(sig.shortReb){dir="SHORT";signal="Rebound";slPct=V09_REB_SL_PCT;tpPct=V09_REB_TP_PCT;noTrail=true;}
        if(!dir) continue;
        let riskUSD=balance*V09_RISK_PCT;
        if(sig.regime==="neutral")riskUSD*=0.75;
        else if((sig.regime==="bull"&&dir==="SHORT")||(sig.regime==="bear"&&dir==="LONG"))riskUSD*=0.5;
        const entry=sig.price, size=riskUSD/slPct;
        v09Open[sig.sym]={dir,signal,entry,size,
          sl:dir==="LONG"?entry*(1-slPct):entry*(1+slPct),
          tp:dir==="LONG"?entry*(1+tpPct):entry*(1-tpPct),
          regime:sig.regime,noTrail,trailing:false,trailHigh:entry,trailLow:entry};
      }
    }
  }

  // Close remaining positions at last price
  for(const [sym,pos] of Object.entries(dtOpen)){
    const last=dtCandles[sym].at(-1);
    const isL=pos.direction==="LONG";
    const movePct=isL?(last.close-pos.entry)/pos.entry:(pos.entry-last.close)/pos.entry;
    const slPct=Math.abs(pos.entry-pos.sl)/pos.entry;
    const pnl=slPct>0?(movePct/slPct)*pos.riskUSD*DT_LEVERAGE:0;
    balance+=pnl;
    trades.push({strategy:"DT",sym,dir:pos.direction,signal:pos.signal,
      entry:pos.entry,exit:last.close,pnl,exitReason:"EOT",ts:last.time});
  }
  for(const [sym,pos] of Object.entries(v09Open)){
    const last=v09Candles[sym].at(-1);
    const isL=pos.dir==="LONG";
    const pnl=isL?(last.close-pos.entry)/pos.entry*pos.size*V09_LEVERAGE
                  :(pos.entry-last.close)/pos.entry*pos.size*V09_LEVERAGE;
    balance+=pnl;
    trades.push({strategy:"V09",sym,dir:pos.dir,signal:pos.signal,
      entry:pos.entry,exit:last.close,pnl,exitReason:"EOT",ts:last.time});
  }
  if(balance>peak)peak=balance;
  return{balance,peak,maxDD,maxDDdollar,trades};
}

// ─── Stats printer ────────────────────────────────────────────────────────────

const MN=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function printResults({balance,maxDD,maxDDdollar,trades}){
  const allW=trades.filter(t=>t.pnl>0), allL=trades.filter(t=>t.pnl<=0);
  const ret=((balance-START_BAL)/START_BAL*100).toFixed(1);
  const wr=(allW.length/trades.length*100).toFixed(1);
  const grossW=allW.reduce((s,t)=>s+t.pnl,0);
  const grossL=Math.abs(allL.reduce((s,t)=>s+t.pnl,0));
  const pf=grossL>0?(grossW/grossL).toFixed(2):"∞";
  const v09T=trades.filter(t=>t.strategy==="V09"), dtT=trades.filter(t=>t.strategy==="DT");
  const v09Pnl=v09T.reduce((s,t)=>s+t.pnl,0), dtPnl=dtT.reduce((s,t)=>s+t.pnl,0);
  const s=n=>(n>=0?"+":"")+"$"+Math.abs(n).toFixed(2);
  const SEP="═".repeat(72);

  console.log(`\n${SEP}`);
  console.log(`  COMBINED: v09 (4H·1.5x) + DT (15m·5x) — ${DAYS} days`);
  console.log(`${SEP}`);
  console.log(`  Start: $${START_BAL.toLocaleString()}  →  End: $${balance.toFixed(2)}`);
  console.log(`  Total return:   ${ret>=0?"+":""}${ret}%`);
  console.log(`  Max drawdown:   ${maxDD.toFixed(1)}%  ($${maxDDdollar.toFixed(2)})`);
  console.log(`  Total trades:   ${trades.length}  (~${(trades.length/DAYS*7).toFixed(1)}/week)`);
  console.log(`  Win rate:       ${wr}%  (${allW.length}W / ${allL.length}L)`);
  console.log(`  Profit factor:  ${pf}`);
  console.log();
  console.log(`  ── Strategy Contribution ───────────────────────────────────────`);
  const v09Wr=v09T.length?`${(v09T.filter(t=>t.pnl>0).length/v09T.length*100).toFixed(0)}% WR`:"—";
  const dtWr =dtT.length ?`${(dtT.filter(t=>t.pnl>0).length/dtT.length*100).toFixed(0)}% WR`:"—";
  console.log(`    v09 (4H · 1.5x)  ${v09T.length} trades  ${v09Wr}  P&L: ${s(v09Pnl)}`);
  console.log(`    DT  (15m · 5x)   ${dtT.length} trades  ${dtWr}  P&L: ${s(dtPnl)}`);

  // Signal breakdown
  const mkBreakdown=(ts,label)=>{
    const bySig={};
    for(const t of ts){if(!bySig[t.signal])bySig[t.signal]=[];bySig[t.signal].push(t);}
    console.log(`\n  ── ${label} ─────────────────────────────────────────────────`);
    for(const [sig,arr] of Object.entries(bySig)){
      const w=arr.filter(t=>t.pnl>0);
      const p=arr.reduce((x,t)=>x+t.pnl,0);
      console.log(`    ${sig.padEnd(12)} ${arr.length} trades  ${(w.length/arr.length*100).toFixed(0)}% WR  ${s(p)}`);
    }
  };
  mkBreakdown(v09T,"v09 Signal Breakdown");
  mkBreakdown(dtT,"DT Signal Breakdown");

  // Monthly table
  const sorted=[...trades].sort((a,b)=>a.ts-b.ts);
  const monthMap={}, monthStartBal={};
  let runBal=START_BAL, lastKey=null;
  for(const t of sorted){
    const d=new Date(t.ts);
    const key=`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
    if(key!==lastKey){monthStartBal[key]=runBal;lastKey=key;}
    if(!monthMap[key])monthMap[key]={trades:[],m:d.getUTCMonth(),y:d.getUTCFullYear()};
    monthMap[key].trades.push(t);
    runBal+=t.pnl;
  }

  console.log(`\n  ── Monthly P&L — Side by Side ───────────────────────────────────────────────────────────────────────────────────────────────────`);
  console.log(`  ${"Month".padEnd(9)} │ ${"v09 (4H·1.5x)".padEnd(38)} │ ${"DT (15m·5x)".padEnd(38)} │ Combined`);
  console.log(`  ${"─".repeat(9)} │ ${"Tr".padEnd(4)} ${"WR%".padEnd(6)} ${"P&L $".padEnd(12)} ${"Ret%".padEnd(10)} Bal │ ${"Tr".padEnd(4)} ${"WR%".padEnd(6)} ${"P&L $".padEnd(12)} ${"Ret%".padEnd(10)} Bal │ Total P&L`);
  console.log(`  ${"─".repeat(122)}`);

  let v09RunBal = START_BAL / 2;  // notional split for individual ret% context
  let dtRunBal  = START_BAL / 2;
  let combRunBal = START_BAL;

  for(const key of Object.keys(monthMap).sort()){
    const {trades:mt,m,y}=monthMap[key];
    const startB = monthStartBal[key] || START_BAL;

    const v09m = mt.filter(t=>t.strategy==="V09");
    const dtm  = mt.filter(t=>t.strategy==="DT");

    const v09pnl = v09m.reduce((x,t)=>x+t.pnl,0);
    const dtpnl  = dtm.reduce((x,t)=>x+t.pnl,0);
    const totpnl = v09pnl + dtpnl;

    const v09wr = v09m.length ? (v09m.filter(t=>t.pnl>0).length/v09m.length*100).toFixed(0)+"%" : "—";
    const dtwr  = dtm.length  ? (dtm.filter(t=>t.pnl>0).length/dtm.length*100).toFixed(0)+"%"   : "—";

    // Use actual start-of-month balance for combined return %
    const combRetPct = (totpnl/startB*100).toFixed(1);
    const endBal     = startB + totpnl;

    // Individual strategy return % relative to their share of the pool at month start
    // Approximate: assume each strategy "owns" its contribution of the pool
    const v09ret = startB > 0 ? (v09pnl/startB*100).toFixed(1) : "0.0";
    const dtret  = startB > 0 ? (dtpnl /startB*100).toFixed(1) : "0.0";

    const sp = (n,w,sign=true) => { const s=(sign&&n>=0?"+":"")+n.toFixed(2); return s.padEnd(w); };
    const lbl = `${MN[m]} ${y}`;

    console.log(
      `  ${lbl.padEnd(9)} │ ` +
      `${String(v09m.length).padEnd(4)} ${v09wr.padEnd(6)} ${sp(v09pnl,12)} ${((v09pnl>=0?"+":"")+v09ret+"%").padEnd(10)} $${(startB+v09pnl).toFixed(0).padEnd(7)} │ ` +
      `${String(dtm.length).padEnd(4)} ${dtwr.padEnd(6)} ${sp(dtpnl,12)} ${((dtpnl>=0?"+":"")+dtret+"%").padEnd(10)} $${(startB+dtpnl).toFixed(0).padEnd(7)} │ ` +
      `${(totpnl>=0?"+":"")}$${totpnl.toFixed(2)}  →  $${endBal.toFixed(2)}`
    );
  }
  console.log(`${SEP}\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`  Combined Backtest: v09 (4H) + DT v01 (15m)`);
console.log(`  ${DAYS} days · $${START_BAL.toLocaleString()} shared pool`);
console.log(`  v09: 30 pairs · 1.5x leverage · 0.8% risk · max 10 pos`);
console.log(`  DT:  4 pairs  · 5x leverage   · 0.8% risk · max 4 pos`);
console.log(`${"═".repeat(60)}\n`);

// 1. Fetch v09 4H candles
console.log(`Fetching v09 4H candles (${V09_PAIRS.length} pairs × ${DAYS+30} days)...`);
const v09Candles={};
for(const sym of V09_PAIRS){
  process.stdout.write(`  ${sym.padEnd(14)}`);
  const bars=await fetchCandles(sym,"4h",DAYS+30);
  if(bars.length>210){v09Candles[sym]=bars;console.log(`${bars.length} bars`);}
  else console.log(`skipped (${bars.length} bars)`);
}
console.log(`  Loaded ${Object.keys(v09Candles).length}/${V09_PAIRS.length} v09 pairs\n`);

// 2. Fetch DT 15m candles
console.log(`Fetching DT 15m candles (${DT_PAIRS.length} pairs × ${DAYS+5} days)...`);
const dtCandles={};
for(const sym of DT_PAIRS){
  process.stdout.write(`  ${sym.padEnd(14)}`);
  const bars=await fetchCandles(sym,"15m",DAYS+5);
  dtCandles[sym]=bars;
  console.log(`${bars.length} bars`);
}
console.log();

// 3. Pre-compute
console.log("Pre-computing indicators + DT signals...");
const v09Pre={};
for(const [sym,bars] of Object.entries(v09Candles)) v09Pre[sym]=v09Precompute(bars);
const dtPre={}, dtSignals={};
for(const sym of DT_PAIRS){
  dtPre[sym]=dtPrecompute(sym,dtCandles[sym]);
  dtSignals[sym]=new Array(dtCandles[sym].length).fill(null);
  for(let i=0;i<dtCandles[sym].length-1;i++) dtSignals[sym][i]=dtSignal(dtPre[sym],i);
  console.log(`  ${sym}: ${dtSignals[sym].filter(Boolean).length} DT signals`);
}

// 4. Simulate + print
console.log("\nRunning combined simulation...\n");
const result=simulate(v09Candles,v09Pre,dtCandles,dtSignals);
printResults(result);
