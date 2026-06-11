// Hybrid FTS5 + vector RRF search.
//
// FTS5 wins on exact tokens ("serde", "Virohan").
// Vector wins on paraphrase ("chat about JSON parsing in Rust" matching
// messages that never say "JSON").
// Reciprocal Rank Fusion merges both rank lists without needing scores on
// the same scale: score(d) = sum_over_modes(1 / (k + rank)).
// Results collapse to one hit per conversation (best message).

import { dbAll, dbGet, getDb, markDirty } from "./db.js";
import { embedText, searchByVector } from "./embeddings.js";
import type { SearchHit } from "@smriti/shared";

const RRF_K = 60;
const FTS_K = 40;
const VEC_K = 40;

export async function search(query: string, limit = 20): Promise<SearchHit[]> {
  const t0 = Date.now();
  const finalLimit = Math.min(limit, 100);
  const q = query.trim();
  if (!q) return [];

  // ─── FTS5 lane ──────────────────────────────────────────────────────────
  const ftsQuery = buildFtsQuery(q);
  type FtsRow = {
    message_id: string;
    conversation_id: string;
    title: string | null;
    platform: string;
    url: string | null;
    last_message_at: string;
    snippet: string;
    content_text: string;
  };
  let ftsRows: FtsRow[] = [];
  if (ftsQuery) {
    try {
      ftsRows = dbAll<FtsRow>(
        `SELECT
           m.id              AS message_id,
           c.id              AS conversation_id,
           c.title           AS title,
           c.platform        AS platform,
           c.url             AS url,
           c.last_message_at AS last_message_at,
           snippet(messages_fts, 0, '<<', '>>', '…', 16) AS snippet,
           m.content_text    AS content_text
         FROM messages_fts
         JOIN messages m       ON m.rowid = messages_fts.rowid
         JOIN conversations c  ON c.id = m.conversation_id
         WHERE messages_fts MATCH ?
         ORDER BY bm25(messages_fts)
         LIMIT ?`,
        [ftsQuery, FTS_K],
      );
    } catch {
      // Malformed FTS query — fall back to vector-only.
      ftsRows = [];
    }
  }

  // ─── Vector lane ────────────────────────────────────────────────────────
  let vecRows: Array<{ message_id: string; conversation_id: string; score: number; content_text: string }> = [];
  try {
    const haveAny = dbGet("SELECT 1 FROM message_embeddings LIMIT 1");
    if (haveAny) {
      const qv = await embedText(q);
      vecRows = searchByVector(qv, VEC_K);
    }
  } catch {
    // Vector search optional — FTS still runs.
  }

  // ─── RRF fusion ─────────────────────────────────────────────────────────
  interface Agg {
    convId: string;
    score: number;
    bestMessageId: string;
    bestSnippet: string;
    bestText: string;
    title: string | null;
    platform: string;
    url: string | null;
    last_message_at: string;
    match: "fts" | "vec" | "hybrid";
  }
  const byConv = new Map<string, Agg>();

  ftsRows.forEach((r, rank) => {
    const contrib = 1 / (RRF_K + rank);
    const existing = byConv.get(r.conversation_id);
    if (!existing) {
      byConv.set(r.conversation_id, {
        convId: r.conversation_id,
        score: contrib,
        bestMessageId: r.message_id,
        bestSnippet: r.snippet,
        bestText: r.content_text,
        title: r.title,
        platform: r.platform,
        url: r.url,
        last_message_at: r.last_message_at,
        match: "fts",
      });
    } else {
      existing.score += contrib;
      if (!existing.bestSnippet.includes("<<")) {
        existing.bestSnippet = r.snippet;
        existing.bestMessageId = r.message_id;
        existing.bestText = r.content_text;
      }
    }
  });

  vecRows.forEach((r, rank) => {
    const contrib = 1 / (RRF_K + rank);
    const existing = byConv.get(r.conversation_id);
    if (!existing) {
      const cv = dbGet<{ title: string | null; platform: string; url: string | null; last_message_at: string }>(
        `SELECT title, platform, url, last_message_at FROM conversations WHERE id = ?`,
        [r.conversation_id],
      );
      if (!cv) return;
      byConv.set(r.conversation_id, {
        convId: r.conversation_id,
        score: contrib,
        bestMessageId: r.message_id,
        bestSnippet: makeSnippet(r.content_text, q),
        bestText: r.content_text,
        title: cv.title,
        platform: cv.platform,
        url: cv.url,
        last_message_at: cv.last_message_at,
        match: "vec",
      });
    } else {
      existing.score += contrib;
      if (!existing.bestSnippet.includes("<<")) {
        existing.bestSnippet = makeSnippet(r.content_text, q);
        existing.bestMessageId = r.message_id;
        existing.bestText = r.content_text;
      }
      existing.match = "hybrid";
    }
  });

  const results = Array.from(byConv.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, finalLimit)
    .map((a) => ({
      conversation_id: a.convId,
      message_id: a.bestMessageId,
      title: a.title,
      platform: a.platform,
      url: a.url,
      snippet: a.bestSnippet,
      last_message_at: a.last_message_at,
      score: a.score,
      match: a.match,
    }));

  const ms = Date.now() - t0;
  console.debug(`[smriti:search] "${q}" hits=${results.length} ms=${ms}`);
  if (ms > 300) console.warn(`[smriti:search] slow query (${ms}ms): "${q}"`);
  return results;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function buildFtsQuery(q: string): string {
  const phrases: string[] = [];
  const remainder = q.replace(/"([^"]+)"/g, (_m, p) => {
    phrases.push(`"${p}"`);
    return " ";
  });
  const tokens = remainder
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, ""))
    .filter((t) => t.length >= 2);
  const parts = [...phrases, ...tokens];
  if (parts.length === 0) return "";
  return parts.join(" OR ");
}

function makeSnippet(text: string, query: string): string {
  const max = 200;
  const lower = text.toLowerCase();
  const toks = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  let idx = -1;
  for (const t of toks) {
    const j = lower.indexOf(t);
    if (j >= 0 && (idx < 0 || j < idx)) idx = j;
  }
  if (idx < 0) {
    const s = text.slice(0, max).replace(/\s+/g, " ").trim();
    return s + (text.length > max ? "…" : "");
  }
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + 140);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(start, end).replace(/\s+/g, " ").trim() + suffix;
}

// ─── Convenience query functions used by offscreen message handlers ───────────

export function getConversation(conversationId: string) {
  const meta = dbGet<{
    id: string; platform: string; title: string | null; url: string | null;
    started_at: string; last_message_at: string; message_count: number;
  }>(
    `SELECT c.id, c.platform, c.title, c.url, c.started_at, c.last_message_at,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
     FROM conversations c WHERE c.id = ?`,
    [conversationId],
  );
  const messages = dbAll<{ id: string; role: string; content_text: string; created_at: string; position: number }>(
    `SELECT id, role, content_text, created_at, position
     FROM messages WHERE conversation_id = ? ORDER BY position ASC`,
    [conversationId],
  );
  return { meta: meta ?? null, messages };
}

export function listRecentConversations(limit: number) {
  return dbAll<{
    id: string; title: string | null; platform: string; url: string | null;
    last_message_at: string; message_count: number;
  }>(
    `SELECT c.id, c.title, c.platform, c.url, c.last_message_at,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
     FROM conversations c
     ORDER BY c.last_message_at DESC
     LIMIT ?`,
    [Math.min(limit, 100)],
  );
}

export function getStats() {
  const c = dbGet<{ n: number }>("SELECT COUNT(*) AS n FROM conversations") ?? { n: 0 };
  const m = dbGet<{ n: number }>("SELECT COUNT(*) AS n FROM messages") ?? { n: 0 };
  return { conversations: c.n, messages: m.n };
}

export function lookupByPlatform(platform: string, platformConvId: string) {
  return dbGet<{
    id: string; platform: string; title: string | null; url: string | null;
    started_at: string; last_message_at: string; message_count: number;
  }>(
    `SELECT c.id, c.platform, c.title, c.url, c.started_at, c.last_message_at,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
     FROM conversations c
     WHERE c.platform = ? AND c.platform_conv_id = ?`,
    [platform, platformConvId],
  ) ?? null;
}

export function wipeArchive(): number {
  const before = (dbGet<{ n: number }>("SELECT COUNT(*) AS n FROM messages") ?? { n: 0 }).n;
  const db = getDb();
  db.run("BEGIN");
  try {
    db.run("DELETE FROM memory_embeddings");
    db.run("DELETE FROM memories");
    db.run("DELETE FROM memory_meta");
    db.run("DELETE FROM message_embeddings");
    db.run("DELETE FROM notes");
    db.run("DELETE FROM conversation_tags");
    db.run("DELETE FROM tags");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    db.run("DELETE FROM backfill_state");
    db.run("DELETE FROM capture_state");
    db.run("DELETE FROM daily_stats");
    db.run("DELETE FROM ingest_state");
    db.run("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    db.run("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
  markDirty();
  return before;
}
