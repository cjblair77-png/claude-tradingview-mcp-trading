// Drill generators.
//
// Every question carries three things beyond the answer:
//   hint   — a nudge you can ask for BEFORE answering
//   steps  — the whole thing broken into toddler-sized pieces, each one a
//            single sentence with real numbers in it
//   note   — the lesson to take away
// That is the entire teaching method: never say "wrong" without immediately
// showing the staircase you should have walked up.
//
// Generators take (rng, difficulty) where difficulty is 0, 1 or 2. Harder
// levels use uglier numbers and are graded more tightly — that is the dial
// that turns "I get it" into "I get it fast".

import { cardsToPretty, deckWithout, drawRandom, pickOne } from './cards.js';
import { describe, evaluate } from './evaluator.js';
import { countOuts, equityVsKnown, equityVsRandom, ruleOfTwoAndFour } from './equity.js';
import { bluffBreakeven, callEV, fmt, impliedOdds, mdf, pct, potOdds } from './potmath.js';

/** Pots get uglier as you climb. Baby numbers first, real numbers later. */
const POTS = [
  [20, 40, 60, 80, 100, 200],
  [30, 50, 75, 90, 120, 150, 250],
  [37, 64, 88, 115, 143, 227, 316],
];

const SIZINGS = [
  [{ label: 'half pot', f: 0.5 }, { label: 'pot', f: 1 }],
  [{ label: 'a third pot', f: 1 / 3 }, { label: 'half pot', f: 0.5 }, { label: 'two thirds pot', f: 2 / 3 },
    { label: 'three quarters pot', f: 0.75 }, { label: 'pot', f: 1 }],
  [{ label: 'a quarter pot', f: 0.25 }, { label: 'a third pot', f: 1 / 3 }, { label: 'two fifths pot', f: 0.4 },
    { label: 'three quarters pot', f: 0.75 }, { label: 'pot', f: 1 }, { label: 'an overbet, 1.5x pot', f: 1.5 },
    { label: 'a monster overbet, 2x pot', f: 2 }],
];

/** Grading gets stricter as you climb. This is most of the "sharpen up" dial. */
const TOLERANCE_SCALE = [1.6, 1, 0.6];

const clampLevel = (d) => Math.max(0, Math.min(2, d | 0));
const round5 = (n) => Math.round(n / 5) * 5 || 5;

function money(rng, difficulty) {
  const d = clampLevel(difficulty);
  const pot = pickOne(POTS[d], rng);
  const sizing = pickOne(SIZINGS[d], rng);
  const bet = d === 2 ? Math.round(pot * sizing.f) : round5(pot * sizing.f);
  return { pot, bet, sizing };
}

function tol(base, difficulty) {
  return base * TOLERANCE_SCALE[clampLevel(difficulty)];
}

function deal(rng, spec) {
  const draw = drawRandom(deckWithout([]), (spec.hero || 0) + (spec.villain || 0) + (spec.board || 0), rng);
  let i = 0;
  const take = (n) => draw.slice(i, (i += n));
  return { hero: take(spec.hero || 0), villain: take(spec.villain || 0), board: take(spec.board || 0) };
}

/* ------------------------------------------------------------------ */
/* Level 1 — the chip arithmetic                                       */
/* ------------------------------------------------------------------ */

function potOddsDrill(rng, difficulty) {
  const { pot, bet, sizing } = money(rng, difficulty);
  const { needed, working } = potOdds(pot, bet);
  const total = pot + bet + bet;
  return {
    type: 'pot-odds',
    topic: 'potOdds',
    title: 'Pot odds',
    scenario: `The pot is ${fmt(pot)}. Villain bets ${fmt(bet)} into it (${sizing.label}).`,
    question: 'What equity do you need for calling to break even?',
    mode: 'number',
    unit: '%',
    answer: needed * 100,
    tolerance: tol(1, difficulty),
    display: pct(needed),
    working,
    hint: 'Your own call goes in the BOTTOM of the fraction too. That is the bit everyone forgets.',
    steps: [
      { do: 'Money already in the middle', result: fmt(pot) },
      { do: 'Money villain just pushed in — that is in the middle now as well', result: fmt(bet) },
      { do: 'So if you call and win, you scoop all of it', result: `${fmt(pot)} + ${fmt(bet)} = ${fmt(pot + bet)}` },
      { do: 'It costs you this much to find out', result: fmt(bet) },
      { do: 'Add your call to the middle — that is the whole pot at showdown', result: `${fmt(pot + bet)} + ${fmt(bet)} = ${fmt(total)}` },
      { do: 'Your share of that pot is the share of the time you must win', result: `${fmt(bet)} ÷ ${fmt(total)} = ${pct(needed)}` },
    ],
    note: `You risk ${fmt(bet)} to win ${fmt(pot + bet)}. Bigger bet, more equity needed — that is the whole relationship.`,
  };
}

function bluffDrill(rng, difficulty) {
  const { pot, bet, sizing } = money(rng, difficulty);
  const { needed, working } = bluffBreakeven(pot, bet);
  return {
    type: 'bluff-breakeven',
    topic: 'bluff',
    title: 'Bluff break-even',
    scenario: `Pot is ${fmt(pot)}. You are about to fire ${fmt(bet)} (${sizing.label}) holding absolutely nothing.`,
    question: 'How often must villain fold for the bluff to break even?',
    mode: 'number',
    unit: '%',
    answer: needed * 100,
    tolerance: tol(1, difficulty),
    display: pct(needed),
    working,
    hint: 'Risk over risk-plus-reward. And unlike pot odds, your own bet does NOT get added to what you win.',
    steps: [
      { do: 'If the bluff works, what do you win? Just what is already there', result: fmt(pot) },
      { do: 'If it fails, what do you lose? Your bet', result: fmt(bet) },
      { do: 'Break-even is risk ÷ (risk + reward)', result: `${fmt(bet)} ÷ (${fmt(bet)} + ${fmt(pot)})` },
      { do: 'Do the sum', result: `${fmt(bet)} ÷ ${fmt(pot + bet)} = ${pct(needed)}` },
    ],
    note: 'Half pot needs 33%. Pot needs 50%. Overbets need more than half the time, which is why they should carry real hands too.',
  };
}

function mdfDrill(rng, difficulty) {
  const { pot, bet, sizing } = money(rng, difficulty);
  const { defend, fold, working } = mdf(pot, bet);
  const theirBluff = bluffBreakeven(pot, bet).needed;
  return {
    type: 'mdf',
    topic: 'mdf',
    title: 'Minimum defence frequency',
    scenario: `Pot ${fmt(pot)}, villain bets ${fmt(bet)} (${sizing.label}).`,
    question: 'What share of your range must you continue with so they cannot auto-profit?',
    mode: 'number',
    unit: '%',
    answer: defend * 100,
    tolerance: tol(2, difficulty),
    display: pct(defend),
    working,
    hint: 'Work out how often their bluff needs to work, then refuse to fold that often.',
    steps: [
      { do: 'Their bluff of this size needs to work how often?', result: pct(theirBluff) },
      { do: 'So you can only afford to fold that often', result: pct(theirBluff) },
      { do: 'Everything else, you keep playing', result: `100% − ${pct(theirBluff)} = ${pct(defend)}` },
      { do: 'Same sum, the short way', result: `${fmt(pot)} ÷ ${fmt(pot + bet)} = ${pct(defend)}` },
    ],
    note: `Fold more than ${pct(fold)} and any two cards prints money against you. It is a ceiling on folding, not a licence to call everything.`,
  };
}

function callEvDrill(rng, difficulty) {
  const { pot, bet } = money(rng, difficulty);
  const equity = Math.round((0.1 + rng() * 0.5) * 100) / 100;
  const { ev, profitable, working } = callEV(pot, bet, equity);
  const needed = potOdds(pot, bet).needed;
  return {
    type: 'call-ev',
    topic: 'potOdds',
    title: 'Call or fold',
    scenario: `Pot ${fmt(pot)}, villain bets ${fmt(bet)}. Somehow you know you have exactly ${pct(equity)} equity.`,
    question: 'Call or fold?',
    mode: 'choice',
    choices: ['Call', 'Fold'],
    answer: profitable ? 'Call' : 'Fold',
    display: `${profitable ? 'Call' : 'Fold'} (EV ${fmt(ev)})`,
    working,
    hint: 'Two numbers: what you need, and what you have. Compare them. That is the whole decision.',
    steps: [
      { do: 'What do you NEED? Pot odds', result: `${fmt(bet)} ÷ ${fmt(pot + 2 * bet)} = ${pct(needed)}` },
      { do: 'What do you HAVE?', result: pct(equity) },
      { do: 'Compare', result: `${pct(equity)} is ${profitable ? 'MORE' : 'LESS'} than ${pct(needed)}` },
      { do: 'Same thing in chips, averaged over every time you face it', result: `${working} per call` },
      { do: 'So the decision makes itself', result: profitable ? 'Call' : 'Fold' },
    ],
    note: profitable
      ? 'Positive EV means call, even on the times it loses. Especially on the times it loses.'
      : 'No price, no call. Being "curious" costs exactly this much per hand, forever.',
  };
}

function impliedDrill(rng, difficulty) {
  const { pot, bet } = money(rng, difficulty);
  const equity = pickOne([0.08, 0.1, 0.12, 0.16, 0.18, 0.2], rng);
  const { extra, working } = impliedOdds(pot, bet, equity);
  const totalNeeded = bet / equity;
  return {
    type: 'implied-odds',
    topic: 'implied',
    title: 'Implied odds',
    scenario: `Pot ${fmt(pot)}, villain bets ${fmt(bet)} on the turn. Your draw is worth ${pct(equity)} and it is this street or nothing.`,
    question: 'How many EXTRA chips must you expect to win on the river for this call to break even?',
    mode: 'number',
    unit: 'chips',
    answer: extra,
    tolerance: Math.max(4, tol(extra * 0.12, difficulty)),
    display: fmt(extra),
    working,
    hint: 'Work out the total the pot would have to be, then subtract the pot you can actually see.',
    steps: [
      { do: 'You hit this often', result: pct(equity) },
      { do: 'So for the call to be free money, the pot must pay you call ÷ equity', result: `${fmt(bet)} ÷ ${pct(equity)} = ${fmt(totalNeeded)}` },
      { do: 'What is actually out there if you call and win right now?', result: `${fmt(pot)} + ${fmt(bet)} = ${fmt(pot + bet)}` },
      { do: 'The gap has to come from the river', result: `${fmt(totalNeeded)} − ${fmt(pot + bet)} = ${fmt(extra)}` },
    ],
    note: 'Implied odds are a promise, not a fact. If the stacks are short or villain never pays, that number is zero and you are just calling badly.',
  };
}

/* ------------------------------------------------------------------ */
/* Level 2 — cards on the table                                        */
/* ------------------------------------------------------------------ */

function outsDrill(rng, difficulty) {
  // Keep dealing until hero is genuinely behind with something to draw to —
  // "count your outs" is a meaningless question when you are already winning.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const street = rng() < 0.6 ? 'flop' : 'turn';
    const { hero, villain, board } = deal(rng, { hero: 2, villain: 2, board: street === 'flop' ? 3 : 4 });
    const outs = countOuts(hero, villain, board);
    if (!outs.behind || outs.count === 0 || outs.count > 21) continue;

    const rule = ruleOfTwoAndFour(outs.count, street);
    return {
      type: 'outs',
      topic: 'outs',
      title: 'Count your outs',
      cards: { hero, villain, board },
      scenario: `${street === 'flop' ? 'Flop' : 'Turn'}. You hold ${cardsToPretty(hero)}, villain has tabled ${cardsToPretty(villain)}.`,
      question: 'How many cards in the deck put you ahead on the next street?',
      mode: 'number',
      unit: 'outs',
      answer: outs.count,
      tolerance: 0.5,
      display: `${outs.count} outs`,
      working: cardsToPretty(outs.outs),
      hint: 'Name your draw first: flush draw 9, open-ender 8, gutshot 4, two overcards 6. Then check none of those cards are already sitting on the board.',
      steps: [
        { do: 'What has villain got, right now?', result: describe(villain.concat(board)) },
        { do: 'What have you got, right now?', result: describe(hero.concat(board)) },
        { do: 'So you are behind. Now go through the deck one card at a time and ask: does THIS card put me in front?', result: `${outs.live} cards to check` },
        { do: 'The ones that do', result: cardsToPretty(outs.outs) },
        { do: 'Count them', result: `${outs.count} outs` },
        { do: `Rule of ${street === 'flop' ? '4 (two cards to come)' : '2 (one card to come)'}`, result: `${outs.count} × ${street === 'flop' ? 4 : 2} ≈ ${pct(rule.approx)}` },
        { do: 'The real number', result: pct(rule.exact) },
      ],
      note: `The shortcut drifts high once you pass about eight outs — here it says ${pct(rule.approx)} against a true ${pct(rule.exact)}. Knock a couple of points off big draws.`,
    };
  }
  return potOddsDrill(rng, difficulty);
}

const CATEGORY_CHOICE = [
  'high card', 'a pair', 'two pair', 'three of a kind', 'a straight',
  'a flush', 'a full house', 'four of a kind', 'a straight flush',
];

function readingDrill(rng) {
  const { hero, board } = deal(rng, { hero: 2, board: 5 });
  const best = hero.concat(board);
  const truth = describe(best);
  const category = evaluate(best).category;
  const correct = CATEGORY_CHOICE[category];

  // Distractors come from neighbouring categories — a plausible mistake teaches
  // more than an absurd one.
  const near = CATEGORY_CHOICE
    .map((label, i) => ({ label, distance: Math.abs(i - category) }))
    .filter((c) => c.distance > 0)
    .sort((a, b) => a.distance - b.distance || rng() - 0.5)
    .slice(0, 4)
    .sort(() => rng() - 0.5)
    .slice(0, 3)
    .map((c) => c.label);

  // Tally by hand so the steps can quote real counts back at the player.
  const all = hero.concat(board);
  const counts = {};
  const suits = {};
  for (const card of all) {
    const rank = (card >> 2) + 2;
    const suit = card & 3;
    counts[rank] = (counts[rank] || 0) + 1;
    suits[suit] = (suits[suit] || 0) + 1;
  }
  const pairs = Object.values(counts).filter((c) => c === 2).length;
  const trips = Object.values(counts).filter((c) => c === 3).length;
  const quads = Object.values(counts).filter((c) => c === 4).length;
  const flushCount = Math.max(...Object.values(suits));

  return {
    type: 'reading',
    topic: 'outs',
    title: 'Name your hand',
    cards: { hero, villain: [], board },
    scenario: `You hold ${cardsToPretty(hero)}. Board: ${cardsToPretty(board)}.`,
    question: 'What is your best five-card hand?',
    mode: 'choice',
    choices: [correct, ...near].sort(() => rng() - 0.5),
    answer: correct,
    display: truth,
    working: `Best five cards play: ${truth}.`,
    hint: 'Run the checklist top down: four of a kind, full house, flush, straight, trips, two pair, pair. Stop at the first yes.',
    steps: [
      { do: 'Lay all seven out', result: cardsToPretty(all) },
      { do: 'Four of the same rank?', result: quads ? 'yes' : 'no' },
      { do: 'Five of one suit?', result: flushCount >= 5 ? `yes — ${flushCount} of them` : `no (most is ${flushCount})` },
      { do: 'Five ranks in a row?', result: category === 4 || category === 8 ? 'yes' : 'no' },
      { do: 'Three of a kind? Pairs?', result: `${trips} set${trips === 1 ? '' : 's'} of three, ${pairs} pair${pairs === 1 ? '' : 's'}` },
      { do: 'First yes down the list wins', result: truth },
    ],
    note: 'Seven cards, best five. Your hole cards are not obliged to be involved at all — the board can outrun you.',
  };
}

/* ------------------------------------------------------------------ */
/* Level 3 — equity by eye                                             */
/* ------------------------------------------------------------------ */

function equityDrill(rng, difficulty) {
  const street = pickOne(['flop', 'flop', 'turn'], rng);
  const { hero, villain, board } = deal(rng, { hero: 2, villain: 2, board: street === 'flop' ? 3 : 4 });
  const { equity, exact, trials } = equityVsKnown([hero, villain], board, { trials: 8000, rng });
  const heroAhead = equity[0] >= 0.5;
  const outs = countOuts(hero, villain, board);
  const underdogOuts = outs.behind ? outs.count : outs.live - outs.count;
  const rule = ruleOfTwoAndFour(underdogOuts, street);

  return {
    type: 'equity',
    topic: 'equity',
    title: 'Eyeball the equity',
    cards: { hero, villain, board },
    scenario: `Both hands face up on the ${street}. You: ${cardsToPretty(hero)}. Villain: ${cardsToPretty(villain)}.`,
    question: 'What is YOUR equity if this runs out with no more betting?',
    mode: 'number',
    unit: '%',
    answer: equity[0] * 100,
    tolerance: tol(5, difficulty),
    display: pct(equity[0]),
    working: exact ? `Exact — all ${trials} runouts enumerated.` : `Sampled over ${trials} runouts.`,
    hint: 'Work out the UNDERDOG first. Count their outs, rule of 4 or 2, then take it off 100.',
    steps: [
      { do: 'Who is winning this second?', result: `${heroAhead ? 'You' : 'Villain'} — ${describe((heroAhead ? hero : villain).concat(board))} beats ${describe((heroAhead ? villain : hero).concat(board))}` },
      { do: 'How many cards are still to come?', result: street === 'flop' ? 'two' : 'one' },
      { do: 'How many outs does the one who is behind have?', result: `${underdogOuts}` },
      { do: `Rule of ${street === 'flop' ? '4' : '2'} on the underdog`, result: `${underdogOuts} × ${street === 'flop' ? 4 : 2} ≈ ${pct(rule.approx)}` },
      { do: 'The leader gets the rest', result: pct(1 - rule.approx) },
      { do: 'Actual answer, all runouts counted', result: pct(equity[0]) },
    ],
    note: 'Made hand versus draw is closer than it looks on the flop and much further apart by the turn. One card to come roughly halves the draw.',
  };
}

const PREFLOP_ANCHORS = 'Pair vs two overcards ≈ 55/45. Pair vs one overcard ≈ 70/30. Pair vs two unders ≈ 83/17. Dominated ace ≈ 73/27. Two overcards vs two unders ≈ 62/38.';

function preflopDrill(rng, difficulty) {
  const { hero, villain } = deal(rng, { hero: 2, villain: 2 });
  const { equity, trials } = equityVsKnown([hero, villain], [], { trials: 6000, rng });
  const heroRanks = hero.map((c) => (c >> 2) + 2).sort((a, b) => b - a);
  const villRanks = villain.map((c) => (c >> 2) + 2).sort((a, b) => b - a);
  const shape = (r) => (r[0] === r[1] ? 'a pair' : 'unpaired');

  return {
    type: 'preflop',
    topic: 'equity',
    title: 'Preflop all-in',
    cards: { hero, villain, board: [] },
    scenario: `All in before the flop. You: ${cardsToPretty(hero)}. Villain: ${cardsToPretty(villain)}.`,
    question: 'Your equity?',
    mode: 'number',
    unit: '%',
    answer: equity[0] * 100,
    tolerance: tol(6, difficulty),
    display: pct(equity[0]),
    working: `Sampled over ${trials} runouts.`,
    hint: `Match it to an anchor you already know. ${PREFLOP_ANCHORS}`,
    steps: [
      { do: 'What shape is your hand?', result: shape(heroRanks) },
      { do: 'What shape is theirs?', result: shape(villRanks) },
      { do: 'Which anchor is this closest to?', result: PREFLOP_ANCHORS },
      { do: 'Adjust: sharing a card hurts the weaker hand, sharing a suit helps the drawer a couple of points', result: 'nudge by 2–5%' },
      { do: 'Actual', result: pct(equity[0]) },
    ],
    note: `Five numbers cover nearly every preflop all-in you will ever see. ${PREFLOP_ANCHORS}`,
  };
}

function multiwayDrill(rng, difficulty) {
  const opponents = pickOne([2, 3, 4, 5, 8], rng);
  const { hero } = deal(rng, { hero: 2 });
  const { equity, trials } = equityVsRandom(hero, [], opponents, { trials: 5000, rng });
  const headsUp = equityVsRandom(hero, [], 1, { trials: 3000, rng }).equity;

  return {
    type: 'multiway',
    topic: 'equity',
    title: 'Against the whole table',
    cards: { hero, villain: [], board: [] },
    scenario: `You hold ${cardsToPretty(hero)} and ${opponents} players call. Everyone runs it out, nobody folds.`,
    question: 'Your equity against all of them?',
    mode: 'number',
    unit: '%',
    answer: equity * 100,
    tolerance: tol(6, difficulty),
    display: pct(equity),
    working: `Sampled over ${trials} hands versus ${opponents} random holdings.`,
    hint: 'Start from "everyone gets an equal share" — that is 1 over the number of players — then push your hand above or below it.',
    steps: [
      { do: 'How many players in the pot, including you?', result: `${opponents + 1}` },
      { do: 'If all hands were equal, everyone gets the same slice', result: pct(1 / (opponents + 1)) },
      { do: 'How does your hand do heads-up?', result: pct(headsUp) },
      { do: 'Every extra opponent drags you toward that equal share', result: `${pct(headsUp)} heads-up → ${pct(equity)} here` },
      { do: 'Actual', result: pct(equity) },
    ],
    note: 'Big pairs hate company; suited connectors and suited aces love it. The hands that flop well gain relative value as the pot grows.',
  };
}

/* ------------------------------------------------------------------ */

export const DRILLS = {
  'pot-odds': { label: 'Pot odds', level: 1, make: potOddsDrill },
  'bluff-breakeven': { label: 'Bluff break-even', level: 1, make: bluffDrill },
  reading: { label: 'Name your hand', level: 1, make: readingDrill },
  'call-ev': { label: 'Call or fold', level: 1, make: callEvDrill },
  mdf: { label: 'Defence frequency', level: 2, make: mdfDrill },
  outs: { label: 'Counting outs', level: 2, make: outsDrill },
  'implied-odds': { label: 'Implied odds', level: 2, make: impliedDrill },
  preflop: { label: 'Preflop all-in', level: 2, make: preflopDrill },
  equity: { label: 'Postflop equity', level: 3, make: equityDrill },
  multiway: { label: 'Multiway equity', level: 3, make: multiwayDrill },
};

export const CURRICULUM = [
  { id: 'auto', label: 'Vic picks (recommended)', drills: null },
  { id: 'starter', label: 'Fundamentals', drills: ['pot-odds', 'bluff-breakeven', 'reading', 'call-ev'] },
  { id: 'draws', label: 'Draws & outs', drills: ['outs', 'implied-odds', 'pot-odds', 'preflop'] },
  { id: 'equity', label: 'Equity', drills: ['equity', 'preflop', 'multiway', 'outs'] },
  { id: 'mixed', label: 'Everything, no mercy', drills: Object.keys(DRILLS) },
];

export function makeDrill(type, rng = Math.random, difficulty = 1) {
  const entry = DRILLS[type];
  if (!entry) throw new Error(`No such drill: ${type}`);
  const drill = entry.make(rng, clampLevel(difficulty));
  return { ...drill, type, label: entry.label, level: entry.level, difficulty: clampLevel(difficulty) };
}

export function trackDrills(trackId) {
  const track = CURRICULUM.find((t) => t.id === trackId);
  return track?.drills || Object.keys(DRILLS);
}

export function makeFromTrack(trackId, rng = Math.random, difficulty = 1) {
  return makeDrill(pickOne(trackDrills(trackId), rng), rng, difficulty);
}
