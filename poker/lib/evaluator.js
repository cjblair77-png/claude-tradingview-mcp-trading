// Seven-card hand evaluation.
//
// Instead of enumerating all 21 five-card subsets we read the hand's shape
// directly: rank counts plus suit counts are enough to name the best five.
// Every hand collapses to one integer score, so comparing two hands is `a - b`.

import { rankOf, suitOf, VALUE_RANK } from './cards.js';

export const CATEGORY = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
};

export const CATEGORY_NAME = [
  'high card',
  'a pair',
  'two pair',
  'three of a kind',
  'a straight',
  'a flush',
  'a full house',
  'four of a kind',
  'a straight flush',
];

// Score layout: category in the top digits, then five tiebreak ranks base 16.
const BASE = 16;
function encode(category, tiebreaks) {
  let score = category;
  for (let i = 0; i < 5; i += 1) {
    score = score * BASE + (tiebreaks[i] || 0);
  }
  return score;
}

/**
 * Highest card of a five-straight inside `ranksDesc` (unique, descending),
 * or 0 if there is none. Returns 5 for the wheel (A-2-3-4-5).
 */
function straightHigh(ranksDesc) {
  const present = new Set(ranksDesc);
  if (present.has(14)) present.add(1); // the ace plays low as well
  for (let high = 14; high >= 5; high -= 1) {
    let run = true;
    for (let i = 0; i < 5; i += 1) {
      if (!present.has(high - i)) {
        run = false;
        break;
      }
    }
    if (run) return high;
  }
  return 0;
}

/**
 * Evaluate 5, 6 or 7 cards.
 * @returns {{score:number, category:number, tiebreaks:number[]}}
 */
export function evaluate(cards) {
  if (cards.length < 5) throw new Error('Need at least five cards to evaluate');

  const rankCounts = new Array(15).fill(0);
  const suitCounts = [0, 0, 0, 0];
  const ranksBySuit = [[], [], [], []];

  for (const card of cards) {
    const r = rankOf(card);
    const s = suitOf(card);
    rankCounts[r] += 1;
    suitCounts[s] += 1;
    ranksBySuit[s].push(r);
  }

  const flushSuit = suitCounts.findIndex((c) => c >= 5);

  if (flushSuit >= 0) {
    const flushRanks = [...new Set(ranksBySuit[flushSuit])].sort((a, b) => b - a);
    const sfHigh = straightHigh(flushRanks);
    if (sfHigh) return result(CATEGORY.STRAIGHT_FLUSH, [sfHigh]);
  }

  // Ranks grouped by how many copies we hold, each group sorted high to low.
  const byCount = { 4: [], 3: [], 2: [], 1: [] };
  for (let r = 14; r >= 2; r -= 1) {
    if (rankCounts[r] > 0) byCount[rankCounts[r]].push(r);
  }

  if (byCount[4].length) {
    const quad = byCount[4][0];
    const kicker = highestExcluding(rankCounts, [quad], 1)[0];
    return result(CATEGORY.QUADS, [quad, kicker]);
  }

  if (byCount[3].length && (byCount[3].length > 1 || byCount[2].length)) {
    const trips = byCount[3][0];
    // A second set of trips can only ever contribute its top two cards.
    const pair = byCount[3].length > 1 ? Math.max(byCount[3][1], byCount[2][0] ?? 0) : byCount[2][0];
    return result(CATEGORY.FULL_HOUSE, [trips, pair]);
  }

  if (flushSuit >= 0) {
    const flushRanks = [...new Set(ranksBySuit[flushSuit])].sort((a, b) => b - a);
    return result(CATEGORY.FLUSH, flushRanks.slice(0, 5));
  }

  const allRanks = [];
  for (let r = 14; r >= 2; r -= 1) if (rankCounts[r] > 0) allRanks.push(r);
  const stHigh = straightHigh(allRanks);
  if (stHigh) return result(CATEGORY.STRAIGHT, [stHigh]);

  if (byCount[3].length) {
    const trips = byCount[3][0];
    const kickers = highestExcluding(rankCounts, [trips], 2);
    return result(CATEGORY.TRIPS, [trips, ...kickers]);
  }

  if (byCount[2].length >= 2) {
    const [hi, lo] = byCount[2];
    const kicker = highestExcluding(rankCounts, [hi, lo], 1)[0];
    return result(CATEGORY.TWO_PAIR, [hi, lo, kicker]);
  }

  if (byCount[2].length === 1) {
    const pair = byCount[2][0];
    const kickers = highestExcluding(rankCounts, [pair], 3);
    return result(CATEGORY.PAIR, [pair, ...kickers]);
  }

  return result(CATEGORY.HIGH_CARD, allRanks.slice(0, 5));
}

function result(category, tiebreaks) {
  return { score: encode(category, tiebreaks), category, tiebreaks };
}

function highestExcluding(rankCounts, excluded, count) {
  const out = [];
  for (let r = 14; r >= 2 && out.length < count; r -= 1) {
    if (rankCounts[r] > 0 && !excluded.includes(r)) out.push(r);
  }
  return out;
}

export function scoreOf(cards) {
  return evaluate(cards).score;
}

const PLURAL = {
  2: 'deuces', 3: 'threes', 4: 'fours', 5: 'fives', 6: 'sixes', 7: 'sevens',
  8: 'eights', 9: 'nines', 10: 'tens', 11: 'jacks', 12: 'queens', 13: 'kings', 14: 'aces',
};

/** "two pair, kings and sevens" — the line the instructor reads back to you. */
export function describe(cards) {
  const { category, tiebreaks: t } = evaluate(cards);
  const name = (v) => VALUE_RANK[v];
  const many = (v) => PLURAL[v];

  switch (category) {
    case CATEGORY.STRAIGHT_FLUSH:
      return t[0] === 14 ? 'a royal flush' : `a straight flush, ${name(t[0])} high`;
    case CATEGORY.QUADS:
      return `four ${many(t[0])}, ${name(t[1])} kicker`;
    case CATEGORY.FULL_HOUSE:
      return `a full house, ${many(t[0])} full of ${many(t[1])}`;
    case CATEGORY.FLUSH:
      return `a flush, ${name(t[0])} high`;
    case CATEGORY.STRAIGHT:
      return t[0] === 5 ? 'a straight, five high (the wheel)' : `a straight, ${name(t[0])} high`;
    case CATEGORY.TRIPS:
      return `three ${many(t[0])}`;
    case CATEGORY.TWO_PAIR:
      return `two pair, ${many(t[0])} and ${many(t[1])}`;
    case CATEGORY.PAIR:
      return `a pair of ${many(t[0])}, ${name(t[1])} kicker`;
    default:
      return `${name(t[0])} high`;
  }
}

/** -1 / 0 / +1 from the first hand's point of view. */
export function compareHands(a, b) {
  return Math.sign(scoreOf(a) - scoreOf(b));
}
