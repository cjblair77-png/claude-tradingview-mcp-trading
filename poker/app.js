// UI wiring. All the poker lives in lib/ — this file only moves text around,
// keeps score, and makes sure Vic gets the last word.

import { cardsToPretty, cardsToString, deckWithout, drawRandom, parseCards, rankOf, suitCharOf, SUIT_SYMBOL, VALUE_RANK } from './lib/cards.js';
import { describe } from './lib/evaluator.js';
import { countOuts, equityVsKnown, equityVsRandom, ruleOfTwoAndFour } from './lib/equity.js';
import { CURRICULUM, DRILLS, makeFromTrack } from './lib/drills.js';
import { grade, HEAT, lesson, say, VERDICT_SCORE } from './lib/snark.js';
import { pct } from './lib/potmath.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'shark-school/v1';

/* ------------------------------ state ------------------------------ */

const blankStats = () => ({
  streak: 0,
  bestStreak: 0,
  answered: 0,
  points: 0,
  byType: {},
});

let state = {
  heat: HEAT.CHEEKY,
  track: 'starter',
  stats: blankStats(),
};
let current = null;
let answered = false;

// localStorage is a nice-to-have: private windows and blocked site data both
// throw, and the app has to work anyway.
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    state = { ...state, ...saved, stats: { ...blankStats(), ...(saved.stats || {}) } };
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

/**
 * Accepts "25", "25%", ".25" and "0.25" for a percentage question — people
 * type what they think in, and arguing about format teaches nobody anything.
 */
function readNumber(raw, drill) {
  const cleaned = String(raw).replace(/[%,\s]/g, '');
  if (cleaned === '') return NaN;
  let value = Number(cleaned);
  if (!Number.isFinite(value)) return NaN;
  if (drill.unit === '%' && value > 0 && value <= 1 && drill.answer > 1.5) value *= 100;
  return value;
}

/* ------------------------------ drills ------------------------------ */

function nextDrill() {
  current = makeFromTrack(state.track);
  answered = false;

  $('drill-title').textContent = current.title;
  $('drill-badge').textContent = `Level ${current.level}`;
  $('drill-scenario').textContent = current.scenario;
  $('drill-question').textContent = current.question;
  $('answer-error').textContent = '';
  $('verdict').classList.add('hidden');

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
      b.addEventListener('click', () => resolve(choice, choice === current.answer ? 'perfect' : 'wrong', b));
      box.appendChild(b);
    });
  }
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
  resolve(value, grade(value, current.answer, current.tolerance));
}

function resolve(given, verdict, clickedButton) {
  if (answered) return;
  answered = true;

  const points = VERDICT_SCORE[verdict] ?? 0;
  const perfect = verdict === 'perfect';

  // Streak bookkeeping happens before we choose a line, so Vic can react to it.
  const brokenAt = state.stats.streak;
  if (perfect) {
    state.stats.streak += 1;
    state.stats.bestStreak = Math.max(state.stats.bestStreak, state.stats.streak);
  } else {
    state.stats.streak = 0;
  }
  state.stats.answered += 1;
  state.stats.points += points;

  const bucket = state.stats.byType[current.type] || { attempts: 0, points: 0 };
  bucket.attempts += 1;
  bucket.points += points;
  state.stats.byType[current.type] = bucket;
  save();

  const opts = { heat: state.heat, vars: { answer: current.display, n: perfect ? state.stats.streak : brokenAt } };
  let line;
  if (perfect && state.stats.streak >= 3) line = say('streak', opts);
  else if (!perfect && brokenAt >= 3) line = `${say('broken', opts)} ${say(verdict, opts)}`;
  else line = say(verdict, opts);

  vicSays(line, current.topic);

  const v = $('verdict');
  v.className = `verdict ${verdict}`;
  $('verdict-headline').textContent = {
    perfect: 'Correct.',
    close: `Close — the answer was ${current.display}.`,
    wrong: `Wrong — the answer was ${current.display}.`,
    awful: `Wrong — the answer was ${current.display}.`,
  }[verdict];
  $('verdict-working').textContent = current.working;
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

  renderScoreboard();
  renderStats();
  $('next-btn').focus();
}

function giveUp() {
  if (answered) return;
  resolve(NaN, 'awful');
}

/* ------------------------------ scoreboard ------------------------------ */

function renderScoreboard() {
  const s = state.stats;
  const accuracy = s.answered ? Math.round((s.points / s.answered) * 100) : 0;
  $('scoreboard').innerHTML = [
    `Streak <b>${s.streak}</b>`,
    `Best <b>${s.bestStreak}</b>`,
    `Hands <b>${s.answered}</b>`,
    `Grade <b>${s.answered ? `${accuracy}%` : '—'}</b>`,
  ].map((t) => `<span class="chip">${t}</span>`).join('');
}

const RANKS_OF_SHAME = [
  [0, 'Live one. Please keep playing, somewhere I can find you.'],
  [40, 'Break-even at best, and that is before the rake eats you.'],
  [60, 'Competent. The word is "competent". Don\'t gild it.'],
  [78, 'Genuinely solid. I am looking for the catch.'],
  [92, 'Fine. You can have the table. I\'ll take the drinks trolley.'],
];

function renderStats() {
  const s = state.stats;
  const table = $('stats-table');
  const rows = Object.entries(DRILLS).map(([type, meta]) => {
    const b = s.byType[type];
    const acc = b && b.attempts ? (b.points / b.attempts) * 100 : null;
    return { label: meta.label, attempts: b?.attempts || 0, acc };
  }).sort((a, b) => (b.attempts - a.attempts) || a.label.localeCompare(b.label));

  table.innerHTML = `<tr><th>Drill</th><th class="num">Hands</th><th class="num">Grade</th><th style="width:34%">&nbsp;</th></tr>` +
    rows.map((r) => `<tr>
      <td>${r.label}</td>
      <td class="num">${r.attempts || '—'}</td>
      <td class="num">${r.acc === null ? '—' : `${Math.round(r.acc)}%`}</td>
      <td>${r.acc === null ? '' : `<div class="bar"><span style="width:${Math.round(r.acc)}%"></span></div>`}</td>
    </tr>`).join('');

  if (!s.answered) {
    $('stats-verdict').textContent = 'No hands played yet. A blank report card is the only kind you have ever enjoyed.';
    return;
  }
  const grade100 = (s.points / s.answered) * 100;
  const verdict = [...RANKS_OF_SHAME].reverse().find(([floor]) => grade100 >= floor)[1];
  const worst = rows.filter((r) => r.attempts >= 3 && r.acc !== null).sort((a, b) => a.acc - b.acc)[0];
  $('stats-verdict').textContent = `${s.answered} hands, ${Math.round(grade100)}% overall. ${verdict}` +
    (worst && worst.acc < 70 ? ` Biggest leak: ${worst.label}. Go and drill it.` : '');
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
      rows.map((r) => `<tr>
        <td>${r.who}</td>
        <td class="num">${pct(r.equity)}</td>
        <td class="num">${r.win === null ? '—' : pct(r.win)}</td>
        <td class="num">${r.tie === null ? '—' : pct(r.tie)}</td>
        <td>${r.made}</td>
      </tr>`).join('');

    const outsBox = $('lab-outs');
    if (villain.length && (board.length === 3 || board.length === 4)) {
      const o = countOuts(hero, villain, board);
      const street = board.length === 3 ? 'flop' : 'turn';
      const rule = ruleOfTwoAndFour(o.count, street);
      outsBox.textContent = o.behind
        ? `You are behind with ${o.count} out${o.count === 1 ? '' : 's'} (${cardsToPretty(o.outs)}). Rule of ${street === 'flop' ? '4' : '2'} says ≈${pct(rule.approx)}; the real number ${street === 'flop' ? 'by the river' : 'on the river'} is ${pct(rule.exact)}.`
        : `You are ahead. ${o.count} of the ${o.live} remaining cards keep you ahead on the next street — the other ${o.live - o.count} are villain's outs.`;
      outsBox.classList.remove('hidden');
    } else {
      outsBox.textContent = '';
    }

    $('lab-result').classList.remove('hidden');
    vicSays(`${pct(rows[0].equity)}. The numbers don't care what you were hoping for.`, 'equity');
  } catch (e) {
    err.textContent = e.message;
    $('lab-result').classList.add('hidden');
  }
}

function dealLab() {
  const draw = drawRandom(deckWithout([]), 9);
  $('lab-hero').value = cardsToString(draw.slice(0, 2)).replace(/[♠♥♦♣]/g, '');
  // Re-render from ids rather than symbols so the inputs stay parseable.
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
  $('heat').value = String(state.heat);

  TABS.forEach((t) => $(`tab-${t}`).addEventListener('click', () => showTab(t)));

  $('answer-form').addEventListener('submit', submitNumber);
  $('giveup-btn').addEventListener('click', giveUp);
  $('next-btn').addEventListener('click', nextDrill);
  $('skip').addEventListener('click', nextDrill);

  $('track').addEventListener('change', (e) => {
    state.track = e.target.value;
    save();
    nextDrill();
  });
  $('heat').addEventListener('change', (e) => {
    state.heat = Number(e.target.value);
    save();
    vicSays(say('greeting', { heat: state.heat }));
  });

  $('lab-run').addEventListener('click', runLab);
  $('lab-deal').addEventListener('click', dealLab);
  ['lab-hero', 'lab-villain', 'lab-board'].forEach((id) => {
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') runLab(); });
  });

  $('reset-stats').addEventListener('click', () => {
    state.stats = blankStats();
    save();
    renderScoreboard();
    renderStats();
    vicSays('Wiped. We both know what it said.');
  });

  renderScoreboard();
  renderStats();
  vicSays(say('greeting', { heat: state.heat }));
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
