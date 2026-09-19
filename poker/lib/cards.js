// Card primitives. Pure ES module — runs unchanged in the browser and in Node.

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUITS = ['s', 'h', 'd', 'c'];

export const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
export const SUIT_NAME = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };

// Rank values: deuce is 2, ace is 14. Wheel straights handle the low ace separately.
export const RANK_VALUE = Object.fromEntries(RANKS.map((r, i) => [r, i + 2]));
export const VALUE_RANK = Object.fromEntries(RANKS.map((r, i) => [i + 2, r]));

/**
 * A card is an integer 0..51 so that comparisons and Set lookups stay cheap.
 * id = (rankValue - 2) * 4 + suitIndex
 */
export function cardId(rank, suit) {
  return (RANK_VALUE[rank] - 2) * 4 + SUITS.indexOf(suit);
}

export function rankOf(card) {
  return (card >> 2) + 2;
}

export function suitOf(card) {
  return card & 3;
}

export function suitCharOf(card) {
  return SUITS[suitOf(card)];
}

/** "Ah" / "ah" / "AH" -> card id. Throws on anything that is not a card. */
export function parseCard(text) {
  const t = String(text).trim();
  if (t.length !== 2) throw new Error(`Not a card: "${text}"`);
  const rank = t[0].toUpperCase();
  const suit = t[1].toLowerCase();
  if (!(rank in RANK_VALUE)) throw new Error(`Bad rank in "${text}"`);
  if (!SUITS.includes(suit)) throw new Error(`Bad suit in "${text}"`);
  return cardId(rank, suit);
}

/** "AhKd 7c" -> [id, id, id]. Accepts spaces, commas or nothing between cards. */
export function parseCards(text) {
  const cleaned = String(text).replace(/[\s,]+/g, '');
  if (cleaned.length === 0) return [];
  if (cleaned.length % 2 !== 0) throw new Error(`Dangling character in "${text}"`);
  const out = [];
  for (let i = 0; i < cleaned.length; i += 2) out.push(parseCard(cleaned.slice(i, i + 2)));
  if (new Set(out).size !== out.length) throw new Error('The same card appears twice');
  return out;
}

export function cardToString(card) {
  return VALUE_RANK[rankOf(card)] + suitCharOf(card);
}

export function cardsToString(cards) {
  return cards.map(cardToString).join(' ');
}

/** Suit symbols, for prose. `cardToString` stays letters so it round-trips. */
export function cardToPretty(card) {
  return VALUE_RANK[rankOf(card)] + SUIT_SYMBOL[suitCharOf(card)];
}

export function cardsToPretty(cards) {
  return cards.map(cardToPretty).join(' ');
}

export function fullDeck() {
  return Array.from({ length: 52 }, (_, i) => i);
}

/** Every card not in `used`. */
export function deckWithout(used) {
  const blocked = new Set(used);
  const out = [];
  for (let i = 0; i < 52; i += 1) if (!blocked.has(i)) out.push(i);
  return out;
}

/** Fisher-Yates over the first `count` slots only — we never need the whole shuffle. */
export function drawRandom(deck, count, rng = Math.random) {
  const pool = deck.slice();
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.floor(rng() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
    out.push(pool[i]);
  }
  return out;
}

export function pickOne(list, rng = Math.random) {
  return list[Math.floor(rng() * list.length)];
}

/** Deterministic PRNG (mulberry32) so drills and tests can be replayed. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
