/**
 * calc_avg_duration.mjs — Average trade duration for DT and v09 strategies
 * Runs 180-day backtest for each, reports average bars held and clock time.
 * Run: node calc_avg_duration.mjs
 */

const DAYS = 180;

// ─── Shared fetch ─────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, days) {
  const msPerBar = interval === "4h" ? 4*60*60*1000 : 15*60*1000;
  const bpd      = interval === "4h" ? 6 : 96;
  const needed   = days * bpd + 300;
  const batches  = Math.ceil(needed / 1000);
  const all      = [];
  let endTime    = Date.now();
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

// ─── DT Strategy ─────────────────────────────────────────────────────────────

const DT_PAIRS    = ["BTCUSDT","BNBUSDT","XRPUSDT","SUIUSDT","LTCUSDT","AVAXUSDT"];
const DT_EMA50_P  = new Set(["BTCUSDT","SUIUSDT"]);
const DT_MAXHOLD  = 8;    // bars
const DT_MAX_SL   = 0.012;
const DT_RR       = 1.3;
const DT_RISK     = 0.008;
const DT_LEV      = 5;

function ema(vals, p) {
  const k = 2/(p+1); let s = vals[0];
  return vals.map((v,i) => { s = i===0 ? v : v*k + s*(1-k); return s; });
}
function sma(vals, p) {
  return vals.map((_,i) => i < p-1 ? null : vals.slice(i-p+1,i+1).reduce((a,b)=>a+b,0)/p);
}
function rsi14(vals) {
  const out = new Array(vals.length).fill(null);
  if (vals.length < 15) return out;
  let ag=0, al=0;
  for (let i=1;i<=14;i++) { const d=vals[i]-vals[i-1]; d>0?ag+=d:al-=d; }
  ag/=14; al/=14;
  out[14] = al===0?100:100-100/(1+ag/al);
  for (let i=15;i<vals.length;i++) {
    const d=vals[i]-vals[i-1];
    ag=(ag*13+Math.max(d,0))/14; al=(al*13+Math.max(-d,0))/14;
    out[i] = al===0?100:100-100/(1+ag/al);
  }
  return out;
}
function adxCalc(candles, period=14) {
  const n=candles.length, out=new Array(n).fill(null);
  if (n<period*2) return out;
  let tr=0,pdm=0,ndm=0;
  for (let i=1;i<=period;i++) {
    const c=candles[i],p=candles[i-1];
    tr  += Math.max(c.high-c.low, Math.abs(c.high-p.close), Math.abs(c.low-p.close));
    pdm += Math.max(c.high-p.high,0)>Math.max(p.low-c.low,0)?Math.max(c.high-p.high,0):0;
    ndm += Math.max(p.low-c.low,0)>Math.max(c.high-p.high,0)?Math.max(p.low-c.low,0):0;
  }
  let adxVal=0; const dxArr=[];
  for (let i=period+1;i<n;i++) {
    const c=candles[i],p=candles[i-1];
    const ctr=Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close));
    const cpdm=Math.max(c.high-p.high,0)>Math.max(p.low-c.low,0)?Math.max(c.high-p.high,0):0;
    const cndm=Math.max(p.low-c.low,0)>Math.max(c.high-p.high,0)?Math.max(p.low-c.low,0):0;
    tr=tr-tr/period+ctr; pdm=pdm-pdm/period+cpdm; ndm=ndm-ndm/period+cndm;
    const pdi=tr>0?pdm/tr*100:0, ndi=tr>0?ndm/tr*100:0;
    const dx=(pdi+ndi)>0?Math.abs(pdi-ndi)/(pdi+ndi)*100:0;
    dxArr.push(dx);
    if (dxArr.length===period) { adxVal=dxArr.reduce((s,x)=>s+x,0)/period; out[i]=adxVal; }
    else if (dxArr.length>period) { adxVal=(adxVal*(period-1)+dx)/period; out[i]=adxVal; }
  }
  return out;
}
function inSession(ts) { const h=new Date(ts).getUTCHours(); return h>=1&&h<22; }
const ORB_OPENS = new Set([1,8,13]);
function orbCalc(candles) {
  const out=new Array(candles.length).fill(null);
  let building=false,orbH=-Infinity,orbL=Infinity,confirmed=null,bias=null;
  for (let i=0;i<candles.length;i++) {
    const c=candles[i],h=new Date(c.time).getUTCHours(),m=new Date(c.time).getUTCMinutes();
    if (ORB_OPENS.has(h)&&m===0) { building=true;orbH=c.high;orbL=c.low;confirmed=null;bias=null; }
    else if (building) { orbH=Math.max(orbH,c.high);orbL=Math.min(orbL,c.low);confirmed={high:orbH,low:orbL};building=false; }
    if (confirmed&&bias===null) { if(c.close>confirmed.high) bias='LONG'; else if(c.close<confirmed.low) bias='SHORT'; }
    out[i]=confirmed?{...confirmed,bias}:null;
  }
  return out;
}

async function runDT() {
  process.stdout.write("DT: fetching candles...");
  const allCandles = {};
  for (const sym of DT_PAIRS) {
    allCandles[sym] = await fetchCandles(sym, "15m", DAYS);
    process.stdout.write(` ${sym.replace("USDT","")}`);
  }
  console.log();

  // Pre-compute
  const pre = {};
  for (const [sym, candles] of Object.entries(allCandles)) {
    const closes=candles.map(c=>c.close), vols=candles.map(c=>c.volume);
    pre[sym] = { candles, e21:ema(closes,21), e50:ema(closes,50), rsiV:rsi14(closes), vsma:sma(vols,20), adx:adxCalc(candles), orbs:orbCalc(candles) };
  }

  // Unified timeline
  const allTimes = new Set();
  for (const c of Object.values(allCandles)) for (const b of c) allTimes.add(b.time);
  const timeline = [...allTimes].sort((a,b)=>a-b);
  const cutoff   = timeline[timeline.length-1] - DAYS*86400000;

  const byTime={}, byIdx={};
  for (const [sym,candles] of Object.entries(allCandles)) {
    byTime[sym]={}; byIdx[sym]={};
    candles.forEach((c,i) => { byTime[sym][c.time]=c; byIdx[sym][c.time]=i; });
  }

  let balance=1000;
  const open={};
  const trades=[];

  for (const t of timeline) {
    // Exits
    for (const [sym,pos] of Object.entries(open)) {
      const c=byTime[sym]?.[t]; if (!c) continue;
      const isLong=pos.dir==="LONG";
      const hitTP=isLong?c.high>=pos.tp:c.low<=pos.tp;
      const hitSL=isLong?c.low<=pos.sl:c.high>=pos.sl;
      const bars=Math.round((t-pos.entryTime)/(15*60*1000));
      const timeEx=bars>=DT_MAXHOLD;
      let exitReason=null,exitPrice=null;
      if(hitSL&&hitTP){exitReason="SL";exitPrice=pos.sl;}
      else if(hitSL){exitReason="SL";exitPrice=pos.sl;}
      else if(hitTP){exitReason="TP";exitPrice=pos.tp;}
      else if(timeEx){exitReason="TIME";exitPrice=c.close;}
      if (exitReason) {
        const movePct=isLong?(exitPrice-pos.entry)/pos.entry:(pos.entry-exitPrice)/pos.entry;
        const slPct=Math.abs(pos.entry-pos.sl)/pos.entry;
        const pnl=slPct>0?(movePct/slPct)*pos.riskUSD*DT_LEV:0;
        balance+=pnl;
        const durationMs = t - pos.entryTime;
        trades.push({ exitReason, pnl, durationMs, bars });
        delete open[sym];
      }
    }
    if (t < cutoff) continue;
    // Entries
    for (const sym of DT_PAIRS) {
      if (open[sym]) continue;
      const c=byTime[sym]?.[t]; if (!c) continue;
      const idx=byIdx[sym][t]; if (idx == null || idx<70) continue;
      const p=pre[sym];
      const r=p.rsiV[idx], vsma=p.vsma[idx], adx=p.adx[idx], orb=p.orbs[idx];
      if (!r||!vsma||!adx||adx<20||!inSession(t)||!orb||!orb.bias) continue;
      const prev=p.candles[idx-1];
      const volOk=c.volume>vsma*1.2, tb=4;
      if (idx<tb) continue;
      const e50Up=p.e50[idx]>p.e50[idx-tb], e50Dn=p.e50[idx]<p.e50[idx-tb];
      let sig=null;
      if (orb.bias==='LONG') {
        if (!sig&&e50Up&&r>=40&&r<65&&volOk&&prev.close<p.e21[idx-1]&&c.close>p.e21[idx]) {
          const sl=Math.min(...p.candles.slice(Math.max(0,idx-3),idx+1).map(x=>x.low));
          const risk=c.close-sl;
          if(risk>0&&risk/c.close<DT_MAX_SL) sig={dir:"LONG",entry:c.close,sl,tp:c.close+risk*DT_RR};
        }
        if (!sig&&DT_EMA50_P.has(sym)&&e50Up&&r>=38&&r<62&&volOk&&prev.close<p.e50[idx-1]&&c.close>p.e50[idx]) {
          const sl=Math.min(...p.candles.slice(Math.max(0,idx-4),idx+1).map(x=>x.low));
          const risk=c.close-sl;
          if(risk>0&&risk/c.close<0.018) sig={dir:"LONG",entry:c.close,sl,tp:c.close+risk*DT_RR};
        }
      }
      if (orb.bias==='SHORT') {
        if (!sig&&e50Dn&&r>35&&r<=60&&volOk&&prev.close>p.e21[idx-1]&&c.close<p.e21[idx]) {
          const sl=Math.max(...p.candles.slice(Math.max(0,idx-3),idx+1).map(x=>x.high));
          const risk=sl-c.close;
          if(risk>0&&risk/c.close<DT_MAX_SL) sig={dir:"SHORT",entry:c.close,sl,tp:c.close-risk*DT_RR};
        }
        if (!sig&&DT_EMA50_P.has(sym)&&e50Dn&&r>38&&r<=62&&volOk&&prev.close>p.e50[idx-1]&&c.close<p.e50[idx]) {
          const sl=Math.max(...p.candles.slice(Math.max(0,idx-4),idx+1).map(x=>x.high));
          const risk=sl-c.close;
          if(risk>0&&risk/c.close<0.018) sig={dir:"SHORT",entry:c.close,sl,tp:c.close-risk*DT_RR};
        }
      }
      if (sig) open[sym]={...sig,entryTime:t,riskUSD:balance*DT_RISK};
    }
  }

  return trades;
}

// ─── v09 Strategy ─────────────────────────────────────────────────────────────
// 4H candles · SL 6.5% · TP 23% · 1.5x leverage · up to 10 positions
// Signals: Breakout LONG (30-bar high, RSI 54-65, vol 1.5x)
//          Breakdown SHORT
//          RSI Rebound LONG

const V09_PAIRS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT","ADAUSDT","DOGEUSDT",
  "AVAXUSDT","DOTUSDT","LINKUSDT","LTCUSDT","ATOMUSDT","NEARUSDT","APTUSDT",
  "ARBUSDT","OPUSDT","INJUSDT","SUIUSDT","SEIUSDT","TIAUSDT",
  "FETUSDT","RENDERUSDT","WLDUSDT","JUPUSDT","PYTHUSDT",
  "STRKUSDT","DYMUSDT","TAOUSDT","ONDOUSDT","EIGENUSDT"
];
const V09_SL    = 0.065;
const V09_TP    = 0.23;
const V09_LEV   = 1.5;
const V09_RISK  = 0.008;
const V09_MAXPOS = 10;

function macd(closes) {
  const ema12=ema(closes,12), ema26=ema(closes,26);
  const line=ema12.map((v,i)=>v-ema26[i]);
  const sig=ema(line,9);
  return {line,signal:sig,hist:line.map((v,i)=>v-sig[i])};
}

async function runV09() {
  process.stdout.write("v09: fetching 4H candles (30 pairs)...");
  const allCandles = {};
  let count = 0;
  for (const sym of V09_PAIRS) {
    const c = await fetchCandles(sym, "4h", DAYS);
    if (c && c.length > 50) { allCandles[sym]=c; count++; }
    if (count % 5 === 0) process.stdout.write(` ${count}`);
  }
  console.log(` (${count} pairs)`);

  // Pre-compute per pair
  const pre = {};
  for (const [sym, candles] of Object.entries(allCandles)) {
    const closes=candles.map(c=>c.close), vols=candles.map(c=>c.volume);
    const rsiV=rsi14(closes), vsma20=sma(vols,20);
    const high30=candles.map((_,i)=>i<30?null:Math.max(...candles.slice(i-30,i).map(x=>x.high)));
    const low30 =candles.map((_,i)=>i<30?null:Math.min(...candles.slice(i-30,i).map(x=>x.low)));
    const {hist}=macd(closes);
    pre[sym]={candles,rsiV,vsma20,high30,low30,hist};
  }

  // Unified 4H timeline
  const allTimes=new Set();
  for (const c of Object.values(allCandles)) for (const b of c) allTimes.add(b.time);
  const timeline=[...allTimes].sort((a,b)=>a-b);
  const cutoff=timeline[timeline.length-1]-DAYS*86400000;

  const byTime={}, byIdx={};
  for (const [sym,candles] of Object.entries(allCandles)) {
    byTime[sym]={}; byIdx[sym]={};
    candles.forEach((c,i)=>{ byTime[sym][c.time]=c; byIdx[sym][c.time]=i; });
  }

  let balance=10000;
  const open={};
  const trades=[];

  for (const t of timeline) {
    // Check exits
    for (const [sym,pos] of Object.entries(open)) {
      const c=byTime[sym]?.[t]; if(!c) continue;
      const isLong=pos.dir==="LONG";
      const hitTP=isLong?c.high>=pos.tp:c.low<=pos.tp;
      const hitSL=isLong?c.low<=pos.sl:c.high>=pos.sl;
      if (hitTP||hitSL) {
        const exitPrice=hitSL?pos.sl:pos.tp;
        const movePct=isLong?(exitPrice-pos.entry)/pos.entry:(pos.entry-exitPrice)/pos.entry;
        const pnl=(movePct/pos.slPct)*pos.riskUSD*V09_LEV;
        balance+=pnl;
        const bars=Math.round((t-pos.entryTime)/(4*60*60*1000));
        trades.push({ exitReason:hitSL?"SL":"TP", pnl, durationMs:t-pos.entryTime, bars });
        delete open[sym];
      }
    }
    if (t<cutoff) continue;
    if (Object.keys(open).length>=V09_MAXPOS) continue;

    // Check signals
    const h4 = new Date(t).getUTCHours();
    const isScanBar = h4===0||h4===4||h4===8||h4===12||h4===16||h4===20;
    if (!isScanBar) continue;

    for (const sym of V09_PAIRS) {
      if (open[sym]) continue;
      if (Object.keys(open).length>=V09_MAXPOS) break;
      const c=byTime[sym]?.[t]; if(!c) continue;
      const idx=byIdx[sym][t]; if(idx==null||idx<35) continue;
      const p=pre[sym];
      const r=p.rsiV[idx], vsma=p.vsma20[idx], h30=p.high30[idx], l30=p.low30[idx], hist=p.hist[idx];
      if(!r||!vsma||!h30||!l30||hist==null) continue;

      const volOk=c.volume>vsma*1.5;
      let sig=null;

      // Breakout LONG
      if (!sig&&c.close>h30&&r>=54&&r<=65&&volOk&&hist>0)
        sig={dir:"LONG",entry:c.close,sl:c.close*(1-V09_SL),tp:c.close*(1+V09_TP),slPct:V09_SL};
      // Breakdown SHORT
      if (!sig&&c.close<l30&&r>=35&&r<=46&&volOk&&hist<0)
        sig={dir:"SHORT",entry:c.close,sl:c.close*(1+V09_SL),tp:c.close*(1-V09_TP),slPct:V09_SL};
      // RSI Rebound LONG
      const prev=p.candles[idx-1]; const prevR=p.rsiV[idx-1];
      if (!sig&&prevR!=null&&prevR<32&&r>prevR&&r>=32&&r<45&&c.close>prev.close)
        sig={dir:"LONG",entry:c.close,sl:c.close*(1-V09_SL),tp:c.close*(1+V09_TP),slPct:V09_SL};

      if (sig) open[sym]={...sig,entryTime:t,riskUSD:balance*V09_RISK};
    }
  }

  return trades;
}

// ─── Report ───────────────────────────────────────────────────────────────────

function durReport(trades, barMins) {
  if (!trades.length) return;
  const byReason = { TP:[], SL:[], TIME:[], END:[] };
  for (const t of trades) (byReason[t.exitReason]||[]).push(t);

  const avgMs  = trades.reduce((s,t)=>s+t.durationMs,0)/trades.length;
  const avgBars= trades.reduce((s,t)=>s+t.bars,0)/trades.length;

  const fmtDur = ms => {
    const m=Math.round(ms/60000);
    if (m<60) return `${m} min`;
    const h=Math.floor(m/60), rm=m%60;
    if (h<24) return rm>0?`${h}h ${rm}m`:`${h}h`;
    const d=Math.floor(h/24), rh=h%24;
    return rh>0?`${d}d ${rh}h`:`${d}d`;
  };

  console.log(`  Total trades: ${trades.length}  |  Avg duration: ${fmtDur(avgMs)}  (${avgBars.toFixed(1)} bars × ${barMins}m)`);
  console.log();

  for (const [reason, ts] of Object.entries(byReason)) {
    if (!ts.length) continue;
    const avg=ts.reduce((s,t)=>s+t.durationMs,0)/ts.length;
    const avgB=ts.reduce((s,t)=>s+t.bars,0)/ts.length;
    const wins=ts.filter(t=>t.pnl>0).length;
    console.log(`  ${reason.padEnd(5)}  ${String(ts.length).padStart(3)} trades  avg ${fmtDur(avg).padEnd(8)} (${avgB.toFixed(1)} bars)`);
  }
}

async function main() {
  console.log(`\n⏱  Average Trade Duration Calculator  |  ${DAYS}-day backtest\n`);
  console.log("═".repeat(60));

  console.log("\n📊 DT Strategy  (15m bars · EMA21 · ORB bias · 6 pairs)\n");
  const dtTrades = await runDT();
  durReport(dtTrades, 15);

  console.log("\n" + "═".repeat(60));
  console.log("\n📊 v09 Strategy  (4H bars · Breakout/Rebound · 30 pairs)\n");
  const v09Trades = await runV09();
  durReport(v09Trades, 240);

  console.log("\n" + "═".repeat(60));
  console.log("\n  SUMMARY\n");
  const dtAvg  = dtTrades.reduce((s,t)=>s+t.durationMs,0)/(dtTrades.length||1);
  const v09Avg = v09Trades.reduce((s,t)=>s+t.durationMs,0)/(v09Trades.length||1);
  const fmt = ms => { const m=Math.round(ms/60000); const h=Math.floor(m/60); const d=Math.floor(h/24); return d>0?`~${d}d ${h%24}h`:`~${h}h ${m%60}m`; };
  console.log(`  DT  (15m)  avg trade length: ${fmt(dtAvg)}`);
  console.log(`  v09 (4H)   avg trade length: ${fmt(v09Avg)}`);
  console.log();
}

main().catch(console.error);
