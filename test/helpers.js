import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, '..', 'schema.sql');
const schemaSql = readFileSync(schemaPath, 'utf8');

// D1's db.exec() splits its input on newlines rather than statement
// boundaries, which breaks our multi-line CREATE TABLE statements. Split on
// ';' ourselves and run each statement individually instead.
const schemaStatements = schemaSql
  .split(';')
  .map(s => s.trim())
  .filter(Boolean);

/**
 * Creates a fresh Miniflare instance with an in-memory D1 binding and the
 * project schema applied. Returns an `env`-shaped object exposing `DB`,
 * matching what a Cloudflare Worker receives at runtime.
 *
 * Pass the test's `t` (TestContext) so the Miniflare instance (and its
 * underlying workerd process) is disposed via `t.after()` once the test
 * finishes -- without this, instances pile up across tests and the test
 * runner process never exits.
 */
export async function freshEnv(t, extraBindings = {}) {
  const mf = new Miniflare({
    modules: true,
    script: `export default { async fetch() { return new Response('ok'); } }`,
    d1Databases: { DB: 'test-db' },
  });
  t.after(() => mf.dispose());

  const DB = await mf.getD1Database('DB');
  for (const stmt of schemaStatements) {
    await DB.prepare(stmt).run();
  }

  return { DB, ...extraBindings };
}
