// The coach: what Vic knows about you, and what he does with it.
//
// Three mechanisms, and between them they are the difference between a quiz
// and actually getting better:
//
//  1. Per-concept mastery. Every drill type carries its own exponential moving
//     average, so "good at pot odds, hopeless at outs" is a thing the app knows.
//  2. Weighted selection. Your worst concept comes up most, and anything you
//     have not seen in a while gets dragged back in front of you (spaced
//     repetition, roughly). You cannot dodge your leak by feel.
//  3. Per-concept difficulty. Master pot odds and pot odds alone gets uglier
//     numbers and tighter grading — while outs stays on baby numbers until it
//     deserves otherwise.

import { DRILLS } from './drills.js';

export const BELTS = [
  { name: 'Fish', blurb: 'Everyone starts here. Vic started here.', difficulty: 0, levels: [1], promote: { hands: 8, mastery: 0.6 } },
  { name: 'Limper', blurb: 'You know the sums. You are slow at them.', difficulty: 0, levels: [1, 2], promote: { hands: 12, mastery: 0.65 } },
  { name: 'Reg', blurb: 'Dangerous on a good night.', difficulty: 1, levels: [1, 2], promote: { hands: 16, mastery: 0.7 } },
  { name: 'Crusher', blurb: 'The numbers are automatic now.', difficulty: 1, levels: [1, 2, 3], promote: { hands: 20, mastery: 0.75 } },
  { name: 'Shark', blurb: 'Vic has stopped making eye contact.', difficulty: 2, levels: [1, 2, 3], promote: null },
];

/** Seconds a sharp player should need. Under it and Vic calls you quick. */
const TARGET_SECONDS = {
  'pot-odds': 12, 'bluff-breakeven': 12, 'call-ev': 10, reading: 12,
  mdf: 14, 'implied-odds': 25, outs: 30,
  preflop: 20, equity: 30, multiway: 20,
};

const ALPHA = 0.34; // how fast mastery reacts. High, because so should you.
const MASTERY_FOR_HARDER = 0.85;
const MASTERY_FOR_EASIER = 0.4;
const TAUGHT_CREDIT = 0.25; // what a walkthrough is worth against a real answer

export function createProgress() {
  return { belt: 0, hands: 0, handsAtBelt: 0, lastType: null, types: {} };
}

function slot(progress, type) {
  if (!progress.types[type]) {
    progress.types[type] = { seen: 0, taught: 0, mastery: 0, lastSeenAt: -99, totalMs: 0, timed: 0, bestMs: null };
  }
  return progress.types[type];
}

/** Drill types available at the current belt. */
export function unlockedTypes(progress) {
  const levels = BELTS[progress.belt].levels;
  return Object.entries(DRILLS)
    .filter(([, meta]) => levels.includes(meta.level))
    .map(([type]) => type);
}

export function masteryOf(progress, type) {
  return progress.types[type]?.mastery ?? 0;
}

/** Mean mastery across everything unlocked — unseen drills count as zero. */
export function overallMastery(progress) {
  const pool = unlockedTypes(progress);
  if (!pool.length) return 0;
  return pool.reduce((sum, type) => sum + masteryOf(progress, type), 0) / pool.length;
}

/**
 * Difficulty for one concept: the belt's baseline, nudged by how you are
 * doing at this specific thing.
 */
export function difficultyFor(progress, type) {
  const base = BELTS[progress.belt].difficulty;
  const entry = progress.types[type];
  if (!entry || entry.seen < 3) return Math.max(0, base - (entry ? 0 : 1));
  if (entry.mastery >= MASTERY_FOR_HARDER) return Math.min(2, base + 1);
  if (entry.mastery <= MASTERY_FOR_EASIER) return Math.max(0, base - 1);
  return base;
}

/**
 * Pick what you need rather than what you fancy: weakest concept most often,
 * with a nudge toward anything gone stale and a little noise so it never
 * becomes predictable.
 */
export function chooseNext(progress, pool = unlockedTypes(progress), rng = Math.random) {
  const candidates = pool.filter((type) => DRILLS[type]);
  if (!candidates.length) return Object.keys(DRILLS)[0];

  const weights = candidates.map((type) => {
    const entry = progress.types[type];
    const mastery = entry?.mastery ?? 0;
    const seen = entry?.seen ?? 0;

    let w = (1 - mastery) ** 1.5 * 3 + 0.25;       // weak things, mostly
    if (seen === 0) w += 1.5;                       // never met it? meet it
    const stale = progress.hands - (entry?.lastSeenAt ?? -99);
    if (stale > 10 && mastery < 0.9) w += 1;        // drag old ground back in
    if (type === progress.lastType && candidates.length > 1) w *= 0.08;
    return w;
  });

  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  for (let i = 0; i < candidates.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

/**
 * Fold one answer into the record.
 * @param {number} score 1 for correct, 0.5 for close, 0 otherwise
 * @param {number} ms    how long they took
 */
export function recordAnswer(progress, { type, score, ms = 0 }) {
  const entry = slot(progress, type);
  entry.seen += 1;
  entry.mastery = entry.mastery + ALPHA * (score - entry.mastery);
  entry.lastSeenAt = progress.hands;
  // Untimed hands (a walkthrough) must not drag the average down to nothing.
  if (ms > 0) {
    entry.totalMs += ms;
    entry.timed += 1;
    if (score === 1 && (entry.bestMs === null || ms < entry.bestMs)) entry.bestMs = ms;
  }

  progress.hands += 1;
  progress.handsAtBelt += 1;
  progress.lastType = type;

  const target = (TARGET_SECONDS[type] || 20) * 1000;
  return {
    quick: score === 1 && ms > 0 && ms <= target * 0.6,
    slow: score === 1 && ms > target * 1.8,
    mastery: entry.mastery,
  };
}

/**
 * Being walked through a question is not the same as answering one. It counts
 * as a small amount of mastery — you did engage with the method — and it keeps
 * the concept hot in the selector, so the twin question that follows and the
 * ones after it keep coming until you can do it unaided.
 */
export function recordTaught(progress, type) {
  const entry = slot(progress, type);
  entry.taught += 1;
  entry.mastery = entry.mastery + ALPHA * (TAUGHT_CREDIT - entry.mastery);
  entry.lastSeenAt = progress.hands;
  // Deliberately does NOT set lastType: the whole point is that the very next
  // question is this same skill again, and after that it should keep coming.
  return entry.mastery;
}

/**
 * Promote or demote. Returns null when nothing changed, otherwise the move —
 * the UI turns that into Vic announcing it.
 */
export function checkBelt(progress) {
  const current = BELTS[progress.belt];
  const mastery = overallMastery(progress);

  if (current.promote && progress.handsAtBelt >= current.promote.hands && mastery >= current.promote.mastery) {
    progress.belt += 1;
    progress.handsAtBelt = 0;
    return { direction: 'up', belt: BELTS[progress.belt], from: current };
  }

  // Demotion only after a real run of bad answers, and never below Limper —
  // being sent back to the start is a reason to close the tab.
  if (progress.belt > 1 && progress.handsAtBelt >= 10 && mastery < 0.35) {
    progress.belt -= 1;
    progress.handsAtBelt = 0;
    return { direction: 'down', belt: BELTS[progress.belt], from: current };
  }

  return null;
}

/** Progress toward the next belt, 0..1, for the bar in the header. */
export function beltProgress(progress) {
  const current = BELTS[progress.belt];
  if (!current.promote) return 1;
  const byHands = Math.min(1, progress.handsAtBelt / current.promote.hands);
  const byMastery = Math.min(1, overallMastery(progress) / current.promote.mastery);
  return Math.min(byHands, byMastery);
}

/** Weakest and strongest concepts you have actually attempted a few times. */
export function report(progress) {
  const rows = unlockedTypes(progress)
    .map((type) => {
      const entry = progress.types[type];
      return {
        type,
        label: DRILLS[type].label,
        seen: entry?.seen ?? 0,
        taught: entry?.taught ?? 0,
        mastery: entry?.mastery ?? 0,
        avgSeconds: entry?.timed ? entry.totalMs / entry.timed / 1000 : null,
        bestSeconds: entry?.bestMs === null || entry?.bestMs === undefined ? null : entry.bestMs / 1000,
        difficulty: difficultyFor(progress, type),
      };
    })
    .sort((a, b) => a.mastery - b.mastery);

  const attempted = rows.filter((r) => r.seen >= 2);
  return {
    rows,
    weakest: attempted[0] || null,
    strongest: attempted[attempted.length - 1] || null,
    overall: overallMastery(progress),
    belt: BELTS[progress.belt],
    nextBelt: BELTS[progress.belt + 1] || null,
  };
}
