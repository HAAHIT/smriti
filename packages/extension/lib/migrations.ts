// SQL migrations as an ordered list of [id, sql] tuples.
// Identical schema to the helper — just inlined as strings.

export const SCHEMA: [string, string][] = [
  [
    "001_init.sql",
    `
CREATE TABLE conversations (
  id               TEXT PRIMARY KEY,
  platform         TEXT NOT NULL,
  platform_conv_id TEXT NOT NULL,
  title            TEXT,
  model            TEXT,
  url              TEXT,
  started_at       TEXT NOT NULL,
  last_message_at  TEXT NOT NULL,
  archived         INTEGER DEFAULT 0,
  ingested_at      TEXT NOT NULL,
  UNIQUE (platform, platform_conv_id)
);

CREATE INDEX idx_conv_last     ON conversations(last_message_at DESC);
CREATE INDEX idx_conv_platform ON conversations(platform);

CREATE TABLE messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  platform_msg_id  TEXT,
  role             TEXT NOT NULL,
  content_text     TEXT NOT NULL,
  content_html     TEXT,
  model            TEXT,
  created_at       TEXT NOT NULL,
  position         INTEGER NOT NULL,
  token_count      INTEGER,
  content_hash     TEXT NOT NULL,
  UNIQUE (conversation_id, content_hash)
);

CREATE INDEX idx_msg_conv     ON messages(conversation_id, position);
CREATE INDEX idx_msg_position ON messages(conversation_id, position, created_at);
CREATE INDEX idx_msg_created  ON messages(created_at DESC);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  content_text,
  role UNINDEXED,
  conversation_id UNINDEXED,
  content='messages',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content_text, role, conversation_id)
  VALUES (new.rowid, new.content_text, new.role, new.conversation_id);
END;

CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content_text, role, conversation_id)
  VALUES ('delete', old.rowid, old.content_text, old.role, old.conversation_id);
END;

CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content_text, role, conversation_id)
  VALUES ('delete', old.rowid, old.content_text, old.role, old.conversation_id);
  INSERT INTO messages_fts(rowid, content_text, role, conversation_id)
  VALUES (new.rowid, new.content_text, new.role, new.conversation_id);
END;

CREATE TABLE tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE conversation_tags (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tag_id          INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, tag_id)
);

CREATE TABLE notes (
  id              INTEGER PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      TEXT REFERENCES messages(id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  CHECK ((conversation_id IS NULL) <> (message_id IS NULL))
);

CREATE TABLE capture_state (
  platform        TEXT PRIMARY KEY,
  enabled         INTEGER NOT NULL DEFAULT 1,
  adapter_version TEXT,
  last_seen_at    TEXT,
  health          TEXT DEFAULT 'green'
);

CREATE TABLE backfill_state (
  platform        TEXT PRIMARY KEY,
  status          TEXT NOT NULL,
  total_known     INTEGER,
  total_fetched   INTEGER DEFAULT 0,
  cursor          TEXT,
  resume_after    TEXT,
  started_at      TEXT,
  updated_at      TEXT,
  completed_at    TEXT,
  error_message   TEXT,
  requests_today  INTEGER DEFAULT 0,
  daily_cap       INTEGER DEFAULT 5000,
  daily_window_started_at TEXT
);

CREATE TABLE daily_stats (
  date            TEXT NOT NULL,
  platform        TEXT NOT NULL,
  conversations_count INTEGER DEFAULT 0,
  messages_count  INTEGER DEFAULT 0,
  user_messages_count INTEGER DEFAULT 0,
  estimated_minutes   INTEGER DEFAULT 0,
  PRIMARY KEY (date, platform)
);

CREATE INDEX idx_daily_stats_date ON daily_stats(date DESC);

CREATE TABLE ingest_state (
  source_key   TEXT PRIMARY KEY,
  last_offset  INTEGER DEFAULT 0,
  last_mtime   TEXT,
  updated_at   TEXT NOT NULL
);
`,
  ],
  [
    "002_embeddings.sql",
    `
CREATE TABLE message_embeddings (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  dims       INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_embed_model ON message_embeddings(model);
`,
  ],
  [
    "003_memory.sql",
    `
-- The memory layer: atomic, durable facts distilled from the user's own
-- conversations. This is what makes every AI tool "remember" the user.
CREATE TABLE memories (
  id                     TEXT PRIMARY KEY,
  kind                   TEXT NOT NULL,            -- identity|preference|project|decision|fact
  text                   TEXT NOT NULL,
  norm_text              TEXT NOT NULL,            -- normalized for dedup
  source                 TEXT NOT NULL DEFAULT 'auto', -- auto|manual
  source_platform        TEXT,
  source_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id      TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  last_used_at           TEXT,
  use_count              INTEGER NOT NULL DEFAULT 0,
  pinned                 INTEGER NOT NULL DEFAULT 0,
  salience               REAL NOT NULL DEFAULT 0.5,
  status                 TEXT NOT NULL DEFAULT 'active',
  UNIQUE (norm_text)
);

CREATE INDEX idx_mem_kind    ON memories(kind);
CREATE INDEX idx_mem_status  ON memories(status, pinned, last_used_at DESC);
CREATE INDEX idx_mem_created ON memories(created_at DESC);

-- Embeddings for semantic recall, mirroring message_embeddings.
CREATE TABLE memory_embeddings (
  memory_id  TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  dims       INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_mem_embed_model ON memory_embeddings(model);

-- Keyword recall over memories.
CREATE VIRTUAL TABLE memories_fts USING fts5(
  text,
  kind UNINDEXED,
  content='memories',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text, kind) VALUES (new.rowid, new.text, new.kind);
END;

CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text, kind)
  VALUES ('delete', old.rowid, old.text, old.kind);
END;

CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text, kind)
  VALUES ('delete', old.rowid, old.text, old.kind);
  INSERT INTO memories_fts(rowid, text, kind) VALUES (new.rowid, new.text, new.kind);
END;

-- Bookkeeping for the memory subsystem (last extraction sweep, etc.).
CREATE TABLE memory_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`,
  ],
  [
    "004_sync.sql",
    `
-- Soft-delete: a deleted memory becomes a tombstone (deleted_at set) instead
-- of being removed outright, so sync can propagate the deletion to other
-- devices. norm_text is mutated on delete (see deleteMemory) to free the
-- UNIQUE(norm_text) slot for re-extraction.
ALTER TABLE memories ADD COLUMN deleted_at TEXT;

-- Singleton row holding this device's sync configuration. All fields here
-- are non-secret — the recovery code / derived key live only in
-- chrome.storage.local, never in this database (so they're never swept into
-- a JSON export).
CREATE TABLE sync_config (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  enabled        INTEGER NOT NULL DEFAULT 0,
  sync_id        TEXT,
  device_id      TEXT,
  last_synced_at TEXT
);
INSERT INTO sync_config (id, enabled) VALUES (1, 0);
`,
  ],
  [
    "005_vault.sql",
    `
-- Vault sync state: tracks which conversations have been exported to the
-- OKF vault (Google Drive), and when. The sync engine uses last_message_at
-- from conversations to detect changes since last sync.
CREATE TABLE vault_sync_state (
  conversation_id  TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  drive_file_id    TEXT,                -- Google Drive file ID (null if not yet uploaded)
  filename         TEXT NOT NULL,       -- e.g. "2026-07-01_my-chat.md"
  vault_path       TEXT NOT NULL,       -- e.g. "threads/claude/"
  last_synced_at   TEXT NOT NULL,       -- ISO 8601 — when this file was last uploaded
  synced_msg_count INTEGER NOT NULL,    -- message count at time of last sync
  status           TEXT NOT NULL DEFAULT 'synced'  -- synced | pending | error
);

CREATE INDEX idx_vault_status ON vault_sync_state(status);

-- Global vault config (singleton row, like sync_config).
CREATE TABLE vault_config (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  enabled          INTEGER NOT NULL DEFAULT 0,
  vault_root_id    TEXT,               -- Drive ID of the "smriti-vault" root folder
  last_sync_at     TEXT,               -- last successful sync round completion
  total_synced     INTEGER DEFAULT 0,  -- lifetime count of files synced
  sync_errors      INTEGER DEFAULT 0   -- count of errors in last round
);
INSERT INTO vault_config (id, enabled) VALUES (1, 0);
`
  ],
  [
    "006_sources.sql",
    `
-- Phase 1 — the source layer.
--
-- Three assumptions baked into 001_init stop being true once a source can be
-- human chat rather than an AI assistant:
--   * a conversation has exactly two roles        -> people / person_identities
--   * a conversation belongs to a "platform"      -> spaces
--   * position is a wall-clock tiebreaker         -> dense per-conversation rank
--
-- NOTE ON TRIGGERS: this migration bulk-updates messages.position,
-- messages.author_id and (defensively) messages.platform_msg_id. None of those
-- are mirrored into messages_fts, but the existing messages_au trigger fires on
-- ANY update and rewrites the row's FTS entry regardless — an O(rows) FTS
-- rebuild for changes the index does not care about. So the trigger is dropped
-- for the duration and recreated at the end as AFTER UPDATE OF <indexed cols>,
-- which also stops every future position/model/token_count write from churning
-- the index.
DROP TRIGGER messages_au;

-- ─── Spaces ─────────────────────────────────────────────────────────────────
-- A space is "where a conversation happened" at a level above the individual
-- thread: an app (all of Claude), a DM with one person, or a group chat. It is
-- what Phase 4's per-space memory layers attach to.
CREATE TABLE spaces (
  id             TEXT PRIMARY KEY,
  source         TEXT NOT NULL,          -- registry SourceId
  space_key      TEXT NOT NULL,          -- source-local key (chat id, phone, "app")
  label          TEXT,
  kind           TEXT NOT NULL,          -- app | dm | group
  created_at     TEXT NOT NULL,
  last_active_at TEXT,
  UNIQUE (source, space_key)
);

CREATE INDEX idx_spaces_source ON spaces(source, last_active_at DESC);

-- ─── People ─────────────────────────────────────────────────────────────────
-- One row per human (or bot) Smriti knows about. Identity resolution across
-- sources happens through person_identities, so the same person reached on two
-- sources collapses to one row.
CREATE TABLE people (
  id           TEXT PRIMARY KEY,
  display_name TEXT,
  is_self      INTEGER NOT NULL DEFAULT 0,   -- exactly one row should be 1
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_people_self ON people(is_self);

CREATE TABLE person_identities (
  person_id    TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  source       TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  display_name TEXT,
  PRIMARY KEY (source, external_id)
);

CREATE INDEX idx_pident_person ON person_identities(person_id);

-- ─── Wiring the existing tables in ──────────────────────────────────────────
ALTER TABLE conversations ADD COLUMN space_id TEXT REFERENCES spaces(id);
ALTER TABLE messages      ADD COLUMN author_id TEXT REFERENCES people(id);

CREATE INDEX idx_conv_space ON conversations(space_id, last_message_at DESC);
CREATE INDEX idx_msg_author ON messages(author_id);

-- ─── platform_msg_id becomes the identity key ───────────────────────────────
-- messages.platform_msg_id already existed and is already populated by
-- backfill; the live connectors now set it too. This partial unique index is
-- what makes re-capturing an already-stored message a no-op regardless of what
-- its text hashed to.
--
-- Defensive first: if any (conversation_id, platform_msg_id) pair is already
-- duplicated, the index creation would fail and roll the migration back on
-- every boot, bricking the extension. Keep the earliest row and null the rest.
UPDATE messages SET platform_msg_id = NULL
WHERE platform_msg_id IS NOT NULL
  AND rowid NOT IN (
    SELECT MIN(rowid) FROM messages
    WHERE platform_msg_id IS NOT NULL
    GROUP BY conversation_id, platform_msg_id
  );

CREATE UNIQUE INDEX idx_msg_external
  ON messages(conversation_id, platform_msg_id)
  WHERE platform_msg_id IS NOT NULL;

-- ─── Dense position ─────────────────────────────────────────────────────────
-- position was Date.now() for live captures and Date.parse(created_at) for
-- backfilled rows — a wall-clock tiebreaker, not a turn index, so the two
-- interleave by capture time instead of by conversation order. Rewrite every
-- existing row to a dense 0-based per-conversation rank derived from the
-- current ordering, so old rows and new ones share one scale.
CREATE TEMP TABLE _dense_pos AS
SELECT
  rowid AS rid,
  ROW_NUMBER() OVER (
    PARTITION BY conversation_id
    ORDER BY position, created_at, rowid
  ) - 1 AS newpos
FROM messages;

CREATE INDEX _dense_pos_rid ON _dense_pos(rid);

UPDATE messages
SET position = (SELECT newpos FROM _dense_pos WHERE _dense_pos.rid = messages.rowid)
WHERE rowid IN (SELECT rid FROM _dense_pos);

DROP TABLE _dense_pos;

-- ─── Backfill people and spaces for existing data ───────────────────────────
-- Ids are deterministic strings rather than UUIDs so this migration is
-- re-derivable and the rows are readable in a debug session.
INSERT INTO people (id, display_name, is_self, created_at)
VALUES ('person:self', 'You', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- One bot person per platform actually present in the archive.
INSERT INTO people (id, display_name, is_self, created_at)
SELECT DISTINCT 'person:bot:' || platform, platform, 0,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM conversations;

INSERT INTO person_identities (person_id, source, external_id, display_name)
SELECT DISTINCT 'person:bot:' || platform, platform, 'assistant', platform
FROM conversations;

-- One app-level space per platform. Human sources will add dm/group spaces.
INSERT INTO spaces (id, source, space_key, label, kind, created_at, last_active_at)
SELECT DISTINCT
  'space:' || platform, platform, 'app', platform, 'app',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  (SELECT MAX(last_message_at) FROM conversations c2 WHERE c2.platform = c.platform)
FROM conversations c;

UPDATE conversations
SET space_id = 'space:' || platform
WHERE space_id IS NULL;

UPDATE messages
SET author_id = CASE
  WHEN role = 'user' THEN 'person:self'
  WHEN role = 'assistant' THEN
    'person:bot:' || (SELECT platform FROM conversations c WHERE c.id = messages.conversation_id)
  ELSE NULL          -- system / tool turns are not people
END
WHERE author_id IS NULL;

-- ─── Restore the FTS trigger, now column-scoped ─────────────────────────────
CREATE TRIGGER messages_au AFTER UPDATE OF content_text, role, conversation_id ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content_text, role, conversation_id)
  VALUES ('delete', old.rowid, old.content_text, old.role, old.conversation_id);
  INSERT INTO messages_fts(rowid, content_text, role, conversation_id)
  VALUES (new.rowid, new.content_text, new.role, new.conversation_id);
END;
`
  ],
  [
    "007_episodes.sql",
    `
-- Phase 2 — the index unit.
--
-- A message is the wrong thing to embed. 500k messages at 384 float32 dims is
-- 768 MB of vectors; at int8 inside SQLite it is still 192 MB, and lib/db.ts
-- persists by serialising the whole database on every flush. An **episode** —
-- a coherent stretch of ~15 messages — is ~1/15th as many vectors, and its
-- gist is a *better* retrieval target for a vague query than any single
-- message, because the gist contains topical words the individual messages
-- never say.
--
-- Episode vectors themselves live outside SQLite entirely, in lib/vectors.ts.
-- This table holds only the structure and the text.

CREATE TABLE episodes (
  id              TEXT PRIMARY KEY,          -- "<conversation_id>:<ordinal>"
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  space_id        TEXT REFERENCES spaces(id),
  ordinal         INTEGER NOT NULL,          -- 0-based, per conversation
  position_start  INTEGER NOT NULL,          -- inclusive, messages.position
  position_end    INTEGER NOT NULL,          -- inclusive
  started_at      TEXT NOT NULL,
  ended_at        TEXT NOT NULL,
  gist            TEXT NOT NULL,
  gist_source     TEXT NOT NULL,             -- extractive | abstractive
  msg_count       INTEGER NOT NULL,
  UNIQUE (conversation_id, ordinal)
);

CREATE INDEX idx_ep_conv  ON episodes(conversation_id, ordinal);
CREATE INDEX idx_ep_space ON episodes(space_id, started_at DESC);
CREATE INDEX idx_ep_time  ON episodes(started_at DESC);

-- FTS over gists, with the Phase 2 tokenizer (see the messages_fts rebuild
-- below for why).
CREATE VIRTUAL TABLE episodes_fts USING fts5(
  gist,
  conversation_id UNINDEXED,
  content='episodes',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3'
);

CREATE TRIGGER episodes_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, gist, conversation_id)
  VALUES (new.rowid, new.gist, new.conversation_id);
END;

CREATE TRIGGER episodes_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, gist, conversation_id)
  VALUES ('delete', old.rowid, old.gist, old.conversation_id);
END;

CREATE TRIGGER episodes_au AFTER UPDATE OF gist, conversation_id ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, gist, conversation_id)
  VALUES ('delete', old.rowid, old.gist, old.conversation_id);
  INSERT INTO episodes_fts(rowid, gist, conversation_id)
  VALUES (new.rowid, new.gist, new.conversation_id);
END;

-- ─── Entities ───────────────────────────────────────────────────────────────
-- The handles a vague query actually reaches for: a person, a place, a link.
-- Populated from Phase 5's query understanding and the extraction tier;
-- declared here so the schema settles in one migration rather than two.
CREATE TABLE entities (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,      -- person | place | org | product | url | media | date
  name       TEXT NOT NULL,
  norm_name  TEXT NOT NULL,
  person_id  TEXT REFERENCES people(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (kind, norm_name)
);

CREATE INDEX idx_entities_person ON entities(person_id);

CREATE TABLE entity_mentions (
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  PRIMARY KEY (entity_id, message_id)
);

CREATE INDEX idx_ementions_msg ON entity_mentions(message_id);
CREATE INDEX idx_ementions_ep  ON entity_mentions(episode_id);

-- ─── Rebuild messages_fts with a multilingual tokenizer ─────────────────────
--
-- 001_init used tokenize='porter unicode61'. Porter is an ENGLISH stemmer and
-- is actively harmful on code-switched text — it mangles Hinglish tokens into
-- nonsense stems that match nothing. The replacement drops it in favour of
-- unicode61 with full diacritic folding, and adds a prefix index.
--
-- Losing Porter means "running" no longer matches "run", so buildFtsQuery()
-- (now one shared implementation in lib/fts-query.ts) emits a trailing-star
-- prefix term for tokens of 3+ characters. The prefix index is what makes that
-- fast — and it is also what finally makes typing "post" match "postgres".
--
-- messages_fts is an external-content table: it stores no content of its own,
-- only the index. So dropping and recreating it loses nothing, and 'rebuild'
-- repopulates it from messages. The three triggers reference it by name and
-- survive the swap.
DROP TABLE messages_fts;

CREATE VIRTUAL TABLE messages_fts USING fts5(
  content_text,
  role UNINDEXED,
  conversation_id UNINDEXED,
  content='messages',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3'
);

INSERT INTO messages_fts(messages_fts) VALUES('rebuild');

-- ─── Same treatment for memories_fts ────────────────────────────────────────
-- memories_fts has the same Porter tokenizer and the same near-duplicate query
-- builder, so it needs the same rebuild or recall regresses the moment the
-- query builder starts emitting prefixes.
DROP TABLE memories_fts;

CREATE VIRTUAL TABLE memories_fts USING fts5(
  text,
  kind UNINDEXED,
  content='memories',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3'
);

INSERT INTO memories_fts(memories_fts) VALUES('rebuild');

-- Scope the memory update trigger the same way messages_au was scoped in 006.
-- This one matters on a hot path: touch_memories() bumps last_used_at and
-- use_count on every single injection, and each of those was rewriting the
-- memory's FTS row for columns FTS does not index.
DROP TRIGGER memories_au;

CREATE TRIGGER memories_au AFTER UPDATE OF text, kind ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text, kind)
  VALUES ('delete', old.rowid, old.text, old.kind);
  INSERT INTO memories_fts(rowid, text, kind) VALUES (new.rowid, new.text, new.kind);
END;
`
  ]
];
