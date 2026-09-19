// node --test poker/test
//
// The evaluator and the equity engine are the parts a trainer cannot get wrong:
// an instructor who insults you over a bad answer had better have the right one.

import test from 'node:test';
import assert from 'node:assert/strict';

import { cardsToPretty, cardsToString, makeRng, parseCard, parseCards } from '../lib/cards.js';
import { CATEGORY, compareHands, describe, evaluate } from '../lib/evaluator.js';
import { countOuts, equityVsKnown, equityVsRandom, ruleOfTwoAndFour } from '../lib/equity.js';
import { bluffBreakeven, callEV, impliedOdds, mdf, potOdds } from '../lib/potmath.js';
import { grade, MOOD, say } from '../lib/snark.js';
import { DRILLS, makeDrill } from '../lib/drills.js';
import {
  BELTS, beltProgress, checkBelt, chooseNext, createProgress, difficultyFor,
  masteryOf, recordAnswer, report, unlockedTypes,
} from '../lib/coach.js';

const cat = (s) => evaluate(parseCards(s)).category;

test('card parsing round-trips and rejects nonsense', () => {
  assert.equal(cardsToString(parseCards('AhKd7c')), 'Ah Kd 7c');
  assert.equal(cardsToPretty(parseCards('as kh')), 'A♠ K♥');
  // The letter form must round-trip: the equity lab reads its own output back.
  assert.deepEqual(parseCards(cardsToString(parseCards('AhKd7c'))), parseCards('AhKd7c'));
  assert.deepEqual(parseCards(''), []);
  assert.throws(() => parseCards('Xh'));
  assert.throws(() => parseCards('Ahh'));
  assert.throws(() => parseCards('AhAh'), /twice/);
  assert.notEqual(parseCard('Ah'), parseCard('As'));
});

test('every category is recognised from seven cards', () => {
  assert.equal(cat('As Ks Qs Js Ts 2h 3d'), CATEGORY.STRAIGHT_FLUSH);
  assert.equal(cat('9h 9d 9c 9s 2h 3d 4c'), CATEGORY.QUADS);
  assert.equal(cat('Kh Kd Ks 4c 4h 9s 2d'), CATEGORY.FULL_HOUSE);
  assert.equal(cat('2s 5s 9s Js Ks 3h 4d'), CATEGORY.FLUSH);
  assert.equal(cat('5h 6d 7c 8s 9h Kd 2c'), CATEGORY.STRAIGHT);
  assert.equal(cat('7h 7d 7c 2s 9h Kd 4c'), CATEGORY.TRIPS);
  assert.equal(cat('Ah Ad Ks Kc 2h 5d 9c'), CATEGORY.TWO_PAIR);
  assert.equal(cat('Ah Ad 7s 4c 2h 9d Jc'), CATEGORY.PAIR);
  assert.equal(cat('Ah Kd 9c 7s 3h 2d 5c'), CATEGORY.HIGH_CARD);
});

test('the wheel is a straight and the ace plays low', () => {
  assert.equal(cat('Ah 2d 3c 4s 5h Kd 9c'), CATEGORY.STRAIGHT);
  assert.equal(evaluate(parseCards('Ah 2d 3c 4s 5h Kd 9c')).tiebreaks[0], 5);
  assert.match(describe(parseCards('Ah 2d 3c 4s 5h Kd 9c')), /five high/);
  // A wheel loses to any higher straight.
  assert.equal(compareHands(parseCards('Ah2d3c4s5h'), parseCards('2h3d4c5s6h')), -1);
});

test('a six-high straight flush beats a flush that shares its suit', () => {
  const sf = parseCards('2s 3s 4s 5s 6s 9h Kd');
  const flush = parseCards('2s 3s 4s 5s Ks 9h Qd');
  assert.equal(evaluate(sf).category, CATEGORY.STRAIGHT_FLUSH);
  assert.equal(compareHands(sf, flush), 1);
});

test('two sets of trips make a full house, never six of a kind', () => {
  const hand = parseCards('9h 9d 9c 4s 4h 4d Kc');
  assert.equal(evaluate(hand).category, CATEGORY.FULL_HOUSE);
  assert.deepEqual(evaluate(hand).tiebreaks.slice(0, 2), [9, 4]);
});

test('kickers decide when the made hand ties', () => {
  assert.equal(compareHands(parseCards('AhAdKs9c2h'), parseCards('AsAcQs9d2d')), 1);
  assert.equal(compareHands(parseCards('AhAdKs9c2h'), parseCards('AsAcKh9d2d')), 0);
  // Board plays: both players hold nothing, the board is the hand.
  const board = parseCards('As Ks Qs Js Ts');
  assert.equal(compareHands(parseCards('2h3d').concat(board), parseCards('4c5d').concat(board)), 0);
});

test('describe() names hands the way a dealer would', () => {
  assert.equal(describe(parseCards('As Ks Qs Js Ts')), 'a royal flush');
  assert.equal(describe(parseCards('Kh Kd Ks 4c 4h')), 'a full house, kings full of fours');
  assert.equal(describe(parseCards('Ah Ad Ks Kc 2h')), 'two pair, aces and kings');
  assert.equal(describe(parseCards('Ah Ad 7s 4c 2h')), 'a pair of aces, 7 kicker');
});

test('equity matches the numbers every poker player already knows', () => {
  const rng = makeRng(42);
  const aaKk = equityVsKnown([parseCards('AsAh'), parseCards('KsKh')], [], { trials: 40000, rng });
  assert.ok(Math.abs(aaKk.equity[0] - 0.822) < 0.015, `AA vs KK was ${aaKk.equity[0]}`);

  const flip = equityVsKnown([parseCards('8s8h'), parseCards('AcKd')], [], { trials: 40000, rng });
  assert.ok(Math.abs(flip.equity[0] - 0.548) < 0.02, `88 vs AK was ${flip.equity[0]}`);

  const dominated = equityVsKnown([parseCards('AhKs'), parseCards('AdQc')], [], { trials: 40000, rng });
  assert.ok(Math.abs(dominated.equity[0] - 0.735) < 0.02, `AK vs AQ was ${dominated.equity[0]}`);

  assert.ok(equityVsKnown([parseCards('AsAh'), parseCards('KsKh')], [], { trials: 40000, rng })
    .equity.reduce((a, b) => a + b) > 0.999);
});

test('a decided river is 100/0 and enumerated exactly', () => {
  const r = equityVsKnown([parseCards('AhAd'), parseCards('7s2c')], parseCards('Ac Kh 5d 9s 3h'));
  assert.equal(r.exact, true);
  assert.equal(r.equity[0], 1);
  assert.equal(r.equity[1], 0);
});

test('a chopped board splits the pot', () => {
  const r = equityVsKnown([parseCards('2h3d'), parseCards('4c5d')], parseCards('As Ks Qs Js Ts'));
  assert.equal(r.equity[0], 0.5);
  assert.equal(r.equity[1], 0.5);
});

test('equity against more opponents only falls', () => {
  const rng = makeRng(7);
  const hero = parseCards('AsAh');
  const one = equityVsRandom(hero, [], 1, { trials: 8000, rng }).equity;
  const five = equityVsRandom(hero, [], 5, { trials: 8000, rng }).equity;
  assert.ok(one > 0.8 && one < 0.89, `AA heads-up was ${one}`);
  assert.ok(five < one);
});

test('outs are the cards that actually take the lead', () => {
  // Nut flush draw plus two overcards against a set of sevens.
  const outs = countOuts(parseCards('AhKh'), parseCards('7s7d'), parseCards('Qh5h2c'));
  assert.equal(outs.behind, true);
  assert.ok(outs.count >= 9);
  // Every listed out really does win.
  assert.equal(outs.outs.length, outs.count);

  // A made straight against a bare pair has nothing to draw to.
  const ahead = countOuts(parseCards('9h8d'), parseCards('KsKc'), parseCards('7c6s5h'));
  assert.equal(ahead.behind, false);
});

test('the rule of 2 and 4 overstates big draws, as advertised', () => {
  const nine = ruleOfTwoAndFour(9, 'flop');
  assert.ok(nine.error > 0 && nine.error < 0.02);
  const fifteen = ruleOfTwoAndFour(15, 'flop');
  assert.ok(fifteen.error > nine.error, 'the shortcut drifts further with more outs');
  assert.ok(Math.abs(ruleOfTwoAndFour(9, 'turn').exact - 9 / 46) < 1e-9);
});

test('pot maths matches the textbook', () => {
  assert.equal(potOdds(100, 50).needed, 0.25);
  assert.equal(potOdds(100, 100).needed, 1 / 3);
  assert.equal(bluffBreakeven(100, 50).needed, 1 / 3);
  assert.equal(bluffBreakeven(100, 100).needed, 0.5);
  assert.equal(mdf(100, 50).defend, 2 / 3);
  assert.equal(callEV(100, 50, 0.25).ev, 0);
  assert.equal(callEV(100, 50, 0.5).profitable, true);
  assert.equal(impliedOdds(100, 50, 0.5).alreadyGood, true);
  assert.ok(impliedOdds(100, 50, 0.1).extra > 0);
});

test('grading bands widen in the right order', () => {
  assert.equal(grade(25, 25, 1), 'perfect');
  assert.equal(grade(27, 25, 1), 'close');
  assert.equal(grade(31, 25, 1), 'wrong');
  assert.equal(grade(80, 25, 1), 'awful');
});

test('Vic fills in his templates at every mood', () => {
  const rng = makeRng(1);
  for (const mood of [MOOD.CLEAN, MOOD.CHEEKY, MOOD.UNFILTERED]) {
    const line = say('wrong', { mood, vars: { answer: '25%' }, rng });
    assert.ok(line.includes('25%'), line);
    assert.ok(!line.includes('{'), `unsubstituted placeholder: ${line}`);
  }
  assert.ok(say('streak', { vars: { n: 4 }, rng }).includes('4'));
  assert.ok(say('beltUp', { vars: { belt: 'Shark' }, rng }).includes('Shark'));
  assert.throws(() => say('nonsense'));
});

test('the clean mood stays clean', () => {
  const rng = makeRng(31);
  const swears = /\b(fuck\w*|shit\w*|bastard|arse|bloody|christ)\b/i;
  for (const kind of ['perfect', 'close', 'wrong', 'awful', 'streak', 'broken', 'greeting', 'toddler', 'hint', 'beltUp', 'fast', 'slow']) {
    for (let i = 0; i < 40; i += 1) {
      const line = say(kind, { mood: MOOD.CLEAN, vars: { answer: '25%', n: 3, belt: 'Reg' }, rng });
      assert.ok(!swears.test(line), `clean mood said: ${line}`);
    }
  }
});

test('every drill generates a complete, answerable question', () => {
  const rng = makeRng(99);
  for (const type of Object.keys(DRILLS)) {
    for (let i = 0; i < 6; i += 1) {
      const d = makeDrill(type, rng);
      assert.ok(d.scenario && d.question && d.working && d.note, `${type} is missing copy`);
      assert.ok(d.hint && d.hint.length > 20, `${type} has no usable hint`);
      assert.ok(Array.isArray(d.steps) && d.steps.length >= 4, `${type} needs a real staircase`);
      d.steps.forEach((step, n) => {
        assert.ok(step.do && step.do.length > 3, `${type} step ${n} has no instruction`);
        assert.ok(step.result !== undefined && String(step.result).length > 0, `${type} step ${n} shows no result`);
      });
      // The staircase has to actually arrive at the answer somewhere — a
      // walkthrough that never reaches the number teaches nothing. (Some
      // drills carry on past it, e.g. outs then converts to a percentage.)
      const key = String(d.display).split(' ')[0];
      assert.ok(d.steps.some((step) => String(step.result).includes(key)),
        `${type} staircase never reaches ${d.display}`);
      assert.ok(d.display, `${type} has no answer to show`);
      if (d.mode === 'number') {
        assert.ok(Number.isFinite(d.answer), `${type} answer was ${d.answer}`);
        assert.ok(d.tolerance > 0, `${type} has no tolerance`);
      } else {
        assert.ok(d.choices.includes(d.answer), `${type} answer is not among its choices`);
        assert.equal(new Set(d.choices).size, d.choices.length, `${type} repeated a choice`);
      }
    }
  }
});

test('the outs drill only ever asks about hands that are behind', () => {
  const rng = makeRng(2024);
  for (let i = 0; i < 25; i += 1) {
    const d = makeDrill('outs', rng);
    if (d.type !== 'outs') continue;
    const o = countOuts(d.cards.hero, d.cards.villain, d.cards.board);
    assert.equal(o.behind, true);
    assert.equal(o.count, d.answer);
  }
});


/* ------------------------------ the coach ------------------------------ */

test('mastery rises with correct answers and falls with wrong ones', () => {
  const p = createProgress();
  for (let i = 0; i < 6; i += 1) recordAnswer(p, { type: 'pot-odds', score: 1, ms: 5000 });
  assert.ok(masteryOf(p, 'pot-odds') > 0.85, masteryOf(p, 'pot-odds'));
  for (let i = 0; i < 6; i += 1) recordAnswer(p, { type: 'pot-odds', score: 0, ms: 5000 });
  assert.ok(masteryOf(p, 'pot-odds') < 0.15, masteryOf(p, 'pot-odds'));
});

test('pace is judged against the drill\'s own target time', () => {
  const p = createProgress();
  assert.equal(recordAnswer(p, { type: 'pot-odds', score: 1, ms: 3000 }).quick, true);
  assert.equal(recordAnswer(p, { type: 'pot-odds', score: 1, ms: 40000 }).slow, true);
  // A wrong answer is never "quick", however fast it was typed.
  assert.equal(recordAnswer(p, { type: 'pot-odds', score: 0, ms: 300 }).quick, false);
});

test('the coach feeds you your weakest skill most often', () => {
  const rng = makeRng(8);
  const p = createProgress();
  const pool = unlockedTypes(p);
  for (const type of pool) {
    for (let i = 0; i < 5; i += 1) {
      recordAnswer(p, { type, score: type === 'reading' ? 0 : 1, ms: 5000 });
    }
  }
  const counts = {};
  for (let i = 0; i < 400; i += 1) {
    const type = chooseNext(p, pool, rng);
    counts[type] = (counts[type] || 0) + 1;
  }
  const others = Object.entries(counts).filter(([t]) => t !== 'reading').map(([, n]) => n);
  assert.ok(counts.reading > Math.max(...others) * 1.5,
    `weak skill picked ${counts.reading}, best of the rest ${Math.max(...others)}`);
});

test('the coach does not ask the same thing twice in a row', () => {
  const rng = makeRng(12);
  const p = createProgress();
  const pool = unlockedTypes(p);
  let repeats = 0;
  for (let i = 0; i < 200; i += 1) {
    const type = chooseNext(p, pool, rng);
    if (type === p.lastType) repeats += 1;
    recordAnswer(p, { type, score: 1, ms: 4000 });
  }
  assert.ok(repeats < 15, `${repeats} back-to-back repeats in 200`);
});

test('difficulty tracks each skill separately', () => {
  const p = createProgress();
  p.belt = 2; // Reg: baseline difficulty 1
  for (let i = 0; i < 8; i += 1) recordAnswer(p, { type: 'pot-odds', score: 1, ms: 4000 });
  for (let i = 0; i < 8; i += 1) recordAnswer(p, { type: 'outs', score: 0, ms: 4000 });
  assert.equal(difficultyFor(p, 'pot-odds'), 2, 'mastered skill should get harder');
  assert.equal(difficultyFor(p, 'outs'), 0, 'weak skill should get easier');
  // Difficulty is a real knob: harder levels grade more tightly.
  const rng = makeRng(5);
  const easy = makeDrill('pot-odds', rng, 0);
  const hard = makeDrill('pot-odds', rng, 2);
  assert.ok(hard.tolerance < easy.tolerance);
});

test('belts unlock drills and promote on sustained mastery', () => {
  const p = createProgress();
  assert.deepEqual(unlockedTypes(p).sort(), ['bluff-breakeven', 'call-ev', 'pot-odds', 'reading'].sort());

  let promotions = 0;
  for (let i = 0; i < 200 && p.belt < BELTS.length - 1; i += 1) {
    for (const type of unlockedTypes(p)) recordAnswer(p, { type, score: 1, ms: 4000 });
    if (checkBelt(p)) promotions += 1;
  }
  assert.equal(p.belt, BELTS.length - 1);
  assert.equal(promotions, BELTS.length - 1);
  assert.ok(unlockedTypes(p).length === Object.keys(DRILLS).length, 'Shark should see everything');
  assert.equal(beltProgress(p), 1);
});

test('a sustained collapse demotes you, but never past Limper', () => {
  const p = createProgress();
  p.belt = 3;
  for (let i = 0; i < 200; i += 1) {
    for (const type of unlockedTypes(p)) recordAnswer(p, { type, score: 0, ms: 4000 });
    checkBelt(p);
  }
  assert.equal(p.belt, 1, 'demotion floors at Limper');
});

test('the report names a weakest and strongest skill', () => {
  const p = createProgress();
  for (let i = 0; i < 5; i += 1) {
    recordAnswer(p, { type: 'pot-odds', score: 1, ms: 3000 });
    recordAnswer(p, { type: 'reading', score: 0, ms: 9000 });
  }
  const r = report(p);
  assert.equal(r.weakest.type, 'reading');
  assert.equal(r.strongest.type, 'pot-odds');
  assert.ok(r.rows.every((row) => row.avgSeconds === null || row.avgSeconds > 0));
  assert.equal(r.belt.name, 'Fish');
  assert.equal(r.nextBelt.name, 'Limper');
});
