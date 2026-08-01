// Hybrid FTS5 + vector RRF search.
//
// FTS5 wins on exact tokens ("serde", "Virohan").
// Vector wins on paraphrase ("chat about JSON parsing in Rust" matching
// messages that never say "JSON").
// Reciprocal Rank Fusion merges both rank lists without needing scores on
// the same scale: score(d) = sum_over_modes(1 / (k + rank)).
// Results collapse to one hit per conversation (best message).
//
// The two lanes work at different granularities on purpose. FTS matches
// individual messages, because an exact token appears in exactly one of them.
// The vector lane matches **episodes** — see lib/vectors.ts for the storage
// arithmetic, but the retrieval half of the argument is that a vague query has
// more in common with a stretch of conversation than with any one line of it.
// Each episode hit is then resolved back down to the message inside it that
// best matches the query, so a result still points somewhere specific.

import { dbAll, dbGet, getDb, markDirty } from "./db.js";
import { embedText } from "./embeddings.js";
import { resolveEpisodes, type EpisodeRow } from "./episodes.js";
import { buildFtsQuery } from "./fts-query.js";
import { isVectorsReady, searchVectors, vectorStats, reset as resetVectors } from "./vectors.js";
import { EMBED_DIMS } from "./embeddings.js";
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

  // ─── Vector lane (episodes) ─────────────────────────────────────────────
  let vecRows: VecRow[] = [];
  try {
    // vectorStats() rather than a SELECT: the vectors are not in SQLite.
    if (isVectorsReady() && vectorStats().count > 0) {
      const qv = await embedText(q);
      vecRows = resolveEpisodeHits(searchVectors(qv, VEC_K).map((h) => h.id), q);
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
  console.debug(`[smriti:search] qlen=${q.length} hits=${results.length} ms=${ms}`);
  if (ms > 300) console.warn(`[smriti:search] slow query (${ms}ms) qlen=${q.length}`);
  return results;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

interface VecRow {
  message_id: string;
  conversation_id: string;
  content_text: string;
}

/**
 * Turn ranked episode ids into ranked messages, preserving rank order.
 *
 * An episode covers ~15 messages, and showing the user "somewhere in here"
 * would be a worse result than the per-message search this replaced. So each
 * episode is resolved to the message inside it with the most query-token
 * overlap — and where nothing overlaps at all (the paraphrase case, which is
 * exactly what the vector lane is for), to the message that opens the episode,
 * since that is usually where the intent is stated.
 */
function resolveEpisodeHits(episodeIds: string[], query: string): VecRow[] {
  if (episodeIds.length === 0) return [];

  const byId = new Map(resolveEpisodes(episodeIds).map((e) => [e.id, e]));
  // resolveEpisodes returns rows in whatever order SQLite likes; re-impose the
  // ranking, dropping ids whose episode was deleted since it was embedded.
  const ranked: EpisodeRow[] = [];
  for (const id of episodeIds) {
    const e = byId.get(id);
    if (e) ranked.push(e);
  }
  if (ranked.length === 0) return [];

  // One query for every range rather than one per episode.
  const clauses = ranked
    .map(() => "(conversation_id = ? AND position BETWEEN ? AND ?)")
    .join(" OR ");
  const params: Array<string | number> = [];
  for (const e of ranked) params.push(e.conversation_id, e.position_start, e.position_end);

  const msgs = dbAll<{
    id: string; conversation_id: string; position: number; content_text: string;
  }>(
    `SELECT id, conversation_id, position, content_text
     FROM messages WHERE ${clauses}
     ORDER BY position ASC`,
    params,
  );

  const byConv = new Map<string, typeof msgs>();
  for (const m of msgs) {
    const bucket = byConv.get(m.conversation_id);
    if (bucket) bucket.push(m);
    else byConv.set(m.conversation_id, [m]);
  }

  const toks = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  const out: VecRow[] = [];
  const seen = new Set<string>();

  for (const e of ranked) {
    const bucket = byConv.get(e.conversation_id);
    if (!bucket) continue;
    let best: { id: string; text: string; score: number } | null = null;
    for (const m of bucket) {
      if (m.position < e.position_start || m.position > e.position_end) continue;
      const lower = m.content_text.toLowerCase();
      let score = 0;
      for (const t of toks) if (lower.includes(t)) score++;
      // Strictly greater, and the bucket is position-ordered, so a tie keeps
      // the earliest message — the start of the episode.
      if (!best || score > best.score) best = { id: m.id, text: m.content_text, score };
    }
    // One row per message: two episodes of the same conversation can otherwise
    // resolve to the same message and double-count in RRF.
    if (best && !seen.has(best.id)) {
      seen.add(best.id);
      out.push({ message_id: best.id, conversation_id: e.conversation_id, content_text: best.text });
    }
  }
  return out;
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
    // Before messages/conversations: entity_mentions references both messages
    // and episodes, and episodes references conversations.
    db.run("DELETE FROM entity_mentions");
    db.run("DELETE FROM entities");
    db.run("DELETE FROM episodes");
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
    db.run("INSERT INTO episodes_fts(episodes_fts) VALUES('rebuild')");
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
  // The episode vectors are not in the database, so the transaction above says
  // nothing about them. Wiping the archive has to wipe them too, or the store
  // keeps scoring episodes that no longer exist.
  resetVectors(EMBED_DIMS);
  markDirty();
  return before;
}
