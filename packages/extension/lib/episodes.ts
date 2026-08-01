// Episodes — the index unit.
//
// An episode is a coherent stretch of one conversation (~15 messages). It is
// what gets embedded, instead of every individual message: see lib/vectors.ts
// for the arithmetic, but the short version is 768 MB of per-message float32
// vectors at WhatsApp volume versus ~13 MB of int8 episode vectors.
//
// It is also a *better* retrieval target for a vague query than any single
// message, because an episode's gist contains topical words that none of its
// messages individually say.
//
// Segmentation itself is pure and lives in lib/segment.ts.

import { dbAll, dbGet, dbRun, markDirty } from "./db.js";
import { EMBED_MODEL, embedText } from "./embeddings.js";
import { episodeGist, segment, type SegmentInput } from "./segment.js";
import { putVector, removeVector, hasVector, isVectorsReady } from "./vectors.js";

/** Conversations with at least this many unepisoded messages get rebuilt. */
const REBUILD_THRESHOLD = 1;

export interface EpisodeRow {
  id: string;
  conversation_id: string;
  space_id: string | null;
  ordinal: number;
  position_start: number;
  position_end: number;
  started_at: string;
  ended_at: string;
  gist: string;
  gist_source: string;
  msg_count: number;
}

interface MsgRow {
  id: string;
  role: string;
  position: number;
  created_at: string;
  content_text: string;
  vec: Uint8Array | null;
}

// ─── Building ────────────────────────────────────────────────────────────────

/**
 * Rebuild every episode for one conversation.
 *
 * Wholesale rather than incremental, deliberately: a conversation is bounded
 * (even a long WhatsApp thread is thousands, not millions), a late message can
 * legitimately change where the *previous* boundary belongs, and an incremental
 * version would need to reason about that. Callers only invoke this for
 * conversations that actually changed.
 */
export function rebuildEpisodes(conversationId: string): EpisodeRow[] {
  const rows = dbAll<MsgRow>(
    `SELECT m.id, m.role, m.position, m.created_at, m.content_text, e.vec
     FROM messages m
     LEFT JOIN message_embeddings e
       ON e.message_id = m.id AND e.model = ?
     WHERE m.conversation_id = ?
     ORDER BY m.position ASC`,
    [EMBED_MODEL, conversationId],
  );
  if (rows.length === 0) {
    dropEpisodes(conversationId);
    return [];
  }

  const spaceId = dbGet<{ space_id: string | null }>(
    "SELECT space_id FROM conversations WHERE id = ?",
    [conversationId],
  )?.space_id ?? null;

  const inputs: SegmentInput[] = rows.map((r) => ({
    position: r.position,
    created_at: r.created_at,
    role: r.role,
    text: r.content_text,
    vec: r.vec ? floatsFromBlob(r.vec) : null,
  }));

  const { boundaries } = segment(inputs);

  // Replacing wholesale: drop first so removed/merged episodes don't linger.
  dropEpisodes(conversationId);

  const built: EpisodeRow[] = [];
  for (let b = 0; b < boundaries.length; b++) {
    const start = boundaries[b]!;
    const end = (b + 1 < boundaries.length ? boundaries[b + 1]! : rows.length) - 1;
    const slice = inputs.slice(start, end + 1);
    const row: EpisodeRow = {
      id: `${conversationId}:${b}`,
      conversation_id: conversationId,
      space_id: spaceId,
      ordinal: b,
      position_start: rows[start]!.position,
      position_end: rows[end]!.position,
      started_at: rows[start]!.created_at,
      ended_at: rows[end]!.created_at,
      gist: episodeGist(slice),
      gist_source: "extractive",
      msg_count: slice.length,
    };
    dbRun(
      `INSERT INTO episodes
         (id, conversation_id, space_id, ordinal, position_start, position_end,
          started_at, ended_at, gist, gist_source, msg_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.conversation_id, row.space_id, row.ordinal, row.position_start,
       row.position_end, row.started_at, row.ended_at, row.gist, row.gist_source,
       row.msg_count],
    );
    built.push(row);
  }
  markDirty();
  return built;
}

function dropEpisodes(conversationId: string): void {
  // Drop their vectors too, or the store leaks rows for episodes that no
  // longer exist and searchVectors keeps scoring them.
  const old = dbAll<{ id: string }>(
    "SELECT id FROM episodes WHERE conversation_id = ?",
    [conversationId],
  );
  for (const e of old) removeVector(e.id);
  dbRun("DELETE FROM episodes WHERE conversation_id = ?", [conversationId]);
}

// ─── Staleness ───────────────────────────────────────────────────────────────

/**
 * Conversations whose episodes no longer cover all their messages.
 *
 * Cheap to evaluate: compare each conversation's message count against the
 * total msg_count of its episodes.
 */
export function conversationsNeedingEpisodes(limit: number): string[] {
  return dbAll<{ id: string }>(
    `SELECT c.id
     FROM conversations c
     LEFT JOIN (
       SELECT conversation_id, SUM(msg_count) AS covered
       FROM episodes GROUP BY conversation_id
     ) e ON e.conversation_id = c.id
     WHERE (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id)
           - COALESCE(e.covered, 0) >= ${REBUILD_THRESHOLD}
     ORDER BY c.last_message_at DESC
     LIMIT ?`,
    [limit],
  ).map((r) => r.id);
}

/** Episodes with no vector yet, oldest first so history is not starved. */
export function episodesNeedingVectors(limit: number): Array<{ id: string; gist: string }> {
  // Before initVectors() resolves, hasVector() says "no" about everything, and
  // acting on that would re-embed the entire corpus on every cold start.
  if (!isVectorsReady()) return [];

  const rows = dbAll<{ id: string; gist: string }>(
    `SELECT id, gist FROM episodes
     WHERE length(gist) > 0
     ORDER BY started_at ASC
     LIMIT ?`,
    [limit * 4],
  );
  // hasVector lives outside SQLite, so the filter happens here rather than in
  // the query.
  return rows.filter((r) => !hasVector(r.id)).slice(0, limit);
}

export async function embedEpisode(id: string, gist: string): Promise<void> {
  const vec = await embedText(gist);
  putVector(id, vec);
}

// ─── Reading ─────────────────────────────────────────────────────────────────

export function getEpisodes(conversationId: string): EpisodeRow[] {
  return dbAll<EpisodeRow>(
    `SELECT * FROM episodes WHERE conversation_id = ? ORDER BY ordinal ASC`,
    [conversationId],
  );
}

/**
 * Map episode ids back to the conversations and message ranges they cover.
 * Used to turn a vector hit into something showable.
 */
export function resolveEpisodes(ids: string[]): EpisodeRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return dbAll<EpisodeRow>(
    `SELECT * FROM episodes WHERE id IN (${placeholders})`,
    ids,
  );
}

/**
 * Candidate episode ids narrowed by space / time, for the `allow` pre-filter
 * that keeps vector scoring off the whole corpus.
 */
export function candidateEpisodeIds(filter: {
  spaceId?: string | null;
  since?: string | null;
  until?: string | null;
}): Set<string> {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.spaceId) { where.push("space_id = ?"); params.push(filter.spaceId); }
  if (filter.since)   { where.push("ended_at >= ?"); params.push(filter.since); }
  if (filter.until)   { where.push("started_at <= ?"); params.push(filter.until); }
  const sql = `SELECT id FROM episodes${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  return new Set(dbAll<{ id: string }>(sql, params).map((r) => r.id));
}

// sql.js hands BLOBs back as Uint8Array — reinterpret as Float32Array.
function floatsFromBlob(b: Uint8Array): Float32Array {
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}
