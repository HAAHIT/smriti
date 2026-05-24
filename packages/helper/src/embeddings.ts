// Local embedding generation + cosine search.
//
// We use transformers.js with all-MiniLM-L6-v2 (384 dims, ~25MB cached under
// ~/.cache/transformers.js on first download). Runs entirely in-process via
// onnxruntime-node — no Python, no GPU, no server.
//
// Storage: each vector is normalized to unit length and stored as a Float32
// BLOB. Cosine similarity → dot product. Brute-force scan is fine up to
// ~100k messages (single-digit ms).

import { log } from "./logger.js";
import { getDb } from "./db.js";

export const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBED_DIMS = 384;

// transformers.js is dynamically imported the first time we need it. This
// avoids paying the onnxruntime startup cost (1-2s + module load) for users
// who never run a search or whose helper just answers ingest pings.
type Extractor = (
  text: string | string[],
  opts: { pooling: "mean"; normalize: true; truncation?: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

let extractorPromise: Promise<Extractor> | null = null;
let extractorReady = false;

export function isModelReady(): boolean {
  return extractorReady;
}

export async function getExtractor(): Promise<Extractor> {
  if (extractorPromise) return extractorPromise;
  extractorPromise = (async () => {
    log.info("loading embedding model", { model: EMBED_MODEL });
    const t0 = Date.now();
    // Dynamic import keeps the dep optional at load time and shields the
    // top-level module from any console noise transformers.js produces at
    // import time.
    const tf = await import("@xenova/transformers");
    // Silence the library's logger — we route everything through our file log.
    tf.env.allowLocalModels = false;
    const fn = await tf.pipeline("feature-extraction", EMBED_MODEL, {
      progress_callback: () => { /* suppress download progress on stdout */ },
    });
    extractorReady = true;
    log.info("embedding model ready", { ms: Date.now() - t0 });
    return fn as unknown as Extractor;
  })();
  return extractorPromise;
}

export async function embedText(text: string): Promise<Float32Array> {
  const fn = await getExtractor();
  const out = await fn(text, { pooling: "mean", normalize: true, truncation: true });
  // out.data is a Float32Array of length EMBED_DIMS (for single input).
  // Copy because the underlying buffer is reused on next call.
  return new Float32Array(out.data);
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  // Simpler & more robust than a batched call (which returns a concatenated
  // buffer that needs reshape). The model warms up after first call; per-text
  // inference is ~30-80ms on a modern laptop.
  const fn = await getExtractor();
  const out: Float32Array[] = [];
  for (const t of texts) {
    const r = await fn(t, { pooling: "mean", normalize: true, truncation: true });
    out.push(new Float32Array(r.data));
  }
  return out;
}

// ─── persistence ────────────────────────────────────────────────────────────

export interface StoredVec {
  message_id: string;
  conversation_id: string;
  content_text: string;
  vec: Float32Array;
}

export function storeEmbedding(messageId: string, vec: Float32Array): void {
  const db = getDb();
  if (vec.length !== EMBED_DIMS) {
    throw new Error(`unexpected dims ${vec.length} (want ${EMBED_DIMS})`);
  }
  const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  db.prepare(
    `INSERT INTO message_embeddings (message_id, model, dims, vec, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       model = excluded.model,
       dims  = excluded.dims,
       vec   = excluded.vec,
       created_at = excluded.created_at`,
  ).run(messageId, EMBED_MODEL, EMBED_DIMS, buf, new Date().toISOString());
}

export function countEmbedStatus(): { total: number; embedded: number; pending: number } {
  const db = getDb();
  const total = (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
  const embedded = (db.prepare("SELECT COUNT(*) AS n FROM message_embeddings").get() as { n: number }).n;
  return { total, embedded, pending: Math.max(0, total - embedded) };
}

export function getPendingMessages(limit: number): Array<{ id: string; content_text: string }> {
  const db = getDb();
  return db
    .prepare(
      `SELECT m.id AS id, m.content_text AS content_text
       FROM messages m
       LEFT JOIN message_embeddings e ON e.message_id = m.id
       WHERE e.message_id IS NULL
         AND length(m.content_text) >= 8
       ORDER BY m.rowid DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{ id: string; content_text: string }>;
}

// ─── search ─────────────────────────────────────────────────────────────────

export interface VecHit {
  message_id: string;
  conversation_id: string;
  score: number;
  content_text: string;
}

// Brute force. Reads all vectors + minimal metadata, computes dot product.
// At 384 dims a Float32 vector is 1.5KB; 100k messages = ~150MB scan ≈ 50ms.
export function searchByVector(queryVec: Float32Array, topK: number): VecHit[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT e.message_id AS message_id,
              m.conversation_id AS conversation_id,
              m.content_text AS content_text,
              e.vec AS vec
       FROM message_embeddings e
       JOIN messages m ON m.id = e.message_id
       WHERE e.model = ?`,
    )
    .all(EMBED_MODEL) as Array<{
      message_id: string;
      conversation_id: string;
      content_text: string;
      vec: Buffer;
    }>;

  const heap: VecHit[] = [];
  for (const r of rows) {
    const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4);
    let s = 0;
    // unrolled-ish dot product; both vectors are unit-normalized.
    for (let i = 0; i < EMBED_DIMS; i++) s += (queryVec[i] as number) * (v[i] as number);
    heap.push({
      message_id: r.message_id,
      conversation_id: r.conversation_id,
      content_text: r.content_text,
      score: s,
    });
  }
  heap.sort((a, b) => b.score - a.score);
  return heap.slice(0, topK);
}
