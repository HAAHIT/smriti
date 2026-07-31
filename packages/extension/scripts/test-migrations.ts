// Migration tests — runs the REAL migration SQL against a real in-memory
// SQLite (fts5-sql-bundle, the same engine the extension uses).
//
// Run: npx tsx scripts/test-migrations.ts
//
// Migration 006 rewrites existing user data — every message's `position`, plus
// `author_id`, plus a defensive null-out of duplicate `platform_msg_id`s. That
// is not something to ship on a code read, so this suite builds a database in
// the pre-006 shape, populates it with the exact pathologies the migration is
// meant to fix, applies 006, and asserts the outcome.

import { createRequire } from "node:module";
// CJS interop: under tsx the namespace object is what lands here, so reach for
// the callable default rather than the namespace itself.
import * as sqlBundle from "fts5-sql-bundle";
import type { Database } from "sql.js";
import { SCHEMA } from "../lib/migrations.js";

// The package only exports the wasm itself, not its package.json, so resolve
// that subpath directly. createRequire().resolve returns a filesystem path.
const require = createRequire(import.meta.url);
const wasmPath = require.resolve("fts5-sql-bundle/dist/sql-wasm.wasm");

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  cond ? pass++ : fail++;
}

// CJS/ESM interop varies by loader: the named export is the reliable one here,
// with the default (and the double-wrapped default) as fallbacks.
const ns = sqlBundle as unknown as Record<string, unknown>;
const initSqlJs = (ns.initSqlJs ??
  (ns.default as Record<string, unknown> | undefined)?.initSqlJs ??
  ns.default) as (
  cfg: { locateFile: () => string },
) => Promise<{ Database: new (data?: Uint8Array) => Database }>;

const SQL = await initSqlJs({ locateFile: () => wasmPath });

/** Apply migrations up to (and including) `throughId`, mirroring db.ts. */
function applyThrough(db: Database, throughId: string): void {
  for (const [id, sql] of SCHEMA) {
    db.run(sql);
    if (id === throughId) return;
  }
}

function all<T = Record<string, unknown>>(db: Database, sql: string): T[] {
  const out: T[] = [];
  const stmt = db.prepare(sql);
  while (stmt.step()) out.push(stmt.getAsObject() as T);
  stmt.free();
  return out;
}

function one<T = Record<string, unknown>>(db: Database, sql: string): T | null {
  return all<T>(db, sql)[0] ?? null;
}

function freshPre006(): Database {
  const db = new SQL.Database();
  db.run("PRAGMA foreign_keys = ON");
  applyThrough(db, "005_vault.sql");
  return db;
}

function apply006(db: Database): void {
  const entry = SCHEMA.find(([id]) => id === "006_sources.sql");
  if (!entry) throw new Error("006_sources.sql missing from SCHEMA");
  db.run(entry[1]);
}

// ─── Fixture ─────────────────────────────────────────────────────────────────
//
// One conversation whose messages carry the old `position` semantics: a mix of
// backfilled rows (position = Date.parse(created_at), ~1.7e12) and live-captured
// rows (position = Date.now(), also ~1.7e12 but from a different clock). They
// are deliberately inserted out of order.

function seed(db: Database): void {
  db.run(`
    INSERT INTO conversations (id, platform, platform_conv_id, title, url, started_at, last_message_at, ingested_at)
    VALUES
      ('c1', 'claude',  'cc1', 'First',  'u1', '2026-01-01T00:00:00Z', '2026-01-01T03:00:00Z', '2026-01-01T00:00:00Z'),
      ('c2', 'chatgpt', 'gg1', 'Second', 'u2', '2026-02-01T00:00:00Z', '2026-02-01T01:00:00Z', '2026-02-01T00:00:00Z');
  `);

  const rows: Array<[string, string, string, string, number, string, string | null]> = [
    // id,   conv, role,        text,        position,      created_at,             platform_msg_id
    ["m3", "c1", "assistant", "third",     1767236400000, "2026-01-01T03:00:00Z", "x3"],
    ["m1", "c1", "user",      "first",     1767225600000, "2026-01-01T00:00:00Z", "x1"],
    ["m2", "c1", "assistant", "second",    1767229200000, "2026-01-01T01:00:00Z", "x2"],
    ["n1", "c2", "user",      "hello",     1769904000000, "2026-02-01T00:00:00Z", null],
    ["n2", "c2", "assistant", "hi",        1769907600000, "2026-02-01T01:00:00Z", null],
  ];
  for (const [id, conv, role, text, position, createdAt, msgId] of rows) {
    db.run(
      `INSERT INTO messages (id, conversation_id, platform_msg_id, role, content_text, created_at, position, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, conv, msgId, role, text, createdAt, position, `h-${id}`],
    );
  }
}

// ─── 1. Dense position rewrite ───────────────────────────────────────────────

console.log("\n=== 006: dense position ===\n");
{
  const db = freshPre006();
  seed(db);
  apply006(db);

  const c1 = all<{ id: string; position: number }>(
    db,
    "SELECT id, position FROM messages WHERE conversation_id='c1' ORDER BY position",
  );
  check(
    "c1 positions are dense 0..n-1",
    JSON.stringify(c1.map((r) => r.position)) === "[0,1,2]",
  );
  check(
    "c1 ordering preserved (first, second, third)",
    JSON.stringify(c1.map((r) => r.id)) === '["m1","m2","m3"]',
  );

  const c2 = all<{ id: string; position: number }>(
    db,
    "SELECT id, position FROM messages WHERE conversation_id='c2' ORDER BY position",
  );
  check(
    "position restarts per conversation, not globally",
    JSON.stringify(c2.map((r) => r.position)) === "[0,1]",
  );
  db.close();
}

// ─── 2. People and spaces backfill ───────────────────────────────────────────

console.log("\n=== 006: people and spaces ===\n");
{
  const db = freshPre006();
  seed(db);
  apply006(db);

  check(
    "exactly one self person",
    one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM people WHERE is_self=1")?.n === 1,
  );
  check(
    "one bot person per platform present",
    one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM people WHERE is_self=0")?.n === 2,
  );
  check(
    "one app space per platform",
    one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM spaces WHERE kind='app'")?.n === 2,
  );
  check(
    "every conversation has a space",
    one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM conversations WHERE space_id IS NULL")?.n === 0,
  );
  check(
    "conversation space points at its own platform",
    one<{ space_id: string }>(db, "SELECT space_id FROM conversations WHERE id='c1'")?.space_id ===
      "space:claude",
  );
  check(
    "user turns authored by self",
    one<{ author_id: string }>(db, "SELECT author_id FROM messages WHERE id='m1'")?.author_id ===
      "person:self",
  );
  check(
    "assistant turns authored by the source's bot",
    one<{ author_id: string }>(db, "SELECT author_id FROM messages WHERE id='m2'")?.author_id ===
      "person:bot:claude",
  );
  check(
    "bot identity registered in person_identities",
    one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM person_identities")?.n === 2,
  );
  db.close();
}

// ─── 3. The partial unique index on platform_msg_id ──────────────────────────

console.log("\n=== 006: platform_msg_id identity ===\n");
{
  const db = freshPre006();
  seed(db);
  apply006(db);

  // Two NULL platform_msg_id rows already coexist in c2 — a partial unique
  // index must not treat NULLs as equal.
  check(
    "NULL platform_msg_ids are exempt from the unique index",
    one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM messages WHERE platform_msg_id IS NULL")?.n === 2,
  );

  let rejected = false;
  try {
    db.run(
      `INSERT INTO messages (id, conversation_id, platform_msg_id, role, content_text, created_at, position, content_hash)
       VALUES ('dup', 'c1', 'x1', 'user', 'different text', '2026-01-01T04:00:00Z', 9, 'h-dup')`,
    );
  } catch {
    rejected = true;
  }
  check("re-inserting an existing platform_msg_id in the same conversation is rejected", rejected);

  // The same external id in a DIFFERENT conversation is legitimate.
  let acceptedOther = true;
  try {
    db.run(
      `INSERT INTO messages (id, conversation_id, platform_msg_id, role, content_text, created_at, position, content_hash)
       VALUES ('ok', 'c2', 'x1', 'user', 'other conv', '2026-02-01T04:00:00Z', 9, 'h-ok')`,
    );
  } catch {
    acceptedOther = false;
  }
  check("the same external id in another conversation is allowed", acceptedOther);
  db.close();
}

// ─── 4. Pre-existing duplicate platform_msg_ids must not brick the migration ──

console.log("\n=== 006: survives duplicate external ids ===\n");
{
  const db = freshPre006();
  seed(db);
  // Sneak in a duplicate of x1 within c1 — possible before the index existed.
  db.run(
    `INSERT INTO messages (id, conversation_id, platform_msg_id, role, content_text, created_at, position, content_hash)
     VALUES ('m1dup', 'c1', 'x1', 'user', 'first again', '2026-01-01T00:30:00Z', 1767227400000, 'h-m1dup')`,
  );

  let threw = false;
  try {
    apply006(db);
  } catch {
    threw = true;
  }
  check("migration completes despite a pre-existing duplicate external id", !threw);
  check(
    "the earliest row keeps the id, the later one is nulled",
    one<{ platform_msg_id: string | null }>(db, "SELECT platform_msg_id FROM messages WHERE id='m1'")
      ?.platform_msg_id === "x1" &&
      one<{ platform_msg_id: string | null }>(
        db,
        "SELECT platform_msg_id FROM messages WHERE id='m1dup'",
      )?.platform_msg_id === null,
  );
  check(
    "no message rows were lost",
    one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM messages")?.n === 6,
  );
  db.close();
}

// ─── 5. FTS survives the trigger swap ────────────────────────────────────────

console.log("\n=== 006: FTS integrity across the trigger swap ===\n");
{
  const db = freshPre006();
  seed(db);
  apply006(db);

  check(
    "pre-existing rows still findable after the position rewrite",
    one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'second'")
      ?.n === 1,
  );

  // Inserts still index (messages_ai untouched).
  db.run(
    `INSERT INTO messages (id, conversation_id, role, content_text, created_at, position, content_hash)
     VALUES ('m4', 'c1', 'user', 'zebra', '2026-01-01T05:00:00Z', 3, 'h-m4')`,
  );
  check(
    "new inserts are still indexed",
    one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'zebra'")
      ?.n === 1,
  );

  // The rebuilt trigger is scoped to the indexed columns — editing text must
  // still reindex.
  db.run("UPDATE messages SET content_text='giraffe' WHERE id='m4'");
  check(
    "editing content_text reindexes (old term gone)",
    one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'zebra'")
      ?.n === 0,
  );
  check(
    "editing content_text reindexes (new term present)",
    one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'giraffe'")
      ?.n === 1,
  );

  // ...and a position-only update must NOT disturb the index.
  db.run("UPDATE messages SET position = 99 WHERE id='m4'");
  check(
    "a position-only update leaves the index intact",
    one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'giraffe'")
      ?.n === 1,
  );
  db.close();
}

// ─── 6. Full chain from empty, and idempotency ───────────────────────────────

console.log("\n=== full migration chain ===\n");
{
  const db = new SQL.Database();
  db.run("PRAGMA foreign_keys = ON");
  let threw = false;
  try {
    for (const [, sql] of SCHEMA) db.run(sql);
  } catch (e) {
    threw = true;
    console.log("   ", String(e));
  }
  check("every migration applies to an empty database", !threw);
  check(
    "a fresh install has no people or spaces to backfill",
    one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM people")?.n === 1, // just self
  );

  const tables = all<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  ).map((r) => r.name);
  for (const t of ["spaces", "people", "person_identities"]) {
    check(`table ${t} exists`, tables.includes(t));
  }
  db.close();
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\nAssertions: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
