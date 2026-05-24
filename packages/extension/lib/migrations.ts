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
];
