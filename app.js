'use strict';

/* =========================================================================
 * Too Many Bones — Lockpicking assistant
 *
 * A faithful browser implementation of the Lockpicking mini-game:
 *   - A Trove Loot has three locks (Lever, Trip, Force), picked left to right.
 *   - Roll the 3 Lockpicking dice (Grey / Brown / Yellow) + the Intuition die.
 *   - Pick a lock by adding the faces showing that lock's type until the total is
 *     equal to or higher than the lock's number. Used dice are exhausted.
 *   - The Intuition die is never exhausted; it shows Reroll / Convert / Save +1.
 *
 * An optional auto-play / "Best move" assistant picks optimal actions with a
 * small expectimax search (see the solver section below).
 * ========================================================================= */

const TYPES = {
  L: { name: 'Lever', c1: '#d78a4a', c2: '#8a4a1e', ink: '#2a1404' },
  T: { name: 'Trip',  c1: '#e8c74e', c2: '#9c7405', ink: '#332600' },
  F: { name: 'Force', c1: '#dbe1e7', c2: '#7d848c', ink: '#22262a' },
};
const LOCK_ORDER = ['L', 'T', 'F'];
/* The Intuition die has two faces of each kind (2× Reroll, 2× Convert, 2× Save +1),
 * so the three effects are equally likely. */
const INTUITION_FACES = ['Reroll', 'Convert', 'Save +1'];

/* The three Lockpicking dice. Every face is a value plus the lock type it can
 * pick (Lever / Trip / Force), e.g. "3F" = three towards a Force lock. Colours
 * match the physical dice. */
const DICE_DEF = [
  { key: 'grey',   name: 'Grey',   primary: 'F', color: { c1: '#dbe1e7', c2: '#7d848c', ink: '#22262a' }, faces: '1F,2F,3F,1T,3T,2L' },
  { key: 'brown',  name: 'Brown',  primary: 'L', color: { c1: '#c69a6a', c2: '#6f4a28', ink: '#20130a' }, faces: '1L,2L,3L,1F,3F,1T' },
  { key: 'yellow', name: 'Yellow', primary: 'T', color: { c1: '#e8c74e', c2: '#9c7405', ink: '#332600' }, faces: '1T,2T,3T,1L,3L,2F' },
];
const STORE_KEY = 'tmb.lockpicking.v2';

const clone = (o) => JSON.parse(JSON.stringify(o));
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const fmtDie = (d) => `${d.value + d.bonus}${d.type}`;
/* e.g. "Grey 2F · Brown 3F · Yellow 2T" */
const fmtRoll = (dice) => dice.map((d) => `${d.name} ${fmtDie(d)}`).join(' · ');

/* "1f,2f,3f,1T,3t,2L" -> [{ value: 1, type: 'F' }, ...] */
function parseFaces(str) {
  const out = [];
  const re = /([0-9]+)\s*([LTF])/gi;
  let m;
  const text = String(str == null ? '' : str);
  while ((m = re.exec(text)) !== null) {
    out.push({ value: clamp(parseInt(m[1], 10) || 1, 1, 9), type: m[2].toUpperCase() });
  }
  return out;
}

function formatFaces(faces) {
  return (faces || []).map((f) => `${f.value}${f.type}`).join(',');
}

const DEFAULT_FACES = DICE_DEF.reduce((acc, d) => { acc[d.key] = parseFaces(d.faces); return acc; }, {});

let state = {
  loot: null,
  attempt: null,
  settings: { faces: clone(DEFAULT_FACES), autoMode: 'off' },
  ui: { mode: null, convertPick: null, selected: {} },
  log: [],
};

let setupOpen = false;

/* ------------------------------- model ---------------------------------- */

function currentLockIndex() {
  if (!state.loot) return -1;
  return state.loot.locks.findIndex((l) => !l.solved);
}

function facesFor(die) {
  const f = state.settings.faces[die.key];
  return Array.isArray(f) && f.length ? f : DEFAULT_FACES[die.key];
}

function rollFace(die) {
  return pickOne(facesFor(die)); // { value, type }
}

function rollIntuition() {
  return pickOne(INTUITION_FACES);
}

function addLog(msg, kind) {
  state.log.push({ text: msg, kind: kind || null });
  if (state.log.length > 60) state.log.shift();
}

function resetUi() {
  state.ui = { mode: null, convertPick: null, selected: {} };
}

function selectedDice() {
  const a = state.attempt;
  if (!a) return [];
  return a.dice.filter((d) => state.ui.selected[d.id] && !d.exhausted && d.type === usableType());
}

function usableType() {
  const idx = currentLockIndex();
  return idx === -1 ? null : state.loot.locks[idx].type;
}

function selectedTotal() {
  return selectedDice().reduce((s, d) => s + d.value + d.bonus, 0);
}

/* ----------------------------- persistence ------------------------------ */

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ loot: state.loot, settings: state.settings }));
  } catch (e) { /* storage unavailable — ignore */ }
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.loot && Array.isArray(data.loot.locks)) state.loot = data.loot;
    if (data.settings) {
      if (data.settings.faces) {
        DICE_DEF.forEach((def) => {
          const f = data.settings.faces[def.key];
          if (Array.isArray(f) && f.length && f.every((x) => x && TYPES[x.type] && typeof x.value === 'number')) {
            state.settings.faces[def.key] = f.map((x) => ({ value: x.value, type: x.type }));
          }
        });
      }
      if (data.settings.autoMode === 'semi' || data.settings.autoMode === 'full' || data.settings.autoMode === 'off') {
        state.settings.autoMode = data.settings.autoMode;
      } else if (typeof data.settings.autoPlay === 'boolean') {
        state.settings.autoMode = data.settings.autoPlay ? 'full' : 'off';
      }
    }
  } catch (e) { /* corrupt storage — ignore */ }
}

/* ------------------------------- actions -------------------------------- */

function newLoot() {
  stopAuto();
  state.loot = {
    locks: LOCK_ORDER.map((type, i) => ({
      type,
      target: [randInt(1, 4), randInt(2, 5), randInt(3, 5)][i],
      solved: false,
    })),
  };
  state.attempt = null;
  resetUi();
  state.log = [];
  addLog('New Trove Loot discovered: three locks — Lever, Trip, Force.');
  save();
  render();
  if (state.settings.autoMode !== 'off') runAuto();
}

function exampleLoot() {
  stopAuto();
  state.loot = { locks: [
    { type: 'L', target: 3, solved: false },
    { type: 'T', target: 4, solved: false },
    { type: 'F', target: 5, solved: false },
  ] };
  state.attempt = null;
  resetUi();
  state.log = [];
  addLog('Loaded example Trove Loot: 3 Lever / 4 Trip / 5 Force.');
  save();
  render();
  if (state.settings.autoMode !== 'off') runAuto();
}

/* Read "3 4 5" (also "3,4,5" or "345") into clamped Lever/Trip/Force targets. */
function parseLootInput(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;
  let parts = raw.split(/[^0-9]+/).filter(Boolean);
  if (parts.length === 1 && parts[0].length === 3) parts = parts[0].split('');
  const nums = parts.map((n) => parseInt(n, 10)).filter((n) => n > 0);
  if (nums.length < 3) return null;
  return nums.slice(0, 3).map((n) => Math.max(1, Math.min(6, n)));
}

function setLootFromInput() {
  stopAuto();
  const input = document.getElementById('loot-quick');
  const targets = parseLootInput(input ? input.value : '');
  if (!targets) {
    addLog('Enter three lock numbers, for example “3 4 5”.');
    render();
    return;
  }
  state.loot = { locks: LOCK_ORDER.map((type, i) => ({ type, target: targets[i], solved: false })) };
  state.attempt = null;
  resetUi();
  state.log = [];
  addLog(`Trove Loot set — ${LOCK_ORDER.map((t, i) => `${TYPES[t].name} ${targets[i]}`).join(', ')}.`);
  save();
  render();
  if (state.settings.autoMode !== 'off') runAuto();
}

function rollAll() {
  const a = state.attempt;
  a.dice.forEach((d) => {
    if (d.exhausted) return;
    const f = rollFace(d);
    d.type = f.type;
    d.value = f.value;
    d.bonus = 0;
    d.saved = false;
  });
  resetUi();
}

function startAttempt(isNewRoll) {
  const idx = currentLockIndex();
  if (idx === -1) return;
  state.attempt = {
    dice: DICE_DEF.map((def, i) => ({
      id: i, key: def.key, name: def.name, color: def.color,
      type: def.primary, value: 0, bonus: 0, saved: false, exhausted: false,
    })),
    intuition: rollIntuition(),
    intuitionUsed: false,
    startingLock: idx,
    rollsUsed: 1,
    over: false,
  };
  rollAll();
  const head = isNewRoll ? `New roll — Lock ${idx + 1}` : `Attempt begins on Lock ${idx + 1}`;
  addLog(`${head} (${TYPES[state.loot.locks[idx].type].name}). Rolled ${fmtRoll(state.attempt.dice)} · Intuition: ${state.attempt.intuition}.`);
  maybeStop();
  render();
}

/* A fresh complete roll, keeping every already-open lock. */
function newRoll() {
  if (currentLockIndex() === -1) return;
  startAttempt(true);
}

function retry() {
  const a = state.attempt;
  if (!a || a.over) return false;
  if (currentLockIndex() !== a.startingLock || a.rollsUsed >= 2) return false;
  a.rollsUsed += 1;
  rollAll();
  a.intuition = rollIntuition();
  a.intuitionUsed = false;
  const first = state.loot.locks[a.startingLock];
  addLog(`Second attempt at the first lock (${TYPES[first.type].name} ${first.target}): ${fmtRoll(a.dice)} · Intuition: ${a.intuition}.`, 'reroll');
  return true;
}

function unlock() {
  const a = state.attempt;
  const idx = currentLockIndex();
  if (!a || a.over || idx === -1) return;
  const lock = state.loot.locks[idx];
  const dice = selectedDice();
  const total = selectedTotal();
  if (!dice.length || total < lock.target) return;

  dice.forEach((d) => { if (!d.saved) d.exhausted = true; });
  lock.solved = true;
  a.dice.forEach((d) => { d.saved = false; });
  addLog(`Unlocked ${TYPES[lock.type].name} ${lock.target}: ${dice.map((d) => `${d.name} ${fmtDie(d)}`).join(' + ')} = ${total}.`);

  const next = currentLockIndex();
  if (next === -1) {
    a.over = true;
    addLog('All three locks picked — the Trove Loot is open!');
    save();
    render();
    return;
  }

  // Moving on: every unused Action die is rerolled together with the Intuition.
  a.dice.forEach((d) => {
    if (d.exhausted) return;
    const f = rollFace(d);
    d.type = f.type;
    d.value = f.value;
    d.bonus = 0;
    d.saved = false;
  });
  a.intuition = rollIntuition();
  a.intuitionUsed = false;
  resetUi();

  if (a.dice.every((d) => d.exhausted)) {
    a.over = true;
    addLog('No Lockpicking dice remain — the attempt ends. Already-open locks are kept.');
  } else {
    const rolled = a.dice.filter((d) => !d.exhausted);
    addLog(`Moved on to Lock ${next + 1} (${TYPES[state.loot.locks[next].type].name}) — unused dice rerolled: ${fmtRoll(rolled)} · Intuition: ${a.intuition}.`, 'reroll');
  }
  maybeStop();
  save();
  render();
}

function endAttempt() {
  if (!state.attempt) return;
  state.attempt.over = true;
  addLog('Roll ended. Already-open locks are kept — press “New roll” to roll again.');
  render();
}

/* True while the lock you are facing can still be opened right now: a plain pick,
 * or an Intuition effect that would reach it (a reroll counts when one of its
 * faces could reach it). */
function canOpenLock() {
  const a = state.attempt;
  const idx = currentLockIndex();
  if (!a || idx === -1) return false;
  const lock = state.loot.locks[idx];
  const wins = (after) => winningSubsets(after, lock.type, lock.target).length > 0;
  if (wins(a.dice)) return true;
  if (a.intuitionUsed) return false;
  if (a.intuition === 'Reroll') {
    for (const d of a.dice) {
      if (d.exhausted) continue;
      for (const f of facesFor(d)) {
        const after = a.dice.map((x) => (x.id === d.id ? { ...x, type: f.type, value: f.value, bonus: 0 } : x));
        if (wins(after)) return true;
      }
    }
    return false;
  }
  if (a.intuition === 'Convert') {
    for (const d of a.dice) {
      if (d.exhausted) continue;
      for (const t of LOCK_ORDER) {
        if (t === d.type) continue;
        if (wins(a.dice.map((x) => (x.id === d.id ? { ...x, type: t } : x)))) return true;
      }
    }
  }
  if (a.intuition === 'Save +1') {
    for (const d of a.dice) {
      if (d.exhausted) continue;
      if (wins(a.dice.map((x) => (x.id === d.id ? { ...x, bonus: x.bonus + 1 } : x)))) return true;
    }
  }
  return false;
}

/* The Attempt is over when you fail to open a lock. The exception is the first
 * lock of the Attempt: there you immediately take one (and only one) second
 * attempt. */
function maybeStop() {
  const a = state.attempt;
  if (!a || a.over) return;
  const idx = currentLockIndex();
  if (idx === -1 || canOpenLock()) return;
  if (idx === a.startingLock && a.rollsUsed < 2 && retry()) { maybeStop(); return; }
  const lock = state.loot.locks[idx];
  a.over = true;
  save();
  addLog(`Attempt over — nothing left can open ${TYPES[lock.type].name} ${lock.target}. Already-open locks are kept.`);
}

function onDieClick(id) {
  const a = state.attempt;
  if (!a || a.over) return;
  const d = a.dice.find((x) => x.id === id);
  if (!d || d.exhausted) return;

  if (state.ui.mode === 'reroll') {
    const f = rollFace(d);
    d.type = f.type;
    d.value = f.value;
    d.bonus = 0;
    d.saved = false;
    a.intuition = rollIntuition();
    a.intuitionUsed = false;
    addLog(`Intuition · Reroll — rerolled the ${d.name} die (now ${fmtDie(d)}) and the Intuition die (now ${a.intuition}).`, 'reroll');
    state.ui.mode = null;
    maybeStop();
    render();
    return;
  }

  if (state.ui.mode === 'save') {
    d.bonus += 1;
    d.saved = true;
    a.intuitionUsed = true;
    addLog(`Intuition · Save +1 — the ${d.name} die is now ${d.value + d.bonus} and will not exhaust if used on this lock.`);
    state.ui.mode = null;
    maybeStop();
    render();
    return;
  }

  if (state.ui.mode === 'convert') {
    state.ui.convertPick = d.id;
    render();
    return;
  }

  if (d.type !== usableType()) return; // only dice of the lock's type can be chosen
  state.ui.selected[d.id] = !state.ui.selected[d.id];
  render();
}

function applyConvert(type) {
  const a = state.attempt;
  const d = a && a.dice.find((x) => x.id === state.ui.convertPick);
  if (!d || d.exhausted) return;
  d.type = type;
  a.intuitionUsed = true;
  state.ui.mode = null;
  state.ui.convertPick = null;
  addLog(`Intuition · Convert — ${d.name} ${d.value} becomes ${TYPES[type].name} ${d.value}.`);
  maybeStop();
  render();
}

function setMode(mode) {
  const a = state.attempt;
  if (!a || a.over || a.intuitionUsed) return;
  state.ui.mode = state.ui.mode === mode ? null : mode;
  state.ui.convertPick = null;
  render();
}

/* ---------------------------- solver (expectimax) ------------------------
 *
 * Picks the best move at a decision point by exact expectimax over the tiny
 * state space: every die face and every Intuition face is enumerated and
 * averaged, so the choice is the one that maximises the expected number of
 * locks solved for the rest of the attempt.
 *
 * Policy: if the current lock can be picked with the dice that are already
 * showing, do exactly that and keep the Intuition die. Spending it up front
 * only pays off when the lock genuinely needs it.
 */

const RAND_BUDGET = 1;           // rerolls looked ahead per lock (bounds cycles)
const SOLVER_NODE_CAP = 20000;   // safety valve so a single decision stays fast
const TIE_PRIORITY = { unlock: 0, retry: 1, end: 2, save: 3, convert: 4, reroll: 5 };

let memo = new Map();
let freshMemo = new Map();
let solverNodes = 0;

const cloneState = (s) => ({ ...s, dice: s.dice.map((d) => ({ ...d })) });

/* Probability of each faced (type, value) pair, honouring duplicate faces. */
function valueDistribution(die) {
  const faces = facesFor(die);
  const map = new Map();
  faces.forEach((f) => {
    const k = f.type + f.value;
    const e = map.get(k);
    if (e) e.count += 1;
    else map.set(k, { count: 1, type: f.type, value: f.value });
  });
  const total = faces.length || 1;
  return Array.from(map.values()).map((e) => ({ p: e.count / total, type: e.type, value: e.value }));
}

function intuitionOptions() {
  return INTUITION_FACES.map((f) => ({ p: 1 / INTUITION_FACES.length, face: f }));
}

function solveKey(s) {
  return [
    s.lock, s.intuition, s.intuitionUsed ? 1 : 0, s.rollsUsed, s.startingLock, s.rand,
    s.dice.map((d) => [d.key, d.type, d.value, d.bonus, d.saved ? 1 : 0, d.exhausted ? 1 : 0].join('.')).join(','),
  ].join('|');
}

/* Average solveValue over the cartesian product of independent outcomes. */
function cartesianExpect(vars, build) {
  const stack = [];
  let acc = 0;
  (function rec(i, p) {
    if (i === vars.length) { acc += p * solveValue(build(stack.slice())); return; }
    for (const opt of vars[i].opts) { stack.push(opt); rec(i + 1, p * opt.p); stack.pop(); }
  })(0, 1);
  return acc;
}

/* Every subset of the dice that shows the lock's type and reaches its number. */
function winningSubsets(dice, type, target) {
  const out = [];
  for (let mask = 1; mask < 8; mask++) {
    const ids = [0, 1, 2].filter((i) => (mask >> i) & 1);
    const chosen = ids.map((i) => dice[i]);
    if (chosen.some((d) => d.exhausted || d.type !== type)) continue;
    const total = chosen.reduce((t, d) => t + d.value + d.bonus, 0);
    if (total >= target) out.push({ ids, total });
  }
  return out;
}

function legalMoves(s, allowRetry) {
  if (s.lock > 2) return [];
  const lock = state.loot.locks[s.lock];
  const lt = lock.type;
  const moves = [];

  // Any subset of same-type dice that reaches the target can pick the lock.
  winningSubsets(s.dice, lt, lock.target).forEach((sub) => moves.push({ kind: 'unlock', ids: sub.ids }));

  if (!s.intuitionUsed) {
    const avail = s.dice.filter((d) => !d.exhausted);
    if (s.intuition === 'Reroll' && s.rand > 0) {
      avail.forEach((d) => moves.push({ kind: 'reroll', id: d.id }));
    } else if (s.intuition === 'Convert') {
      avail.forEach((d) => LOCK_ORDER.forEach((t) => {
        if (t !== d.type) moves.push({ kind: 'convert', id: d.id, type: t });
      }));
    } else if (s.intuition === 'Save +1') {
      avail.forEach((d) => moves.push({ kind: 'save', id: d.id }));
    }
  }

  if (allowRetry && s.lock === s.startingLock && s.rollsUsed < 2) moves.push({ kind: 'retry' });
  moves.push({ kind: 'end' });
  return moves;
}

/* Value of picking the current lock with `usedIds`. Because moving on rerolls
 * every unused die, the result depends only on WHICH dice survive — the current
 * faces of the unused dice no longer matter. */
function expectedAdvance(s, usedIds) {
  const used = new Set(usedIds);
  const exhausted = s.dice.map((d) => d.exhausted || (used.has(d.id) && !d.saved));
  let acc = 0;
  INTUITION_FACES.forEach((face) => {
    acc += (1 / INTUITION_FACES.length) * freshValue(exhausted, s.lock + 1, face, s.rollsUsed, s.startingLock);
  });
  return acc;
}

/* Expected value after moving to `lock`, where every surviving die is freshly
 * rerolled together with the Intuition. Cacheable on (survivors, lock, face). */
function freshValue(exhausted, lock, intuition, rollsUsed, startingLock) {
  if (lock > 2 || exhausted.every(Boolean)) return 0;
  const key = [exhausted.map((e) => (e ? 1 : 0)).join(''), lock, intuition, rollsUsed, startingLock].join('|');
  const hit = freshMemo.get(key);
  if (hit !== undefined) return hit;
  const base = {
    lock, intuition, intuitionUsed: false, rollsUsed, startingLock, rand: RAND_BUDGET,
    dice: DICE_DEF.map((def, i) => ({
      id: i, key: def.key, name: def.name, color: def.color,
      type: def.primary, value: 0, bonus: 0, saved: false, exhausted: exhausted[i],
    })),
  };
  const vars = [];
  DICE_DEF.forEach((def, i) => {
    if (exhausted[i]) return;
    vars.push({ opts: valueDistribution({ key: def.key }).map((o) => ({ p: o.p, die: i, type: o.type, value: o.value })) });
  });
  const v = cartesianExpect(vars, (opts) => {
    const faces = {};
    opts.forEach((o) => { if (o.die != null) faces[o.die] = o; });
    const next = cloneState(base);
    next.dice = next.dice.map((d) => (faces[d.id] ? { ...d, type: faces[d.id].type, value: faces[d.id].value, bonus: 0, saved: false } : d));
    return next;
  });
  freshMemo.set(key, v);
  return v;
}

function expectedReroll(s, id) {
  const die = s.dice.find((d) => d.id === id);
  const vars = [
    { opts: valueDistribution(die).map((o) => ({ p: o.p, die: id, type: o.type, value: o.value })) },
    { opts: intuitionOptions() },
  ];
  return cartesianExpect(vars, (opts) => {
    const f = opts.find((o) => o.die != null);
    const face = opts.find((o) => o.face != null).face;
    const next = cloneState(s);
    next.dice = next.dice.map((d) => (d.id === id ? { ...d, type: f.type, value: f.value, bonus: 0, saved: false } : d));
    next.intuition = face;
    next.intuitionUsed = false;
    next.rand = s.rand - 1;
    return next;
  });
}

function expectedRetry(s) {
  const vars = [];
  s.dice.forEach((d) => {
    if (d.exhausted) return;
    vars.push({ opts: valueDistribution(d).map((o) => ({ p: o.p, die: d.id, type: o.type, value: o.value })) });
  });
  vars.push({ opts: intuitionOptions() });
  return cartesianExpect(vars, (opts) => {
    const faces = {};
    let face = INTUITION_FACES[0];
    opts.forEach((o) => { if (o.die != null) faces[o.die] = o; else face = o.face; });
    const next = cloneState(s);
    next.dice = next.dice.map((d) => (faces[d.id] ? { ...d, type: faces[d.id].type, value: faces[d.id].value, bonus: 0, saved: false } : d));
    next.intuition = face;
    next.intuitionUsed = false;
    next.rollsUsed = s.rollsUsed + 1;
    next.rand = RAND_BUDGET;
    return next;
  });
}

function moveValue(s, m) {
  switch (m.kind) {
    case 'end': return 0;
    case 'unlock': return 1 + expectedAdvance(s, m.ids);
    case 'convert': {
      const next = cloneState(s);
      next.dice = next.dice.map((d) => (d.id === m.id ? { ...d, type: m.type } : d));
      next.intuitionUsed = true;
      return solveValue(next);
    }
    case 'save': {
      const next = cloneState(s);
      next.dice = next.dice.map((d) => (d.id === m.id ? { ...d, bonus: d.bonus + 1, saved: true } : d));
      next.intuitionUsed = true;
      return solveValue(next);
    }
    case 'reroll': return expectedReroll(s, m.id);
    case 'retry': return expectedRetry(s);
    default: return 0;
  }
}

function solveValue(s) {
  if (s.lock > 2) return 0;                                  // every lock is open
  if (s.dice.every((d) => d.exhausted)) return 0;            // attempt ends: no dice left
  if (solverNodes++ > SOLVER_NODE_CAP) return 0;             // safety valve
  const key = solveKey(s);
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let best = 0; // ending the attempt is always available
  for (const m of legalMoves(s, false)) {
    const v = moveValue(s, m);
    if (v > best) best = v;
  }
  memo.set(key, best);
  return best;
}

function faceStr(d) { return `${d.value + d.bonus}${d.type}`; }
function dieDesc(d) { return `${d.name} ${faceStr(d)}`; }

/* A plain-language reason for the chosen move (shown in the attempt log). */
function moveReason(s, m) {
  const lock = state.loot.locks[s.lock];
  const lockName = TYPES[lock.type].name;
  const dice = s.dice;

  if (m.kind === 'unlock') {
    const chosen = m.ids.map((i) => dice[i]);
    const total = chosen.reduce((t, d) => t + d.value + d.bonus, 0);
    const ways = winningSubsets(dice, lock.type, lock.target).length;
    let why = 'a plain pick was already showing, so the Intuition die is kept';
    if (ways > 1) why += ` (best of ${ways} ways to reach it)`;
    return `Best move — pick ${lockName} with ${chosen.map(dieDesc).join(' + ')} = ${total}: ${why}.`;
  }
  if (m.kind === 'convert') {
    const d = dice.find((x) => x.id === m.id);
    const after = dice.map((x) => (x.id === m.id ? { ...x, type: m.type } : x));
    const wins = winningSubsets(after, lock.type, lock.target);
    const why = wins.length
      ? `that makes ${wins[0].ids.map((i) => dieDesc(after[i])).join(' + ')} = ${wins[0].total} reach ${lockName} ${lock.target}`
      : `no face had reached ${lockName} ${lock.target}`;
    return `Best move — Convert the ${d.name} die (${faceStr(d)} → ${d.value + d.bonus}${m.type}): ${why}.`;
  }
  if (m.kind === 'save') {
    const d = dice.find((x) => x.id === m.id);
    const after = dice.map((x) => (x.id === m.id ? { ...x, bonus: x.bonus + 1 } : x));
    const wins = winningSubsets(after, lock.type, lock.target);
    const why = wins.length
      ? `that makes ${wins[0].ids.map((i) => dieDesc(after[i])).join(' + ')} = ${wins[0].total} reach ${lockName} ${lock.target}, and the die won't exhaust`
      : `the best way to close the gap to ${lockName} ${lock.target}`;
    return `Best move — Save +1 on the ${d.name} die (${faceStr(d)} → ${d.value + d.bonus + 1}${d.type}): ${why}.`;
  }
  if (m.kind === 'reroll') {
    const d = dice.find((x) => x.id === m.id);
    return `Best move — Reroll the ${d.name} die (showing ${faceStr(d)}): nothing reaches ${lockName} ${lock.target} yet, so a fresh face is the best chance.`;
  }
  if (m.kind === 'retry') {
    return `Best move — Take a second attempt at the first lock (${lockName} ${lock.target}): the current faces are too far, so a fresh roll of all the dice is worth the most.`;
  }
  return `Best move — End the attempt: ${lockName} ${lock.target} can't be reached with what's left, and solved locks are kept.`;
}

/* Chosen move + its expected value + a plain-language reason. */
function chooseMove(s) {
  memo = new Map();
  freshMemo.clear();
  solverNodes = 0;
  if (!s || s.lock > 2) return null;
  const moves = legalMoves(s, true);
  if (!moves.length) return { move: { kind: 'end' }, value: 0, reason: moveReason(s, { kind: 'end' }) };

  // Keep the Intuition die when a plain pick is already possible.
  const unlocks = moves.filter((m) => m.kind === 'unlock');
  const pool = unlocks.length ? unlocks : moves;
  const ranked = pool.slice().sort((a, b) => {
    const pa = TIE_PRIORITY[a.kind];
    const pb = TIE_PRIORITY[b.kind];
    if (pa !== pb) return pa - pb;
    if (a.kind === 'unlock') return a.ids.length - b.ids.length;
    return 0;
  });

  let best = null;
  let bestV = -Infinity;
  for (const m of ranked) {
    const v = moveValue(s, m);
    if (v > bestV + 1e-9) { bestV = v; best = m; }
  }
  best = best || { kind: 'end' };
  return { move: best, value: bestV, reason: moveReason(s, best) };
}

function bestMove(s) {
  const chosen = chooseMove(s);
  return chosen ? chosen.move : null;
}

/* --------------------------- solver bridge / auto ----------------------- */

function solverStateFromAttempt() {
  const a = state.attempt;
  if (!a || a.over) return null;
  const idx = currentLockIndex();
  if (idx === -1) return null;
  return {
    lock: idx,
    dice: a.dice.map((d) => ({
      id: d.id, key: d.key, name: d.name, type: d.type, value: d.value,
      bonus: d.bonus, saved: !!d.saved, exhausted: !!d.exhausted,
    })),
    intuition: a.intuition,
    intuitionUsed: !!a.intuitionUsed,
    rollsUsed: a.rollsUsed,
    startingLock: a.startingLock,
    rand: RAND_BUDGET,
  };
}

function applyMove(m) {
  if (!m) return;
  switch (m.kind) {
    case 'unlock':
      state.ui.mode = null;
      state.ui.convertPick = null;
      state.ui.selected = {};
      m.ids.forEach((id) => { state.ui.selected[id] = true; });
      unlock();
      break;
    case 'convert':
      state.ui.mode = 'convert';
      state.ui.convertPick = m.id;
      applyConvert(m.type);
      break;
    case 'save':
      state.ui.mode = 'save';
      onDieClick(m.id);
      break;
    case 'reroll':
      state.ui.mode = 'reroll';
      onDieClick(m.id);
      break;
    case 'retry': retry(); break;
    case 'end': endAttempt(); break;
    default: break;
  }
}

/* Apply a single optimal action. Starts an attempt first if none is running. */
function applyOneBestMove() {
  if (!state.loot || currentLockIndex() === -1) return null;
  if (!state.attempt || state.attempt.over) { startAttempt(); return 'start'; }
  const s = solverStateFromAttempt();
  if (!s) return null;
  const chosen = chooseMove(s);
  if (!chosen) return null;
  if (chosen.reason) addLog(chosen.reason);
  applyMove(chosen.move);
  return chosen.move;
}

let autoTimer = null;
let autoToken = 0;
let autoSteps = 0;

function stopAuto() {
  autoToken += 1;
  if (autoTimer !== null) { clearTimeout(autoTimer); autoTimer = null; }
}

/* Play optimal moves automatically until the whole Trove Loot is open, a
 * safety limit is hit, or auto-play is switched off. */
function runAuto() {
  stopAuto();
  if (state.settings.autoMode === 'off') return;
  const full = state.settings.autoMode === 'full';
  autoSteps = 0;
  const token = autoToken;
  const step = () => {
    if (token !== autoToken || state.settings.autoMode === 'off') return;
    if (!state.loot) return;
    if (currentLockIndex() === -1) { addLog('Auto-play: all three locks are open.'); render(); return; }
    if (autoSteps++ >= 400) {
      addLog('Auto-play stopped — that is a lot of moves. Check the dice faces under Rules & setup.');
      render();
      return;
    }
    if (!state.attempt) {
      newRoll();
    } else if (state.attempt.over) {
      if (!full) { render(); return; }   // semi-automatic: stop after the attempt
      newRoll();
    } else {
      const s = solverStateFromAttempt();
      const chosen = s ? chooseMove(s) : null;
      if (!chosen || !chosen.move) { render(); return; }
      if (chosen.reason) addLog(chosen.reason);
      applyMove(chosen.move);
      render();
    }
    if (state.settings.autoMode !== 'off' && currentLockIndex() !== -1) {
      autoTimer = setTimeout(step, 650);
    }
  };
  autoTimer = setTimeout(step, 400);
}

/* ------------------------------- render --------------------------------- */

function render() {
  const app = document.getElementById('app');
  const lootVal = state.loot ? state.loot.locks.map((l) => l.target).join(' ') : '';
  app.innerHTML = `
    <header class="top">
      <div>
        <h1>Too Many Bones <span>Lockpicking</span></h1>
        <p class="sub">Roll the three Lockpicking dice (Grey, Brown, Yellow) plus the Intuition die. Every face is a number and a lock type — pick the Trove Loot's locks left to right.</p>
      </div>
      <div class="top-actions">
        <div class="loot-entry">
          <input type="text" id="loot-quick" data-input="quick-loot" placeholder="3 4 5" value="${lootVal}"
            aria-label="Lock numbers: Lever, Trip, Force" />
          <button class="btn small" data-action="set-loot">Set loot</button>
        </div>
        <button class="btn" data-action="new-loot">New Trove Loot</button>
        <button class="btn ghost" data-action="example-loot">Example: 3·4·5</button>
      </div>
    </header>
    ${renderLoot()}
    ${state.attempt && !state.attempt.over ? renderDice() : ''}
    ${renderControls()}
    ${renderLog()}
    ${renderSetup()}
  `;
  // The log reads oldest-first, so keep the newest entry in view.
  const logEl = typeof app.querySelector === 'function' ? app.querySelector('.log') : null;
  if (logEl) logEl.scrollTop = logEl.scrollHeight;
}

function renderLoot() {
  if (!state.loot) return '';
  const cur = currentLockIndex();
  const editable = !state.attempt;
  const cards = state.loot.locks.map((l, i) => {
    const t = TYPES[l.type];
    const isCur = i === cur;
    return `
      <div class="lock ${l.solved ? 'open' : ''} ${isCur ? 'current' : ''}">
        <div class="lock-num">Lock ${i + 1}</div>
        <div class="lock-icon" aria-hidden="true">${l.solved ? '🔓' : '🔒'}</div>
        <div class="lock-type" style="--c:${t.c1}">${t.name}</div>
        <div class="lock-target">
          <span>needs</span>
          ${editable
            ? `<input class="target-input" type="number" min="1" max="6" value="${l.target}" data-input="target" data-id="${i}" aria-label="${t.name} lock target" />`
            : `<b>${l.target}</b>`}
        </div>
        <div class="lock-state">${l.solved ? 'Open' : isCur ? 'Picking now' : 'Sealed'}</div>
      </div>`;
  }).join('');
  const solved = state.loot.locks.map((l) => l.solved);
  const connected = solved.filter(Boolean).length;
  const pipes = `
    <div class="pipes" aria-label="${connected} of 3 pipes connected">
      ${LOCK_ORDER.map((t, i) => `
        <span class="pipe-node ${solved[i] ? 'on' : ''}"></span>
        ${i < 2 ? `<span class="pipe-seg ${solved[i] ? 'on' : ''}"></span>` : ''}
      `).join('')}
    </div>
    <div class="pipe-caption">${connected} / 3 pipes connected</div>`;
  return `<section class="panel"><h2 class="panel-title">Trove Loot</h2><div class="locks">${cards}</div>${pipes}</section>`;
}

function renderDice() {
  const a = state.attempt;
  if (!a) return '';
  const lockType = usableType();
  const dice = a.dice.map((d) => {
    const t = TYPES[d.type];
    const col = d.color;
    const usable = !d.exhausted && d.type === lockType;
    const selected = !!state.ui.selected[d.id];
    const converting = state.ui.mode === 'convert' && state.ui.convertPick === d.id;
    return `
      <button class="die action ${d.exhausted ? 'exhausted' : ''} ${usable ? 'usable' : ''} ${selected ? 'selected' : ''} ${converting ? 'pick' : ''}"
        style="--c1:${col.c1};--c2:${col.c2};--ink:${col.ink}"
        data-action="pick-die" data-id="${d.id}"
        ${d.exhausted ? 'disabled' : ''}
        aria-label="${d.name} die showing ${d.value + d.bonus} ${t.name}">
        <span class="die-val">${d.value + d.bonus}</span>
        <span class="die-type-chip" style="--t:${t.c1};--ti:${t.ink}" title="${t.name}">${d.type}</span>
        ${d.bonus ? `<span class="die-badge">+${d.bonus}</span>` : ''}
        ${d.saved ? `<span class="die-save" title="Saved: will not exhaust this lock">★</span>` : ''}
        <span class="die-home">${d.name}</span>
      </button>`;
  }).join('');

  const converting = state.ui.mode === 'convert';
  const typeBtns = converting
    ? `<div class="convert-row">
         <span class="convert-label">Convert ${state.ui.convertPick == null ? 'a die' : 'to'}:</span>
         ${LOCK_ORDER.map((t) => `<button class="btn small" data-action="convert-to" data-type="${t}" style="--c:${TYPES[t].c1}" ${state.ui.convertPick == null ? 'disabled' : ''}>${TYPES[t].name}</button>`).join('')}
         <button class="btn small ghost" data-action="cancel-mode">Cancel</button>
       </div>`
    : '';

  return `
    <section class="panel">
      <h2 class="panel-title">Dice</h2>
      <div class="dice-row">
        ${dice}
        <button class="die intuition" data-action="intuition-info" aria-label="Intuition die showing ${a.intuition} (2 of each face)" title="Intuition die: 2× Reroll, 2× Convert, 2× Save +1">
          <span class="intuition-face">${a.intuition}</span>
          <span class="die-home">Intuition</span>
        </button>
      </div>
      ${typeBtns}
    </section>`;
}

function autoSelectHtml() {
  const m = state.settings.autoMode;
  const opt = (v, label) => `<option value="${v}"${m === v ? ' selected' : ''}>${label}</option>`;
  return `<label class="auto-toggle">Auto-play
    <select data-input="auto">${opt('off', 'Off')}${opt('semi', 'One attempt, then stop')}${opt('full', 'Until the loot is open')}</select>
  </label>`;
}

function renderControls() {
  if (!state.loot) return '';
  const cur = currentLockIndex();

  if (cur === -1) {
    return `<section class="panel win">
      <div class="win-msg">🎉 All three locks are open — this Trove Loot is yours.</div>
      <div class="controls auto-row">
        <button class="btn primary" data-action="new-loot">Draw another Trove Loot</button>
        ${autoSelectHtml()}
      </div>
    </section>`;
  }

  if (!state.attempt) {
    const lock = state.loot.locks[cur];
    return `<section class="panel">
      <h2 class="panel-title">Attempt</h2>
      <p class="hint">First lock you face: <b>${TYPES[lock.type].name} ${lock.target}</b>. If you can't open it, you may take a <b>second attempt</b> (a fresh roll of all the dice). Solved locks stay open.</p>
      <button class="btn primary" data-action="start">Roll the dice</button>
      ${autoSelectHtml()}
    </section>`;
  }

  const a = state.attempt;
  const lock = state.loot.locks[cur];

  if (a.over) {
    return `<section class="panel">
      <h2 class="panel-title">Attempt over</h2>
      <p class="hint">Already-open locks stay open — still sealed: <b>${TYPES[lock.type].name} ${lock.target}</b>. Press <b>New roll</b> to start a new attempt.</p>
      <div class="controls auto-row">
        <button class="btn primary" data-action="new-roll">New roll</button>
        ${autoSelectHtml()}
      </div>
    </section>`;
  }
  const total = selectedTotal();
  const count = selectedDice().length;
  const canUnlock = !a.over && cur !== -1 && count > 0 && total >= lock.target;
  const mode = state.ui.mode;

  const intuitionDisabled = a.intuitionUsed || a.over;
  const intuitionLabel = a.intuitionUsed ? 'Intuition used this lock' : `${a.intuition} available`;

  let status;
  if (a.over) {
    status = cur === -1 ? 'Trove Loot open.' : 'Attempt over — solved locks are kept for your next day.';
  } else {
    status = `${TYPES[lock.type].name} lock needs <b>${lock.target}</b>. Selected: <b>${total}</b>${count ? ` from ${count} dice` : ''}.`;
  }

  return `<section class="panel">
    <h2 class="panel-title">Attempt · Lock ${cur + 1}</h2>
    <p class="status">${status}</p>
    <div class="controls">
      <button class="btn ${mode === 'convert' ? 'active' : ''}" data-action="convert" ${intuitionDisabled || a.intuition !== 'Convert' ? 'disabled' : ''}>Convert</button>
      <button class="btn ${mode === 'reroll' ? 'active' : ''}" data-action="reroll" ${intuitionDisabled || a.intuition !== 'Reroll' ? 'disabled' : ''}>Reroll</button>
      <button class="btn ${mode === 'save' ? 'active' : ''}" data-action="save1" ${intuitionDisabled || a.intuition !== 'Save +1' ? 'disabled' : ''}>Save +1</button>
      <span class="intuition-state">${intuitionLabel}</span>
    </div>
    <div class="controls">
      <button class="btn primary" data-action="unlock" ${canUnlock ? '' : 'disabled'}>Unlock ${TYPES[lock.type].name}</button>
      <button class="btn ghost" data-action="end" ${a.over ? 'disabled' : ''}>End attempt</button>
    </div>
    <div class="controls auto-row">
      ${autoSelectHtml()}
      ${state.settings.autoMode !== 'off'
        ? '<span class="auto-note">Auto-playing… set Auto-play to Off to take over.</span>'
        : '<button class="btn small" data-action="best-move">Best move</button>'}
    </div>
  </section>`;
}

function renderLog() {
  if (!state.log.length) return '';
  const lines = state.log.map((e) => {
    const text = typeof e === 'string' ? e : e.text;
    const kind = typeof e === 'string' ? null : e.kind;
    return `<li class="${kind ? 'log-' + kind : ''}">${text}</li>`;
  }).join('');
  return `<section class="panel"><h2 class="panel-title">Attempt log</h2><ol class="log">${lines}</ol></section>`;
}

function renderSetup() {
  const faceInput = (def) => `
    <label class="face-input">
      <span style="color:${def.color.c1}">${def.name} die</span>
      <input type="text" value="${formatFaces(state.settings.faces[def.key])}" data-input="faces" data-key="${def.key}" aria-label="${def.name} die faces" />
    </label>`;
  return `<details class="panel setup"${setupOpen ? ' open' : ''}>
    <summary>Rules &amp; setup</summary>
    <div class="rules">
      <h3>How a lockpicking attempt works</h3>
      <ol>
        <li>A Trove Loot has three locks, always <b>Lever → Trip → Force</b>, picked left to right. Each lock has a number; pick it by rolling that lock's type <b>equal to or higher</b> than the number.</li>
        <li>Roll the <b>3 Lockpicking dice</b> (Grey, Brown, Yellow). Every face is a number plus a lock type — <b>1F</b> is one towards a Force lock, <b>3L</b> three towards a Lever lock. Add together every face showing the current lock's type.</li>
        <li>Dice used to pick a lock are <b>exhausted</b> for the rest of the attempt. When you move on to the next lock, <b>every unused die is rerolled together with the Intuition die</b> (the Intuition die itself is never exhausted).</li>
        <li>The <b>Intuition die</b> has two faces of each kind — <b>2× Reroll, 2× Convert, 2× Save +1</b> (so each is equally likely) — and is rerolled each time you move to a new lock. Its faces:
          <ul>
            <li><b>Reroll</b> — reroll one Lockpicking die and the Intuition die.</li>
            <li><b>Convert</b> — change the lock type of one face (Lever/Trip/Force).</li>
            <li><b>Save +1</b> — give one face +1, and it does not exhaust if used on this lock.</li>
          </ul>
        </li>
        <li>If you <b>fail to open the first lock you face</b> in an attempt, you <b>immediately take one second attempt</b> — a fresh roll of all the dice and the Intuition die. <b>Only one second attempt per attempt</b>, and only on that first lock.</li>
        <li>Your attempt is <b>over</b> as soon as you <b>fail to open a lock</b>, you have no Action Dice left to apply to it, or you have opened all three locks. Already-open locks are kept.</li>
      </ol>
      <h3>Dice faces (editable)</h3>
      <p class="hint">Each face is a number plus L (Lever), T (Trip) or F (Force), e.g. <b>1F,2F,3F,1T,3T,2L</b>. Defaults match the three Lockpicking dice.</p>
      <div class="face-grid">${DICE_DEF.map(faceInput).join('')}</div>
      <p class="caveat">Note: the official rulebook was intentionally not consulted. The dice faces default to the three physical Lockpicking dice and remain editable.</p>
    </div>
  </details>`;
}

/* ------------------------------- events --------------------------------- */

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  switch (action) {
    case 'new-loot': newLoot(); break;
    case 'example-loot': exampleLoot(); break;
    case 'set-loot': setLootFromInput(); break;
    case 'start': startAttempt(); if (state.settings.autoMode !== 'off') runAuto(); break;
    case 'new-roll': newRoll(); if (state.settings.autoMode !== 'off') runAuto(); break;
    case 'best-move': applyOneBestMove(); render(); break;
    case 'pick-die': onDieClick(Number(el.dataset.id)); break;
    case 'convert': setMode('convert'); break;
    case 'reroll': setMode('reroll'); break;
    case 'save1': setMode('save'); break;
    case 'cancel-mode': state.ui.mode = null; state.ui.convertPick = null; render(); break;
    case 'convert-to': applyConvert(el.dataset.type); break;
    case 'unlock': unlock(); break;
    case 'end': endAttempt(); break;
    case 'intuition-info': break; // decorative
    default: break;
  }
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-input]');
  if (!el) return;
  const kind = el.dataset.input;

  if (kind === 'target') {
    const lock = state.loot && state.loot.locks[Number(el.dataset.id)];
    if (!lock || state.attempt) return;
    const v = Math.max(1, Math.min(6, parseInt(el.value, 10) || 1));
    lock.target = v;
    el.value = v;
    save();
    return;
  }

  if (kind === 'faces') {
    const key = el.dataset.key;
    if (!DEFAULT_FACES[key]) return;
    const faces = parseFaces(el.value);
    state.settings.faces[key] = faces.length ? faces : clone(DEFAULT_FACES[key]);
    el.value = formatFaces(state.settings.faces[key]);
    save();
    return;
  }

  if (kind === 'auto') {
    const v = el.value;
    state.settings.autoMode = (v === 'semi' || v === 'full') ? v : 'off';
    save();
    if (state.settings.autoMode === 'off') stopAuto();
    else runAuto();
    render();
  }
});

document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (d && d.classList && d.classList.contains('setup')) setupOpen = d.open;
}, true);

/* ---------------------------- test hooks -------------------------------- */

window.TMB = {
  TYPES,
  LOCK_ORDER,
  INTUITION_FACES,
  DICE_DEF,
  DEFAULT_FACES,
  parseFaces,
  formatFaces,
  get state() { return state; },
  setRender(fn) { render = fn; },
  currentLockIndex,
  usableType,
  selectedDice,
  selectedTotal,
  parseLootInput,
  setLootFromInput,
  solverStateFromAttempt,
  legalMoves,
  bestMove,
  chooseMove,
  moveReason,
  winningSubsets,
  moveValue,
  applyMove,
  applyOneBestMove,
  newLoot,
  exampleLoot,
  startAttempt,
  newRoll,
  canOpenLock,
  maybeStop,
  retry,
  unlock,
  endAttempt,
  onDieClick,
  applyConvert,
  setMode,
};

/* -------------------------------- boot ---------------------------------- */

load();
render();

// Resume a full auto-play after a reload if the player left it switched on.
if (state.settings.autoMode === 'full' && state.loot && currentLockIndex() !== -1) runAuto();
