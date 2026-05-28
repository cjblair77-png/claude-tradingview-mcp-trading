/**
 * bot_market_pulse.js — 6-hourly "what are we looking for / how close are we"
 * report for all 3 strategies. Condition-focused, not P&L-focused.
 *
 * For each strategy it reports:
 *   - What it's looking for (the setup)
 *   - How close we are (nearest pair to a trigger + why blocked if blocked)
 *   - Any active trades / pending orders
 *
 * Run: every 6h via Railway cron (0 *​/6 * * *)
 * Notify: ntfy.sh/hermes-pulse
 */

import "dotenv/config";

const GIST_ID      = process.env.GITHUB_GIST_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const NTFY_TOPIC   = process.env.PULSE_NTFY_TOPIC || "hermes-pulse";
const MEXC_BASE    = "https://contract.mexc.com";

const V09_PAIRS = [
  "KAIA_USDT","S_USDT","FILECOIN_USDT","AR_USDT","PLUME_USDT","FIDA_USDT","GMT_USDT","ENA_USDT","TIA_USDT","TURBO_USDT",
  "WIF_USDT","SHIB_USDT","BCH_USDT","VET_USDT","ONDO_USDT","THETA_USDT","HBAR_USDT","RUNE_USDT","IOTA_USDT","JUP_USDT",
  "FLUX_USDT","W_USDT","CATI_USDT","ZKSYNC_USDT","KAITO_USDT","WLD_USDT","AIXBT_USDT","LA_USDT","JASMY_USDT","HOME_USDT",
];
const DT_PAIRS = ["BTC_USDT","ETH_USDT","SOL_USDT","BNB_USDT","XRP_USDT","SUI_USDT","LTC_USDT","AVAX_USDT"];

const V09_LOOKBACK = 15;

// ── Helpers ────────────────────────────────────────────────────────────────
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
async function klines(sym, interval, limit=250){
  const url=`${MEXC_BASE}/api/v1/contract/kline/${sym}?interval=${interval}`;
  try{
    const r=await fetch(url,{signal:AbortSignal.timeout(15000)});
    const j=await r.json();
    if(!j.success||!j.data?.close?.length)return null;
    const d=j.data;
    return d.close.map((_,i)=>({t:d.time[i]*1000,o:+d.open[i],h:+d.high[i],l:+d.low[i],c:+d.close[i],v:+d.vol[i]})).slice(-limit);
  }catch{return null;}
}
function ema(v,p){if(v.length<p)return null;const k=2/(p+1);let e=v.slice(0,p).reduce((a,b)=>a+b,0)/p;for(const x of v.slice(p))e=x*k+e*(1-k);return e;}
function rsiLast(c,p=14){if(c.length<p+1)return null;let g=0,l=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];d>0?g+=d:l-=d;}let r=l===0?100:100-100/(1+g/l);for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];if(d>0){g=(g*(p-1)+d)/p;l=l*(p-1)/p;}else{g=g*(p-1)/p;l=(l*(p-1)-d)/p;}}return l===0?100:100-100/(1+g/l);}
function v09RegimeLast(c){const e21=ema(c,21),e50=ema(c,50),e200=ema(c,200);if(!e200)return"neutral";const x=c[c.length-1];let s=0;if(x>e200)s++;else s--;if(x>e50)s++;else s--;if(x>e21)s++;else s--;if(e21>e50)s++;else s--;if(e50>e200)s++;else s--;return s>=4?"bull":s<=-4?"bear":"neutral";}

async function gistFile(name){
  if(!GIST_ID||!GITHUB_TOKEN)return null;
  try{
    const r=await fetch(`https://api.github.com/gists/${GIST_ID}`,{headers:{Authorization:`token ${GITHUB_TOKEN}`,Accept:"application/vnd.github+json"},signal:AbortSignal.timeout(10000)});
    const d=await r.json();const f=d.files?.[name];return f?JSON.parse(f.content):null;
  }catch{return null;}
}
async function gistAll(){
  if(!GIST_ID||!GITHUB_TOKEN)return {};
  try{
    const r=await fetch(`https://api.github.com/gists/${GIST_ID}`,{headers:{Authorization:`token ${GITHUB_TOKEN}`,Accept:"application/vnd.github+json"},signal:AbortSignal.timeout(10000)});
    const d=await r.json();const out={};for(const k in (d.files||{})){try{out[k]=JSON.parse(d.files[k].content);}catch{}}return out;
  }catch{return {};}
}

function ascii(s){return s.replace(/[^\x20-\x7E]/g,"").trim();}
async function notify(title,body){
  for(let attempt=1;attempt<=3;attempt++){
    try{
      await fetch(`https://ntfy.sh/${NTFY_TOPIC}`,{method:"POST",headers:{"Content-Type":"text/plain",Title:ascii(title),Tags:"satellite"},body,signal:AbortSignal.timeout(8000)});
      console.log("[ntfy] sent");return;
    }catch(e){
      console.warn(`[ntfy] attempt ${attempt} failed:`,e.message);
      if(attempt<3)await sleep(2000);
    }
  }
}
const coin=s=>(s||"").replace("_USDT","");
const pct=n=>(n>=0?"+":"")+n.toFixed(1)+"%";

async function main(){
  console.log(`\n📡 Market Pulse — ${new Date().toISOString()}\n`);
  const hourUTC = new Date().getUTCHours();

  // ── Gist state (accounts + regime) ────────────────────────────────────
  const files = await gistAll();
  const v09acc = files["paper_account_v09.json"];
  const dtacc  = files["paper_daytrading_v01.json"];
  const gpacc  = files["paper_account_golden_pocket.json"];
  const regime = files["regime_state.json"];
  const macroBull = !!(regime?.daily?.ema50_gt_200 || regime?.weekly?.ema10_gt_20);

  // ── v09 scan (4H) ──────────────────────────────────────────────────────
  let regCounts={bull:0,neutral:0,bear:0};
  let nearLong=null, nearShort=null;
  for(const sym of V09_PAIRS){
    const bars=await klines(sym,"Hour4",250); await sleep(60);
    if(!bars||bars.length<60)continue;
    const c=bars.map(b=>b.c);
    const reg=v09RegimeLast(c); regCounts[reg]=(regCounts[reg]||0)+1;
    const price=c[c.length-1];
    const rsi=rsiLast(c.slice(-50));
    const recent=c.slice(-1-V09_LOOKBACK,-1);
    const highN=Math.max(...recent), lowN=Math.min(...recent);
    // distance to breakout (LONG) — only meaningful when not already bear
    const distHigh=(highN-price)/price*100;
    if(reg!=="bear" && distHigh>=0 && (!nearLong||distHigh<nearLong.dist)) nearLong={sym,dist:distHigh,rsi};
    // distance to breakdown (momentum SHORT) — bear regime + RSI in 35-52
    const distLow=(price-lowN)/price*100;
    if(reg==="bear" && distLow>=0 && (!nearShort||distLow<nearShort.dist)) nearShort={sym,dist:distLow,rsi};
  }
  const v09open=(v09acc?.openPositions||[]);

  // ── DT scan (15m) ──────────────────────────────────────────────────────
  let dtOversold=0, dtInWindow=[];
  for(const sym of DT_PAIRS){
    const bars=await klines(sym,"Min15",120); await sleep(60);
    if(!bars||bars.length<60)continue;
    const c=bars.map(b=>b.c);
    const rsi=rsiLast(c.slice(-50));
    if(rsi<35) dtOversold++;
    else if(rsi>=35&&rsi<=65) dtInWindow.push({sym,rsi});
  }
  const dtSession = !(hourUTC>=1&&hourUTC<8); // DT blocks Asia 01-08 UTC
  const dtOpen=(dtacc?.positions||[]);

  // ── GP (session + pending from Gist) ────────────────────────────────────
  const gpSession = hourUTC>=13 && hourUTC<18;
  const gpOpen=(gpacc?.positions||[]);
  const gpPending=(gpacc?.pendingPositions||[]);

  // ── Compose report ──────────────────────────────────────────────────────
  const L=[];
  L.push(`MARKET PULSE  ${new Date().toUTCString().slice(17,22)} UTC`);
  if(regime) L.push(`BTC $${Math.round(regime.btcPrice).toLocaleString()} | regime ${regCounts.bear>regCounts.bull?"BEARISH":regCounts.bull>regCounts.bear?"BULLISH":"MIXED"} | shorts ${macroBull?"OFF (macro bull)":"ON"}`);
  L.push("");

  // v09
  L.push(`== v09 (4H, 30 alts) ==`);
  L.push(`Want: LONG breakouts in uptrends / momentum SHORTS in bear`);
  L.push(`Regime: ${regCounts.bull}bull ${regCounts.neutral}neut ${regCounts.bear}bear`);
  if(v09open.length){
    for(const p of v09open) L.push(`ACTIVE: ${p.direction} ${coin(p.symbol)} @ $${p.entryPrice} (${p.signal})`);
  } else {
    if(nearShort) L.push(`Closest SHORT: ${coin(nearShort.sym)} ${pct(-nearShort.dist)} to 15-bar low, RSI ${nearShort.rsi?.toFixed(0)}`);
    if(nearLong)  L.push(`Closest LONG: ${coin(nearLong.sym)} ${pct(nearLong.dist)} to breakout, RSI ${nearLong.rsi?.toFixed(0)}`);
    if(!nearShort&&!nearLong) L.push(`No pairs near a trigger`);
  }
  L.push("");

  // DT
  L.push(`== DT (15m, 8 majors) ==`);
  L.push(`Want: EMA recapture/rejection, RSI 35-65, in session`);
  L.push(`Session: ${dtSession?"ACTIVE":"paused (Asia 01-08 UTC)"}`);
  if(dtOpen.length){
    for(const p of dtOpen) L.push(`ACTIVE: ${p.direction} ${coin(p.symbol)} @ $${p.entry}`);
  } else if(dtOversold>=DT_PAIRS.length-1){
    L.push(`${dtOversold}/${DT_PAIRS.length} oversold (RSI<35) - entries BLOCKED, waiting for bounce`);
  } else if(dtInWindow.length){
    const names=dtInWindow.slice(0,3).map(d=>`${coin(d.sym)} ${d.rsi.toFixed(0)}`).join(", ");
    L.push(`In RSI window: ${names} - watching for setup`);
  } else {
    L.push(`No pairs in entry window`);
  }
  L.push("");

  // GP
  L.push(`== GP (15m Fib, 7 pairs) ==`);
  L.push(`Want: impulse + 0.618 retrace, 13-18 UTC only`);
  L.push(`Session: ${gpSession?"ACTIVE":"closed (opens 13 UTC)"}`);
  if(gpOpen.length) for(const p of gpOpen) L.push(`ACTIVE: ${p.direction} ${coin(p.symbol)} @ $${p.entry}`);
  if(gpPending.length) for(const p of gpPending) L.push(`PENDING: ${p.direction} ${coin(p.symbol)} limit $${p.limitPrice}`);
  if(!gpOpen.length&&!gpPending.length) L.push(`No active orders`);

  const body=L.join("\n");
  console.log(body);
  console.log("");
  await notify("Market Pulse", body);
  console.log("✅ Done.\n");
}
main().catch(e=>{console.error("FATAL:",e);notify("Market Pulse - ERROR",e.message).catch(()=>{});process.exit(1);});
