# Too Many Bones — Lockpicking

A small, dependency-free web app that runs the **Lockpicking** mini-game from
*Too Many Bones*: roll the Lockpicking dice and the Intuition die and pick the
three locks on a piece of Trove Loot.

## Run it

Open `index.html` in any modern browser — no build step, no server, no internet
required.

```
index.html    UI shell
styles.css    styling
app.js        game logic + rendering
```

## The mini-game

A Trove Loot has three locks, always **Lever → Trip → Force**, picked left to
right. Each lock has a number; solve it by rolling that lock's type **equal to or
higher** than the number.

- You roll the **3 Lockpicking dice** — **Grey, Brown, Yellow** — plus the
  **Intuition die**. Every die face is a number plus a lock type, so `3F` is three
  towards a Force lock and `2L` two towards a Lever lock.
- Add together every face showing the current lock's type (on any of the dice) to
  reach the number.
- Dice used to pick a lock are **exhausted** for the rest of the attempt. When
  you move on to the next lock, **every unused Action die is rerolled together
  with the Intuition die** (the Intuition die itself is never exhausted).
- The Intuition die has **two faces of each kind** (2× Reroll, 2× Convert,
  2× Save +1 — so each is equally likely), is **always rolled together with the
  Action dice** and is rerolled whenever you move to a new lock. Its faces:
  - **Reroll** — reroll one Lockpicking die and the Intuition die.
  - **Convert** — change the lock type (Lever / Trip / Force) of one face.
  - **Save +1** — give one face +1, and it does not exhaust if used on this
    lock.
- Your attempt is **over** as soon as you **fail to open a lock**, you have no
  Action Dice left to apply to the lock, or you have opened all three locks.
  **Already-open locks are remembered** across attempts.
- The one exception: if you **fail to open the first lock you face**, the app
  **immediately takes a single second attempt** — a fresh roll of all the dice and
  the Intuition die. **Only one second attempt per attempt**, and only on that
  first lock.
- When the attempt is over, press **New roll** to begin a new attempt, starting at
  the first still-sealed lock.

## How to play in the app

1. **Enter the loot.** Type the three lock numbers into the field in the top bar
   (Lever, Trip, Force — e.g. `3 4 5`, or `3,4,5` / `345`) and press **Set loot**.
   Or press **New Trove Loot** for a random one, or **Example: 3·4·5**.
   Lock numbers are also editable directly on the cards while no attempt is running.
2. **Roll the dice.**
3. Tap the dice whose face shows the current lock's type to select them (the
   running total is shown). Use the Intuition effect if you want, then
   **Unlock**.
4. If you can't open the first lock you face, the app **automatically takes your
   one second attempt**. When the attempt is over, press **New roll** to start a
   new one from the first still-sealed lock. Already-open locks are kept.

Progress, lock numbers, dice-face settings and the log are stored in
`localStorage`, so a refresh won't lose the current Trove Loot.

As you solve locks, the **pipe** bar under the Trove Loot connects one pipe per
solved lock ("1 / 3 pipes connected"), echoing the Gearloc mat.

## Auto-play and the best-move solver

Choose an **Auto-play** mode (in the Attempt panel or the auto row under the
controls):

- **Off** — you play; **Best move** applies a single optimal action.
- **One attempt, then stop** — the app plays the current attempt optimally and
  then stops. Press **New roll** to continue; already-open locks are kept.
- **Until the loot is open** — the app keeps rolling new attempts until all three
  locks are open.

Every decision it makes is written to the **attempt log with a short reason**, so
you can follow the thinking — e.g. *"Best move — pick Force with Grey 3F + Brown
2F = 5: a plain pick was already showing, so the Intuition die is kept."* or
*"Best move — Reroll the Brown die (showing 3L): nothing reaches Force 5 yet, so
a fresh face is the best chance."*

The app chooses each move with a small **expectimax** search: it enumerates every
outcome of the dice and the Intuition die, works out how many locks each option is
expected to solve for the rest of the attempt, and takes the best one. Two
consequences worth knowing:

- It **keeps the Intuition die when the current lock can already be picked** with
  the showing dice — spending it speculatively is only done when a lock genuinely
  needs it (for example when only a Convert or Save +1 can reach the number).
- The search is deliberately bounded so a decision is instant: it looks one
  reroll ahead per lock, treats **Retry** as a decision evaluated at the current
  lock only, and caps the number of explored states. Because every unused die is
  rerolled when moving on, the lookahead only has to reason about *which* dice
  survive. Auto-play keeps going until the whole Trove Loot is open, with a
  safety limit on the number of moves.

## Tests

Open `tests.html` in a browser (no test runner required). It drives the real
resolution logic with rendering stubbed out and reports pass/fail for each case:
target resolution, same-type filtering and summing, Convert, Save +1, exhaustion,
reroll-on-advance, starting-lock retries, persistent progress across attempts,
Reroll, full Trove Loot completion, the typed face parser, the quick loot-entry
parser, and the best-move solver (plain unlock preferred, no speculative
rerolls, Convert when required, Retry when stuck).

```
tests.html    tiny in-browser test page
 tests.js     the assertions
```

## Notes / assumptions

The rules were reconstructed with the player (dice faces, the second-attempt
rule and the reroll-on-advance rule were supplied directly). One detail is
editable under **Rules & setup**:

- **Dice faces** — the faces of the Grey, Brown and Yellow dice, as number+type
  pairs. Defaults match the physical Lockpicking dice:
  Grey `1F,2F,3F,1T,3T,2L`, Brown `1L,2L,3L,1F,3F,1T`, Yellow `1T,2T,3T,1L,3L,2F`.
