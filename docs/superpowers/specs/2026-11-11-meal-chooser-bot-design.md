# Meal Chooser Bot — Design

## Intent

The user and their partner spend real time each day negotiating who picks
the meal. A plain coin flip can drift arbitrarily far from even and feel
unfair even though it's "random." The goal is a tool that removes the
negotiation while guaranteeing — not just statistically trending toward —
an even split over a defined stretch of meals.

## Fairness scheme (decided)

Explored visually (an interactive simulator compared three approaches
against the same random draws): a plain coin flip converges toward 50%
over hundreds of meals by the law of large numbers, but that's true of
*any* scheme and doesn't prove day-to-day fairness — what matters is how
far the running pick-count gap wanders along the way. The chosen scheme
is **fixed-block / sampling without replacement**, generalized from 2 to
*k* participants:

- A session has a fixed length `n` meals and a fixed participant list.
- At session start, distribute `n` as evenly as possible:
  `quota_i = floor(n/k)`, and a uniformly random subset of size `n mod k`
  participants each get one extra (`quota_i + 1`) — the remainder isn't
  always given to the same person/people.
- `remaining_i` starts at `quota_i`.
- Each draw: `P(participant_i) = remaining_i / sum(remaining)`. Draw
  `r ~ Uniform[0,1)`; walk participants in a fixed order accumulating
  probability; the first participant whose cumulative share exceeds `r`
  wins. Decrement that participant's `remaining`.
- `forced = true` when exactly one participant has `remaining > 0` at
  draw time (the winner's probability was exactly 1) — surfaced in the
  audit log rather than hidden, same as the earlier simulator did.
- A session is complete when `sum(remaining) == 0` (`mealsLogged == n`).
  Completion immediately starts the next session with the same `n` and
  current roster — no manual step required to keep going.

For `k=2` this collapses to the original "you_left/(you_left+partner_left)"
formula from the simulator.

**`/draw` picks *who*, never *what*.** The fairness logic and the food
ideas below are deliberately independent systems — confirmed with the
user rather than assumed, since coupling them would have been a much
bigger feature. The menu is a reference list a person can browse after
being picked; it is not consulted by the draw.

## Platform (decided)

- **Telegram**, not WhatsApp: Telegram's Bot API is free and official.
  WhatsApp's free path means an unofficial library logged in as a real
  phone number (ban risk); the official path is a paid business API not
  meant for this.
- **Cloudflare Workers + D1**, not Google Apps Script and not a
  Railway/Render-hosted process. The user already runs
  `telegram-expense-tracker` on Apps Script + Sheets, which was the
  starting point, but research turned up real problems: **Railway and
  Fly.io have both dropped their free tiers** (Railway since 2023,
  Fly.io since 2024 — both now require a card); **Apps Script has
  real-world reports of going unresponsive after ~30–40 minutes idle
  specifically in group chats**, which matters here because this bot is
  deliberately shared by two people in one chat; **Render's free tier
  cold-starts after 15 minutes idle** (~1 min lag on the first message
  after a quiet spell). **Cloudflare Workers has a genuinely free,
  permanent tier (100k requests/day) that is edge-based, so it never
  sleeps and has no cold start** — the most reliable option found. D1
  (Cloudflare's SQLite-compatible managed database) replaces Sheets as
  the durable store: 5 GB storage, 5M reads/day, 100k writes/day free,
  no card required, and its relational shape fits this app's data (two
  new list-shaped features below) more naturally than spreadsheet rows.
- Telegram webhook auth uses the **`secret_token` → `X-Telegram-Bot-Api-
  Secret-Token` header** mechanism (set via `setWebhook`), not a secret in
  the URL query string — nothing sensitive ends up in logs or the webhook
  URL.
- Authorization is by `chat.id` alone (any chat type) against one
  configured `AUTHORIZED_CHAT_ID` — either person in the shared chat can
  issue any command. This differs from the expense tracker, which
  authorizes one owner's exact `user.id` + exact `chat.id` +
  `chat.type === 'private'`.
- No multi-step conversation/draft flow (unlike the expense tracker's
  amount→name→method→comments form): every command here is a single
  message, because a meal pick, a food log entry, or a menu edit is each
  one atomic action, not a form.

## Functional requirements (from the user)

1. Configurable participant names; defaults to 2 generic names, renamable.
2. Configurable *number* of participants (not fixed at 2) — the quota math
   above is already general in `k`.
3. Configurable session length `n`, defaulting to 21; a session can be
   started with a different `n` on demand (e.g. the user's first real
   session is 10 meals).
4. `/draw` — automatic fairness-weighted random pick for the next meal.
5. `/log <name>` — manual override for the next meal slot. Same bookkeeping
   as an automatic draw (decrements that participant's `remaining`, counts
   toward the session) but flagged `method = manual`. Allowed to push
   `remaining` below zero — it's a deliberate override — and reported
   honestly rather than clamped or hidden.
6. `/audit` — the current session's full meal-by-meal log (who picked).
7. A session resets automatically the instant it fills — see completion
   behavior above.
8. **`/ate <dish>`** — log what was actually eaten, as a **standalone food
   diary** independent of the fairness session: not one-to-one with a
   pick, can be logged more or fewer times than there are draws (e.g. both
   lunch and dinner on one day, or a day with no draw at all). `/food [n]`
   views the most recent entries (default 10, capped at 50).
9. **`/menu`** — a configurable list of meal ideas ("what can we eat"),
   managed entirely through bot commands: `/menu` lists it, `/menu add
   <dish>` adds an item, `/menu remove <dish>` removes one. Purely a
   reference list for a human to browse — `/draw` never reads it (see
   above).

## Commands

`/start`, `/help`, `/setup <names>`, `/newsession [n]`, `/draw`, `/log
<name>`, `/status`, `/audit`, `/config`, `/ate <dish>`, `/food [n]`,
`/menu`, `/menu add <dish>`, `/menu remove <dish>`.

## Non-goals

No automatic meal *suggestion* tied to the draw — `/draw` never reads the
menu or picks a dish, by explicit choice (see Fairness scheme above). No
multi-household support — one configured chat per deployed bot. No auth
beyond the webhook secret + configured chat id. No silent edit/undo of a
logged entry (fairness pick, food diary, or menu item) — a correction is a
new command call, visible in the relevant log/list.

## Data model

Cloudflare D1 (SQLite-compatible):

- `roster(chat_id PK, names_json, default_n)` — persists independently of
  any active session.
- `sessions(id PK, chat_id, session_index, n, started_at, status)` and
  `participants(session_id, name, quota, remaining)` — the active fairness
  session; `/audit` filters `meal_log` to the current `session_id` only.
- `meal_log(id PK, session_id, meal_number, name, method, probability,
  forced, logged_at, update_id)` — one row per logged pick (auto or
  manual), every session's rows retained.
- `food_log(id PK, chat_id, dish, logged_at, update_id)` — the standalone
  food diary; not linked to `sessions` or `meal_log` at all, by design.
- `menu_items(chat_id, name, added_at, PRIMARY KEY(chat_id, name))` — the
  configurable "what can we eat" list.
- `processed_updates(chat_id, update_id, PRIMARY KEY(chat_id, update_id))`
  — idempotency guard against Telegram webhook retries.
