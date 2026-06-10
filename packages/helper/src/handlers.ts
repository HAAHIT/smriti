import { getDb } from "./db.js";
import { log } from "./logger.js";
import type {
  NMRequest,
  NMResponse,
  SearchHit,
  ConversationMessageRow,
} from "@smriti/shared";
import { ingestEvents } from "./ingest.js";
import { scanClaudeCode } from "./claude-code.js";
import { startBackfill, getBackfillStatuses } from "./backfill/index.js";
import {
  EMBED_MODEL,
  countEmbedStatus,
  embedText,
  isModelReady,
  searchByVector,
} from "./embeddings.js";
import { getOutline } from "./outline.js";
import type { ConversationMeta, RecentConversation } from "@smriti/shared";

const HELPER_VERSION = "0.0.1";

export async function handleRequest(raw: unknown): Promise<NMResponse> {
  const req = raw as Partial<NMRequest>;
  if (
    !req ||
    typeof req !== "object" ||
    typeof req.id !== "string" ||
    typeof req.type !== "string"
  ) {
    return { id: (req?.id as string) ?? "?", ok: false, error: "malformed request" };
  }

  try {
    switch (req.type) {
      case "hello":
        return {
          id: req.id,
          ok: true,
          type: "hello",
          helper_version: HELPER_VERSION,
          protocol: 1,
        };
      case "ingest": {
        const r = ingestEvents((req as Extract<NMRequest, { type: "ingest" }>).events);
        return { id: req.id, ok: true, type: "ingest", accepted: r.accepted };
      }
      case "search":
        return await handleSearch(req as Extract<NMRequest, { type: "search" }>);
      case "get_conversation":
        return handleGetConversation(
          req as Extract<NMRequest, { type: "get_conversation" }>,
        );
      case "stats":
        return handleStats(req as Extract<NMRequest, { type: "stats" }>);
      case "claude_code_scan": {
        const out = await scanClaudeCode(
          (req as Extract<NMRequest, { type: "claude_code_scan" }>).root,
        );
        return {
          id: req.id,
          ok: true,
          type: "claude_code_scan",
          files_scanned: out.files_scanned,
          events_ingested: out.events_ingested,
        };
      }
      case "start_backfill": {
        const r = await startBackfill(
          (req as Extract<NMRequest, { type: "start_backfill" }>).platform,
        );
        return { id: req.id, ok: true, type: "start_backfill", accepted: true, resuming: r.resuming };
      }
      case "backfill_status": {
        const platform = (req as Extract<NMRequest, { type: "backfill_status" }>).platform;
        return { id: req.id, ok: true, type: "backfill_status", jobs: getBackfillStatuses(platform) };
      }
      case "embed_status": {
        const s = countEmbedStatus();
        return {
          id: req.id,
          ok: true,
          type: "embed_status",
          total: s.total,
          embedded: s.embedded,
          pending: s.pending,
          model: isModelReady() ? EMBED_MODEL : null,
        };
      }
      case "get_outline": {
        const cid = (req as Extract<NMRequest, { type: "get_outline" }>).conversation_id;
        const o = getOutline(cid);
        return { id: req.id, ok: true, type: "get_outline", ready: o.ready, segments: o.segments };
      }
      case "list_recent_conversations": {
        const limit = (req as Extract<NMRequest, { type: "list_recent_conversations" }>).limit ?? 30;
        return { id: req.id, ok: true, type: "list_recent_conversations", conversations: listRecent(Math.min(limit, 100)) };
      }
      case "service_start": {
        // Long-lived port from background. The helper process stays alive as
        // long as stdin is open, which lets the indexer make real progress.
        log.info("service port connected");
        return { id: req.id, ok: true, type: "service_start" };
      }
      case "get_by_platform": {
        const q = req as Extract<NMRequest, { type: "get_by_platform" }>;
        const meta = lookupByPlatform(q.platform, q.platform_conv_id);
        const segs = meta ? getOutline(meta.id).segments : [];
        return { id: req.id, ok: true, type: "get_by_platform", meta, segments: segs };
      }
      case "wipe_archive": {
        const cleared = wipeArchive();
        return { id: req.id, ok: true, type: "wipe_archive", cleared };
      }
      default:
        return {
          id: req.id,
          ok: false,
          error: `unknown request type: ${String((req as { type: unknown }).type)}`,
        };
    }
  } catch (e) {
    log.error("handler error", { type: req.type, err: String(e) });
    return { id: req.id, ok: false, error: String(e) };
  }
}

// ─── search: hybrid FTS5 + cosine with RRF fusion ────────────────────────────
//
// Why hybrid:
//   - FTS5 wins on exact words ("serde", "Virohan") and rare-token recall.
//   - Vector wins on paraphrase ("the chat where we discussed JSON parsing in
//     Rust" matching messages that never say the word "JSON").
// Reciprocal Rank Fusion (RRF) merges the two rank lists without needing the
// scores on the same scale: score(d) = sum over modes of 1 / (k + rank).
// We then collapse to one hit per conversation (keep the best message) so the
// UI shows distinct chats rather than 8 hits from the same long conversation.

const RRF_K = 60;
const FTS_K = 40;
const VEC_K = 40;

async function handleSearch(req: Extract<NMRequest, { type: "search" }>): Promise<NMResponse> {
  const db = getDb();
  const finalLimit = Math.min(req.limit ?? 20, 100);
  const query = req.query.trim();
  if (!query) {
    return { id: req.id, ok: true, type: "search", results: [] };
  }

  // ─── FTS5 lane ─────────────────────────────────────────────────────────
  // Build a permissive FTS query: bare tokens are common-user input ("Virohan
  // product manager"). We OR the tokens so multi-word natural-language queries
  // still match. Quoted phrases pass through unchanged.
  const ftsQuery = buildFtsQuery(query);
  type FtsRow = {
    message_id: string;
    conversation_id: string;
    title: string | null;
    platform: string;
    url: string | null;
    last_message_at: string;
    snippet: string;
    bm25: number;
    content_text: string;
  };
  let ftsRows: FtsRow[] = [];
  if (ftsQuery) {
    try {
      ftsRows = db
        .prepare(
          `SELECT
             m.id              AS message_id,
             c.id              AS conversation_id,
             c.title           AS title,
             c.platform        AS platform,
             c.url             AS url,
             c.last_message_at AS last_message_at,
             snippet(messages_fts, 0, '<<', '>>', '…', 16) AS snippet,
             bm25(messages_fts) AS bm25,
             m.content_text    AS content_text
           FROM messages_fts
           JOIN messages m       ON m.rowid = messages_fts.rowid
           JOIN conversations c  ON c.id = m.conversation_id
           WHERE messages_fts MATCH ?
           ORDER BY bm25
           LIMIT ?`,
        )
        .all(ftsQuery, FTS_K) as FtsRow[];
    } catch (e) {
      // Malformed FTS query — fall back gracefully to vector-only.
      log.warn("fts query failed, falling back to vec", { q: ftsQuery, err: String(e) });
      ftsRows = [];
    }
  }

  // ─── Vector lane ──────────────────────────────────────────────────────
  let vecRows: Array<{
    message_id: string;
    conversation_id: string;
    score: number;
    content_text: string;
  }> = [];
  try {
    // Only run a semantic search if we have any embeddings at all; otherwise
    // pay the model load cost for nothing.
    const haveAny = db.prepare("SELECT 1 FROM message_embeddings LIMIT 1").get() as unknown;
    if (haveAny) {
      const qv = await embedText(query);
      vecRows = searchByVector(qv, VEC_K);
    }
  } catch (e) {
    log.warn("vector search failed", { err: String(e) });
  }

  // ─── RRF fusion ────────────────────────────────────────────────────────
  // Score each conversation by aggregating message-level RRF contributions.
  // For each conversation, track the best message (highest combined rank)
  // to use for the snippet.
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
      // FTS snippet is better than truncated text — prefer it.
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
      // Need conv metadata.
      const cv = db
        .prepare(
          `SELECT title, platform, url, last_message_at FROM conversations WHERE id = ?`,
        )
        .get(r.conversation_id) as
        | { title: string | null; platform: string; url: string | null; last_message_at: string }
        | undefined;
      if (!cv) return;
      byConv.set(r.conversation_id, {
        convId: r.conversation_id,
        score: contrib,
        bestMessageId: r.message_id,
        // No FTS snippet — synthesize from message text.
        bestSnippet: makeSnippet(r.content_text, query),
        bestText: r.content_text,
        title: cv.title,
        platform: cv.platform,
        url: cv.url,
        last_message_at: cv.last_message_at,
        match: "vec",
      });
    } else {
      existing.score += contrib;
      // If FTS already gave us a marker-decorated snippet, keep it; otherwise
      // upgrade snippet from vec hit's message.
      if (!existing.bestSnippet.includes("<<")) {
        existing.bestSnippet = makeSnippet(r.content_text, query);
        existing.bestMessageId = r.message_id;
        existing.bestText = r.content_text;
      }
      existing.match = "hybrid";
    }
  });

  const results: SearchHit[] = Array.from(byConv.values())
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

  return { id: req.id, ok: true, type: "search", results };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

// Turn natural-language input into a permissive FTS5 MATCH expression.
// Strategy: drop punctuation, OR tokens, preserve double-quoted phrases.
// Bail to empty string if nothing useful (caller treats as no-FTS-lane).
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

// Build a centered snippet around the first occurrence of any query token,
// or a leading chunk if no token matched (semantic-only hit).
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

function handleGetConversation(
  req: Extract<NMRequest, { type: "get_conversation" }>,
): NMResponse {
  const db = getDb();
  const meta = db
    .prepare(
      `SELECT c.id, c.platform, c.title, c.url, c.started_at, c.last_message_at,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c WHERE c.id = ?`,
    )
    .get(req.conversation_id) as ConversationMeta | undefined;
  const messages = db
    .prepare(
      `SELECT id, role, content_text, created_at, position
       FROM messages WHERE conversation_id = ? ORDER BY position ASC`,
    )
    .all(req.conversation_id) as ConversationMessageRow[];
  return { id: req.id, ok: true, type: "get_conversation", meta: meta ?? null, messages };
}

function wipeArchive(): number {
  const db = getDb();
  // Cascade through every user-data table. messages have FK to conversations
  // with ON DELETE CASCADE, but everything else is independent.
  const before = (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
  const tx = db.transaction(() => {
    db.exec("DELETE FROM message_embeddings;");
    db.exec("DELETE FROM notes;");
    db.exec("DELETE FROM conversation_tags;");
    db.exec("DELETE FROM tags;");
    db.exec("DELETE FROM messages;");
    db.exec("DELETE FROM conversations;");
    db.exec("DELETE FROM backfill_state;");
    db.exec("DELETE FROM capture_state;");
    db.exec("DELETE FROM daily_stats;");
    db.exec("DELETE FROM ingest_state;");
    // FTS5 contentless table — rebuild from (now empty) source.
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');");
  });
  tx();
  // Reclaim space.
  try { db.exec("VACUUM;"); } catch { /* not critical */ }
  log.info("archive wiped", { messages_cleared: before });
  return before;
}

function lookupByPlatform(platform: string, platformConvId: string): ConversationMeta | null {
  const db = getDb();
  const meta = db
    .prepare(
      `SELECT c.id, c.platform, c.title, c.url, c.started_at, c.last_message_at,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c
       WHERE c.platform = ? AND c.platform_conv_id = ?`,
    )
    .get(platform, platformConvId) as ConversationMeta | undefined;
  return meta ?? null;
}

function listRecent(limit: number): RecentConversation[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT c.id, c.title, c.platform, c.url, c.last_message_at,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c
       ORDER BY c.last_message_at DESC
       LIMIT ?`,
    )
    .all(limit) as RecentConversation[];
}

function handleStats(req: Extract<NMRequest, { type: "stats" }>): NMResponse {
  const db = getDb();
  const c = db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number };
  const m = db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
  return { id: req.id, ok: true, type: "stats", conversations: c.n, messages: m.n };
}
