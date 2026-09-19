// The instructor. His name is Vic, he has been dealt in since 1978, and he
// teaches like you are four years old because — in his professional opinion —
// at the poker table you are.
//
// House rules for the writing in here, and they are not negotiable:
//   * Vic mocks the ANSWER, the MATH, or his own ruined career.
//   * Vic never mocks the player for anything they did not just type in.
//   * No slurs, no punching at who someone is. Swearing at arithmetic only.
// MOOD lets the player dial the language, because "cheeky instructor" is fun
// right up until it isn't, and that call belongs to the person being roasted.

export const MOOD = { CLEAN: 0, CHEEKY: 1, UNFILTERED: 2 };
export const MOOD_LABELS = ['Clean', 'Cheeky', 'Unfiltered'];

// Back-compat alias — the drills and tests grew up calling it heat.
export const HEAT = MOOD;

const LINES = {
  perfect: [
    ['Correct. Well done.', 'Correct. Next.', 'Right. Keep that shape in your head.'],
    ["Correct, and you didn't even flinch.", 'Yes. Bloody good.', "Right. That's the one.", 'Correct. Look at you, doing maths.'],
    ["Correct. Shit, you're learning.", 'Yes! Fucking finally.', 'Right. Do that on the felt and people will hate you.', "Correct. I'd buy you a drink but you'd only get cocky."],
  ],
  close: [
    ['Close — it is {answer}. Look at step three again.', 'Nearly. {answer}.', 'Good instinct, slightly off: {answer}.'],
    ['Close. Close pays the other guy. {answer}.', 'Nearly. {answer}. Tighten it up.', "So close I almost let it go. {answer}."],
    ['Close, and close is how you go broke slowly. {answer}.', 'Nearly, you rounding bastard. {answer}.', "Arse. {answer}. You had it and you fumbled it."],
  ],
  wrong: [
    ["Not quite — {answer}. Let's walk it through.", "That's off. {answer}.", 'Miss. {answer}. Read the steps.'],
    ['No. {answer}. Crayons out, we are doing this together.', 'Wrong. {answer}.', "Nope. {answer}. Don't argue, just read it."],
    ['No. {answer}. Bloody hell, mate.', 'Wrong. {answer}. Right, crayons out.', "Shit no. {answer}. Sit down, we're starting from the top.", 'Wrong. {answer}. Somewhere a fish just got a raise.'],
  ],
  awful: [
    ["Well off — {answer}. Slow down, we'll do it in steps.", 'Not close. {answer}. Read it twice.', 'A long way off. {answer}.'],
    ["That's not in the same postcode. {answer}.", "Miles off. {answer}. You didn't work that out, you guessed.", 'No. {answer}. Deep breath, steps, go again.'],
    ["What the fuck was that? {answer}.", "Christ. {answer}. That wasn't an estimate, it was a hostage note.", 'No. {answer}. You dowsed for that number with a stick.', 'Absolutely not. {answer}. I have seen drunks count better.'],
  ],
  streak: [
    ['{n} in a row. Good.', '{n} straight. Keep going.', '{n} correct. That is a habit forming.'],
    ["{n} in a row. Now I'm suspicious of the deck.", '{n} straight. Do not spend it all in one pot.', '{n} on the bounce. The maths is starting to like you back.'],
    ["{n} in a row. Fine. FINE. You're good at this. I hate it.", "{n} straight, you show-off.", "{n} on the bounce. This is exactly where idiots start gambling it back."],
  ],
  broken: [
    ['Streak over at {n}.', 'And there it goes. {n}.', 'Run ends at {n}. Start another.'],
    ['Streak dies at {n}. They always do.', '{n} and out. Poker is one long apology.', 'There it is. {n}, then reality.'],
    ['Streak dead at {n}. I was drafting the fucking plaque.', '{n}, then that. Classic.', 'And the run ends at {n}. Pride, meet river card.'],
  ],
  greeting: [
    ["Right. Let's work on your game. Small steps, quick progress.", 'Sit down. We start with the numbers.', 'Welcome. Poker is a maths test that takes your wallet.'],
    ["Sit. I'll teach you like you're four, and you'll be dangerous by Friday.", "Right, let's find out what you actually know.", 'Poker is arithmetic in a leather jacket. Begin.'],
    ["Sit down. I'm going to teach you like a toddler and you're going to thank me.", "Right. Let's find your leaks and beat them out of you.", "Poker's just sums, mate. Terrifying, expensive sums."],
  ],
  toddler: [
    ["Here it is, one step at a time.", "Slowly, then. Step by step.", "Right, small pieces."],
    ["Fine. Crayons out. One step at a time.", "Here, I'll hold your hand. Small steps.", "Right, tiny pieces, like cutting up a sausage."],
    ["Crayons out. Tiny fucking steps, then.", "Fine. I'll do it slowly, like I'm explaining stairs.", "Right, hold my hand. One bit at a time."],
  ],
  hint: [
    ['A nudge, not the answer.', 'Here is the shape of it.', 'Think about it like this.'],
    ["I'll point, you walk.", "A nudge. Don't get used to it.", "Here's the trick of it."],
    ["A nudge, you big baby.", "Fine, here's the trick. Don't ask twice.", "I'll point. You still have to do the walking."],
  ],
  beltUp: [
    ['Promoted: {belt}. The questions get harder now.', 'You have earned {belt}. New drills unlocked.', '{belt}. Well done — difficulty up.'],
    ['Promoted to {belt}. Harder numbers from here, obviously.', "{belt}. Don't get comfortable, I've tightened the grading.", 'Up you go: {belt}. New drills, tighter margins.'],
    ["Promoted: {belt}. Right, no more baby numbers, you've earned the ugly ones.", "{belt}. Bloody hell. Fine, difficulty up.", "{belt}. I've tightened the grading out of spite. Enjoy."],
  ],
  twin: [
    ['Now do one yourself. Same maths, new numbers.', 'Your turn. Same shape, different figures.', 'Right — same sum, you drive.'],
    ["Right. Now you do one, while it's still warm.", 'Your turn. Same maths, new numbers, no hand-holding.', "Go on then. Same thing, you drive."],
    ["Right, now you fucking do one. Same maths, new numbers.", "Your turn, and no crying.", "Go on. Same sum. Off you go."],
  ],
  learned: [
    ['There it is — you just did that one yourself.', 'That is the one I walked you through. Well done.', 'Learned and applied. That is how it works.'],
    ['There it is. Walked through, then done solo. That is learning.', "See? You could do it all along, you just didn't know the order.", 'That is the whole trick: shown once, then done yourself.'],
    ["There it fucking is. Taught, then done solo.", "See, you could do it. You just needed the order of operations and a shove.", 'Shown once, nailed once. That is how this works.'],
  ],
  fast: [
    ['Correct and quick. That is the goal.', 'Fast and right. Good.', 'Quick. That matters at a real table.'],
    ['Quick AND right. Now we are getting somewhere.', "Fast. Good — the clock is part of the game.", 'Snappy. Keep that.'],
    ['Quick and right. Christ, who are you?', 'Fast. Bloody good. Speed is the whole point.', 'Instant. That is what sharp looks like.'],
  ],
  slow: [
    ['Right, but slow. Speed comes with reps.', 'Correct, eventually. Work on the pace.', 'Right. Now do it faster.'],
    ["Correct, but I aged. Faster next time.", 'Right, at a glacial pace. Speed it up.', 'Yes — and a real table would have moved on.'],
    ["Correct, but I grew a beard waiting. Faster.", 'Right, eventually. At a real table they would have called the clock.', 'Yes. Slowly. Painfully. Fix that.'],
  ],
};

const TEACHING = {
  potOdds: 'Pot odds: you risk the call to win the pot plus the call. Needed equity = call / (pot + call + call).',
  bluff: 'A bluff of B into P must work B / (P + B) of the time. Bigger bluff, more folds needed.',
  outs: 'Count the cards that actually put you ahead, then rule of 4 on the flop, rule of 2 on the turn.',
  equity: 'Equity is how often you win if the hand goes to showdown right now, with no more betting.',
  mdf: 'Defend pot / (pot + bet) or the bettor prints money with any two cards.',
  implied: 'Implied odds only exist if the money is behind AND they will actually pay you.',
};

/** Pick a line. `rng` is injectable so tests and replays are deterministic. */
export function say(kind, { heat = MOOD.CHEEKY, mood = heat, vars = {}, rng = Math.random } = {}) {
  const tiers = LINES[kind];
  if (!tiers) throw new Error(`Vic has nothing to say about "${kind}"`);
  const pool = tiers[Math.min(Math.max(mood, 0), tiers.length - 1)];
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
 * Grade a numeric answer.
 * `tolerance` is the "correct" band; 3x is "close", 8x is "wrong", beyond that
 * Vic gets creative.
 */
export function grade(given, expected, tolerance) {
  const error = Math.abs(given - expected);
  if (error <= tolerance) return 'perfect';
  if (error <= tolerance * 3) return 'close';
  if (error <= tolerance * 8) return 'wrong';
  return 'awful';
}

export const VERDICT_SCORE = { perfect: 1, close: 0.5, wrong: 0, awful: 0 };
