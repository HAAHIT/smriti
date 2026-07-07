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
  ]
];
