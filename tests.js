'use strict';

/* =========================================================================
 * In-browser tests for the Lockpicking resolution logic.
 * Open tests.html in a browser. No build step / test runner required.
 *
 * The tests drive the real public functions exposed by app.js on window.TMB,
 * with rendering stubbed out so nothing is drawn.
 * ========================================================================= */

(function () {
  const T = window.TMB;
  if (!T) {
    document.getElementById('summary').textContent = 'app.js did not expose window.TMB';
    return;
  }

  T.setRender(() => {}); // stub rendering

  /* ---------------------------- mini harness ---------------------------- */

  const results = [];

  function test(name, fn) {
    try {
      fn();
      results.push({ name, pass: true });
    } catch (err) {
      results.push({ name, pass: false, msg: err && err.message ? err.message : String(err) });
    }
  }
  const ok = (cond, msg) => { if (!cond) throw new Error(msg || 'expected true'); };
  const eq = (actual, expected, msg) => {
    if (actual !== expected) {
      throw new Error(`${msg || 'value'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const eqArr = (a, b, m) => eq(JSON.stringify(a), JSON.stringify(b), m);

  /* ------------------------------ fixtures ------------------------------ */

  const defaultFaces = () => JSON.parse(JSON.stringify(T.DEFAULT_FACES));

  function reset(targets) {
    T.state.loot = {
      locks: ['L', 'T', 'F'].map((type, i) => ({ type, target: targets[i], solved: false })),
    };
    T.state.attempt = null;
    T.state.log = [];
    T.state.ui = { mode: null, convertPick: null, selected: {} };
    T.state.settings.faces = defaultFaces();
    T.state.settings.autoMode = 'off';
  }

  /* Build a deterministic attempt from explicit face types/values (id 0 = grey,
   * 1 = brown, 2 = yellow). Avoids the random first roll entirely. */
  function makeAttempt(types, vals, intuition, opts) {
    opts = opts || {};
    T.state.attempt = {
      dice: ['grey', 'brown', 'yellow'].map((key, i) => ({
        id: i,
        key,
        name: key.charAt(0).toUpperCase() + key.slice(1),
        type: (types && types[i]) || 'L',
        value: vals[i] == null ? 0 : vals[i],
        bonus: 0,
        saved: false,
        exhausted: false,
      })),
      intuition: intuition || 'Reroll',
      intuitionUsed: !!opts.intuitionUsed,
      startingLock: opts.startingLock == null ? T.currentLockIndex() : opts.startingLock,
      rollsUsed: opts.rollsUsed || 1,
      over: false,
    };
    T.state.ui = { mode: null, convertPick: null, selected: {} };
    return T.state.attempt;
  }

  const die = (i) => T.state.attempt.dice[i];
  const setDie = (i, type, value) => { const d = die(i); d.type = type; d.value = value; d.bonus = 0; };
  const setFaces = (grey, brown, yellow) => {
    T.state.settings.faces = {
      grey: grey.map((f) => ({ value: f[1], type: f[0] })),
      brown: brown.map((f) => ({ value: f[1], type: f[0] })),
      yellow: yellow.map((f) => ({ value: f[1], type: f[0] })),
    };
  };
  const select = (ids) => {
    T.state.ui.selected = {};
    ids.forEach((i) => { T.state.ui.selected[i] = true; });
  };
  const solveRoot = () => T.chooseMove(T.solverStateFromAttempt());

  /* -------------------------------- tests ------------------------------- */

  test('a lock is solved when its dice total reaches the target', () => {
    reset([3, 4, 5]);
    makeAttempt(['L', 'T', 'F'], [3, 1, 1], 'Convert');
    select([0]);
    T.unlock();
    eq(T.state.loot.locks[0].solved, true, 'lock 1 solved');
    eq(die(0).exhausted, true, 'the used die is exhausted');
    eq(T.currentLockIndex(), 1, 'advances to lock 2');
  });

  test('same-type faces on different dice are summed', () => {
    reset([5, 3, 3]);
    makeAttempt(['L', 'L', 'F'], [2, 3, 1], 'Convert'); // grey 2L + brown 3L
    select([0, 1]);
    T.unlock();
    eq(T.state.loot.locks[0].solved, true, '2 + 3 = 5 solves the Lever lock');
  });

  test('a die of another type cannot pick the lock', () => {
    reset([3, 4, 5]);
    makeAttempt(['L', 'T', 'F'], [1, 6, 1], 'Convert');
    select([1]);                     // a high Trip face, but lock 1 is a Lever lock
    T.unlock();
    eq(T.state.loot.locks[0].solved, false, 'wrong-type selection is ignored');
    eq(T.currentLockIndex(), 0, 'still on lock 1');
  });

  test('Convert changes a face type so a second die can join', () => {
    reset([5, 3, 3]);
    makeAttempt(['L', 'T', 'F'], [2, 3, 1], 'Convert');
    T.state.ui.mode = 'convert';
    T.onDieClick(1);                 // choose the Brown die
    T.applyConvert('L');             // treat its 3 as a Lever face
    eq(die(1).type, 'L', 'face type changed to Lever');
    eq(die(1).value, 3, 'value is unchanged');
    eq(T.state.attempt.intuitionUsed, true, 'Convert consumed the intuition');
    select([0, 1]);
    T.unlock();
    eq(T.state.loot.locks[0].solved, true, '2 + 3 = 5 solves the lock');
  });

  test('Save +1 adds 1 and keeps the die from being exhausted', () => {
    reset([2, 3, 3]);
    makeAttempt(['L', 'T', 'F'], [1, 3, 3], 'Save +1');
    T.state.ui.mode = 'save';
    T.onDieClick(0);
    eq(die(0).bonus, 1, 'bonus applied');
    select([0]);
    T.unlock();                      // 1 + 1 = 2
    eq(T.state.loot.locks[0].solved, true, 'solved with the boosted die');
    eq(die(0).exhausted, false, 'saved die is not exhausted');
  });

  test('unused Action dice are rerolled when moving to the next lock', () => {
    reset([2, 4, 3]);
    setFaces([['F', 1]], [['T', 1]], [['F', 1]]); // brown always comes back as 1T
    makeAttempt(['L', 'T', 'F'], [2, 5, 1], 'Convert');
    select([0]);
    T.unlock();
    eq(T.usableType(), 'T', 'now picking the Trip lock');
    eq(die(1).exhausted, false, 'the unused die is still available');
    eq(die(1).type, 'T', 'it was rerolled');
    eq(die(1).value, 1, 'its previous 5 is gone');
  });

  test('a +1 bonus does not carry to the next lock', () => {
    reset([2, 3, 3]);
    makeAttempt(['L', 'T', 'F'], [2, 4, 1], 'Convert');
    die(1).bonus = 1;
    select([0]);
    T.unlock();
    eq(die(1).bonus, 0, 'bonus cleared on advancing');
  });

  test('picking all three locks opens the Trove Loot', () => {
    reset([1, 1, 1]);
    setFaces([['L', 1]], [['T', 1]], [['F', 1]]);
    T.startAttempt();                 // grey 1L, brown 1T, yellow 1F
    select([0]); T.unlock();          // Lever 1
    select([1]); T.unlock();          // Trip 1 (brown comes back as 1T)
    select([2]); T.unlock();          // Force 1
    eq(T.currentLockIndex(), -1, 'no locks remain');
    eq(T.state.attempt.over, true, 'the attempt is over');
  });

  test('the first lock gets exactly one automatic second attempt', () => {
    reset([6, 3, 3]);
    setFaces([['F', 1]], [['F', 1]], [['F', 1]]);   // can never open a Lever lock
    T.startAttempt();
    eq(T.state.attempt.rollsUsed, 2, 'the second attempt was taken automatically');
    eq(T.state.attempt.over, true, 'and then the attempt is over');
    ok(T.state.log.some((e) => e.text && e.text.indexOf('Second attempt') === 0), 'it is logged');
  });

  test('a second attempt is only for the first lock you face', () => {
    reset([2, 3, 3]);
    makeAttempt(['L', 'T', 'F'], [2, 5, 5], 'Reroll');
    select([0]);
    T.unlock();                      // opened the first lock, now on lock 2
    eq(T.state.attempt.rollsUsed, 1, 'still the first roll');
    eq(T.retry(), false, 'no second attempt once the first lock is open');
    eq(T.state.attempt.rollsUsed, 1, 'rolls used unchanged');
  });

  test('solved locks persist after the attempt ends', () => {
    reset([2, 3, 3]);
    makeAttempt(['L', 'T', 'F'], [2, 1, 1], 'Convert');
    select([0]);
    T.unlock();
    T.endAttempt();
    eq(T.state.loot.locks[0].solved, true, 'lock 1 stays solved');
    T.startAttempt();
    eq(T.state.attempt.startingLock, 1, 'the next attempt starts on lock 2');
  });

  test('Reroll refreshes the intuition (it is never exhausted)', () => {
    reset([3, 4, 5]);
    makeAttempt(['L', 'T', 'F'], [2, 2, 2], 'Reroll');
    T.state.ui.mode = 'reroll';
    T.onDieClick(1);
    eq(T.state.attempt.intuitionUsed, false, 'a fresh intuition face is usable');
    ok(T.state.attempt.intuition !== undefined, 'an intuition face is set');
  });

  test('a die keeps its identity (key) so its faces can be re-rolled', () => {
    reset([3, 4, 5]);
    // rollsUsed: 2 so a failed convert doesn't trigger the automatic second attempt.
    makeAttempt(['L', 'T', 'F'], [2, 2, 2], 'Convert', { rollsUsed: 2 });
    eq(die(2).key, 'yellow', 'the third die is the Yellow die');
    T.state.ui.mode = 'convert';
    T.onDieClick(2);
    T.applyConvert('T');
    eq(die(2).type, 'T', 'type changed');
    eq(die(2).key, 'yellow', 'identity preserved for future rolls');
  });

  /* ------------------------- typed face parsing ------------------------- */

  test('face strings parse and format with value + lock type', () => {
    const parsed = T.parseFaces('1f,2f,3f,1T,3t,2L');
    eqArr(parsed, [
      { value: 1, type: 'F' }, { value: 2, type: 'F' }, { value: 3, type: 'F' },
      { value: 1, type: 'T' }, { value: 3, type: 'T' }, { value: 2, type: 'L' },
    ], 'parsed the Grey die');
    eq(T.formatFaces(parsed), '1F,2F,3F,1T,3T,2L', 'formats back');
    eqArr(T.DICE_DEF.map((d) => d.key), ['grey', 'brown', 'yellow'], 'three dice');
    eq(T.formatFaces(T.DEFAULT_FACES.brown), '1L,2L,3L,1F,3F,1T', 'brown defaults');
    eq(T.formatFaces(T.DEFAULT_FACES.yellow), '1T,2T,3T,1L,3L,2F', 'yellow defaults');
  });

  /* ------------------------- quick loot entry --------------------------- */

  test('quick loot entry parses "3 4 5", "3,4,5" and "345"', () => {
    eqArr(T.parseLootInput('3 4 5'), [3, 4, 5], 'spaces');
    eqArr(T.parseLootInput('3,4,5'), [3, 4, 5], 'commas');
    eqArr(T.parseLootInput('345'), [3, 4, 5], 'single run of three digits');
    eqArr(T.parseLootInput('9 4 2'), [6, 4, 2], 'clamped to 1..6');
    eq(T.parseLootInput('1 2'), null, 'needs three numbers');
    eq(T.parseLootInput(''), null, 'empty input');
  });

  /* ------------------------------ solver -------------------------------- */

  test('best move picks a plain unlock and keeps the intuition die', () => {
    reset([3, 4, 5]);
    makeAttempt(['L', 'T', 'F'], [3, 1, 1], 'Convert');
    const m = T.bestMove(T.solverStateFromAttempt());
    eq(m.kind, 'unlock', 'an unlock is chosen');
    eqArr(m.ids, [0], 'uses only the Grey (Lever) die');
  });

  test('best move does not reroll when the lock is already pickable', () => {
    reset([1, 4, 5]);
    makeAttempt(['L', 'T', 'F'], [1, 6, 6], 'Reroll');
    eq(T.bestMove(T.solverStateFromAttempt()).kind, 'unlock', 'unlock rather than a speculative reroll');
  });

  test('best move converts when that is the only way to reach the lock', () => {
    reset([5, 4, 5]);
    makeAttempt(['L', 'T', 'F'], [1, 4, 1], 'Convert', { rollsUsed: 2 }); // no retry left
    const m = T.bestMove(T.solverStateFromAttempt());
    eq(m.kind, 'convert', 'a convert is chosen');
    eq(m.type, 'L', 'converts a face to Lever');
    eq(m.id, 1, 'converts the Brown die (1 + 4 = 5)');
  });

  test('applying best moves opens all three locks when the faces allow', () => {
    reset([3, 3, 3]);
    setFaces([['L', 3]], [['T', 3]], [['F', 3]]); // each die always shows its lock's face
    T.startAttempt();
    for (let step = 0; step < 8 && T.currentLockIndex() !== -1; step++) {
      const m = T.bestMove(T.solverStateFromAttempt());
      ok(m && m.kind === 'unlock', `expected an unlock at step ${step}`);
      T.applyMove(m);
    }
    eq(T.currentLockIndex(), -1, 'every lock is open');
    eq(T.state.attempt.over, true, 'the attempt is over');
  });

  test('best move produces a move without blowing up when rerolls are needed', () => {
    reset([6, 6, 6]);
    makeAttempt(['L', 'T', 'F'], [1, 1, 1], 'Reroll');
    const m = T.bestMove(T.solverStateFromAttempt());
    ok(m && typeof m.kind === 'string', 'a move was produced');
  });

  test('each chosen move comes with a plain-language reason', () => {
    reset([3, 4, 5]);
    makeAttempt(['L', 'T', 'F'], [3, 1, 1], 'Convert');
    const c = solveRoot();
    ok(c && typeof c.reason === 'string', 'a reason string is returned');
    ok(c.reason.indexOf('Best move') === 0, 'reason starts with "Best move"');
    ok(c.reason.indexOf('Lever') >= 0, 'reason names the lock');
    ok(c.reason.indexOf('Grey') >= 0, 'reason names the die used');
  });

  /* --------------------------- new roll / stop -------------------------- */

  test('New roll rolls again and remembers the open locks', () => {
    reset([2, 3, 3]);
    setFaces([['L', 1]], [['T', 3]], [['F', 1]]);   // so the fresh roll can open Trip 3
    makeAttempt(['L', 'T', 'F'], [2, 5, 5], 'Reroll');
    select([0]);
    T.unlock();                       // lock 1 is now open
    eq(T.currentLockIndex(), 1, 'facing lock 2');
    T.newRoll();
    eq(T.state.loot.locks[0].solved, true, 'the open lock is remembered');
    eq(T.currentLockIndex(), 1, 'still facing lock 2');
    eq(T.state.attempt.rollsUsed, 1, 'a new roll starts fresh');
    eq(T.state.attempt.startingLock, 1, 'it starts at the first unopened lock');
    ok(T.state.log.some((e) => e.text && e.text.indexOf('New roll') === 0), 'the new roll is logged');
  });

  test('the attempt is over once nothing can open the lock you face', () => {
    reset([6, 6, 6]);
    setFaces([['F', 1]], [['F', 1]], [['F', 1]]);   // no Lever faces anywhere
    makeAttempt(['F', 'F', 'F'], [1, 1, 1], 'Convert', { rollsUsed: 2 });
    eq(T.canOpenLock(), false, 'nothing can open Lever 6');
    T.maybeStop();
    eq(T.state.attempt.over, true, 'the attempt is stopped');
    ok(T.state.log.some((e) => e.text && e.text.indexOf('Attempt over') >= 0), 'the stop is explained in the log');
  });

  test('a reroll keeps the lock open', () => {
    reset([6, 6, 6]);
    makeAttempt(['L', 'L', 'T'], [2, 2, 3], 'Reroll', { rollsUsed: 2 });
    eq(T.canOpenLock(), true, 'rerolling could still find a Lever face');
  });

  test('reroll actions are flagged so the log can highlight them', () => {
    reset([3, 4, 5]);
    makeAttempt(['L', 'T', 'F'], [2, 2, 2], 'Reroll');
    T.state.ui.mode = 'reroll';
    T.onDieClick(1);
    ok(T.state.log.some((e) => e && e.kind === 'reroll'), 'Intuition Reroll is flagged');

    reset([4, 3, 3]);
    makeAttempt(['L', 'T', 'F'], [1, 1, 1], 'Reroll');
    T.retry();
    ok(T.state.log.some((e) => e && e.kind === 'reroll'), 'the second attempt is flagged');

    reset([2, 3, 3]);
    makeAttempt(['L', 'T', 'F'], [2, 1, 1], 'Convert');
    select([0]);
    T.unlock();
    ok(T.state.log.some((e) => e && e.kind == null), 'ordinary entries are not flagged');
  });

  /* ------------------------------ reporting ----------------------------- */

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;

  const summary = document.getElementById('summary');
  summary.textContent = `${passed}/${results.length} tests passed` + (failed ? ` — ${failed} failed` : '');
  summary.className = failed ? 'fail' : 'pass';

  const list = document.getElementById('results');
  list.innerHTML = results.map((r) => {
    const msg = r.pass ? '' : `<span class="msg">${r.msg}</span>`;
    return `<li class="${r.pass ? 'pass' : 'fail'}">${r.name}${msg}</li>`;
  }).join('');

  // Make it easy to see a non-zero exit from automation / the console.
  if (failed) console.error(`${failed} test(s) failed`);
})();
