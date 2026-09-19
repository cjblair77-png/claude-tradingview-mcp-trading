// Equity: how often each hand wins if the board runs out from here.
//
// With few unknown cards we enumerate every runout and get an exact answer.
// Past that, we sample. The UI always says which one it used, because
// "62.4% (sampled)" and "62.4% (exact)" are different claims.

import { deckWithout, drawRandom } from './cards.js';
import { scoreOf } from './evaluator.js';

/** Runouts we are willing to enumerate before falling back to sampling. */
const EXACT_LIMIT = 250000;

function combinations(n, k) {
  if (k > n) return 0;
  let out = 1;
  for (let i = 0; i < k; i += 1) out = (out * (n - i)) / (i + 1);
  return Math.round(out);
}

function scoreShowdown(hands, board, tally) {
  let best = -1;
  let winners = [];
  for (let i = 0; i < hands.length; i += 1) {
    const s = scoreOf(hands[i].concat(board));
    if (s > best) {
      best = s;
      winners = [i];
    } else if (s === best) {
      winners.push(i);
    }
  }
  if (winners.length === 1) {
    tally.wins[winners[0]] += 1;
  } else {
    for (const w of winners) tally.ties[w] += 1 / winners.length;
  }
}

/**
 * Equity for two or more fully-specified hands.
 * @param {number[][]} hands  hole cards per player
 * @param {number[]} board    0-5 community cards
 * @returns {{equity:number[], wins:number[], ties:number[], trials:number, exact:boolean}}
 */
export function equityVsKnown(hands, board = [], { trials = 20000, rng = Math.random } = {}) {
  const needed = 5 - board.length;
  const deck = deckWithout(hands.flat().concat(board));
  const tally = { wins: hands.map(() => 0), ties: hands.map(() => 0) };

  const runouts = combinations(deck.length, needed);
  const exact = runouts > 0 && runouts <= Math.min(EXACT_LIMIT, trials * 8);

  let played = 0;
  if (exact) {
    const chosen = [];
    const walk = (start, left) => {
      if (left === 0) {
        scoreShowdown(hands, board.concat(chosen), tally);
        played += 1;
        return;
      }
      for (let i = start; i <= deck.length - left; i += 1) {
        chosen.push(deck[i]);
        walk(i + 1, left - 1);
        chosen.pop();
      }
    };
    walk(0, needed);
  } else {
    for (let t = 0; t < trials; t += 1) {
      scoreShowdown(hands, board.concat(drawRandom(deck, needed, rng)), tally);
      played += 1;
    }
  }

  return {
    equity: hands.map((_, i) => (tally.wins[i] + tally.ties[i]) / played),
    wins: tally.wins.map((w) => w / played),
    ties: tally.ties.map((t) => t / played),
    trials: played,
    exact,
  };
}

/**
 * Equity for a hero against N opponents holding random cards.
 * Always sampled — the opponents' cards are unknown by definition.
 */
export function equityVsRandom(hero, board = [], opponents = 1, { trials = 12000, rng = Math.random } = {}) {
  const needed = 5 - board.length;
  const deck = deckWithout(hero.concat(board));
  let equity = 0;

  for (let t = 0; t < trials; t += 1) {
    const draw = drawRandom(deck, opponents * 2 + needed, rng);
    const hands = [hero];
    for (let o = 0; o < opponents; o += 1) hands.push([draw[o * 2], draw[o * 2 + 1]]);
    const runout = board.concat(draw.slice(opponents * 2));

    let best = -1;
    let winners = [];
    for (let i = 0; i < hands.length; i += 1) {
      const s = scoreOf(hands[i].concat(runout));
      if (s > best) {
        best = s;
        winners = [i];
      } else if (s === best) winners.push(i);
    }
    if (winners.includes(0)) equity += 1 / winners.length;
  }

  return { equity: equity / trials, trials, exact: false };
}

/**
 * Cards that flip hero from behind to ahead on the very next street.
 * This is the textbook definition of an "out", and it is what the outs drill
 * grades against — no hand-waving about backdoors.
 */
export function countOuts(hero, villain, board) {
  if (board.length < 3 || board.length > 4) {
    throw new Error('Outs are counted on the flop or the turn');
  }
  const deck = deckWithout(hero.concat(villain, board));
  const heroNow = scoreOf(hero.concat(board));
  const villainNow = scoreOf(villain.concat(board));

  const outs = [];
  for (const card of deck) {
    const next = board.concat([card]);
    if (scoreOf(hero.concat(next)) > scoreOf(villain.concat(next))) outs.push(card);
  }
  return { outs, count: outs.length, behind: heroNow < villainNow, live: deck.length };
}

/** The "rule of 2 and 4" shortcut, next to what it is approximating. */
export function ruleOfTwoAndFour(outs, street) {
  const multiplier = street === 'flop' ? 4 : 2;
  const approx = outs * multiplier;
  // One card to come: outs / 47. Two cards: 1 - (47-o)/47 * (46-o)/46.
  const exact = street === 'flop'
    ? 1 - ((47 - outs) / 47) * ((46 - outs) / 46)
    : outs / 46;
  return { approx: approx / 100, exact, error: approx / 100 - exact };
}
