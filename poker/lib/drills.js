// Drill generators. Each one returns a self-contained question: the setup, the
// correct answer, how tightly we grade it, and the working Vic reads out
// afterwards. The UI knows nothing about poker — it just renders these.

import { cardsToPretty, deckWithout, drawRandom, pickOne } from './cards.js';
import { describe, evaluate } from './evaluator.js';
import { countOuts, equityVsKnown, equityVsRandom, ruleOfTwoAndFour } from './equity.js';
import { bluffBreakeven, callEV, fmt, impliedOdds, mdf, pct, potOdds } from './potmath.js';

const POTS = [20, 30, 40, 50, 60, 80, 100, 120, 150, 200, 300];
const FRACTIONS = [
  { label: 'a third pot', f: 1 / 3 },
  { label: 'half pot', f: 0.5 },
  { label: 'two thirds pot', f: 2 / 3 },
  { label: 'three quarters pot', f: 0.75 },
  { label: 'pot', f: 1 },
  { label: 'overbet, 1.5x pot', f: 1.5 },
];

const round5 = (n) => Math.round(n / 5) * 5 || 5;

function deal(rng, spec) {
  // spec: { hero: n, villain: n, board: n } — dealt from one shared deck.
  const draw = drawRandom(deckWithout([]), (spec.hero || 0) + (spec.villain || 0) + (spec.board || 0), rng);
  let i = 0;
  const take = (n) => draw.slice(i, (i += n));
  return { hero: take(spec.hero || 0), villain: take(spec.villain || 0), board: take(spec.board || 0) };
}

/* ------------------------------------------------------------------ */
/* Level 1 — the chip arithmetic                                       */
/* ------------------------------------------------------------------ */

function potOddsDrill(rng) {
  const pot = pickOne(POTS, rng);
  const sizing = pickOne(FRACTIONS, rng);
  const bet = round5(pot * sizing.f);
  const { needed, working } = potOdds(pot, bet);
  return {
    type: 'pot-odds',
    topic: 'potOdds',
    title: 'Pot odds',
    scenario: `The pot is ${fmt(pot)}. Villain shoves ${fmt(bet)} into it (${sizing.label}).`,
    question: 'What equity do you need for the call to break even?',
    mode: 'number',
    unit: '%',
    answer: needed * 100,
    tolerance: 1,
    display: pct(needed),
    working,
    note: `You risk ${fmt(bet)} to win ${fmt(pot + bet)}. Your own call counts in the denominator — that is the part everybody forgets.`,
  };
}

function bluffDrill(rng) {
  const pot = pickOne(POTS, rng);
  const sizing = pickOne(FRACTIONS, rng);
  const bet = round5(pot * sizing.f);
  const { needed, working } = bluffBreakeven(pot, bet);
  return {
    type: 'bluff-breakeven',
    topic: 'bluff',
    title: 'Bluff break-even',
    scenario: `Pot is ${fmt(pot)}. You are about to fire ${fmt(bet)} (${sizing.label}) with absolutely nothing.`,
    question: 'How often must villain fold for the bluff to break even?',
    mode: 'number',
    unit: '%',
    answer: needed * 100,
    tolerance: 1,
    display: pct(needed),
    working,
    note: 'Risk over risk-plus-reward. Note that your own bet is NOT in the denominator here — you win the pot as it stands, not the pot plus your bet.',
  };
}

function mdfDrill(rng) {
  const pot = pickOne(POTS, rng);
  const sizing = pickOne(FRACTIONS.slice(0, 5), rng);
  const bet = round5(pot * sizing.f);
  const { defend, fold, working } = mdf(pot, bet);
  return {
    type: 'mdf',
    topic: 'mdf',
    title: 'Minimum defence frequency',
    scenario: `Pot ${fmt(pot)}, villain bets ${fmt(bet)} (${sizing.label}).`,
    question: 'What share of your range must you continue with to stop them auto-profiting?',
    mode: 'number',
    unit: '%',
    answer: defend * 100,
    tolerance: 2,
    display: pct(defend),
    working,
    note: `Fold more than ${pct(fold)} and any two cards prints money against you. This is a ceiling on folding, not a licence to call everything.`,
  };
}

function callEvDrill(rng) {
  const pot = pickOne(POTS, rng);
  const bet = round5(pot * pickOne([0.5, 0.75, 1], rng));
  const equity = Math.round((0.1 + rng() * 0.5) * 100) / 100;
  const { ev, profitable, working } = callEV(pot, bet, equity);
  return {
    type: 'call-ev',
    topic: 'potOdds',
    title: 'Call or fold',
    scenario: `Pot ${fmt(pot)}, villain bets ${fmt(bet)}. You somehow know you have exactly ${pct(equity)} equity.`,
    question: 'Call or fold?',
    mode: 'choice',
    choices: ['Call', 'Fold'],
    answer: profitable ? 'Call' : 'Fold',
    display: `${profitable ? 'Call' : 'Fold'} (EV ${fmt(ev)})`,
    working,
    note: `You need ${pct(potOdds(pot, bet).needed)} and you have ${pct(equity)}. ${profitable ? 'Free money. Take it.' : 'Not enough. Let it go.'}`,
  };
}

function impliedDrill(rng) {
  const pot = pickOne([40, 60, 80, 100, 150], rng);
  const bet = round5(pot * pickOne([0.5, 0.75, 1], rng));
  const equity = pickOne([0.08, 0.1, 0.12, 0.16, 0.18, 0.2], rng);
  const { extra, working } = impliedOdds(pot, bet, equity);
  return {
    type: 'implied-odds',
    topic: 'implied',
    title: 'Implied odds',
    scenario: `Pot ${fmt(pot)}, villain bets ${fmt(bet)}. Your draw is worth ${pct(equity)} and it is the turn, so it is this street or nothing.`,
    question: 'How many EXTRA chips must you expect to win on the river for this call to break even?',
    mode: 'number',
    unit: 'chips',
    answer: extra,
    tolerance: Math.max(4, extra * 0.1),
    display: fmt(extra),
    working,
    note: 'Implied odds are a promise, not a fact. If the stacks are short or villain never pays, that number is zero and you are just calling badly.',
  };
}

/* ------------------------------------------------------------------ */
/* Level 2 — cards on the table                                        */
/* ------------------------------------------------------------------ */

function outsDrill(rng) {
  // Keep dealing until hero is genuinely behind with something to draw to —
  // "count your outs" is a meaningless question when you're already winning.
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
      scenario: `${street === 'flop' ? 'Flop' : 'Turn'}. You hold ${cardsToPretty(hero)}, villain has tabled ${cardsToPretty(villain)} — they have ${describe(villain.concat(board))}, you have ${describe(hero.concat(board))}.`,
      question: 'How many cards in the deck put you ahead on the next street?',
      mode: 'number',
      unit: 'outs',
      answer: outs.count,
      tolerance: 0.5,
      display: `${outs.count} outs`,
      working: `${cardsToPretty(outs.outs)}`,
      note: `Rule of ${street === 'flop' ? '4' : '2'} says ≈${pct(rule.approx)}; the real number ${street === 'flop' ? 'by the river' : 'on the river'} is ${pct(rule.exact)}. The shortcut drifts high once you pass about 8 outs.`,
    };
  }
  return potOddsDrill(rng); // vanishingly unlikely, but never hand back nothing
}

function equityDrill(rng) {
  const street = pickOne(['flop', 'flop', 'turn'], rng);
  const { hero, villain, board } = deal(rng, { hero: 2, villain: 2, board: street === 'flop' ? 3 : 4 });
  const { equity, exact, trials } = equityVsKnown([hero, villain], board, { trials: 8000, rng });
  return {
    type: 'equity',
    topic: 'equity',
    title: 'Eyeball the equity',
    cards: { hero, villain, board },
    scenario: `Both hands face up on the ${street}. You: ${cardsToPretty(hero)} (${describe(hero.concat(board))}). Villain: ${cardsToPretty(villain)} (${describe(villain.concat(board))}).`,
    question: 'What is YOUR equity if this runs out with no more betting?',
    mode: 'number',
    unit: '%',
    answer: equity[0] * 100,
    tolerance: 5,
    display: pct(equity[0]),
    working: exact ? `Exact — all ${trials} runouts enumerated.` : `Sampled over ${trials} runouts.`,
    note: 'Made hand versus draw is usually closer than it looks on the flop and much further apart by the turn. One card to come halves everything.',
  };
}

function preflopDrill(rng) {
  const { hero, villain } = deal(rng, { hero: 2, villain: 2 });
  const { equity, trials } = equityVsKnown([hero, villain], [], { trials: 6000, rng });
  return {
    type: 'preflop',
    topic: 'equity',
    title: 'Preflop all-in',
    cards: { hero, villain, board: [] },
    scenario: `It's all in preflop. You: ${cardsToPretty(hero)}. Villain: ${cardsToPretty(villain)}.`,
    question: 'Your equity?',
    mode: 'number',
    unit: '%',
    answer: equity[0] * 100,
    tolerance: 6,
    display: pct(equity[0]),
    working: `Sampled over ${trials} runouts.`,
    note: 'Anchors worth memorising: pair vs two overcards ≈ 55/45. Pair vs one overcard ≈ 70/30. Dominated ace ≈ 70/30. Two overcards vs two unders ≈ 62/38.',
  };
}

function multiwayDrill(rng) {
  const opponents = pickOne([2, 3, 4, 5, 8], rng);
  const { hero } = deal(rng, { hero: 2 });
  const { equity, trials } = equityVsRandom(hero, [], opponents, { trials: 5000, rng });
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
    tolerance: 6,
    display: pct(equity),
    working: `Sampled over ${trials} hands versus ${opponents} random holdings.`,
    note: 'Big pairs hate company; suited connectors and suited aces love it. Equity falls roughly like 1/(players), so the hands that need to flop well gain relative value.',
  };
}

const CATEGORY_CHOICE = [
  'high card', 'a pair', 'two pair', 'three of a kind', 'a straight',
  'a flush', 'a full house', 'four of a kind', 'a straight flush',
];

function readingDrill(rng) {
  const { hero, board } = deal(rng, { hero: 2, board: 5 });
  const best = hero.concat(board);
  const truth = describe(best);
  const correct = CATEGORY_CHOICE[evaluate(best).category];

  // Distractors are drawn from neighbouring categories — a plausible mistake is
  // a better lesson than an absurd one.
  const near = CATEGORY_CHOICE
    .map((label, i) => ({ label, distance: Math.abs(i - evaluate(best).category) }))
    .filter((c) => c.distance > 0)
    .sort((a, b) => a.distance - b.distance || rng() - 0.5)
    .slice(0, 4)
    .sort(() => rng() - 0.5)
    .slice(0, 3)
    .map((c) => c.label);

  const choices = [correct, ...near].sort(() => rng() - 0.5);

  return {
    type: 'reading',
    topic: 'outs',
    title: 'Name your hand',
    cards: { hero, villain: [], board },
    scenario: `You hold ${cardsToPretty(hero)}. Board: ${cardsToPretty(board)}.`,
    question: 'What is your best five-card hand?',
    mode: 'choice',
    choices,
    answer: correct,
    display: truth,
    working: `Best five cards play: ${truth}.`,
    note: 'Seven cards, best five. Your hole cards are not obliged to be involved at all — the board can outrun you.',
  };
}

/* ------------------------------------------------------------------ */

export const DRILLS = {
  'pot-odds': { label: 'Pot odds', level: 1, make: potOddsDrill },
  'bluff-breakeven': { label: 'Bluff break-even', level: 1, make: bluffDrill },
  mdf: { label: 'Defence frequency', level: 1, make: mdfDrill },
  'call-ev': { label: 'Call or fold', level: 1, make: callEvDrill },
  'implied-odds': { label: 'Implied odds', level: 2, make: impliedDrill },
  outs: { label: 'Counting outs', level: 2, make: outsDrill },
  reading: { label: 'Name your hand', level: 1, make: readingDrill },
  equity: { label: 'Postflop equity', level: 3, make: equityDrill },
  preflop: { label: 'Preflop all-in', level: 2, make: preflopDrill },
  multiway: { label: 'Multiway equity', level: 3, make: multiwayDrill },
};

export const CURRICULUM = [
  { id: 'starter', label: 'Fundamentals', drills: ['pot-odds', 'bluff-breakeven', 'reading', 'call-ev'] },
  { id: 'draws', label: 'Draws & outs', drills: ['outs', 'implied-odds', 'pot-odds', 'preflop'] },
  { id: 'equity', label: 'Equity', drills: ['equity', 'preflop', 'multiway', 'outs'] },
  { id: 'mixed', label: 'Everything, no mercy', drills: Object.keys(DRILLS) },
];

export function makeDrill(type, rng = Math.random) {
  const entry = DRILLS[type];
  if (!entry) throw new Error(`No such drill: ${type}`);
  return { ...entry.make(rng), type, label: entry.label, level: entry.level };
}

export function makeFromTrack(trackId, rng = Math.random) {
  const track = CURRICULUM.find((t) => t.id === trackId) || CURRICULUM[0];
  return makeDrill(pickOne(track.drills, rng), rng);
}
