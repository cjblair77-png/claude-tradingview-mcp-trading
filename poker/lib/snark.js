// The instructor. His name is Vic, he has been dealt in since 1978, and he has
// never once been impressed by anybody.
//
// House rules for the writing in here: the lines mock the ANSWER, the MATH, or
// Vic's own ruined career. They never mock the player for anything they did not
// just type into the box. Keep it a roast, not a bar fight.
//
// HEAT levels let the player dial it down (or up) — because "insulting" is fun
// right up until it isn't, and that call belongs to the person being insulted.

export const HEAT = { POLITE: 0, CHEEKY: 1, BRUTAL: 2 };
export const HEAT_LABELS = ['Supportive', 'Cheeky', 'Brutal'];

const LINES = {
  perfect: [
    ["Correct. Well done.", "Correct. Don't let it go to your head.", "Correct. A stopped clock, etc."],
    ["Right on the number. I'm as surprised as you are.", "Correct. Somebody's been reading.", "Exactly right. Suspicious, but right.", "Nailed it. I'll allow one smug moment."],
    ["Correct, which after that last effort feels like a typo.", "Right. Frame it, it won't happen twice.", "Perfect. The table will miss your money.", "Correct. Now do it when there's actual money on it, hero."],
  ],
  close: [
    ["Close enough — the exact figure is {answer}.", "Nearly. {answer} is the number.", "Good instinct, slightly off: {answer}."],
    ["Close. In poker, close pays the other guy. It's {answer}.", "Within spitting distance. {answer}.", "Nearly right, which is the most expensive kind of wrong. {answer}."],
    ["Close! Also wrong. {answer}.", "You grazed it. The number is {answer}. Grazing is how bankrolls die.", "Almost. Rounding like that is a slow leak with good manners. {answer}."],
  ],
  wrong: [
    ["Not quite — it's {answer}. Have another look at the working.", "That's off. The answer is {answer}.", "Miss. {answer} — the working is below."],
    ["No. {answer}. Read the working before you argue with me.", "Wrong, and confidently so. {answer}.", "That's a fold. It's {answer}.", "Nope. {answer}. The pot was never going to be that generous."],
    ["Wrong. {answer}. I've seen better arithmetic from the drinks trolley.", "No. {answer}. Whatever you did there, do it away from a card room.", "Incorrect. {answer}. That guess had the shape of a number and none of the content.", "Wrong. {answer}. Somewhere a recreational player just got a raise."],
  ],
  awful: [
    ["That's a long way off. It's {answer} — let's slow this one down.", "Well off. {answer}. Worth re-reading the section.", "Not close. {answer}."],
    ["That's not in the same postcode. {answer}.", "Off by a mile. {answer}. Take the long road next time.", "No. {answer}. You didn't calculate that, you dowsed for it."],
    ["That answer needs a search party. It's {answer}.", "{answer}. You were closer to the correct answer before you started thinking.", "No. {answer}. I've watched people shove drunk with more discipline than that.", "{answer}. That wasn't an estimate, that was a hostage note."],
  ],
  streak: [
    ["{n} in a row. Good work.", "{n} straight. Keep going.", "{n} correct. That's a habit forming."],
    ["{n} in a row. Now I'm suspicious of the deck.", "{n} straight. Don't spend it all in one pot.", "{n} on the bounce. The math is starting to like you back."],
    ["{n} in a row. Fine. FINE. You're competent. I hate it.", "{n} straight. This is where the average player starts to gamble it all back.", "{n} correct. Careful — feeling good at poker is the most expensive feeling there is."],
  ],
  broken: [
    ["Streak over at {n}. It happens.", "And there goes the run. {n}.", "Streak ends at {n}. Start another."],
    ["Streak dies at {n}. They always do.", "{n} and out. Poker is just a long apology.", "There it is. {n}, then reality."],
    ["Streak over at {n}. I was drafting the plaque and everything.", "{n}, then that. Classic you.", "And the run ends. {n}. Pride comes before the river card."],
  ],
  greeting: [
    ["Right. Let's work on your game.", "Sit down, we'll start with the numbers.", "Welcome. Poker is a math test that takes your wallet."],
    ["Sit. The math doesn't care how you feel about it.", "Let's find out what you actually know, as opposed to what you tell people at parties.", "Poker is arithmetic wearing a leather jacket. Begin."],
    ["Sit down. I've seen your results. We have work to do.", "Let's establish a baseline for the disappointment.", "Poker rewards two things: math and patience. You've brought neither. Yet."],
  ],
};

const TEACHING = {
  potOdds: 'Pot odds: you risk the call to win the pot plus the call. Needed equity = call / (pot + call + call).',
  bluff: 'A bluff of B into P must work B / (P + B) of the time. Bigger bluff, more folds needed.',
  outs: 'Count the cards that actually put you ahead, then rule of 4 on the flop, rule of 2 on the turn.',
  equity: 'Equity is how often you win if the hand goes to showdown right now, with no more betting.',
  mdf: 'Defend pot / (pot + bet) or the bettor can print money with any two cards.',
  implied: 'Implied odds only exist if the money is actually behind AND they will actually pay you.',
};

/**
 * Pick a line. `rng` is injectable so tests and replays are deterministic.
 */
export function say(kind, { heat = HEAT.CHEEKY, vars = {}, rng = Math.random } = {}) {
  const tiers = LINES[kind];
  if (!tiers) throw new Error(`Vic has nothing to say about "${kind}"`);
  const pool = tiers[Math.min(heat, tiers.length - 1)];
  const line = pool[Math.floor(rng() * pool.length)];
  const filled = line.replace(/\{(\w+)\}/g, (_, key) => (key in vars ? String(vars[key]) : `{${key}}`));
  // Substituted answers like "a pair of aces" often land at the start of a
  // sentence, so tidy the capitals rather than writing two copies of every line.
  return filled.replace(/(^|[.!?]\s+)([a-z])/g, (_, lead, letter) => lead + letter.toUpperCase());
}

export function lesson(topic) {
  return TEACHING[topic] || '';
}

/**
 * Grade a numeric answer and pick the matching insult.
 * `tolerance` is the "correct" band; 3x is "close", 8x is "wrong", beyond that Vic gets creative.
 */
export function grade(given, expected, tolerance) {
  const error = Math.abs(given - expected);
  if (error <= tolerance) return 'perfect';
  if (error <= tolerance * 3) return 'close';
  if (error <= tolerance * 8) return 'wrong';
  return 'awful';
}

export const VERDICT_SCORE = { perfect: 1, close: 0.5, wrong: 0, awful: 0 };
