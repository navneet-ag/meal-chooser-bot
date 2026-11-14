// D1 storage layer: thin query wrappers over the schema in schema.sql.
// No business logic beyond shaping rows into/out of the Session/log shapes
// consumed by src/fairness.js and (eventually) src/commands.js.

export async function getRoster(env, chatId) {
  const row = await env.DB.prepare(
    'SELECT names_json, default_n FROM roster WHERE chat_id = ?'
  ).bind(chatId).first();
  if (!row) return null;
  return { names: JSON.parse(row.names_json), defaultN: row.default_n };
}

export async function saveRoster(env, chatId, roster) {
  await env.DB.prepare(
    `INSERT INTO roster (chat_id, names_json, default_n) VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       names_json = excluded.names_json,
       default_n = excluded.default_n`
  ).bind(chatId, JSON.stringify(roster.names), roster.defaultN).run();
}

export async function getActiveSession(env, chatId) {
  const sessionRow = await env.DB.prepare(
    `SELECT id, session_index, n, started_at FROM sessions
     WHERE chat_id = ? AND status = 'active'
     ORDER BY id DESC LIMIT 1`
  ).bind(chatId).first();
  if (!sessionRow) return null;

  // ORDER BY rowid (Ruling 2): participants must come back in the same
  // order they were inserted so the reconstructed Session matches the
  // order startSession originally produced.
  const participantsResult = await env.DB.prepare(
    'SELECT name, quota, remaining FROM participants WHERE session_id = ? ORDER BY rowid'
  ).bind(sessionRow.id).all();

  const mealsLoggedRow = await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM meal_log WHERE session_id = ?'
  ).bind(sessionRow.id).first();

  return {
    id: sessionRow.id,
    sessionIndex: sessionRow.session_index,
    n: sessionRow.n,
    startedAt: sessionRow.started_at,
    mealsLogged: mealsLoggedRow.cnt,
    participants: participantsResult.results.map(p => ({
      name: p.name,
      quota: p.quota,
      remaining: p.remaining,
    })),
  };
}

export async function createSession(env, chatId, session) {
  // `last_insert_rowid()` only reliably refers to the sessions row for the
  // FIRST subsequent insert: every table (even one with a composite
  // declared PRIMARY KEY, like `participants`) still has an implicit
  // rowid, and SQLite updates last_insert_rowid() after *every* successful
  // INSERT -- including each participant row as it's written. So with two
  // or more participants, the second (and later) `last_insert_rowid()`
  // reference resolves to the previous participant row's own rowid rather
  // than the session's id, which violates the FK on participants.session_id
  // (confirmed via direct reproduction against D1 through Miniflare).
  // The sessions insert therefore has to happen first, on its own, so we
  // have the real numeric id in hand before building the participants
  // batch.
  const sessionResult = await env.DB.prepare(
    `INSERT INTO sessions (chat_id, session_index, n, started_at, status)
     VALUES (?, ?, ?, ?, 'active')`
  ).bind(chatId, session.sessionIndex, session.n, session.startedAt).run();

  const sessionId = sessionResult.meta.last_row_id;

  await env.DB.batch(
    session.participants.map(p =>
      env.DB.prepare(
        'INSERT INTO participants (session_id, name, quota, remaining) VALUES (?, ?, ?, ?)'
      ).bind(sessionId, p.name, p.quota, p.remaining)
    )
  );

  // Ruling 1: mutate the passed-in session in place to attach the new row
  // id, matching the codebase's existing mutate-in-place convention
  // (drawNext already mutates `session` the same way).
  session.id = sessionId;
}

export async function recordDraw(env, session, entry, updateId, nowIso) {
  // Absolute write, not a relative decrement: `session.participants` already
  // carries the correct post-draw `remaining` value (computed in memory by
  // drawNext/handleLog before any persistence happens), so we persist that
  // value directly. This is what makes the write correct regardless of
  // whether createSession already persisted this exact session (and this
  // exact already-decremented value) moments earlier -- as it does on the
  // auto-start path in index.js -- or whether the session already existed
  // in D1 beforehand. A relative `remaining = remaining - 1` double-counts
  // the decrement in the former case.
  const participant = session.participants.find((p) => p.name === entry.name);
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE participants SET remaining = ? WHERE session_id = ? AND name = ?'
    ).bind(participant.remaining, session.id, entry.name),
    env.DB.prepare(
      `INSERT INTO meal_log (session_id, meal_number, name, method, probability, forced, logged_at, update_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      session.id,
      entry.mealNumber,
      entry.name,
      entry.method,
      entry.probability,
      entry.forced ? 1 : 0,
      nowIso,
      updateId,
    ),
  ]);
}

export async function readSessionLog(env, sessionId) {
  const result = await env.DB.prepare(
    `SELECT meal_number, name, method, probability, forced FROM meal_log
     WHERE session_id = ? ORDER BY meal_number`
  ).bind(sessionId).all();

  return result.results.map(r => ({
    mealNumber: r.meal_number,
    name: r.name,
    method: r.method,
    probability: r.probability,
    forced: !!r.forced,
  }));
}

export async function appendFoodLog(env, chatId, dish, updateId, nowIso) {
  await env.DB.prepare(
    'INSERT INTO food_log (chat_id, dish, logged_at, update_id) VALUES (?, ?, ?, ?)'
  ).bind(chatId, dish, nowIso, updateId).run();
}

export async function readFoodLog(env, chatId, limit) {
  const result = await env.DB.prepare(
    `SELECT dish, logged_at FROM food_log WHERE chat_id = ?
     ORDER BY logged_at DESC, id DESC LIMIT ?`
  ).bind(chatId, limit).all();

  return result.results.map(r => ({ dish: r.dish, loggedAt: r.logged_at }));
}

export async function listMenu(env, chatId) {
  const result = await env.DB.prepare(
    'SELECT name FROM menu_items WHERE chat_id = ? ORDER BY name'
  ).bind(chatId).all();
  return result.results.map(r => r.name);
}

export async function addMenuItem(env, chatId, name, nowIso) {
  // SELECT-first (per the brief): determine the before/after boolean
  // definitively, rather than relying on D1Result metadata field names.
  const existing = await env.DB.prepare(
    'SELECT 1 FROM menu_items WHERE chat_id = ? AND name = ?'
  ).bind(chatId, name).first();
  if (existing) return { added: false };

  await env.DB.prepare(
    'INSERT INTO menu_items (chat_id, name, added_at) VALUES (?, ?, ?)'
  ).bind(chatId, name, nowIso).run();
  return { added: true };
}

export async function removeMenuItem(env, chatId, name) {
  const existing = await env.DB.prepare(
    'SELECT 1 FROM menu_items WHERE chat_id = ? AND name = ?'
  ).bind(chatId, name).first();
  if (!existing) return { removed: false };

  await env.DB.prepare(
    'DELETE FROM menu_items WHERE chat_id = ? AND name = ?'
  ).bind(chatId, name).run();
  return { removed: true };
}

export async function hasProcessed(env, chatId, updateId) {
  const row = await env.DB.prepare(
    'SELECT 1 FROM processed_updates WHERE chat_id = ? AND update_id = ?'
  ).bind(chatId, updateId).first();
  return !!row;
}

export async function markProcessed(env, chatId, updateId) {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO processed_updates (chat_id, update_id) VALUES (?, ?)'
  ).bind(chatId, updateId).run();
}
