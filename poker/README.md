# Shark School

A poker trainer for the part of the game that actually decides who keeps their
money: the arithmetic. Your instructor is Vic, who has been dealt in since 1978
and has never once been impressed by anybody.

```bash
npm run poker          # http://localhost:4242
npm run test:poker     # the maths, verified
```

No dependencies, no build step, no bundler. Open ES modules served over plain
HTTP by a 40-line static server.

## What it teaches

Ten drills across three levels, grouped into tracks you can switch between at
any time:

| Drill | What it drills |
| --- | --- |
| Pot odds | `call / (pot + call + call)` — the equity a call needs |
| Bluff break-even | `bet / (pot + bet)` — how often they must fold |
| Defence frequency | `pot / (pot + bet)` — how much you must continue with |
| Call or fold | turning equity and a price into a decision |
| Name your hand | reading the best five out of seven |
| Counting outs | the cards that genuinely put you ahead, not the hopeful ones |
| Implied odds | what the river has to pay for a bad price to become good |
| Preflop all-in | the matchup equities worth memorising |
| Postflop equity | made hand versus draw, flop and turn |
| Multiway equity | what happens to your hand when four people call |

Numeric answers are graded on a band, not an exact match — `perfect`, `close`,
`wrong`, `awful` — and every answer comes back with the working, so a miss
teaches something. There is also an **equity lab** for punching in real hands,
a **report card** that names your worst drill, and a one-page **cheat sheet**.

## Vic

The insults are the point, but they have rules, enforced by the comment at the
top of `lib/snark.js`: Vic mocks the *answer*, the *math*, or his own ruined
career. He never mocks the player for anything other than what they just typed
into the box. A **mood** selector runs Supportive → Cheeky → Brutal, because
"insulting instructor" is fun right up until it isn't, and that call belongs to
the person being insulted.

## Layout

```
poker/
  index.html        markup
  app.css           felt-green theme, one stylesheet
  app.js            UI only — moves text around and keeps score
  serve.js          dependency-free static server
  lib/
    cards.js        cards as ints 0..51, parsing, shuffling, seeded RNG
    evaluator.js    7-card evaluation, one comparable integer per hand
    equity.js       exact enumeration where it fits, sampling past that
    potmath.js      pot odds, MDF, EV, implied odds — each returns its working
    snark.js        Vic's lines, grading bands
    drills.js       question generators
  test/poker.test.js
```

The evaluator reads a hand's shape (rank counts plus suit counts) rather than
enumerating all 21 five-card subsets, so a hand collapses to a single integer
and comparing two hands is subtraction.

The equity engine enumerates every runout when there are few enough of them and
samples otherwise — and the UI always says which, because "62.4% (exact)" and
"62.4% (sampled)" are different claims.

## Tests

`poker/test/poker.test.js` pins the evaluator against every hand category, the
wheel, kicker rules, two-sets-of-trips, and chopped boards; checks equity
against numbers poker players already know (AA vs KK ≈ 82%, the 55/45 flip,
the dominated ace ≈ 73%); and generates every drill repeatedly to prove each one
produces an answerable question with a correct answer.

Play money only. Vic is fictional and none of this is financial advice.
