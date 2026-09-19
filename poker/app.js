// UI wiring. All the poker lives in lib/ — this file moves text around, runs
// the clock, and makes sure Vic gets the last word.

import { cardsToPretty, cardsToString, deckWithout, drawRandom, parseCards, rankOf, suitCharOf, SUIT_SYMBOL, VALUE_RANK } from './lib/cards.js';
import { describe } from './lib/evaluator.js';
import { countOuts, equityVsKnown, equityVsRandom, ruleOfTwoAndFour } from './lib/equity.js';
import { CURRICULUM, DRILLS, makeDrill, trackDrills } from './lib/drills.js';
import { beltProgress, checkBelt, chooseNext, createProgress, difficultyFor, recordAnswer, report, unlockedTypes } from './lib/coach.js';
import { grade, lesson, MOOD, say, VERDICT_SCORE } from './lib/snark.js';
import { pct } from './lib/potmath.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'shark-school/v2';

/* ------------------------------ state ------------------------------ */

const freshState = () => ({
  mood: MOOD.CHEEKY,
  track: 'auto',
  toddler: true,
  streak: 0,
  bestStreak: 0,
  answered: 0,
  points: 0,
  progress: createProgress(),
});

let state = freshState();
let current = null;
let answered = false;
let startedAt = 0;
let tickHandle = null;

// localStorage is a nice-to-have: private windows and blocked site data both
// throw, and the app has to work anyway.
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    state = { ...freshState(), ...saved, progress: { ...createProgress(), ...(saved.progress || {}) } };
  } catch { /* first visit, or storage is off. Carry on. */ }
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch { /* nothing we can do, and nothing that matters. */ }
}

/* ------------------------------ helpers ------------------------------ */

function cardEl(card) {
  const el = document.createElement('div');
  const suit = suitCharOf(card);
  el.className = `card${suit === 'h' || suit === 'd' ? ' red' : ''}`;
  el.innerHTML = `<span class="r">${VALUE_RANK[rankOf(card)]}</span><span class="s">${SUIT_SYMBOL[suit]}</span>`;
  return el;
}

function renderSeats(container, seats) {
  container.innerHTML = '';
  let any = false;
  for (const [label, cards] of seats) {
    if (!cards || !cards.length) continue;
    any = true;
    const seat = document.createElement('div');
    seat.className = 'seat';
    const title = document.createElement('div');
    title.className = 'seat-label';
    title.textContent = label;
    const hand = document.createElement('div');
    hand.className = 'hand';
    cards.forEach((c) => hand.appendChild(cardEl(c)));
    seat.append(title, hand);
    container.appendChild(seat);
  }
  container.classList.toggle('hidden', !any);
}

function vicSays(text, topic) {
  $('vic-line').textContent = text;
  const note = topic ? lesson(topic) : '';
  $('vic-lesson').textContent = note;
  $('vic-lesson').classList.toggle('hidden', !note);
}

const line = (kind, vars) => say(kind, { mood: state.mood, vars: vars || {} });

/**
 * Accepts "25", "25%", ".25" and "0.25" for a percentage question — people
 * type what they think in, and arguing about format teaches nobody anything.
 */
function readNumber(raw, drill) {
  const cleaned = String(raw).replace(/[%,\s]/g, '');
  if (cleaned === '') return NaN;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return NaN;
  if (drill.unit === '%' && value > 0 && value <= 1 && drill.answer > 1.5) return value * 100;
  return value;
}

/* ------------------------------ the clock ------------------------------ */

function startClock() {
  startedAt = performance.now();
  clearInterval(tickHandle);
  tickHandle = setInterval(() => {
    $('timer').textContent = `${((performance.now() - startedAt) / 1000).toFixed(1)}s`;
  }, 100);
}

function stopClock() {
  clearInterval(tickHandle);
  const ms = performance.now() - startedAt;
  $('timer').textContent = `${(ms / 1000).toFixed(1)}s`;
  return ms;
}

/* ------------------------------ drills ------------------------------ */

/**
 * Even on a hand-picked track the coach chooses WITHIN it, so your weakest
 * skill in that track still comes up most. "Auto" just widens the pool to
 * everything your belt has unlocked.
 */
function pickType() {
  const pool = state.track === 'auto' ? unlockedTypes(state.progress) : trackDrills(state.track);
  return chooseNext(state.progress, pool);
}

function nextDrill() {
  const type = pickType();
  current = makeDrill(type, Math.random, difficultyFor(state.progress, type));
  answered = false;

  $('drill-title').textContent = current.title;
  $('drill-badge').textContent = `${current.label} · level ${current.difficulty + 1}`;
  $('drill-scenario').textContent = current.scenario;
  $('drill-question').textContent = current.question;
  $('answer-error').textContent = '';
  $('verdict').classList.add('hidden');
  $('hintbox').classList.add('hidden');
  $('steps').classList.add('hidden');
  $('steps').innerHTML = '';
  $('steps-btn').classList.remove('hidden');
  $('hint-btn').disabled = false;
  $('giveup-btn').disabled = false;
  $('answer-aux').classList.remove('hidden');

  renderSeats($('drill-cards'), [
    ['Your hand', current.cards?.hero],
    ['Villain', current.cards?.villain],
    ['Board', current.cards?.board],
  ]);

  const numeric = current.mode === 'number';
  $('answer-form').classList.toggle('hidden', !numeric);
  $('answer-choices').classList.toggle('hidden', numeric);

  if (numeric) {
    $('answer-unit').textContent = current.unit;
    $('answer-input').value = '';
    $('submit-btn').disabled = false;
    $('answer-input').focus();
  } else {
    const box = $('answer-choices');
    box.innerHTML = '';
    current.choices.forEach((choice) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = choice;
      b.addEventListener('click', () => resolve(choice === current.answer ? 'perfect' : 'wrong', b));
      box.appendChild(b);
    });
  }

  startClock();
}

function showHint() {
  if (answered) return;
  $('hintbox').textContent = `${line('hint')} — ${current.hint}`;
  $('hintbox').classList.remove('hidden');
  $('hint-btn').disabled = true;
}

/** Reveal the staircase, one step at a time so it reads like being taught. */
function showSteps() {
  const list = $('steps');
  list.innerHTML = '';
  list.classList.remove('hidden');
  $('steps-btn').classList.add('hidden');

  current.steps.forEach((step, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="step-do"></span><span class="step-result"></span>`;
    li.querySelector('.step-do').textContent = step.do;
    li.querySelector('.step-result').textContent = step.result;
    li.style.animationDelay = `${i * 90}ms`;
    list.appendChild(li);
  });
}

function submitNumber(event) {
  event.preventDefault();
  if (answered) return;
  const value = readNumber($('answer-input').value, current);
  if (Number.isNaN(value)) {
    $('answer-error').textContent = 'That is not a number. Vic is waiting.';
    return;
  }
  $('answer-error').textContent = '';
  resolve(grade(value, current.answer, current.tolerance));
}

function resolve(verdict, clickedButton) {
  if (answered) return;
  answered = true;
  const ms = stopClock();

  const points = VERDICT_SCORE[verdict] ?? 0;
  const perfect = verdict === 'perfect';

  const brokenAt = state.streak;
  if (perfect) {
    state.streak += 1;
    state.bestStreak = Math.max(state.bestStreak, state.streak);
  } else {
    state.streak = 0;
  }
  state.answered += 1;
  state.points += points;

  const pace = recordAnswer(state.progress, { type: current.type, score: points, ms });
  const beltMove = checkBelt(state.progress);
  save();

  // Vic's line: belt news trumps everything, then streaks, then the verdict,
  // with a word about pace when the answer was right.
  const vars = { answer: current.display, n: perfect ? state.streak : brokenAt };
  let said;
  if (beltMove?.direction === 'up') {
    said = `${line(verdict, vars)} ${line('beltUp', { belt: beltMove.belt.name })}`;
  } else if (beltMove?.direction === 'down') {
    said = `${line(verdict, vars)} Back down to ${beltMove.belt.name} until you can hold it together.`;
  } else if (perfect && pace.quick) {
    said = `${line('fast')} ${state.streak >= 3 ? line('streak', vars) : ''}`.trim();
  } else if (perfect && pace.slow) {
    said = line('slow');
  } else if (perfect && state.streak >= 3) {
    said = line('streak', vars);
  } else if (!perfect && brokenAt >= 3) {
    said = `${line('broken', vars)} ${line(verdict, vars)}`;
  } else {
    said = line(verdict, vars);
  }
  vicSays(said, current.topic);

  const v = $('verdict');
  v.className = `verdict ${verdict}`;
  $('verdict-headline').textContent = perfect
    ? `Correct — ${current.display}. ${(ms / 1000).toFixed(1)}s.`
    : `${verdict === 'close' ? 'Close' : 'Wrong'} — the answer was ${current.display}.`;
  $('verdict-note').textContent = current.note;

  if (current.mode === 'choice') {
    [...$('answer-choices').children].forEach((b) => {
      b.disabled = true;
      if (b.textContent === current.answer) b.classList.add('right');
      else if (b === clickedButton) b.classList.add('wrong-pick');
    });
  } else {
    $('submit-btn').disabled = true;
  }
  $('answer-aux').classList.add('hidden');

  // Toddler mode: never make someone ask for the explanation after a miss.
  if (state.toddler || !perfect) {
    if (!perfect) vicSays(`${said} ${line('toddler')}`, current.topic);
    showSteps();
  }

  renderScoreboard();
  renderStats();
  $('next-btn').focus();
}

function giveUp() {
  if (answered) return;
  resolve('awful');
}

/* ------------------------------ scoreboard ------------------------------ */

function renderScoreboard() {
  const r = report(state.progress);
  const accuracy = state.answered ? Math.round((state.points / state.answered) * 100) : 0;

  $('scoreboard').innerHTML = [
    `Streak <b>${state.streak}</b>`,
    `Best <b>${state.bestStreak}</b>`,
    `Hands <b>${state.answered}</b>`,
    `Grade <b>${state.answered ? `${accuracy}%` : '—'}</b>`,
  ].map((t) => `<span class="chip">${t}</span>`).join('');

  $('belt-name').textContent = r.belt.name;
  $('belt-next').textContent = r.nextBelt ? `→ ${r.nextBelt.name}` : 'top of the shop';
  $('belt-bar').style.width = `${Math.round(beltProgress(state.progress) * 100)}%`;
}

const RANKS_OF_SHAME = [
  [0, 'Live one. Please keep playing, somewhere I can find you.'],
  [40, 'Break-even at best, and that is before the rake eats you.'],
  [60, 'Competent. The word is "competent". Do not gild it.'],
  [78, 'Genuinely solid. I am looking for the catch.'],
  [92, 'Fine. Take the table. I will take the drinks trolley.'],
];

function renderStats() {
  const r = report(state.progress);

  $('stats-table').innerHTML = `<tr><th>Skill</th><th class="num">Hands</th><th class="num">Mastery</th><th style="width:22%">&nbsp;</th><th class="num">Avg</th><th class="num">Level</th></tr>` +
    r.rows.map((row) => `<tr>
      <td>${row.label}</td>
      <td class="num">${row.seen || '—'}</td>
      <td class="num">${row.seen ? `${Math.round(row.mastery * 100)}%` : '—'}</td>
      <td>${row.seen ? `<div class="bar"><span style="width:${Math.round(row.mastery * 100)}%"></span></div>` : ''}</td>
      <td class="num">${row.avgSeconds ? `${row.avgSeconds.toFixed(1)}s` : '—'}</td>
      <td class="num">${row.seen ? row.difficulty + 1 : '—'}</td>
    </tr>`).join('');

  if (!state.answered) {
    $('stats-verdict').textContent = 'No hands played yet. A blank report card is the only kind you have ever enjoyed.';
    return;
  }

  const grade100 = (state.points / state.answered) * 100;
  const verdict = [...RANKS_OF_SHAME].reverse().find(([floor]) => grade100 >= floor)[1];
  const parts = [`${r.belt.name} — ${r.belt.blurb}`, `${state.answered} hands, ${Math.round(grade100)}% overall.`, verdict];
  if (r.weakest && r.weakest.mastery < 0.7) {
    parts.push(`Biggest leak: ${r.weakest.label} at ${Math.round(r.weakest.mastery * 100)}%. Vic is feeding you extra of those on purpose.`);
  }
  if (r.strongest && r.strongest.mastery >= 0.85) {
    parts.push(`${r.strongest.label} is solid, so it has been bumped to level ${r.strongest.difficulty + 1}.`);
  }
  $('stats-verdict').textContent = parts.join(' ');
}

/* ------------------------------ equity lab ------------------------------ */

function runLab() {
  const err = $('lab-error');
  err.textContent = '';
  try {
    const hero = parseCards($('lab-hero').value);
    const villain = parseCards($('lab-villain').value);
    const board = parseCards($('lab-board').value);
    const opponents = Math.max(1, Math.min(9, Number($('lab-opponents').value) || 1));

    if (hero.length !== 2) throw new Error('Your hand needs exactly two cards.');
    if (villain.length && villain.length !== 2) throw new Error('Villain needs exactly two cards, or none at all.');
    if (board.length > 5) throw new Error('A board holds five cards, tops.');
    if (new Set([...hero, ...villain, ...board]).size !== hero.length + villain.length + board.length) {
      throw new Error('Same card twice. Which one of you is cheating?');
    }

    renderSeats($('lab-cards'), [['Your hand', hero], ['Villain', villain], ['Board', board]]);

    let rows;
    let summary;
    if (villain.length) {
      const r = equityVsKnown([hero, villain], board, { trials: 20000 });
      summary = r.exact ? `Exact — every one of ${r.trials} runouts counted.` : `Sampled over ${r.trials} runouts (±0.7% or so).`;
      rows = [
        { who: `You (${cardsToPretty(hero)})`, equity: r.equity[0], win: r.wins[0], tie: r.ties[0], made: board.length >= 3 ? describe(hero.concat(board)) : '—' },
        { who: `Villain (${cardsToPretty(villain)})`, equity: r.equity[1], win: r.wins[1], tie: r.ties[1], made: board.length >= 3 ? describe(villain.concat(board)) : '—' },
      ];
    } else {
      const r = equityVsRandom(hero, board, opponents, { trials: 12000 });
      summary = `Sampled over ${r.trials} hands against ${opponents} random holding${opponents > 1 ? 's' : ''}.`;
      rows = [
        { who: `You (${cardsToPretty(hero)})`, equity: r.equity, win: null, tie: null, made: board.length >= 3 ? describe(hero.concat(board)) : '—' },
        { who: `${opponents} random opponent${opponents > 1 ? 's' : ''}, combined`, equity: 1 - r.equity, win: null, tie: null, made: '—' },
      ];
    }

    $('lab-summary').textContent = summary;
    $('lab-table').innerHTML = `<tr><th>Seat</th><th class="num">Equity</th><th class="num">Win</th><th class="num">Tie</th><th>Holding</th></tr>` +
      rows.map((row) => `<tr>
        <td>${row.who}</td>
        <td class="num">${pct(row.equity)}</td>
        <td class="num">${row.win === null ? '—' : pct(row.win)}</td>
        <td class="num">${row.tie === null ? '—' : pct(row.tie)}</td>
        <td>${row.made}</td>
      </tr>`).join('');

    const outsBox = $('lab-outs');
    if (villain.length && (board.length === 3 || board.length === 4)) {
      const o = countOuts(hero, villain, board);
      const street = board.length === 3 ? 'flop' : 'turn';
      const rule = ruleOfTwoAndFour(o.count, street);
      outsBox.textContent = o.behind
        ? `You are behind with ${o.count} out${o.count === 1 ? '' : 's'} (${cardsToPretty(o.outs)}). Rule of ${street === 'flop' ? '4' : '2'} says ≈${pct(rule.approx)}; the real number ${street === 'flop' ? 'by the river' : 'on the river'} is ${pct(rule.exact)}.`
        : `You are ahead. ${o.count} of the ${o.live} remaining cards keep you ahead next street — the other ${o.live - o.count} are villain's outs.`;
    } else {
      outsBox.textContent = '';
    }

    $('lab-result').classList.remove('hidden');
    vicSays(`${pct(rows[0].equity)}. The numbers do not care what you were hoping for.`, 'equity');
  } catch (e) {
    err.textContent = e.message;
    $('lab-result').classList.add('hidden');
  }
}

function dealLab() {
  const draw = drawRandom(deckWithout([]), 9);
  const asText = (cards) => cardsToString(cards).replace(/ /g, '');
  $('lab-hero').value = asText(draw.slice(0, 2));
  $('lab-villain').value = asText(draw.slice(2, 4));
  $('lab-board').value = asText(draw.slice(4, 7));
  runLab();
}

/* ------------------------------ tabs & boot ------------------------------ */

const TABS = ['drill', 'lab', 'stats', 'sheet'];

function showTab(name) {
  TABS.forEach((t) => {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
    $(`view-${t}`).classList.toggle('hidden', t !== name);
  });
}

function boot() {
  load();

  $('track').innerHTML = CURRICULUM.map((t) => `<option value="${t.id}">${t.label}</option>`).join('');
  $('track').value = state.track;
  $('mood').value = String(state.mood);
  $('toddler').checked = state.toddler;

  TABS.forEach((t) => $(`tab-${t}`).addEventListener('click', () => showTab(t)));

  $('answer-form').addEventListener('submit', submitNumber);
  $('giveup-btn').addEventListener('click', giveUp);
  $('hint-btn').addEventListener('click', showHint);
  $('steps-btn').addEventListener('click', showSteps);
  $('next-btn').addEventListener('click', nextDrill);
  $('skip').addEventListener('click', nextDrill);

  $('track').addEventListener('change', (e) => { state.track = e.target.value; save(); nextDrill(); });
  $('toddler').addEventListener('change', (e) => { state.toddler = e.target.checked; save(); });
  $('mood').addEventListener('change', (e) => {
    state.mood = Number(e.target.value);
    save();
    vicSays(line('greeting'));
  });

  $('lab-run').addEventListener('click', runLab);
  $('lab-deal').addEventListener('click', dealLab);
  ['lab-hero', 'lab-villain', 'lab-board'].forEach((id) => {
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') runLab(); });
  });

  $('reset-stats').addEventListener('click', () => {
    const { mood, track, toddler } = state;
    state = { ...freshState(), mood, track, toddler };
    save();
    renderScoreboard();
    renderStats();
    vicSays('Wiped. We both know what it said.');
    nextDrill();
  });

  renderScoreboard();
  renderStats();
  vicSays(line('greeting'));
  nextDrill();

  // A deliberate handle on the running app: handy in the console, and it lets
  // a browser test answer a question correctly without reimplementing poker.
  window.sharkSchool = {
    get drill() { return current; },
    get state() { return state; },
    next: nextDrill,
  };
}

boot();
