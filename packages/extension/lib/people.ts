// People and spaces — resolving "who said this" and "where" to real rows.
//
// Migration 006 created `people`, `person_identities` and `spaces` and
// backfilled the AI-shaped archive into them: one bot person per source, one
// app space per source, every user turn owned by `person:self`. That mapping is
// fixed and needs no lookups. A human source is the opposite — the participant
// changes per message, the same person recurs across threads and sources, and
// the thread itself belongs to a DM or a group rather than to "all of WhatsApp".
// This module is the resolution step that difference requires.
//
// `person_identities` is the indirection that makes cross-source identity work:
// resolution always goes (source, external_id) → person_id, so merging two
// identities later is a repoint of that row, not a rewrite of every message.
//
// ─── Why the DB is injected ─────────────────────────────────────────────────
// The SQL below decides which human owns which message. Getting it wrong is a
// silent, compounding corruption of the archive, so it is tested against real
// SQLite rather than read (`npm run test:people`). Importing `lib/db.ts` would
// drag OPFS and the browser in; taking a two-method interface instead lets the
// test drive the very same statements against a real database.

import type { CaptureAuthor, CaptureSpace, Role, SourceId } from "@smriti/shared";
import {
  APP_SPACE,
  SELF_PERSON_ID,
  botPersonId,
  displayNameFor,
  isSelf,
  normalizeExternalId,
  personIdFor,
  spaceIdFor,
  spaceKeyFor,
} from "./people-identity.js";

export { APP_SPACE, SELF_PERSON_ID, botPersonId } from "./people-identity.js";

/** Bind values these statements use. A subset of sql.js's own `BindParams`. */
export type PeopleParams = (string | number | null)[];

/** The slice of lib/db.ts this module needs. See the header for why. */
export interface PeopleDb {
  get<T>(sql: string, params?: PeopleParams): T | null | undefined;
  run(sql: string, params?: PeopleParams): void;
}

// ─── People ──────────────────────────────────────────────────────────────────

/** The user. One row, shared by every source; created by 006 for existing data. */
export function ensureSelf(db: PeopleDb, now: string): string {
  db.run(
    `INSERT INTO people (id, display_name, is_self, created_at)
     VALUES (?, 'You', 1, ?)
     ON CONFLICT(id) DO NOTHING`,
    [SELF_PERSON_ID, now],
  );
  return SELF_PERSON_ID;
}

/** An AI source's assistant, as a person. */
export function ensureBot(db: PeopleDb, source: SourceId, now: string): string {
  const id = botPersonId(source);
  db.run(
    `INSERT INTO people (id, display_name, is_self, created_at)
     VALUES (?, ?, 0, ?)
     ON CONFLICT(id) DO NOTHING`,
    [id, source, now],
  );
  db.run(
    `INSERT INTO person_identities (person_id, source, external_id, display_name)
     VALUES (?, ?, 'assistant', ?)
     ON CONFLICT(source, external_id) DO NOTHING`,
    [id, source, source],
  );
  return id;
}

/**
 * Resolve a captured author to a person id, creating the person on first sight.
 *
 * Returns null for an author with no usable external id — better an unattributed
 * message than a bucket person that every unidentified turn falls into.
 */
export function resolvePerson(
  db: PeopleDb,
  source: SourceId,
  author: CaptureAuthor,
  now: string,
): string | null {
  const externalId = normalizeExternalId(author.external_id);
  if (!externalId) return null;

  // The user's own turns resolve to the shared self person, and the mapping is
  // recorded: in a group thread only some turns carry a "from me" signal, and
  // the identity row is what lets the rest resolve to self anyway.
  if (isSelf(author)) {
    ensureSelf(db, now);
    db.run(
      `INSERT INTO person_identities (person_id, source, external_id, display_name)
       VALUES (?, ?, ?, 'You')
       ON CONFLICT(source, external_id) DO UPDATE SET person_id = excluded.person_id`,
      [SELF_PERSON_ID, source, externalId],
    );
    return SELF_PERSON_ID;
  }

  const hit = db.get<{ person_id: string }>(
    "SELECT person_id FROM person_identities WHERE source = ? AND external_id = ?",
    [source, externalId],
  );
  if (hit) {
    maybeNameThem(db, source, hit.person_id, author, externalId);
    return hit.person_id;
  }

  const id = personIdFor(source, externalId);
  const name = displayNameFor(author);
  db.run(
    `INSERT INTO people (id, display_name, is_self, created_at)
     VALUES (?, ?, 0, ?)
     ON CONFLICT(id) DO NOTHING`,
    [id, name, now],
  );
  db.run(
    `INSERT INTO person_identities (person_id, source, external_id, display_name)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(source, external_id) DO NOTHING`,
    [id, source, externalId, name],
  );
  return id;
}

/**
 * Fill in a display name we didn't have before.
 *
 * A contact is often first seen as a bare number (an unsaved sender, or a group
 * turn rendered without a name) and named later. Upgrading is worth doing;
 * *overwriting* a real name with a worse one is not, so this only writes when
 * the stored name is missing or is the number itself.
 */
function maybeNameThem(
  db: PeopleDb,
  source: SourceId,
  personId: string,
  author: CaptureAuthor,
  externalId: string,
): void {
  const name = displayNameFor(author);
  if (!name || name === externalId) return;
  db.run(
    `UPDATE people SET display_name = ?
     WHERE id = ? AND is_self = 0
       AND (display_name IS NULL OR display_name = '' OR display_name = ?)`,
    [name, personId, externalId],
  );
  db.run(
    `UPDATE person_identities SET display_name = ?
     WHERE source = ? AND external_id = ?
       AND (display_name IS NULL OR display_name = '' OR display_name = ?)`,
    [name, source, externalId, externalId],
  );
}

/**
 * Which person owns this turn.
 *
 * The AI mapping (role → self / that source's bot) stays exactly as 006 wrote
 * it, so nothing about the existing archive changes. `author` only overrides it
 * when a connector actually supplied one.
 */
export function authorIdFor(
  db: PeopleDb,
  source: SourceId,
  role: Role,
  author: CaptureAuthor | undefined,
  now: string,
): string | null {
  if (author) {
    const resolved = resolvePerson(db, source, author, now);
    if (resolved) return resolved;
  }
  if (role === "user") return ensureSelf(db, now);
  if (role === "assistant") return ensureBot(db, source, now);
  return null; // system / tool turns are not people
}

// ─── Spaces ──────────────────────────────────────────────────────────────────

/**
 * Resolve a space to its row id, creating or refreshing it.
 *
 * Returns the id **as stored**, not the one computed here: an app space
 * backfilled by 006 already has an id, and a source could in principle have had
 * one written under a different scheme. `(source, space_key)` is the identity;
 * the id is just its handle.
 */
export function ensureSpace(
  db: PeopleDb,
  source: SourceId,
  space: CaptureSpace,
  now: string,
): string {
  const key = spaceKeyFor(space);
  if (!key) return ensureSpace(db, source, APP_SPACE, now);

  db.run(
    `INSERT INTO spaces (id, source, space_key, label, kind, created_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, space_key) DO UPDATE SET
       last_active_at = excluded.last_active_at,
       label          = COALESCE(excluded.label, spaces.label)`,
    [
      spaceIdFor(source, space),
      source,
      key,
      space.label ?? (space.kind === "app" ? source : null),
      space.kind,
      now,
      now,
    ],
  );

  const row = db.get<{ id: string }>(
    "SELECT id FROM spaces WHERE source = ? AND space_key = ?",
    [source, key],
  );
  return row?.id ?? spaceIdFor(source, space);
}

/** The app-level space for an AI source — the pre-Phase-3 behaviour. */
export function ensureAppSpace(db: PeopleDb, source: SourceId, now: string): string {
  return ensureSpace(db, source, APP_SPACE, now);
}
