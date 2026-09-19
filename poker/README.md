# Shark School

A poker trainer for the part of the game that decides who keeps their money:
the arithmetic. Your instructor is Vic, who has been dealt in since 1978, has
never once been impressed by anybody, and teaches like you are four years old
because in his professional opinion, at the poker table, you are.

```bash
npm run poker          # http://localhost:4242
npm run test:poker     # the maths and the coach, verified
```

No dependencies, no build step, no bundler. Plain ES modules served over HTTP
by a 40-line static server.

## Educate: learn it instead of guessing it

The important button. When you look at a question and have no idea where to
even start, **Educate me** walks the maths with you *before* you answer, one
step per click, at your pace:

```
WORKING IT OUT                                              Step 3 of 4
1  If the bluff works, what do you win? Just what is there        200
2  If it fails, what do you lose? Your bet                        100
3  Break-even is risk ÷ (risk + reward)            100 ÷ (100 + 200)
                                                 [ Next step ]
```

The clock stops while you are being taught. At the end the button becomes
**"Got it — give me one like it"**, and you immediately get a fresh question of
the *same skill with different numbers*, so the method gets used while it is
still warm. Being shown how is not the same as knowing how — the twin is the
part that sticks.

A walkthrough is worth a quarter of answering one yourself, and it keeps that
skill coming back in the rotation until you can do it unaided. The report card
counts them in a **Taught** column, so guessing your way to a good grade and
learning your way to one look different.

## The rest of the teaching method

Never say "wrong" without immediately showing the staircase you should have
walked up. Beyond Educate, every question carries:

- **a hint** — *Just a nudge*, for when you know the method but want a pointer
- **the steps**, shown automatically after a miss so you never have to ask for
  help after already feeling stupid
- **a note**, the thing to actually remember

Get it right and the steps are one click away, or always on if you leave
**Explain like I'm four** ticked.

```
1  Money already in the middle                                          20
2  Money villain just pushed in — that is in the middle now as well      10
3  So if you call and win, you scoop all of it              20 + 10 = 30
4  It costs you this much to find out                                    10
5  Add your call to the middle — the whole pot at showdown   30 + 10 = 40
6  Your share of that pot is the share of the time you must win
                                                          10 ÷ 40 = 25.0%
```

## How it sharpens you up fast

`lib/coach.js` holds three mechanisms, and between them they are the difference
between a quiz and actually improving:

1. **Per-concept mastery.** Every skill carries its own fast-moving rolling
   average, so "good at pot odds, hopeless at outs" is a thing the app knows.
2. **Weighted selection.** Your worst skill comes up most, and anything gone
   stale gets dragged back in front of you. You cannot dodge your leak by feel.
3. **Per-concept difficulty.** Master pot odds and *pot odds alone* gets uglier
   numbers and tighter grading, while outs stays on baby numbers until it
   deserves otherwise.

On top of that: a clock on every question (Vic has opinions about your pace),
and five belts that unlock harder drills as you climb.

| Belt | Unlocks | Baseline numbers |
| --- | --- | --- |
| Fish | the four fundamentals | round |
| Limper | + draws, outs, implied odds, preflop | round |
| Reg | same, uglier | realistic |
| Crusher | + equity estimation | realistic |
| Shark | everything | awkward, tightly graded |

A player who answers everything correctly goes Fish → Shark in about 60 hands.
A sustained collapse demotes you, but never below Limper — being sent back to
the start is a reason to close the tab.

## The drills

| Drill | What it drills | Belt |
| --- | --- | --- |
| Pot odds | `call / (pot + call + call)` | Fish |
| Bluff break-even | `bet / (pot + bet)` | Fish |
| Name your hand | best five out of seven | Fish |
| Call or fold | equity + price → decision | Fish |
| Defence frequency | `pot / (pot + bet)` | Limper |
| Counting outs | cards that genuinely take the lead | Limper |
| Implied odds | what the river has to pay | Limper |
| Preflop all-in | the five matchups worth memorising | Limper |
| Postflop equity | made hand vs draw | Crusher |
| Multiway equity | your hand when four people call | Crusher |

Also included: an **equity lab** for punching in real hands, a **report card**
that names your leak and your best time per skill, and a one-page **cheat
sheet**.

## Vic

The insults are the point, but they have rules, enforced by the comment at the
top of `lib/snark.js`:

> Vic mocks the **answer**, the **math**, or his own ruined career. Vic never
> mocks the player for anything they did not just type in. No slurs, no punching
> at who someone is. Swearing at arithmetic only.

**Vic's mouth** runs Clean → Cheeky → Unfiltered. Cheeky is the default;
Unfiltered swears properly. A test asserts the Clean tier never swears, so the
setting means what it says.

## Layout

```
poker/
  index.html        markup
  app.css           felt-green theme, one stylesheet
  app.js            UI only — moves text around, runs the clock, keeps score
  serve.js          dependency-free static server
  lib/
    cards.js        cards as ints 0..51, parsing, shuffling, seeded RNG
    evaluator.js    7-card evaluation, one comparable integer per hand
    equity.js       exact enumeration where it fits, sampling past that
    potmath.js      pot odds, MDF, EV, implied odds — each returns its working
    snark.js        Vic's lines, three moods, grading bands
    drills.js       question generators: scenario, hint, staircase, answer
    coach.js        mastery, selection, difficulty, belts
  test/poker.test.js
```

The evaluator reads a hand's shape (rank counts plus suit counts) rather than
enumerating all 21 five-card subsets, so a hand collapses to a single integer
and comparing two hands is subtraction.

The equity engine enumerates every runout when there are few enough and samples
otherwise — and the UI always says which, because "62.4% (exact)" and "62.4%
(sampled)" are different claims.

## Tests

`npm run test:poker` — 27 tests. They pin the evaluator against every hand
category, the wheel, kicker rules, two sets of trips and chopped boards; check
equity against numbers players already know (AA vs KK ≈ 82%, the 55/45 flip,
the dominated ace ≈ 73%); assert every drill produces a usable hint and a
staircase that actually reaches its own answer; and drive the coach through
simulated learners to prove it feeds you your weakest skill, scales difficulty
per concept, and promotes and demotes when it should.

Play money only. Vic is fictional and none of this is financial advice.
