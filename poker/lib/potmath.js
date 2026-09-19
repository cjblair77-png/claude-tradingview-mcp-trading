// The chip arithmetic the instructor keeps yelling about.
// Every function returns the working as well as the answer, because a drill
// that only says "wrong" teaches nothing.

/** Equity you need to call `bet` into a pot of `pot` (bet is not yet in the pot). */
export function potOdds(pot, bet) {
  const needed = bet / (pot + bet + bet);
  return {
    needed,
    risking: bet,
    toWin: pot + bet,
    ratio: (pot + bet) / bet,
    working: `${fmt(bet)} to win ${fmt(pot + bet)} → ${fmt(bet)} / ${fmt(pot + 2 * bet)} = ${pct(needed)}`,
  };
}

/** How often a bluff of `bet` into `pot` must work to break even. */
export function bluffBreakeven(pot, bet) {
  const needed = bet / (pot + bet);
  return {
    needed,
    working: `${fmt(bet)} / (${fmt(pot)} + ${fmt(bet)}) = ${pct(needed)} of the time`,
  };
}

/** Extra chips you must expect to win later for a call to break even now. */
export function impliedOdds(pot, bet, equity) {
  if (equity <= 0) return { extra: Infinity, working: 'No equity, no price. Fold.' };
  const extra = (bet * (1 - equity)) / equity - pot - bet;
  return {
    extra: Math.max(0, extra),
    alreadyGood: extra <= 0,
    working: extra <= 0
      ? `At ${pct(equity)} the direct price is already good — you need nothing extra.`
      : `Need ${fmt(bet)}/${pct(equity)} = ${fmt(bet / equity)} total; pot lays ${fmt(pot + bet)}, so win ${fmt(extra)} more later.`,
  };
}

/** Expected value of a call in chips. */
export function callEV(pot, bet, equity) {
  const ev = equity * (pot + bet) - (1 - equity) * bet;
  return {
    ev,
    profitable: ev > 0,
    working: `${pct(equity)} × ${fmt(pot + bet)} − ${pct(1 - equity)} × ${fmt(bet)} = ${fmt(ev)}`,
  };
}

/** Minimum defence frequency: how much of your range you must continue with. */
export function mdf(pot, bet) {
  const defend = pot / (pot + bet);
  return { defend, fold: 1 - defend, working: `${fmt(pot)} / (${fmt(pot)} + ${fmt(bet)}) = ${pct(defend)}` };
}

export function fmt(chips) {
  if (!Number.isFinite(chips)) return '∞';
  return Number.isInteger(chips) ? String(chips) : chips.toFixed(1);
}

export function pct(fraction) {
  return `${(fraction * 100).toFixed(1)}%`;
}
