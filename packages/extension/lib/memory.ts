// The memory engine — the core of "your AI remembers you".
//
// Three jobs:
//   1. EXTRACT durable, reusable facts from the user's own messages, locally,
//      with no LLM call (heuristic clause matching). Runs incrementally in the
//      index worker so it covers both live capture and imported history.
//   2. RECALL the memories relevant to what the user is about to ask — hybrid
//      FTS5 + vector, fused, with pinned/salience/recency boosts.
//   3. MANAGE the store: list, add, edit, pin, delete. The user owns their
//      memory and can curate it at any time.
//
// A "memory" is atomic (one fact per row) and carries provenance back to the
// exact message it came from, so the user can always verify it.

import { randomUUID } from "./crypto.js";
import { dbAll, dbGet, dbRun, markDirty } from "./db.js";
import {
  EMBED_MODEL,
  EMBED_DIMS,
  embedText,
} from "./embeddings.js";
import {
  extractCandidates,
  cleanMemoryText,
  normalize,
  tokenSet,
  jaccard,
  MIN_MEMORY_LEN,
  NEAR_DUP_JACCARD,
} from "./extract.js";
import type {
  MemoryItem,
  MemoryKind,
  MemoryRecallHit,
  MemoryStats,
  Platform,
} from "@smriti/shared";

export { extractCandidates } from "./extract.js";

const EXTRACT_CURSOR_KEY = "extract_through_rowid";
const LAST_EXTRACTED_KEY = "last_extracted_at";

// ─── Storage ────────────────────────────────────────────────────────────────

interface StoreInput {
  kind: MemoryKind;
  text: string;
  salience: number;
  source: "auto" | "manual";
  platform?: Platform | null;
  conversationId?: string | null;
  messageId?: string | null;
}

// Insert a memory unless an exact or near-duplicate already exists. Returns the
// id if created, or null if deduped (existing salience/use is bumped instead).
export function storeMemory(input: StoreInput): string | null {
  const norm = normalize(input.text);
  if (norm.length < MIN_MEMORY_LEN) return null;

  // Exact dup (also enforced by UNIQUE(norm_text)).
  const exact = dbGet<{ id: string; salience: number }>(
    "SELECT id, salience FROM memories WHERE norm_text = ? AND status = 'active'",
    [norm],
  );
  if (exact) {
    bumpSalience(exact.id, exact.salience);
    return null;
  }

  // Near-dup guard: compare token overlap against recent active memories of the
  // same kind. Cheap, no embeddings required, keeps the store clean.
  const ts = tokenSet(norm);
  const recent = dbAll<{ id: string; norm_text: string; salience: number }>(
    "SELECT id, norm_text, salience FROM memories WHERE status = 'active' AND kind = ? ORDER BY rowid DESC LIMIT 400",
    [input.kind],
  );
  for (const r of recent) {
    if (jaccard(ts, tokenSet(r.norm_text)) >= NEAR_DUP_JACCARD) {
      bumpSalience(r.id, r.salience);
      return null;
    }
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  dbRun(
    `INSERT INTO memories
       (id, kind, text, norm_text, source, source_platform,
        source_conversation_id, source_message_id, created_at, updated_at,
        last_used_at, use_count, pinned, salience, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, ?, 'active')`,
    [
      id, input.kind, input.text, norm, input.source,
      input.platform ?? null, input.conversationId ?? null,
      input.messageId ?? null, now, now, input.salience,
    ],
  );
  markDirty();
  return id;
}

function bumpSalience(id: string, current: number): void {
  const next = Math.min(1, current + 0.03);
  dbRun("UPDATE memories SET salience = ?, updated_at = ? WHERE id = ?", [
    next, new Date().toISOString(), id,
  ]);
  markDirty();
}

// ─── Incremental extraction sweep (called by the index worker) ──────────────
//
// Processes user messages with rowid beyond a stored cursor, so every message
// — live or imported — is extracted exactly once. Returns memories created.

interface UserMsgRow {
  rowid: number;
  id: string;
  content_text: string;
  conversation_id: string;
  platform: Platform;
}

export function extractionSweep(maxMessages = 64): { processed: number; created: number } {
  const cursor = getCursor();
  const rows = dbAll<UserMsgRow>(
    `SELECT m.rowid AS rowid, m.id AS id, m.content_text AS content_text,
            m.conversation_id AS conversation_id, c.platform AS platform
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE m.role = 'user' AND m.rowid > ?
     ORDER BY m.rowid ASC
     LIMIT ?`,
    [cursor, maxMessages],
  );
  if (rows.length === 0) return { processed: 0, created: 0 };

  let created = 0;
  let maxRowid = cursor;
  for (const row of rows) {
    maxRowid = Math.max(maxRowid, row.rowid);
    for (const cand of extractCandidates(row.content_text)) {
      const id = storeMemory({
        kind: cand.kind,
        text: cand.text,
        salience: cand.salience,
        source: "auto",
        platform: row.platform,
        conversationId: row.conversation_id,
        messageId: row.id,
      });
      if (id) created++;
    }
  }
  setCursor(maxRowid);
  setMeta(LAST_EXTRACTED_KEY, new Date().toISOString());
  if (created > 0) markDirty();
  return { processed: rows.length, created };
}

// How many user messages are still awaiting extraction.
export function pendingExtractionCount(): number {
  const cursor = getCursor();
  return (
    dbGet<{ n: number }>(
      "SELECT COUNT(*) AS n FROM messages WHERE role = 'user' AND rowid > ?",
      [cursor],
    ) ?? { n: 0 }
  ).n;
}

function getCursor(): number {
  const v = getMeta(EXTRACT_CURSOR_KEY);
  return v ? Number(v) || 0 : 0;
}
function setCursor(rowid: number): void {
  setMeta(EXTRACT_CURSOR_KEY, String(rowid));
}
function getMeta(key: string): string | null {
  const r = dbGet<{ value: string }>("SELECT value FROM memory_meta WHERE key = ?", [key]);
  return r?.value ?? null;
}
function setMeta(key: string, value: string): void {
  dbRun(
    "INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

// ─── Memory embeddings ──────────────────────────────────────────────────────

export function getPendingMemoryEmbeddings(limit: number): Array<{ id: string; text: string }> {
  return dbAll<{ id: string; text: string }>(
    `SELECT m.id AS id, m.text AS text
     FROM memories m
     LEFT JOIN memory_embeddings e ON e.memory_id = m.id
     WHERE e.memory_id IS NULL AND m.status = 'active' AND length(m.text) >= 8
     ORDER BY m.pinned DESC, m.rowid DESC
     LIMIT ?`,
    [limit],
  );
}

export function storeMemoryEmbedding(memoryId: string, vec: Float32Array): void {
  if (vec.length !== EMBED_DIMS) throw new Error(`unexpected dims ${vec.length}`);
  const blob = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
  dbRun(
    `INSERT INTO memory_embeddings (memory_id, model, dims, vec, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(memory_id) DO UPDATE SET
       model = excluded.model, dims = excluded.dims,
       vec = excluded.vec, created_at = excluded.created_at`,
    [memoryId, EMBED_MODEL, EMBED_DIMS, blob, new Date().toISOString()],
  );
  markDirty();
}

interface MemVecHit { id: string; score: number }

function searchMemoriesByVector(queryVec: Float32Array, topK: number): MemVecHit[] {
  const rows = dbAll<{ memory_id: string; vec: Uint8Array }>(
    `SELECT e.memory_id AS memory_id, e.vec AS vec
     FROM memory_embeddings e
     JOIN memories m ON m.id = e.memory_id
     WHERE e.model = ? AND m.status = 'active'`,
    [EMBED_MODEL],
  );
  const hits: MemVecHit[] = [];
  for (const r of rows) {
    const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4);
    let s = 0;
    for (let i = 0; i < EMBED_DIMS; i++) s += (queryVec[i] as number) * (v[i] as number);
    hits.push({ id: r.memory_id, score: s });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}

// ─── Recall ─────────────────────────────────────────────────────────────────
//
// Hybrid FTS + vector RRF over memories, then boost pinned / salient / recently
// used items. Pinned memories are always eligible even on a weak query.

const RRF_K = 60;
const FTS_K = 30;
const VEC_K = 30;

export async function recallMemories(query: string, limit = 6): Promise<MemoryRecallHit[]> {
  const q = query.trim();
  const finalLimit = Math.min(Math.max(1, limit), 25);

  interface Agg {
    id: string;
    score: number;
    match: MemoryRecallHit["match"];
  }
  const byId = new Map<string, Agg>();

  if (q) {
    // FTS lane
    const ftsQuery = buildFtsQuery(q);
    if (ftsQuery) {
      try {
        const ftsRows = dbAll<{ id: string }>(
          `SELECT m.id AS id
           FROM memories_fts
           JOIN memories m ON m.rowid = memories_fts.rowid
           WHERE memories_fts MATCH ? AND m.status = 'active'
           ORDER BY bm25(memories_fts)
           LIMIT ?`,
          [ftsQuery, FTS_K],
        );
        ftsRows.forEach((r, rank) => {
          const contrib = 1 / (RRF_K + rank);
          const e = byId.get(r.id);
          if (e) { e.score += contrib; e.match = "hybrid"; }
          else byId.set(r.id, { id: r.id, score: contrib, match: "fts" });
        });
      } catch { /* malformed FTS — vector still runs */ }
    }

    // Vector lane
    try {
      const haveAny = dbGet("SELECT 1 FROM memory_embeddings LIMIT 1");
      if (haveAny) {
        const qv = await embedText(q);
        searchMemoriesByVector(qv, VEC_K).forEach((r, rank) => {
          const contrib = 1 / (RRF_K + rank);
          const e = byId.get(r.id);
          if (e) { e.score += contrib; e.match = e.match === "fts" ? "hybrid" : e.match; }
          else byId.set(r.id, { id: r.id, score: contrib, match: "vec" });
        });
      }
    } catch { /* vector optional */ }
  }

  // Always fold in pinned memories so the user's curated context is never lost.
  const pinned = dbAll<{ id: string }>(
    "SELECT id FROM memories WHERE status = 'active' AND pinned = 1 LIMIT 25",
  );
  pinned.forEach((r) => {
    const e = byId.get(r.id);
    if (e) { e.score += 0.02; }
    else byId.set(r.id, { id: r.id, score: 0.008, match: "pinned" });
  });

  if (byId.size === 0) return [];

  // Hydrate + apply boosts.
  const ids = [...byId.keys()];
  const meta = dbAll<{
    id: string; kind: MemoryKind; text: string; source_platform: Platform | null;
    source_conversation_id: string | null; source_message_id: string | null;
    created_at: string; pinned: number; salience: number; use_count: number;
    last_used_at: string | null;
  }>(
    `SELECT id, kind, text, source_platform, source_conversation_id,
            source_message_id, created_at, pinned, salience, use_count, last_used_at
     FROM memories WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids,
  );
  const metaById = new Map(meta.map((m) => [m.id, m]));

  const hits: MemoryRecallHit[] = [];
  for (const agg of byId.values()) {
    const m = metaById.get(agg.id);
    if (!m) continue;
    const boost =
      agg.score *
      (1 + 0.5 * m.salience) *
      (m.pinned ? 1.4 : 1) *
      (1 + Math.min(0.3, m.use_count * 0.03));
    hits.push({
      id: m.id,
      kind: m.kind,
      text: m.text,
      source_platform: m.source_platform,
      source_conversation_id: m.source_conversation_id,
      source_message_id: m.source_message_id,
      created_at: m.created_at,
      pinned: !!m.pinned,
      score: boost,
      match: agg.match,
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, finalLimit);
}

function buildFtsQuery(q: string): string {
  const tokens = q
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, ""))
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return "";
  return tokens.join(" OR ");
}

// Mark memories as used (called when they're injected). Powers recency boost.
export function touchMemories(ids: string[]): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const placeholders = ids.map(() => "?").join(",");
  dbRun(
    `UPDATE memories SET use_count = use_count + 1, last_used_at = ?
     WHERE id IN (${placeholders})`,
    [now, ...ids],
  );
  markDirty();
}

// ─── Management ─────────────────────────────────────────────────────────────

function rowToItem(r: Record<string, unknown>): MemoryItem {
  return {
    id: String(r.id),
    kind: r.kind as MemoryKind,
    text: String(r.text),
    source: (r.source as "auto" | "manual") ?? "auto",
    source_platform: (r.source_platform as Platform | null) ?? null,
    source_conversation_id: (r.source_conversation_id as string | null) ?? null,
    source_message_id: (r.source_message_id as string | null) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    last_used_at: (r.last_used_at as string | null) ?? null,
    use_count: Number(r.use_count ?? 0),
    pinned: !!r.pinned,
    salience: Number(r.salience ?? 0.5),
    status: (r.status as "active" | "archived") ?? "active",
  };
}

export function listMemories(opts: { kind?: MemoryKind | "all"; query?: string; limit?: number; sort?: "default" | "recent" } = {}): MemoryItem[] {
  const limit = Math.min(opts.limit ?? 500, 1000);
  const where: string[] = ["status = 'active'"];
  const params: (string | number)[] = [];
  if (opts.kind && opts.kind !== "all") { where.push("kind = ?"); params.push(opts.kind); }
  if (opts.query && opts.query.trim()) {
    where.push("norm_text LIKE ?");
    params.push("%" + normalize(opts.query) + "%");
  }
  params.push(limit);
  const orderBy = opts.sort === "recent"
    ? "created_at DESC"
    : "pinned DESC, salience DESC, created_at DESC";
  const rows = dbAll(
    `SELECT * FROM memories WHERE ${where.join(" AND ")}
     ORDER BY ${orderBy} LIMIT ?`,
    params,
  );
  return rows.map(rowToItem);
}

export function addMemory(text: string, kind: MemoryKind = "fact", source: "auto" | "manual" = "manual", provenance?: { platform?: Platform | null; conversationId?: string | null; messageId?: string | null }): MemoryItem | null {
  const cleaned = cleanMemoryText(text);
  const id = storeMemory({
    kind, text: cleaned, salience: source === "manual" ? 0.9 : 0.6, source,
    platform: provenance?.platform ?? null,
    conversationId: provenance?.conversationId ?? null,
    messageId: provenance?.messageId ?? null,
  });
  if (!id) {
    // Deduped — return the existing matching memory so the UI can react.
    const existing = dbGet("SELECT * FROM memories WHERE norm_text = ?", [normalize(cleaned)]);
    return existing ? rowToItem(existing) : null;
  }
  // Manual memories are high-trust → pin-eligible immediately; embed soon.
  const row = dbGet("SELECT * FROM memories WHERE id = ?", [id]);
  return row ? rowToItem(row) : null;
}

export function editMemory(id: string, text: string, kind?: MemoryKind): boolean {
  const cleaned = cleanMemoryText(text);
  const norm = normalize(cleaned);
  if (norm.length < MIN_MEMORY_LEN) return false;
  const now = new Date().toISOString();
  // Editing the text invalidates the old embedding — clear it so the worker
  // recomputes against the new text.
  dbRun("DELETE FROM memory_embeddings WHERE memory_id = ?", [id]);
  if (kind) {
    dbRun("UPDATE memories SET text = ?, norm_text = ?, kind = ?, updated_at = ? WHERE id = ?", [cleaned, norm, kind, now, id]);
  } else {
    dbRun("UPDATE memories SET text = ?, norm_text = ?, updated_at = ? WHERE id = ?", [cleaned, norm, now, id]);
  }
  markDirty();
  return true;
}

export function setMemoryPinned(id: string, pinned: boolean): void {
  dbRun("UPDATE memories SET pinned = ?, updated_at = ? WHERE id = ?", [pinned ? 1 : 0, new Date().toISOString(), id]);
  markDirty();
}

export function deleteMemory(id: string): void {
  dbRun("DELETE FROM memories WHERE id = ?", [id]);
  markDirty();
}

export function memoryStats(): MemoryStats {
  const total = (dbGet<{ n: number }>("SELECT COUNT(*) AS n FROM memories WHERE status = 'active'") ?? { n: 0 }).n;
  const kinds = dbAll<{ kind: MemoryKind; n: number }>(
    "SELECT kind, COUNT(*) AS n FROM memories WHERE status = 'active' GROUP BY kind",
  );
  const byKind: Record<MemoryKind, number> = {
    identity: 0, preference: 0, project: 0, decision: 0, fact: 0,
  };
  for (const k of kinds) byKind[k.kind] = k.n;
  const pendingEmb = (dbGet<{ n: number }>(
    `SELECT COUNT(*) AS n FROM memories m
     LEFT JOIN memory_embeddings e ON e.memory_id = m.id
     WHERE e.memory_id IS NULL AND m.status = 'active'`,
  ) ?? { n: 0 }).n;
  return {
    total,
    byKind,
    pending_embeddings: pendingEmb,
    last_extracted_at: getMeta(LAST_EXTRACTED_KEY),
  };
}
