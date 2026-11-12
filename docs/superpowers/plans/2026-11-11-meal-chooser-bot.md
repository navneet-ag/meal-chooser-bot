# Meal Chooser Telegram Bot — Plan (Cloudflare Workers + D1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Telegram bot that runs the generalized fixed-block
fairness draw for two (or more) people, with manual-entry override, an
audit view, configurable participants/session length, a standalone food
diary, and a configurable "what can we eat" menu — hosted free and
reliably.

**Architecture:** Pure command/fairness core (no platform globals, tested
with plain `node --test`) behind a thin Cloudflare Worker shell that talks
to Telegram (webhook) and D1 (storage). Mirrors the pure-core/thin-shell
split and idempotency discipline already proven in the user's
`telegram-expense-tracker` project, adapted to a new runtime. Outcome-
dependent replies (did this row already exist?) are composed by the shell
after the D1 effect runs, the same way the expense tracker composes
"saved" vs. "already saved" after `appendExpense` — not pre-baked by the
pure core.

**Tech Stack:** Cloudflare Workers (JavaScript), Cloudflare D1 (SQLite-
compatible), Telegram Bot API (webhook + `secret_token` header auth),
Miniflare for local integration testing, plain Node `node --test` for the
pure core.

**Spec:** `docs/superpowers/specs/2026-11-11-meal-chooser-bot-design.md`
— already fully current (Workers/D1 platform, fairness algorithm, all
eleven functional requirements including the food diary and menu, command
list, non-goals). This plan implements it as written; no design-doc
update task is needed.

## Global Constraints

- Fairness formula is exactly: `quota_i = floor(n/k)` plus 1 for a
  uniformly-random subset of size `n mod k` participants; `P(i) =
  remaining_i / sum(remaining)`; `forced = true` iff exactly one
  participant has `remaining > 0`.
- **`/draw` never reads `menu_items`** — the fairness draw and the food
  ideas list are independent systems, confirmed explicitly with the user
  rather than assumed.
- The food diary (`food_log`) is **not** one-to-one with `meal_log` — it
  is a standalone log, loggable any number of times independent of draws.
- `/ate`, `/food`, and `/menu` (list/add/remove) all work with **no
  roster or active session configured** — they must not depend on
  `ensureRoster` or any session state.
- Authorization is by `chat.id` only (any chat type) against
  `AUTHORIZED_CHAT_ID` — not tied to a specific sender's user id.
- Telegram webhook auth uses the `secret_token` → `X-Telegram-Bot-Api-Secret-Token`
  header mechanism, not a URL query-string secret.
- D1 free tier: 5 GB storage, 5M reads/day, 100k writes/day — no cleanup
  job is needed for `processed_updates` at this app's scale (a few rows a
  day); do not build one.
- No Google Sheets dependency — `/audit`, `/food`, and `/menu` all read
  D1 directly.
- Commands: `/start`, `/help`, `/setup <names>`, `/newsession [n]`,
  `/draw`, `/log <name>`, `/status`, `/audit`, `/config`, `/ate <dish>`,
  `/food [n]`, `/menu`, `/menu add <dish>`, `/menu remove <dish>`.
- A session auto-rolls into a new one (same `n`, current roster) the
  instant `sum(remaining) == 0` — no manual step required.
- `/log` on an unmatched name errors without mutating state; `/log` is
  allowed to push a participant's `remaining` negative (reported, not
  blocked) since it's a deliberate manual override.

## Review Focus

- `n` not evenly divisible by the participant count (e.g. 10 meals / 3
  people) — quotas must still sum to exactly `n`, and the extra slot must
  not always land on the same person across repeated sessions.
- `/setup` changing the roster while a session is active must not corrupt
  that session's in-flight quotas — the change applies starting next
  session only.
- A retried/duplicate Telegram `update_id` during `/draw` must not
  double-draw or double-decrement.
- `/audit` immediately after an auto-rolled session must show the *new*
  session's (empty) log, not bleed in the just-completed session's rows.
- A webhook call with a missing or wrong `X-Telegram-Bot-Api-Secret-Token`
  header, or from an unconfigured `chat.id`, must be silently ignored, not
  processed or acknowledged as valid.
- `/menu add` called twice with the same dish (e.g. a retried tap) must
  not create a duplicate row or error — the second call reports "already
  on the menu" instead of silently succeeding twice.

---

### Task 1: Project scaffolding + D1 schema

**Files:**
- Create: `package.json` (name `meal-chooser-bot`, `"type": "module"`,
  scripts: `"test": "node --test test/*.test.js"`, devDependencies:
  `wrangler`, `miniflare`)
- Create: `wrangler.toml`
- Create: `schema.sql`
- Create: `.gitignore` (`.dev.vars`, `node_modules/`, `.wrangler/`, `.DS_Store`)
- Create: `.dev.vars.example` (documents `BOT_TOKEN`, `WEBHOOK_SECRET` for
  local Miniflare runs — real values go in `.dev.vars`, gitignored)

**Interfaces:**
- Produces: D1 binding name `DB` (used by every later task); tables
  `roster`, `sessions`, `participants`, `meal_log`, `food_log`,
  `menu_items`, `processed_updates` exactly as specified in the design
  doc's Data Model section.

- [ ] **Step 1: Write `schema.sql`** with all seven tables from the design
  doc's Data Model section verbatim (including `food_log` and
  `menu_items` — not deferred to a later migration, since nothing has
  been deployed yet).

- [ ] **Step 2: Write `wrangler.toml`**

```toml
name = "meal-chooser-bot"
main = "src/index.js"
compatibility_date = "2026-11-12"

[[d1_databases]]
binding = "DB"
database_name = "meal_chooser"
database_id = "REPLACE_AFTER_WRANGLER_D1_CREATE"

[vars]
AUTHORIZED_CHAT_ID = "REPLACE_WITH_YOUR_GROUP_CHAT_ID"
```

- [ ] **Step 3: Write `package.json`, `.gitignore`, `.dev.vars.example`.**

- [ ] **Step 4: `npm install` and verify `node --test` runs (zero tests, exits 0).**

Run: `npm install && npm test`
Expected: passes with "0 tests" (no test files yet).

- [ ] **Step 5: Commit**

```bash
git init
git add package.json wrangler.toml schema.sql .gitignore .dev.vars.example
git commit -m "chore: scaffold meal-chooser-bot project"
```

---

### Task 2: Fairness core — quota distribution & probabilities

**Files:**
- Create: `src/fairness.js`
- Test: `test/fairness.test.js`

**Interfaces:**
- Produces: `distributeQuotas(n: number, names: string[], randomFn: () =>
  number): {name: string, quota: number}[]` (order matches `names`, quotas
  sum to `n`). `computeProbabilities(participants: {name, remaining}[]):
  {name, p}[]` (`p` sums to 1; throws if `sum(remaining) === 0`).

- [ ] **Step 1: Write failing tests**

```js
test('distributeQuotas splits evenly when n is divisible by k', () => {
  const q = distributeQuotas(10, ['A', 'B'], () => 0.1);
  assert.deepEqual(q, [{name:'A', quota:5}, {name:'B', quota:5}]);
});

test('distributeQuotas sums to n with 3 participants and a remainder', () => {
  const q = distributeQuotas(10, ['A', 'B', 'C'], () => 0.1);
  assert.equal(q.reduce((s, x) => s + x.quota, 0), 10);
  assert.ok(q.every(x => x.quota === 3 || x.quota === 4));
  assert.equal(q.filter(x => x.quota === 4).length, 1); // 10 mod 3 = 1
});

test('distributeQuotas remainder assignment depends on randomFn, not always the first name', () => {
  const lowRandom = distributeQuotas(10, ['A', 'B', 'C'], () => 0.01);
  const highRandom = distributeQuotas(10, ['A', 'B', 'C'], () => 0.99);
  const extraLow = lowRandom.find(x => x.quota === 4).name;
  const extraHigh = highRandom.find(x => x.quota === 4).name;
  assert.notEqual(extraLow, extraHigh);
});

test('computeProbabilities matches remaining ratios and sums to 1', () => {
  const p = computeProbabilities([{name:'A', remaining:3}, {name:'B', remaining:1}]);
  assert.equal(p.find(x => x.name === 'A').p, 0.75);
  assert.equal(p.find(x => x.name === 'B').p, 0.25);
});

test('computeProbabilities throws when all remaining are zero', () => {
  assert.throws(() => computeProbabilities([{name:'A', remaining:0}, {name:'B', remaining:0}]));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `fairness.js` does not exist yet.

- [ ] **Step 3: Implement `distributeQuotas` and `computeProbabilities` in `src/fairness.js`**

`distributeQuotas`: compute `base = Math.floor(n/names.length)` and
`remainderCount = n % names.length`; pick `remainderCount` distinct
indices via partial Fisher-Yates driven by `randomFn()` to get `quota =
base+1`, rest get `base`. `computeProbabilities`: sum `remaining`, divide
each; throw a plain `Error` when the sum is 0.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/fairness.js test/fairness.test.js
git commit -m "feat: add quota distribution and probability calculation"
```

---

### Task 3: Fairness core — draw & session lifecycle

**Files:**
- Modify: `src/fairness.js`
- Test: `test/fairness.test.js`

**Interfaces:**
- Consumes: `distributeQuotas`, `computeProbabilities` (Task 2).
- Produces: `startSession(n, names, randomFn, nowIso, sessionIndex):
  Session` where `Session = {sessionIndex, n, startedAt, mealsLogged: 0,
  participants: {name, quota, remaining}[]}`. `pickWinner(participants:
  {name, remaining}[], r: number): {name, p, forced}`. `drawNext(session:
  Session, randomFn): {winner: {name, p, forced}, mealNumber: number}`
  (mutates `session` in place: decrements winner's `remaining`, increments
  `mealsLogged`). `isSessionComplete(session): boolean`.

- [ ] **Step 1: Write failing tests**

```js
test('pickWinner picks by cumulative probability boundary', () => {
  const participants = [{name:'A', remaining:3}, {name:'B', remaining:1}]; // P(A)=0.75
  assert.equal(pickWinner(participants, 0.5).name, 'A');
  assert.equal(pickWinner(participants, 0.8).name, 'B');
});

test('pickWinner reports forced when only one participant has remaining', () => {
  const participants = [{name:'A', remaining:0}, {name:'B', remaining:2}];
  const result = pickWinner(participants, 0.9);
  assert.equal(result.name, 'B');
  assert.equal(result.p, 1);
  assert.equal(result.forced, true);
});

test('drawNext decrements the winner and advances mealsLogged', () => {
  const session = startSession(4, ['A', 'B'], () => 0.1, '2026-11-12T00:00:00.000Z', 1);
  const { winner, mealNumber } = drawNext(session, () => 0.1); // P(A)=0.5 at start, r=0.1 -> A
  assert.equal(winner.name, 'A');
  assert.equal(mealNumber, 1);
  assert.equal(session.mealsLogged, 1);
  assert.equal(session.participants.find(p => p.name === 'A').remaining, 1);
});

test('a full session ends with totals exactly equal to quotas (10 meals, 3 people)', () => {
  const session = startSession(10, ['A', 'B', 'C'], () => 0.1, '2026-11-12T00:00:00.000Z', 1);
  const quotas = Object.fromEntries(session.participants.map(p => [p.name, p.quota]));
  const totals = { A: 0, B: 0, C: 0 };
  const draws = [0.9, 0.1, 0.5, 0.99, 0.01, 0.4, 0.6, 0.2, 0.8, 0.3];
  let i = 0;
  while (!isSessionComplete(session)) {
    totals[drawNext(session, () => draws[i++]).winner.name]++;
  }
  assert.deepEqual(totals, quotas);
  assert.equal(i, 10);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement `startSession`, `pickWinner`, `drawNext`, `isSessionComplete` in `src/fairness.js`**

`pickWinner`: call `computeProbabilities`, walk in input order accumulating
cumulative probability, return the first participant whose cumulative
share exceeds `r` (fall back to the last participant with `remaining > 0`
if floating-point rounding leaves none selected); `forced` = exactly one
participant has `remaining > 0`. `drawNext`: call `pickWinner` on
`session.participants`, decrement that participant's `remaining` in place,
increment `session.mealsLogged`, return `{winner, mealNumber:
session.mealsLogged}`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/fairness.js test/fairness.test.js
git commit -m "feat: add draw, session lifecycle, and exact-balance guarantee"
```

---

### Task 4: Commands — roster & session config

**Files:**
- Create: `src/commands.js`
- Test: `test/commands.test.js`

**Interfaces:**
- Consumes: `startSession` (Task 3).
- Produces: `LIMITS` — an exported constant object, extended by later
  tasks, starting with `{nameLength:40, maxParticipants:10}`. `handle(state:
  {roster, session}, event: {text, chatId, updateId}, context: {config,
  nowMs, nowIso, random}): {state, effects}` where `effects` is an array
  of `{type:'send', text}` for now (Tasks 5–6 add more effect types).
  `state.roster = {names: string[], defaultN: number} | null`; lazily
  initialized from `context.config.defaultParticipants` /
  `defaultSessionLength` on first use, same normalization idiom as the
  expense tracker's `state && typeof state === 'object' ? state :
  {draft: null}`. `index.js` will build `context.limits` from this same
  `LIMITS` constant (imported from `commands.js`).

- [ ] **Step 1: Write failing tests** (using a fake context: `{config:
  {defaultParticipants:['Person 1','Person 2'], defaultSessionLength:21},
  nowMs:0, nowIso:'2026-11-12T00:00:00.000Z', random:() => 0.1}`)

```js
test('/setup requires 2-10 names', () => {
  const r1 = handle({roster:null, session:null}, msg('/setup'), ctx());
  assert.match(r1.effects[0].text, /Usage: \/setup/);
  const r2 = handle({roster:null, session:null}, msg('/setup Solo'), ctx());
  assert.match(r2.effects[0].text, /between 2 and 10/);
});

test('/setup updates the roster and defers mid-session changes', () => {
  let state = handle({roster:null, session:null}, msg('/setup Anshika, Partner'), ctx()).state;
  state = handle(state, msg('/newsession 4'), ctx()).state;
  const result = handle(state, msg('/setup A, B, C'), ctx());
  assert.deepEqual(state.roster.names, ['Anshika', 'Partner']); // unchanged by the call above until reassigned
  assert.match(result.effects[0].text, /next session/);
  assert.deepEqual(result.state.roster.names, ['A', 'B', 'C']);
  assert.equal(result.state.session.participants.length, 2); // active session untouched
});

test('/newsession without an arg uses the roster default', () => {
  const result = handle({roster:{names:['A','B'], defaultN:21}, session:null}, msg('/newsession'), ctx());
  assert.equal(result.state.session.n, 21);
});

test('/newsession rejects n smaller than the participant count', () => {
  const result = handle({roster:{names:['A','B','C'], defaultN:21}, session:null}, msg('/newsession 2'), ctx());
  assert.match(result.effects[0].text, /at least 3/);
});

test('/status with no active session', () => {
  const result = handle({roster:null, session:null}, msg('/status'), ctx());
  assert.match(result.effects[0].text, /No active session/);
});

test('unknown command falls back to help pointer', () => {
  const result = handle({roster:null, session:null}, msg('/nonsense'), ctx());
  assert.match(result.effects[0].text, /\/help/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `commands.js` does not exist.

- [ ] **Step 3: Implement `LIMITS`, `/start`, `/help`, `/setup`, `/newsession`, `/status`, `/config`, and the unknown-command fallback in `src/commands.js`**

Internal `ensureRoster(state, context)` lazily sets `state.roster` from
config defaults — used only by the roster/session/draw commands, never by
`/ate`, `/food`, or `/menu` (Task 6). `/setup`: split args on `,` if
present else whitespace, trim, filter empty, validate count `[2,
LIMITS.maxParticipants]` and each name length `<= LIMITS.nameLength`; if a
session is active and incomplete, note the change applies next session,
otherwise just confirm. `/newsession [n]`: `n` defaults to
`state.roster.defaultN`; validate `Number.isInteger(n) && n >=
state.roster.names.length`; if a prior session was active and incomplete,
prefix the reply with its partial tally before calling `startSession` with
`sessionIndex = (prior session index or 0) + 1`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands.js test/commands.test.js
git commit -m "feat: add roster and session configuration commands"
```

---

### Task 5: Commands — draw, manual log, audit

**Files:**
- Modify: `src/commands.js`
- Test: `test/commands.test.js`

**Interfaces:**
- Consumes: `drawNext`, `isSessionComplete`, `startSession` (Task 3);
  `handle`, `ensureRoster`, `LIMITS` (Task 4).
- Produces: `/draw` and `/log <name>` now also return `{type:'log', entry:
  {sessionIndex, mealNumber, name, method:'auto'|'manual', probability:
  number|null, forced: boolean}}` effects alongside `'send'`. `/audit`
  returns `{type:'audit', sessionIndex}` when a session is active, or a
  direct `'send'` effect ("No active session yet.") when not.

- [ ] **Step 1: Write failing tests**

```js
test('/draw auto-starts a session when none is active and logs the draw', () => {
  const result = handle({roster:{names:['A','B'], defaultN:4}, session:null}, msg('/draw'), ctx());
  const logEffect = result.effects.find(e => e.type === 'log');
  assert.equal(logEffect.entry.method, 'auto');
  assert.equal(logEffect.entry.mealNumber, 1);
  assert.equal(result.state.session.mealsLogged, 1);
});

test('/draw completing a session auto-rolls into the next one', () => {
  let state = {roster:{names:['A','B'], defaultN:2}, session:null};
  state = handle(state, msg('/draw'), ctx()).state;
  const result = handle(state, msg('/draw'), ctx());
  assert.equal(result.state.session.sessionIndex, 2);
  assert.equal(result.state.session.mealsLogged, 0);
  assert.match(result.effects.find(e => e.type === 'send').text, /new session/i);
});

test('/log applies a manual entry and allows negative remaining with a note', () => {
  let state = handle({roster:{names:['A','B'], defaultN:4}, session:null}, msg('/newsession 4'), ctx()).state;
  for (let i = 0; i < 4; i++) state = handle(state, msg('/log A'), ctx()).state; // overshoot A's quota of 2
  const participantA = state.session.participants.find(p => p.name === 'A');
  assert.ok(participantA.remaining < 0);
});

test('/log on an unmatched name errors without mutating state', () => {
  const state = handle({roster:{names:['A','B'], defaultN:4}, session:null}, msg('/newsession'), ctx()).state;
  const result = handle(state, msg('/log Nobody'), ctx());
  assert.match(result.effects[0].text, /No participant named/);
  assert.equal(result.state.session.mealsLogged, 0);
});

test('/audit with an active session emits an audit effect for the shell to fulfill', () => {
  const state = handle({roster:{names:['A','B'], defaultN:4}, session:null}, msg('/newsession'), ctx()).state;
  const result = handle(state, msg('/audit'), ctx());
  assert.deepEqual(result.effects[0], {type:'audit', sessionIndex: state.session.sessionIndex});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `/draw`/`/log`/`/audit` not implemented.

- [ ] **Step 3: Implement `/draw`, `/log`, `/audit` in `src/commands.js`**

Both `/draw` and `/log` call `ensureRoster` then auto-start a session via
the same path as `/newsession` with no arg if `!state.session`. `/draw`
calls `drawNext(state.session, context.random)` and emits a `'log'`
effect from the result. `/log <name>` matches case-insensitively against
`state.session.participants`; on no match, return an error `send` effect
*without* touching `state`; on match, decrement `remaining` directly,
increment `mealsLogged`, emit a `'log'` effect with `method:'manual',
probability:null, forced:false`. Both check
`isSessionComplete(state.session)` afterward and, if true, append a
completion summary to the reply and call `startSession` again
(`sessionIndex + 1`, same `n` and roster) before returning.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands.js test/commands.test.js
git commit -m "feat: add draw, manual log, and audit commands"
```

---

### Task 6: Commands — food diary & menu

**Files:**
- Modify: `src/commands.js`
- Test: `test/commands.test.js`

**Interfaces:**
- Consumes: `LIMITS`, `handle` (Task 4). Does **not** consume
  `ensureRoster` — these commands must work with no roster configured.
- Produces: `LIMITS` extended with `{dishLength:80, foodHistoryDefault:10,
  foodHistoryMax:50}`. `/ate <dish>` returns `[{type:'food_log', entry:
  {dish}}, {type:'send', text}]` (pre-baked reply — no DB-dependent
  branching needed). `/food [n]` returns `[{type:'food_history', limit:
  number}]`. `/menu` (no args) returns `[{type:'menu_list'}]`. `/menu add
  <dish>` returns `[{type:'menu_add', name: string}]` and `/menu remove
  <dish>` returns `[{type:'menu_remove', name: string}]` — **no `'send'`
  effect**, because whether the dish was already on the menu is a D1 fact
  the pure core can't know; the shell (Task 9) composes the reply after
  running the effect, the same way the expense tracker composes "saved"
  vs. "already saved" after `appendExpense`.

- [ ] **Step 1: Write failing tests**

```js
test('/ate logs a standalone food diary entry with a pre-baked confirmation', () => {
  const result = handle({roster:null, session:null}, msg('/ate Pasta'), ctx());
  assert.deepEqual(result.effects.find(e => e.type === 'food_log').entry, {dish:'Pasta'});
  assert.match(result.effects.find(e => e.type === 'send').text, /Logged: Pasta/);
});

test('/ate rejects an empty dish without requiring a roster', () => {
  const result = handle({roster:null, session:null}, msg('/ate'), ctx());
  assert.match(result.effects[0].text, /Usage: \/ate/);
});

test('/ate rejects a dish name over the length limit', () => {
  const result = handle({roster:null, session:null}, msg('/ate ' + 'x'.repeat(100)), ctx());
  assert.match(result.effects[0].text, /characters or fewer/);
});

test('/food with no arg emits a food_history effect with the default limit', () => {
  const result = handle({roster:null, session:null}, msg('/food'), ctx());
  assert.deepEqual(result.effects[0], {type:'food_history', limit: LIMITS.foodHistoryDefault});
});

test('/food caps an oversized limit argument', () => {
  const result = handle({roster:null, session:null}, msg('/food 500'), ctx());
  assert.deepEqual(result.effects[0], {type:'food_history', limit: LIMITS.foodHistoryMax});
});

test('/menu with no args emits a menu_list effect', () => {
  const result = handle({roster:null, session:null}, msg('/menu'), ctx());
  assert.deepEqual(result.effects[0], {type:'menu_list'});
});

test('/menu add emits a menu_add effect with no pre-baked reply', () => {
  const result = handle({roster:null, session:null}, msg('/menu add Pasta'), ctx());
  assert.deepEqual(result.effects, [{type:'menu_add', name:'Pasta'}]);
});

test('/menu remove emits a menu_remove effect with no pre-baked reply', () => {
  const result = handle({roster:null, session:null}, msg('/menu remove Pasta'), ctx());
  assert.deepEqual(result.effects, [{type:'menu_remove', name:'Pasta'}]);
});

test('/menu add rejects a dish name over the length limit', () => {
  const result = handle({roster:null, session:null}, msg('/menu add ' + 'x'.repeat(100)), ctx());
  assert.match(result.effects[0].text, /characters or fewer/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `/ate`/`/food`/`/menu` not implemented.

- [ ] **Step 3: Implement `/ate`, `/food`, `/menu` in `src/commands.js`**

`/ate <dish>`: trim remaining text; if empty, error "Usage: /ate
<dish>."; if over `LIMITS.dishLength`, error "Dish name must be
{LIMITS.dishLength} characters or fewer."; else emit the `food_log` +
pre-baked `send` effects. `/food [n]`: parse an optional integer arg,
default `LIMITS.foodHistoryDefault`, clamp to `[1,
LIMITS.foodHistoryMax]`. `/menu`: if remaining text (after `/menu`) is
empty, emit `menu_list`; if it starts with `add ` (case-insensitive),
validate and emit `menu_add`; if it starts with `remove `, validate and
emit `menu_remove`; otherwise error "Usage: /menu | /menu add <dish> |
/menu remove <dish>." None of these three call `ensureRoster`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands.js test/commands.test.js
git commit -m "feat: add food diary and menu commands"
```

---

### Task 7: Telegram client

**Files:**
- Create: `src/telegram.js`
- Test: `test/telegram.test.js`

**Interfaces:**
- Produces: `sendMessage(env: {BOT_TOKEN}, chatId: string|number, text:
  string): Promise<void>` — posts to
  `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage` with JSON
  body `{chat_id, text}`; throws on a non-2xx or `!ok` response, with the
  bot token redacted from any thrown message (same redaction idiom as the
  expense tracker's `ExpenseTelegram.redact`).

- [ ] **Step 1: Write failing tests** (stub global `fetch`)

```js
test('sendMessage posts the chat id and text', async () => {
  let captured;
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => { captured = {url, init}; return {ok:true, status:200, json: async () => ({ok:true, result:{}})}; };
  await sendMessage({BOT_TOKEN:'t'}, 42, 'hello');
  assert.match(captured.url, /\/bott\/sendMessage$/);
  assert.deepEqual(JSON.parse(captured.init.body), {chat_id:42, text:'hello'});
  global.fetch = originalFetch;
});

test('sendMessage throws with the token redacted on failure', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ok:false, status:401, json: async () => ({ok:false, description:'bad token-secret'})});
  await assert.rejects(() => sendMessage({BOT_TOKEN:'token-secret'}, 42, 'hi'), /\[REDACTED\]/);
  global.fetch = originalFetch;
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `telegram.js` does not exist.

- [ ] **Step 3: Implement `sendMessage` in `src/telegram.js`**

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/telegram.js test/telegram.test.js
git commit -m "feat: add Telegram sendMessage client"
```

---

### Task 8: D1 storage layer

**Files:**
- Create: `src/db.js`
- Test: `test/db.test.js` (Miniflare-backed, local D1)

**Interfaces:**
- Consumes: D1 binding `env.DB` (Task 1 schema).
- Produces:
  - `getRoster(env, chatId): {names, defaultN} | null`,
    `saveRoster(env, chatId, roster)`.
  - `getActiveSession(env, chatId): Session | null` (reconstructs the
    `Session` shape from Task 3's `startSession` by joining `sessions` +
    `participants`), `createSession(env, chatId, session)` (inserts into
    `sessions` + `participants` in one `env.DB.batch([...])`),
    `recordDraw(env, session, entry, updateId, nowIso)` (updates
    `participants.remaining` and inserts into `meal_log` in one `batch`),
    `readSessionLog(env, sessionId): {mealNumber, name, method,
    probability, forced}[]` ordered by `mealNumber`.
  - `appendFoodLog(env, chatId, dish, updateId, nowIso)`,
    `readFoodLog(env, chatId, limit): {dish, loggedAt}[]` ordered
    most-recent-first.
  - `listMenu(env, chatId): string[]` ordered by `name`,
    `addMenuItem(env, chatId, name, nowIso): {added: boolean}`,
    `removeMenuItem(env, chatId, name): {removed: boolean}` — both
    SELECT-first to determine the boolean definitively (existence-check
    then write), rather than relying on D1Result metadata field names.
  - `hasProcessed(env, chatId, updateId): boolean`, `markProcessed(env,
    chatId, updateId)` (`INSERT OR IGNORE`).

- [ ] **Step 1: Write failing tests** using Miniflare's D1 binding, applying
  `schema.sql` in a `beforeEach`.

```js
test('saveRoster then getRoster round-trips', async () => {
  const env = await freshEnv(); // helper: new Miniflare instance + schema applied
  await saveRoster(env, 'chat1', {names:['A','B'], defaultN:21});
  assert.deepEqual(await getRoster(env, 'chat1'), {names:['A','B'], defaultN:21});
});

test('createSession then getActiveSession reconstructs the Session shape', async () => {
  const env = await freshEnv();
  const session = startSession(4, ['A','B'], () => 0.1, '2026-11-12T00:00:00.000Z', 1);
  await createSession(env, 'chat1', session);
  assert.deepEqual(await getActiveSession(env, 'chat1'), session);
});

test('recordDraw persists the decrement and the log row', async () => {
  const env = await freshEnv();
  const session = startSession(4, ['A','B'], () => 0.1, '2026-11-12T00:00:00.000Z', 1);
  await createSession(env, 'chat1', session);
  const { winner, mealNumber } = drawNext(session, () => 0.1);
  await recordDraw(env, session, {sessionIndex:1, mealNumber, name:winner.name, method:'auto', probability:winner.p, forced:winner.forced}, 'upd1', '2026-11-12T00:01:00.000Z');
  const reloaded = await getActiveSession(env, 'chat1');
  assert.equal(reloaded.participants.find(p => p.name === winner.name).remaining, session.participants.find(p => p.name === winner.name).remaining);
  const log = await readSessionLog(env, reloaded.id);
  assert.equal(log.length, 1);
  assert.equal(log[0].name, winner.name);
});

test('hasProcessed/markProcessed dedupe by (chatId, updateId)', async () => {
  const env = await freshEnv();
  assert.equal(await hasProcessed(env, 'chat1', 'upd1'), false);
  await markProcessed(env, 'chat1', 'upd1');
  assert.equal(await hasProcessed(env, 'chat1', 'upd1'), true);
  await markProcessed(env, 'chat1', 'upd1'); // second call must not throw
});

test('readSessionLog only returns rows for the given session id', async () => {
  const env = await freshEnv();
  const s1 = startSession(2, ['A','B'], () => 0.1, '2026-11-12T00:00:00.000Z', 1);
  await createSession(env, 'chat1', s1);
  const d1 = drawNext(s1, () => 0.1);
  await recordDraw(env, s1, {sessionIndex:1, mealNumber:d1.mealNumber, name:d1.winner.name, method:'auto', probability:d1.winner.p, forced:d1.winner.forced}, 'u1', '2026-11-12T00:01:00.000Z');
  const sessionRow = await getActiveSession(env, 'chat1');
  assert.equal(sessionRow.sessionIndex, 1); // full cross-session isolation is exercised end-to-end in Task 9
});

test('appendFoodLog then readFoodLog returns most-recent-first, limited', async () => {
  const env = await freshEnv();
  await appendFoodLog(env, 'chat1', 'Pasta', 'u1', '2026-11-12T00:00:00.000Z');
  await appendFoodLog(env, 'chat1', 'Dal Rice', 'u2', '2026-11-12T01:00:00.000Z');
  const rows = await readFoodLog(env, 'chat1', 1);
  assert.deepEqual(rows, [{dish:'Dal Rice', loggedAt:'2026-11-12T01:00:00.000Z'}]);
});

test('addMenuItem reports added:false on a second identical add', async () => {
  const env = await freshEnv();
  assert.deepEqual(await addMenuItem(env, 'chat1', 'Pasta', '2026-11-12T00:00:00.000Z'), {added:true});
  assert.deepEqual(await addMenuItem(env, 'chat1', 'Pasta', '2026-11-12T00:01:00.000Z'), {added:false});
  assert.deepEqual(await listMenu(env, 'chat1'), ['Pasta']);
});

test('removeMenuItem reports removed:false when the dish is not on the menu', async () => {
  const env = await freshEnv();
  assert.deepEqual(await removeMenuItem(env, 'chat1', 'Pasta'), {removed:false});
  await addMenuItem(env, 'chat1', 'Pasta', '2026-11-12T00:00:00.000Z');
  assert.deepEqual(await removeMenuItem(env, 'chat1', 'Pasta'), {removed:true});
  assert.deepEqual(await listMenu(env, 'chat1'), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: the Miniflare-backed test invocation (add a `test:integration`
script to `package.json` if these need to run separately from the plain
`node --test` pure-core suite)
Expected: FAIL — `db.js` does not exist.

- [ ] **Step 3: Implement `src/db.js`**

Each function is a thin wrapper: `env.DB.prepare(sql).bind(...).run()` for
writes, `.all()`/`.first()` for reads. `createSession` and `recordDraw`
each build their statements and pass them to `env.DB.batch([...])` so the
session-row/participant-rows (or remaining-decrement/log-insert) land
together. `getActiveSession` does two queries (session row by
`chat_id`+`status='active'`, then participants by `session_id`) and
assembles the `Session` shape. `addMenuItem`/`removeMenuItem`: `SELECT 1
FROM menu_items WHERE chat_id=? AND name=?` first to get a definitive
before/after boolean, then `INSERT`/`DELETE`.

- [ ] **Step 4: Run tests to verify they pass**

Run: the integration test command
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/db.test.js package.json
git commit -m "feat: add D1 storage layer"
```

---

### Task 9: Worker entry point (webhook)

**Files:**
- Create: `src/index.js`
- Test: `test/index.test.js` (Miniflare-backed, full `fetch` handler)

**Interfaces:**
- Consumes: `handle`, `LIMITS` (Tasks 4–6), `sendMessage` (Task 7), all of
  `db.js` (Task 8).
- Produces: `export default { async fetch(request, env, ctx) }` — the
  deployed Worker's entire surface.

- [ ] **Step 1: Write failing tests**

```js
test('rejects a request with a missing or wrong secret header', async () => {
  const env = await freshEnv({AUTHORIZED_CHAT_ID:'1'});
  const res1 = await worker.fetch(makeRequest({}), env);
  assert.equal(res1.status, 200); // acknowledged but ignored, mirrors expense tracker's IGNORED pattern
  const res2 = await worker.fetch(makeRequest({headers:{'X-Telegram-Bot-Api-Secret-Token':'wrong'}}), env);
  const body = await res2.text();
  assert.match(body, /IGNORED|OK/); // never processes the update
  assert.equal(await hasProcessed(env, '1', '1'), false);
});

test('rejects an update from an unconfigured chat id', async () => {
  const env = await freshEnv({AUTHORIZED_CHAT_ID:'1'});
  await worker.fetch(validRequest({chatId: '999', text: '/draw'}), env);
  assert.equal(await getActiveSession(env, '999'), null);
});

test('duplicate update_id is processed once', async () => {
  const env = await freshEnv({AUTHORIZED_CHAT_ID:'1'});
  const req = validRequest({chatId:'1', text:'/draw', updateId:'5'});
  await worker.fetch(req.clone(), env);
  await worker.fetch(req.clone(), env);
  const session = await getActiveSession(env, '1');
  assert.equal(session.mealsLogged, 1);
});

test('a full 10-meal, 3-participant session ends exactly on quota and audit reflects only the current session', async () => {
  const env = await freshEnv({AUTHORIZED_CHAT_ID:'1'});
  await worker.fetch(validRequest({chatId:'1', text:'/setup Anshika, Partner, Guest'}), env);
  await worker.fetch(validRequest({chatId:'1', text:'/newsession 10'}), env);
  for (let i = 0; i < 10; i++) await worker.fetch(validRequest({chatId:'1', text:'/draw', updateId:String(10+i)}), env);
  const session2 = await getActiveSession(env, '1'); // auto-rolled
  assert.equal(session2.sessionIndex, 2);
  // audit reply (captured via a stubbed sendMessage) must reflect 0 rows for session 2, not session 1's 10
});

test('/ate and /food work with no setup/session ever run', async () => {
  const env = await freshEnv({AUTHORIZED_CHAT_ID:'1'});
  await worker.fetch(validRequest({chatId:'1', text:'/ate Pasta', updateId:'1'}), env);
  const rows = await readFoodLog(env, '1', 10);
  assert.equal(rows[0].dish, 'Pasta');
});

test('/menu add twice reports already-added the second time', async () => {
  const env = await freshEnv({AUTHORIZED_CHAT_ID:'1'});
  await worker.fetch(validRequest({chatId:'1', text:'/menu add Pasta', updateId:'1'}), env);
  // capture sent messages via a stubbed sendMessage
  await worker.fetch(validRequest({chatId:'1', text:'/menu add Pasta', updateId:'2'}), env);
  // assert the second call's sent text matches /already on the menu/
  assert.deepEqual(await listMenu(env, '1'), ['Pasta']); // not duplicated
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: the integration test command
Expected: FAIL — `index.js` does not exist.

- [ ] **Step 3: Implement `src/index.js`**

`fetch(request, env, ctx)`: read `X-Telegram-Bot-Api-Secret-Token` header,
compare to `env.WEBHOOK_SECRET`; parse the JSON body; extract
`update.message.chat.id`, `.text`, `update.update_id`; if the secret is
wrong, the body is malformed, or `chat.id !== env.AUTHORIZED_CHAT_ID`,
return `new Response('IGNORED')` without touching D1 (mirrors the expense
tracker's `receive`/`IGNORED` pattern, adapted). Otherwise: `if (await
hasProcessed(env, chatId, updateId)) return new Response('OK')`; load
`{roster: await getRoster(...), session: await getActiveSession(...)}`;
build `context.limits` from the `LIMITS` import; call `handle(state,
event, context)`; for each effect, in order:
- `'send'` → `sendMessage`.
- `'log'` → `recordDraw`.
- `'audit'` → `readSessionLog` then `sendMessage` with the formatted rows
  (or "No picks logged yet." if empty).
- `'food_log'` → `appendFoodLog`.
- `'food_history'` → `readFoodLog` then `sendMessage` with the formatted
  rows (or "No food logged yet." if empty).
- `'menu_list'` → `listMenu` then `sendMessage` (or "The menu is empty —
  add one with /menu add <dish>." if empty).
- `'menu_add'` → `addMenuItem` then `sendMessage` composing "Added {name}
  to the menu." or "{name} is already on the menu." from the `{added}`
  result.
- `'menu_remove'` → `removeMenuItem` then `sendMessage` composing
  "Removed {name} from the menu." or "{name} isn't on the menu." from the
  `{removed}` result.

Then persist `result.state.roster` via `saveRoster` if changed, call
`markProcessed`, and return `new Response('OK')`.

- [ ] **Step 4: Run tests to verify they pass**

Run: the integration test command
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.js test/index.test.js
git commit -m "feat: add Worker webhook entry point"
```

---

### Task 10: README and deployment

**Files:**
- Create: `README.md`

**Interfaces:** None (documentation only).

- [ ] **Step 1: Write `README.md`**

Mirror `telegram-expense-tracker/README.md`'s structure: scope (including
the food diary and menu as independent of the fairness draw), create the
bot via @BotFather, `wrangler d1 create meal_chooser` (then paste the
returned `database_id` into `wrangler.toml`), `wrangler d1 execute
meal_chooser --file=schema.sql --remote`, `wrangler secret put BOT_TOKEN`,
`wrangler secret put WEBHOOK_SECRET`, set `AUTHORIZED_CHAT_ID` in
`wrangler.toml` to the target group chat's id (obtained the same way the
expense tracker's README gets it — `getUpdates` once after messaging the
bot), `wrangler deploy`, then call `setWebhook` with
`url=<the deployed *.workers.dev URL>` and `secret_token=<WEBHOOK_SECRET>`.
List all commands. Include a smoke-test checklist: `/setup`, `/newsession
10`, ten `/draw`s, confirm the tally is exactly even per the remainder
rule, `/audit` matches; `/menu add` a few dishes, `/menu`, `/menu remove`
one, confirm it's gone; `/ate` a couple of entries and `/food` confirm
they show up, independent of whether a session is running; a message from
a different chat gets no response.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add setup and deployment guide"
```

---

## Self-Review

**Spec coverage:** Configurable participants/count → Tasks 2, 4.
Configurable session length incl. ad-hoc override → Tasks 3–4
(`/newsession [n]`). `/draw` → Task 5. `/log` manual override → Task 5.
`/audit` → Tasks 5, 8, 9. Auto-reset on completion → Tasks 3, 5, 9.
Standalone food diary (`/ate`, `/food`) → Tasks 6, 8, 9. Configurable menu
(`/menu`, `/menu add`, `/menu remove`) → Tasks 6, 8, 9. Hosting (Workers +
D1, webhook secret) → Tasks 1, 7–9. Documentation/deployment → Task 10.
All eleven functional requirements from the design doc are covered.

**Review Focus coverage:** non-divisible `n` → Task 2's remainder test.
Mid-session `/setup` isolation → Task 4's deferred-change test. Duplicate
`update_id` → Task 9's dedupe test. `/audit` post-roll isolation → Task 9's
full-session test. Missing/wrong secret header and wrong chat id → Task 9's
first two tests. Repeated `/menu add` → Task 8's `addMenuItem` test and
Task 9's end-to-end equivalent.

**Proportion check:** ten tasks, each with a bounded set of tests and one
short implementation note — proportionate to a small two-person tool, not
a transcript of the code.
