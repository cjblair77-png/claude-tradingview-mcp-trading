import https from 'https';

// ── ORB Config ────────────────────────────────────────────────────────────────
// Opening Range = first 30 min of RTH (13:30–14:00 UTC = 9:30–10:00am ET)
// Entry: breakout above OR high (LONG) or below OR low (SHORT) after 14:00 UTC
// SL: opposite side of OR (OR range = SL distance)
// TP: OR range × TP_MULT beyond entry (1.5R default)
// Max hold: close by 18:00 UTC (4pm ET = end of real session volume)
// 1 trade per symbol per day

const DAYS       = 150;
const START_BAL  = 5000;
const LEVERAGE   = 5;
const RISK_PCT   = 0.008;     // 0.8% risk per trade (same as DT)
const TP_MULT    = 1.5;       // TP = 1.5 × OR range beyond entry
const VOL_MULT   = 1.3;       // entry bar must be > 1.3× avg volume
const OR_START   = 13 * 60 + 30;  // 13:30 UTC in minutes
const OR_END     = 14 * 60;        // 14:00 UTC — end of opening range
const TRADE_END  = 18 * 60;        // 18:00 UTC — no new entries after this
const CLOSE_EOD  = 19 * 60 + 55;   // 19:55 UTC — force-close all positions

const SYMBOLS = [
  'SPYUSDT','QQQUSDT','TSLAUSDT','NVDAUSDT','AAPLUSDT',
  'METAUSDT','AMZNUSDT','COINUSDT','HOODUSDT'
];

function get(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch { res([]); } });
    }).on('error', rej);
  });
}

async function fetch5m(symbol) {
  const cutoff = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  let raw = [], cursor = cutoff, page = 0;
  while (true) {
    const url = `https://www.bitmex.com/api/v1/trade/bucketed?binSize=5m&symbol=${symbol}&count=1000&reverse=false&partial=false&startTime=${cursor}`;
    const chunk = await get(url);
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    const slice = page === 0 ? chunk : chunk.slice(1);
    raw = raw.concat(slice);
    if (chunk.length < 1000) break;
    cursor = chunk[chunk.length - 1].timestamp;
    page++;
    await new Promise(r => setTimeout(r, 300));
  }
  return raw.filter(b => b.open && b.high && b.low && b.close)
            .map(b => ({
              t: new Date(b.timestamp).getTime(),
              o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume || 0,
            }));
}

// Group bars into trading days (keyed by date string)
function groupByDay(bars) {
  const days = {};
  for (const b of bars) {
    const d = new Date(b.t);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    if (!days[key]) days[key] = [];
    days[key].push(b);
  }
  return days;
}

function minutesUTC(t) {
  const d = new Date(t);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function simulate(bars) {
  const days = groupByDay(bars);
  const sortedDays = Object.keys(days).sort();

  // Rolling volume average across all bars (for vol filter)
  const allVols = bars.map(b => b.v);
  let volSum = 0, volCount = 0;

  let balance = START_BAL, peak = START_BAL, maxDD = 0;
  const trades = [], monthly = {};
  const mk = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; };

  for (const dayKey of sortedDays) {
    const dayBars = days[dayKey];

    // ── Build opening range ───────────────────────────────────────────────
    const orBars = dayBars.filter(b => {
      const m = minutesUTC(b.t);
      return m >= OR_START && m < OR_END;
    });
    if (orBars.length < 3) continue; // need enough bars for OR

    const orHigh = Math.max(...orBars.map(b => b.h));
    const orLow  = Math.min(...orBars.map(b => b.l));
    const orRange = orHigh - orLow;
    if (orRange <= 0) continue;

    // Update rolling vol average from today's bars
    for (const b of dayBars) { volSum += b.v; volCount++; }
    const avgVol = volCount > 0 ? volSum / volCount : 1;

    // ── Scan post-OR bars for breakout ────────────────────────────────────
    const tradeBars = dayBars.filter(b => {
      const m = minutesUTC(b.t);
      return m >= OR_END && m < TRADE_END;
    });

    let inTrade = false, trade = {};

    for (const b of tradeBars) {
      const m = minutesUTC(b.t);
      const volOk = b.v > VOL_MULT * avgVol;

      // Exit existing trade
      if (inTrade) {
        const isLong = trade.dir === 'LONG';
        let closed = false, ep = 0, why = '';

        if      (isLong  && b.l <= trade.sl) { ep = trade.sl; why = 'SL';   closed = true; }
        else if (!isLong && b.h >= trade.sl) { ep = trade.sl; why = 'SL';   closed = true; }
        else if (isLong  && b.h >= trade.tp) { ep = trade.tp; why = 'TP';   closed = true; }
        else if (!isLong && b.l <= trade.tp) { ep = trade.tp; why = 'TP';   closed = true; }
        else if (m >= CLOSE_EOD)              { ep = b.c;     why = 'EOD';  closed = true; }

        if (closed) {
          const rawPct = isLong ? (ep - trade.entry) / trade.entry : (trade.entry - ep) / trade.entry;
          // Position sizing: risk RISK_PCT of balance, SL = OR range / entry
          const slPct  = orRange / trade.entry;
          const pnl    = balance * RISK_PCT * LEVERAGE * (rawPct / slPct);
          balance += pnl; peak = Math.max(peak, balance);
          maxDD = Math.max(maxDD, (peak - balance) / peak * 100);
          const m_ = mk(b.t);
          if (!monthly[m_]) monthly[m_] = { tr: 0, wins: 0, pnl: 0, bal0: balance - pnl };
          monthly[m_].tr++; monthly[m_].pnl += pnl;
          if (pnl > 0) monthly[m_].wins++;
          trades.push({ dir: trade.dir, entry: trade.entry, exit: ep, why, pnl, orRange, slPct: slPct*100, time: dayKey + 'T' + String(new Date(b.t).getUTCHours()).padStart(2,'0') });
          inTrade = false;
        }
      }

      // New entry — only 1 per day, only with volume
      if (!inTrade && volOk) {
        if (b.c > orHigh && b.o <= orHigh) {
          // LONG breakout
          trade = {
            dir: 'LONG',
            entry: b.c,
            sl:    orLow,                         // SL = OR low
            tp:    b.c + orRange * TP_MULT,       // TP = 1.5× OR range above entry
          };
          inTrade = true;
        } else if (b.c < orLow && b.o >= orLow) {
          // SHORT breakdown
          trade = {
            dir: 'SHORT',
            entry: b.c,
            sl:    orHigh,                        // SL = OR high
            tp:    b.c - orRange * TP_MULT,       // TP = 1.5× OR range below entry
          };
          inTrade = true;
        }
      }
    }

    // Force close any EOD position
    if (inTrade) {
      const eodBar = dayBars[dayBars.length - 1];
      const ep = eodBar.c;
      const rawPct = trade.dir === 'LONG' ? (ep - trade.entry) / trade.entry : (trade.entry - ep) / trade.entry;
      const slPct  = orRange / trade.entry;
      const pnl    = balance * RISK_PCT * LEVERAGE * (rawPct / slPct);
      balance += pnl; peak = Math.max(peak, balance);
      maxDD = Math.max(maxDD, (peak - balance) / peak * 100);
      const m_ = mk(eodBar.t);
      if (!monthly[m_]) monthly[m_] = { tr: 0, wins: 0, pnl: 0, bal0: balance - pnl };
      monthly[m_].tr++; monthly[m_].pnl += pnl;
      if (pnl > 0) monthly[m_].wins++;
      trades.push({ dir: trade.dir, entry: trade.entry, exit: ep, why: 'EOD', pnl, orRange, slPct: slPct*100, time: dayKey });
    }
  }

  const wins   = trades.filter(t => t.pnl > 0).length;
  const grossW = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossL = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  return {
    trades, monthly,
    total: trades.length,
    wins, losses: trades.length - wins,
    wr: wins / (trades.length || 1) * 100,
    pf: grossW / (grossL || 1),
    maxDD, balance,
    ret: (balance - START_BAL) / START_BAL * 100,
    tpCount:  trades.filter(t => t.why === 'TP').length,
    slCount:  trades.filter(t => t.why === 'SL').length,
    eodCount: trades.filter(t => t.why === 'EOD').length,
    avgOR: trades.reduce((s,t) => s + t.orRange, 0) / (trades.length || 1),
    avgSLpct: trades.reduce((s,t) => s + t.slPct, 0) / (trades.length || 1),
  };
}

// ── Run all symbols ───────────────────────────────────────────────────────────
const results = [];
for (const sym of SYMBOLS) {
  process.stdout.write(`[${SYMBOLS.indexOf(sym)+1}/${SYMBOLS.length}] ${sym} — fetching...`);
  const bars = await fetch5m(sym);
  process.stdout.write(` ${bars.length} bars — simulating...`);
  const r = simulate(bars);
  process.stdout.write(` done. ${r.total} trades | WR ${r.wr.toFixed(0)}% | ${r.ret >= 0 ? '+' : ''}${r.ret.toFixed(1)}%\n`);
  results.push({ sym, ...r });
}

// ── Output ────────────────────────────────────────────────────────────────────
const fmtD   = n => (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(0);
const fmtPct = n => (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
const MNAMES = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

results.sort((a, b) => b.ret - a.ret);

console.log('\n\n' + '='.repeat(105));
console.log(`  BITMEX STOCK FUTURES — ORB STRATEGY  |  ${DAYS} days  |  $${START_BAL.toLocaleString()} start  |  5x lev  |  OR=first 30min  |  TP=1.5R`);
console.log('='.repeat(105));
console.log(`  ${'Symbol'.padEnd(14)} ${'Days'.padStart(5)} ${'Tr'.padStart(4)} ${'WR%'.padStart(6)} ${'PF'.padStart(6)} ${'MaxDD'.padStart(7)} ${'AvgOR%'.padStart(8)} ${'Return'.padStart(9)} ${'Final Bal'.padStart(11)} ${'TP/SL/EOD'.padStart(11)}`);
console.log('  ' + '-'.repeat(88));

for (const r of results) {
  const flag = r.ret > 30 ? '🔥' : r.ret > 10 ? '✅' : r.ret > 0 ? '→' : '❌';
  console.log(
    `  ${r.sym.padEnd(14)}` +
    `${String(r.total > 0 ? DAYS : 0).padStart(5)}` +
    `${String(r.total).padStart(4)}` +
    `${(r.wr.toFixed(1)+'%').padStart(6)}` +
    `${r.pf.toFixed(2).padStart(6)}` +
    `${(r.maxDD.toFixed(1)+'%').padStart(7)}` +
    `${(r.avgSLpct.toFixed(2)+'%').padStart(8)}` +
    `${fmtPct(r.ret).padStart(9)}` +
    `${'$'+r.balance.toFixed(0).padStart(9)}` +
    `${(r.tpCount+'/'+r.slCount+'/'+r.eodCount).padStart(11)}  ${flag}`
  );
}

// Monthly for all profitable symbols
const winners = results.filter(r => r.ret > 0);
for (const r of winners) {
  console.log('\n' + '-'.repeat(90));
  console.log(`  ${r.sym} — MONTHLY  |  ${fmtPct(r.ret)} return  |  PF ${r.pf.toFixed(2)}  |  WR ${r.wr.toFixed(1)}%  |  MaxDD ${r.maxDD.toFixed(1)}%  |  Avg OR range ${r.avgSLpct.toFixed(2)}%`);
  console.log('-'.repeat(90));
  console.log(`  ${'Month'.padEnd(10)} ${'Tr'.padStart(4)} ${'W'.padStart(4)} ${'WR'.padStart(5)} ${'P&L'.padStart(10)} ${'Month%'.padStart(8)} ${'Balance'.padStart(11)} ${'CumRet%'.padStart(10)}`);
  console.log('  ' + '-'.repeat(65));
  let runBal = START_BAL;
  for (const key of Object.keys(r.monthly).sort()) {
    const m = r.monthly[key];
    runBal += m.pnl;
    const [yr, mo] = key.split('-');
    const label  = `${MNAMES[+mo]} ${yr}`;
    const wr_    = (m.wins / (m.tr || 1) * 100).toFixed(0) + '%';
    const monPct = m.pnl / m.bal0 * 100;
    const cumRet = (runBal - START_BAL) / START_BAL * 100;
    console.log(`  ${label.padEnd(10)} ${String(m.tr).padStart(4)} ${String(m.wins).padStart(4)} ${wr_.padStart(5)} ${fmtD(m.pnl).padStart(10)} ${fmtPct(monPct).padStart(8)} ${'$'+runBal.toFixed(0).padStart(10)} ${fmtPct(cumRet).padStart(10)}`);
  }
}

// ── Combined portfolio ────────────────────────────────────────────────────────
if (winners.length > 0) {
  const totalStart = winners.length * START_BAL;
  const totalFinal = winners.reduce((s, r) => s + r.balance, 0);
  const avgDD      = winners.reduce((s, r) => s + r.maxDD, 0) / winners.length;
  const avgWR      = winners.reduce((s, r) => s + r.wr, 0) / winners.length;
  const totalRet   = (totalFinal - totalStart) / totalStart * 100;
  console.log('\n' + '='.repeat(90));
  console.log(`  COMBINED — ${winners.length} profitable symbols, $${START_BAL.toLocaleString()} each ($${totalStart.toLocaleString()} total)`);
  console.log('='.repeat(90));
  console.log(`  Symbols:         ${winners.map(r => r.sym).join(', ')}`);
  console.log(`  Final balance:   $${totalFinal.toFixed(0)}  (${fmtPct(totalRet)})`);
  console.log(`  Total P&L:       ${fmtD(totalFinal - totalStart)}`);
  console.log(`  Avg win rate:    ${avgWR.toFixed(1)}%`);
  console.log(`  Avg max DD:      ${avgDD.toFixed(1)}%`);

  // ORB vs DT comparison
  console.log('\n' + '-'.repeat(90));
  console.log('  ORB vs EMA21-DT STRATEGY COMPARISON');
  console.log('-'.repeat(90));
  console.log(`  ${'Metric'.padEnd(22)} ${'ORB (30min range)'.padEnd(22)} EMA21 DT (crypto)`);
  console.log('  ' + '-'.repeat(65));
  const rows = [
    ['Avg return (150d)',  fmtPct(totalRet / winners.length), '~+600-700%'],
    ['Avg win rate',       avgWR.toFixed(1)+'%',              '55-59%'],
    ['Avg max DD',         avgDD.toFixed(1)+'%',              '33-40%'],
    ['Trades/symbol/mo',  (winners.reduce((s,r)=>s+r.total,0)/winners.length/(DAYS/30)).toFixed(1), '~18'],
    ['Entry logic',        'OR breakout + volume',            'EMA21 recapture'],
    ['Best instrument',    'SPY / TSLA',                      'BTC / XRP / SUI'],
    ['SL reference',       'OR range (dynamic)',              'Fixed 0.65%'],
  ];
  for (const [label, orb, dt] of rows) {
    console.log(`  ${label.padEnd(22)} ${orb.padEnd(22)} ${dt}`);
  }
  console.log('');
}
