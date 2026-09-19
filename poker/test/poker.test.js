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
import { grade, HEAT, say } from '../lib/snark.js';
import { DRILLS, makeDrill } from '../lib/drills.js';

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

test('Vic fills in his templates and honours the heat setting', () => {
  const rng = makeRng(1);
  for (const heat of [HEAT.POLITE, HEAT.CHEEKY, HEAT.BRUTAL]) {
    const line = say('wrong', { heat, vars: { answer: '25%' }, rng });
    assert.ok(line.includes('25%'), line);
    assert.ok(!line.includes('{'), `unsubstituted placeholder: ${line}`);
  }
  assert.ok(say('streak', { vars: { n: 4 }, rng }).includes('4'));
  assert.throws(() => say('nonsense'));
});

test('every drill generates a complete, answerable question', () => {
  const rng = makeRng(99);
  for (const type of Object.keys(DRILLS)) {
    for (let i = 0; i < 6; i += 1) {
      const d = makeDrill(type, rng);
      assert.ok(d.scenario && d.question && d.working && d.note, `${type} is missing copy`);
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
