// People, identity and spaces — the Phase 3 attribution layer.
//
// Run: npx tsx scripts/test-people.ts
//
// Two halves, and both matter for different reasons:
//
//   1. **Normalisation** (pure). Every way a person's id can be written has to
//      land on one key. Get it too loose and two humans merge into one identity,
//      which leaks one person's messages into the other's memory; too strict and
//      one person becomes several and their memory splits. The tests below pin
//      both edges, especially the deliberate refusal to invent a country code.
//
//   2. **Resolution** (real SQLite). lib/people.ts decides which person owns
//      which message, using upserts, a unique index and a conditional name
//      update. That is not something to ship on a code read, so the suite builds
//      a real database from the real migrations and drives the real statements
//      against it — the same standard scripts/test-migrations.ts holds.

import { createRequire } from "node:module";
import * as sqlBundle from "fts5-sql-bundle";
import type { Database } from "sql.js";
import { SCHEMA } from "../lib/migrations.js";
import {
  APP_SPACE,
  SELF_PERSON_ID,
  authorIdFor,
  botPersonId,
  ensureBot,
  ensureSelf,
  ensureSpace,
  resolvePerson,
  type PeopleDb,
} from "../lib/people.js";
import {
  displayNameFor,
  isGroupId,
  normalizeExternalId,
  personIdFor,
  spaceIdFor,
  spaceKeyFor,
} from "../lib/people-identity.js";

const require = createRequire(import.meta.url);
const wasmPath = require.resolve("fts5-sql-bundle/dist/sql-wasm.wasm");

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  cond ? pass++ : fail++;
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) console.log(`    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  ok ? pass++ : fail++;
}

// ─── Part 1: normalisation ───────────────────────────────────────────────────

console.log("\n=== identity normalisation ===\n");

eq("a WhatsApp jid becomes an international number", normalizeExternalId("919812345678@c.us"), "+919812345678");
eq("…and so does the same number written by hand", normalizeExternalId("+91 98123 45678"), "+919812345678");
eq("…and the two are therefore one person", normalizeExternalId("919812345678@c.us"), normalizeExternalId("+91 98123 45678"));
eq("punctuation is formatting, not identity", normalizeExternalId("+1 (415) 555-0132"), "+14155550132");
eq("an en-dash separator is still punctuation", normalizeExternalId("+1–415–555–0132"), "+14155550132");
eq("other jid domains normalise the same way", normalizeExternalId("919812345678@s.whatsapp.net"), "+919812345678");

// The whole point of the module: no country codes are ever invented.
eq("a 10-digit national number stays national", normalizeExternalId("(415) 555-0132"), "4155550132");
eq("a trunk-prefixed number stays national", normalizeExternalId("09812345678"), "09812345678");
check(
  "a national number is NOT merged with an international one",
  normalizeExternalId("09812345678") !== normalizeExternalId("+919812345678"),
);
eq("a plusless 11-digit number is international", normalizeExternalId("14155550132"), "+14155550132");

eq("handles lose their @ and their case", normalizeExternalId("@Alice"), "alice");
eq("handle whitespace collapses", normalizeExternalId("  Alice   Cooper "), "alice cooper");
eq("an empty id stays empty", normalizeExternalId("   "), "");
eq("a bare jid domain yields nothing", normalizeExternalId("@c.us"), "");

check("group jids are recognised", isGroupId("120363019283746@g.us"));
check("contact jids are not groups", !isGroupId("919812345678@c.us"));
eq("a group jid keeps its opaque key", normalizeExternalId("120363019283746@g.us"), "120363019283746");
eq("a legacy group jid keeps its dash", normalizeExternalId("919812345678-1600000000@g.us"), "919812345678-1600000000");

// Normalised ids are written to person_identities and re-normalised on every
// later capture, so a second pass must be a no-op.
for (const raw of ["919812345678@c.us", "+91 98123 45678", "@Alice", "09812345678", "120363019@g.us"]) {
  const once = normalizeExternalId(raw);
  eq(`idempotent: ${raw}`, normalizeExternalId(once), once);
}

eq("person ids are readable and deterministic", personIdFor("whatsapp", "919812345678@c.us"), "person:whatsapp:+919812345678");
eq("the app space id matches what migration 006 wrote", spaceIdFor("claude", APP_SPACE), "space:claude");
eq("a dm space id carries the normalised key", spaceIdFor("whatsapp", { space_key: "919812345678@c.us", kind: "dm" }), "space:whatsapp:+919812345678");
eq("the app space key is literally 'app'", spaceKeyFor(APP_SPACE), "app");

eq("a display name is trimmed and single-spaced", displayNameFor({ external_id: "x", display_name: "  Alice   Cooper " }), "Alice Cooper");
eq("a missing name falls back to the normalised id", displayNameFor({ external_id: "919812345678@c.us" }), "+919812345678");
check("a display name is length-capped", displayNameFor({ external_id: "x", display_name: "a".repeat(200) }).length === 80);

// ─── Part 2: resolution against real SQLite ──────────────────────────────────

console.log("\n=== resolution (real SQLite) ===\n");

const ns = sqlBundle as unknown as Record<string, unknown>;
const initSqlJs = (ns.initSqlJs ??
  (ns.default as Record<string, unknown> | undefined)?.initSqlJs ??
  ns.default) as (
  cfg: { locateFile: () => string },
) => Promise<{ Database: new (data?: Uint8Array) => Database }>;

const SQL = await initSqlJs({ locateFile: () => wasmPath });

function freshDb(): Database {
  const db = new SQL.Database();
  // Foreign keys ON, so a person_identities row pointing at a person who was
  // never inserted is an error here rather than a mystery later.
  db.run("PRAGMA foreign_keys = ON");
  for (const [, sql] of SCHEMA) db.run(sql);
  return db;
}

/** The PeopleDb lib/people.ts expects, backed by a real database. */
function adapt(db: Database): PeopleDb {
  return {
    get<T>(sql: string, params?: unknown[]): T | undefined {
      const stmt = db.prepare(sql);
      try {
        if (params) stmt.bind(params as never);
        if (!stmt.step()) return undefined;
        return stmt.getAsObject() as T;
      } finally {
        stmt.free();
      }
    },
    run(sql: string, params?: unknown[]): void {
      const stmt = db.prepare(sql);
      try {
        if (params) stmt.run(params as never);
        else stmt.run();
      } finally {
        stmt.free();
      }
    },
  };
}

function all<T = Record<string, unknown>>(db: Database, sql: string): T[] {
  const out: T[] = [];
  const stmt = db.prepare(sql);
  while (stmt.step()) out.push(stmt.getAsObject() as T);
  stmt.free();
  return out;
}

function count(db: Database, table: string, where = "1"): number {
  return all<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)[0].n;
}

const NOW = "2026-08-01T10:00:00.000Z";

// Migration 006 inserts `person:self` into every database, so a "fresh" one is
// never empty. Counting humans means counting everyone who is not the user and
// not a bot.
const CONTACTS = "is_self = 0 AND id NOT LIKE 'person:bot:%'";

function nameOf(db: Database, personId: string): string | null {
  const row = all<{ display_name: string | null }>(
    db,
    `SELECT display_name FROM people WHERE id = '${personId}'`,
  )[0];
  return row ? row.display_name : null;
}

// — first sight of a person —
{
  const db = freshDb();
  const pdb = adapt(db);

  const id = resolvePerson(pdb, "whatsapp", { external_id: "919812345678@c.us", display_name: "Alice" }, NOW);
  eq("a new person gets a deterministic id", id, "person:whatsapp:+919812345678");
  eq("…one contact row", count(db, "people", CONTACTS), 1);
  eq("…and one identity row", count(db, "person_identities"), 1);
  eq("…named", nameOf(db, id!), "Alice");
  eq(
    "the identity is keyed on the normalised id",
    all<{ external_id: string }>(db, "SELECT external_id FROM person_identities")[0].external_id,
    "+919812345678",
  );

  // Same human, written the way a contact card would write it.
  const again = resolvePerson(pdb, "whatsapp", { external_id: "+91 98123 45678" }, NOW);
  eq("the same person written differently resolves to the same row", again, id);
  eq("…without creating a second person", count(db, "people", CONTACTS), 1);

  // A different person entirely.
  resolvePerson(pdb, "whatsapp", { external_id: "919999999999@c.us", display_name: "Bob" }, NOW);
  eq("a different number is a different person", count(db, "people", CONTACTS), 2);

  db.close();
}

// — naming a contact we first met as a number —
{
  const db = freshDb();
  const pdb = adapt(db);

  const id = resolvePerson(pdb, "whatsapp", { external_id: "919812345678@c.us" }, NOW)!;
  eq("an unsaved contact is stored under their number", nameOf(db, id), "+919812345678");

  resolvePerson(pdb, "whatsapp", { external_id: "919812345678@c.us", display_name: "Alice" }, NOW);
  eq("a real name later upgrades it", nameOf(db, id), "Alice");

  resolvePerson(pdb, "whatsapp", { external_id: "919812345678@c.us", display_name: "A" }, NOW);
  eq("…but a later name does not overwrite it", nameOf(db, id), "Alice");
  eq(
    "the identity row is named too",
    all<{ display_name: string }>(db, "SELECT display_name FROM person_identities")[0].display_name,
    "Alice",
  );

  db.close();
}

// — the user themselves —
{
  const db = freshDb();
  const pdb = adapt(db);

  const self = resolvePerson(pdb, "whatsapp", { external_id: "919800000000@c.us", is_self: true }, NOW);
  eq("an is_self author resolves to the shared self person", self, SELF_PERSON_ID);
  eq("…not to a new one", count(db, "people", CONTACTS), 0);
  eq("…and self stays flagged", count(db, "people", "is_self = 1"), 1);

  // The payoff: in a group only some rows carry a "from me" marker, and the
  // identity recorded above is what resolves the rest.
  const later = resolvePerson(pdb, "whatsapp", { external_id: "+91 98000 00000", display_name: "Me" }, NOW);
  eq("a later turn from the user's own number is still the user", later, SELF_PERSON_ID);
  eq("…and 'You' is not overwritten by a rendered name", nameOf(db, SELF_PERSON_ID), "You");

  // Self is shared across sources, so the same person on a second source is
  // still one row.
  resolvePerson(pdb, "telegram", { external_id: "@me", is_self: true }, NOW);
  eq("self is one row across sources", count(db, "people", "is_self = 1"), 1);
  eq("…with an identity per source", count(db, "person_identities", `person_id = '${SELF_PERSON_ID}'`), 2);

  db.close();
}

// — authors with nothing usable —
{
  const db = freshDb();
  const pdb = adapt(db);

  eq("an empty external id resolves to nobody", resolvePerson(pdb, "whatsapp", { external_id: "  " }, NOW), null);
  eq("…and creates no bucket person for it", count(db, "people", CONTACTS), 0);
  eq("…and no identity row", count(db, "person_identities"), 0);

  eq(
    "an unusable author falls back to the role mapping",
    authorIdFor(pdb, "whatsapp", "user", { external_id: "" }, NOW),
    SELF_PERSON_ID,
  );

  db.close();
}

// — the AI mapping is untouched —
{
  const db = freshDb();
  const pdb = adapt(db);

  eq("a user turn is the user", authorIdFor(pdb, "claude", "user", undefined, NOW), SELF_PERSON_ID);
  eq("an assistant turn is that source's bot", authorIdFor(pdb, "claude", "assistant", undefined, NOW), botPersonId("claude"));
  eq("a system turn is nobody", authorIdFor(pdb, "claude", "system", undefined, NOW), null);
  eq("a tool turn is nobody", authorIdFor(pdb, "claude", "tool", undefined, NOW), null);
  eq("bots are one per source", count(db, "people", "id LIKE 'person:bot:%'"), 1);

  authorIdFor(pdb, "chatgpt", "assistant", undefined, NOW);
  eq("…and a second source adds a second bot", count(db, "people", "id LIKE 'person:bot:%'"), 2);
  eq("bots are not self", count(db, "people", "is_self = 1"), 1);

  // Re-running the whole fixed mapping must not duplicate anything.
  ensureSelf(pdb, NOW);
  ensureBot(pdb, "claude", NOW);
  ensureBot(pdb, "claude", NOW);
  eq("the fixed rows are idempotent", count(db, "people"), 3);
  eq("…identities too", count(db, "person_identities"), 2);

  db.close();
}

// — spaces —
{
  const db = freshDb();
  const pdb = adapt(db);

  const app = ensureSpace(pdb, "claude", APP_SPACE, NOW);
  eq("an AI source gets one app space", app, "space:claude");
  eq("…labelled with the source", all<{ label: string }>(db, "SELECT label FROM spaces")[0].label, "claude");

  const dm = ensureSpace(pdb, "whatsapp", { space_key: "919812345678@c.us", kind: "dm", label: "Alice" }, NOW);
  eq("a dm becomes its own space", dm, "space:whatsapp:+919812345678");
  const group = ensureSpace(pdb, "whatsapp", { space_key: "120363019@g.us", kind: "group", label: "Trip" }, NOW);
  eq("a group becomes its own space", group, "space:whatsapp:120363019");
  eq("…recorded as a group", count(db, "spaces", "kind = 'group'"), 1);
  eq("three spaces so far", count(db, "spaces"), 3);

  // Re-capture: the same chat must land in the same space, and a re-render that
  // loses the header must not erase the name.
  const later = "2026-08-02T09:00:00.000Z";
  const dmAgain = ensureSpace(pdb, "whatsapp", { space_key: "+91 98123 45678", kind: "dm" }, later);
  eq("the same chat resolves to the same space", dmAgain, dm);
  eq("…and does not multiply", count(db, "spaces"), 3);
  const row = all<{ label: string; last_active_at: string }>(
    db,
    `SELECT label, last_active_at FROM spaces WHERE id = '${dm}'`,
  )[0];
  eq("a missing label does not erase the stored one", row.label, "Alice");
  eq("activity moves forward", row.last_active_at, later);

  // A space that already exists under some other id keeps it: (source,
  // space_key) is the identity, the id is only its handle.
  pdb.run(
    `INSERT INTO spaces (id, source, space_key, label, kind, created_at, last_active_at)
     VALUES ('legacy-space-1', 'whatsapp', '+919777777777', 'Carol', 'dm', ?, ?)`,
    [NOW, NOW],
  );
  eq(
    "an existing space keeps its own id",
    ensureSpace(pdb, "whatsapp", { space_key: "919777777777@c.us", kind: "dm" }, later),
    "legacy-space-1",
  );
  eq("…and is not duplicated", count(db, "spaces", "space_key = '+919777777777'"), 1);

  db.close();
}

console.log(`\nAssertions: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
