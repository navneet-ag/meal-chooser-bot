# Meal Chooser Bot

A Telegram bot that fairly decides who picks the next meal using a remainder-balanced algorithm, plus a standalone food diary and a configurable meal idea menu. Runs on Cloudflare Workers with D1 as the database.

## Scope

**Core fairness feature:** `/draw` picks who decides the next meal, balancing selections so that over a session of *n* meals among *k* participants, each person gets *exactly* `floor(n/k)` or `floor(n/k) + 1` picks — not approximately; the quotas always sum to exactly *n*. The algorithm handles non-divisible *n* by distributing the remainder picks fairly (randomly, one extra pick per person until the remainder is used up). `/log` allows manual overrides.

**Food diary:** `/ate` and `/food` log what was actually eaten, independent of the draw. They are decoupled from the fairness session — `/ate` entries appear in `/food` regardless of whether a session is running or what the fairness draw says.

**Menu management:** `/menu`, `/menu add`, and `/menu remove` maintain a configurable list of meal ideas. It is independent of the draw and diary.

This v1 focuses on fairness and basic tracking. It excludes budgets, dietary restrictions, dish ratings, and historical analytics.

## Create the bot and database

### 1. Create the bot via @BotFather

Open Telegram, message **@BotFather**, run `/newbot`, and follow the prompts. Save the token securely — it grants full control of the bot.

### 2. Add the bot to the group chat and capture its chat id

`AUTHORIZED_CHAT_ID` needs to be the numeric id of the *group* chat both people will use — not a private chat with the bot — so:

1. Add the bot to that group chat.
2. Send any message in the group (from either person).
3. In a browser, call:

   ```sh
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```

4. Find that message in the response and read `message.chat.id` — it will be a negative number, since it's a group chat. You'll use this to configure `AUTHORIZED_CHAT_ID` later.

> **Note:** if the group is later upgraded to a "supergroup" (Telegram does this automatically once the group crosses a certain member count or feature threshold), the chat id changes. If that happens, repeat this step and update `AUTHORIZED_CHAT_ID` to the new id.

### 3. Create the D1 database

In the repo, run:

```sh
wrangler d1 create meal_chooser
```

Copy the returned `database_id` and paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "meal_chooser"
database_id = "<your-database-id-here>"
```

### 4. Initialize the schema

Run:

```sh
wrangler d1 execute meal_chooser --file=schema.sql --remote
```

This creates the `roster`, `sessions`, `participants`, `meal_log`, `food_log`, `menu_items`, and `processed_updates` tables.

### 5. Set secrets

```sh
wrangler secret put BOT_TOKEN
# Paste the token from @BotFather
```

```sh
wrangler secret put WEBHOOK_SECRET
# Paste a cryptographically random string of at least 32 characters. Generate one with:
# openssl rand -hex 32
```

### 6. Configure the authorized chat

Edit `wrangler.toml` and set `AUTHORIZED_CHAT_ID` to the group chat's numeric ID (obtained above from `getUpdates`):

```toml
[vars]
AUTHORIZED_CHAT_ID = "-1001234567890"
```

## Deploy the webhook

```sh
wrangler deploy
```

Note the deployed URL (looks like `https://meal-chooser-bot.YOUR_ACCOUNT.workers.dev`).

Then register the webhook with Telegram using `setWebhook`. The critical detail is the `secret_token` parameter, which must match your `WEBHOOK_SECRET` value exactly:

```sh
curl --request POST \
  'https://api.telegram.org/bot<TOKEN>/setWebhook' \
  --header 'Content-Type: application/json' \
  --data '{
    "url": "https://meal-chooser-bot.YOUR_ACCOUNT.workers.dev",
    "secret_token": "<WEBHOOK_SECRET>"
  }'
```

Verify the webhook is set:

```sh
curl --silent 'https://api.telegram.org/bot<TOKEN>/getWebhookInfo'
```

Expected output includes:
- `"url": "https://meal-chooser-bot.YOUR_ACCOUNT.workers.dev"`
- `"pending_update_count": 0`
- No `last_error_message` field (or it is absent)

## Commands

### Session and draw

| Command | Description |
|---------|-------------|
| `/setup <name1>, <name2>, ...` | Configure participants (2–10 names). Changes take effect for the next session. |
| `/newsession [n]` | Start a new fairness session with *n* meals (default: 21). *n* must be at least the number of participants (one meal per participant minimum). |
| `/draw` | Auto-pick who decides the next meal, using fair allocation. Starts a session if none is active. |
| `/log <name>` | Manually log a meal assignment for the named participant. Starts a session if none is active. |
| `/status` | Show the current session: meal count, participant quotas, and remaining picks. |
| `/audit` | Show the full log of meal picks in the current session (auto/manual, probability, assigned name). |

### Food diary

| Command | Description |
|---------|-------------|
| `/ate <dish>` | Log what was eaten (independent of the draw). Timestamps the entry. |
| `/food [n]` | Show the *n* most recent food log entries (default: 10, max: 50). |

### Menu

| Command | Description |
|---------|-------------|
| `/menu` | List all meal ideas on the menu. |
| `/menu add <dish>` | Add a dish to the menu. |
| `/menu remove <dish>` | Remove a dish from the menu. |

### Utilities

| Command | Description |
|---------|-------------|
| `/start` | Show a brief welcome message. |
| `/help` | List all commands. |
| `/config` | Show the current roster (participants, default session length) and limits. |

## Exact smoke test

1. **In a group chat where the bot is a member, start with `/start`** and verify the welcome text arrives.

2. **Configure participants:** Send `/setup Alice, Bob, Charlie` and verify confirmation.

3. **Start a session:** Send `/newsession 10` and verify *"New session started: 10 meals among Alice, Bob, Charlie."*

4. **Run 10 draws:** Send `/draw` ten times in rapid succession.
   - Each reply confirms who is picked (e.g., *"Alice is picked for meal 1/10."*).
   - After the 10th draw, verify auto-roll: *"Session complete (Alice: 3/3, Bob: 3/3, Charlie: 4/4)! Starting a new session..."* (exact tallies depend on the algorithm's remainder distribution).

5. **Verify exact tally:** Send `/audit` and confirm the output lists exactly 10 picks with no gaps and a perfect balance according to the remainder rule: with 10 meals and 3 participants, one gets 4 and two get 3 (remainder distributed fairly).

6. **Add menu items:** Send `/menu add Pizza`, `/menu add Pasta`, `/menu add Salad` and verify each is added.

7. **List menu:** Send `/menu` and verify all three dishes are listed.

8. **Remove from menu:** Send `/menu remove Pasta` and verify it's removed.

9. **Log food independently:** Send `/ate Pizza` and `/ate Pasta` (these are not tied to the draw or session).

10. **View food log:** Send `/food` and verify both recent entries appear with timestamps, independent of session state.

11. **Check config:** Send `/config` and verify participants and default session length (21).

12. **Verify authorization:** From a different Telegram group or chat, attempt to send any command to the bot. Verify the bot sends no response (silently ignored).

## Defaults

| Setting | Value |
|---------|-------|
| Default participants | Person 1, Person 2 |
| Default session length | 21 meals |
| Max participants | 10 |
| Max name length | 40 characters |
| Max dish name length | 80 characters |
| Food history default | 10 entries |
| Food history max | 50 entries |

## Reliability and authorization

- All authorized updates are deduplicated by update ID, so retries from Telegram never create duplicate entries.
- Authorization is enforced by three checks: (1) the `X-Telegram-Bot-Api-Secret-Token` header must match `WEBHOOK_SECRET`, (2) the chat ID must match `AUTHORIZED_CHAT_ID`, and (3) malformed updates (missing fields, wrong types) are silently ignored.
- Telegram credentials (`BOT_TOKEN`, `WEBHOOK_SECRET`) are stored in wrangler secrets and never logged.
- Session state auto-rolls: the instant meal count reaches *n*, a new session starts automatically with the same *n* and the current roster names.
- Mid-session roster changes (via `/setup`) defer until the next session; the running session keeps its original participants.

## Design and planning docs

- [Design doc](docs/superpowers/specs/2026-11-11-meal-chooser-bot-design.md)
- [Implementation plan](docs/superpowers/plans/2026-11-11-meal-chooser-bot.md)
