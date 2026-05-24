-- Local message embeddings for semantic search.
--
-- One vector per message. We brute-force cosine in JS for now — at <100k
-- messages this scans in single-digit ms. When we outgrow that, swap to
-- sqlite-vec without changing the table shape (vec is already a contiguous
-- Float32 BLOB).
--
-- model + dims are recorded per-row so we can detect when we've upgraded the
-- embedder and re-embed selectively rather than blowing the table away.

CREATE TABLE message_embeddings (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  dims       INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_embed_model ON message_embeddings(model);
