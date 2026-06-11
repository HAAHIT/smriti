// Local embedding generation using Transformers.js (WASM/ONNX).
//
// Runs inside the Offscreen Document. The model (~25 MB) and ONNX runtime
// wasm are vendored into the package by `npm run fetch:model` (run
// automatically via prebuild/predev) — zero network requests at runtime.
//
// IMPORTANT: set numThreads=1 — offscreen documents cannot use SharedArrayBuffer
// (requires COOP/COEP headers that extensions can't set), so multi-threaded
// ONNX inference is unavailable.

import { pipeline, env } from "@xenova/transformers";
import { dbAll, dbGet, dbRun, markDirty } from "./db.js";

export const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBED_DIMS = 384;

// Fully local model — vendored into the package by `npm run fetch:model`.
// Zero network calls at runtime.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = chrome.runtime.getURL("/models/");
env.useBrowserCache = false; // files are extension-local; caching adds nothing
// Single-threaded inference (no SharedArrayBuffer in offscreen context).
// @ts-ignore — property exists at runtime
if (env.backends?.onnx?.wasm) {
  // @ts-ignore
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("/ort/");
  // @ts-ignore
  env.backends.onnx.wasm.numThreads = 1;
}

type PipelineFn = (
  text: string | string[],
  opts: { pooling: "mean"; normalize: true; truncation?: boolean },
) => Promise<{ data: Float32Array }>;

let _extractor: PipelineFn | null = null;
let _loading: Promise<PipelineFn> | null = null;

export function isModelReady(): boolean {
  return _extractor !== null;
}

export async function getExtractor(): Promise<PipelineFn> {
  if (_extractor) return _extractor;
  if (_loading) return _loading;
  _loading = (async () => {
    console.log("[smriti:embed] loading model", EMBED_MODEL);
    const t0 = Date.now();
    const fn = await pipeline("feature-extraction", EMBED_MODEL, {
      progress_callback: () => {},
    });
    _extractor = fn as unknown as PipelineFn;
    console.log("[smriti:embed] model ready", Date.now() - t0, "ms");
    return _extractor;
  })();
  return _loading;
}

export async function embedText(text: string): Promise<Float32Array> {
  const fn = await getExtractor();
  const out = await fn(text, { pooling: "mean", normalize: true, truncation: true });
  return new Float32Array(out.data);
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const fn = await getExtractor();
  const results: Float32Array[] = [];
  for (const t of texts) {
    const out = await fn(t, { pooling: "mean", normalize: true, truncation: true });
    results.push(new Float32Array(out.data));
  }
  return results;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

export function storeEmbedding(messageId: string, vec: Float32Array): void {
  if (vec.length !== EMBED_DIMS) {
    throw new Error(`unexpected dims ${vec.length}`);
  }
  const blob = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
  dbRun(
    `INSERT INTO message_embeddings (message_id, model, dims, vec, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       model = excluded.model, dims = excluded.dims,
       vec = excluded.vec, created_at = excluded.created_at`,
    [messageId, EMBED_MODEL, EMBED_DIMS, blob, new Date().toISOString()],
  );
  markDirty();
}

export function getPendingMessages(limit: number): Array<{ id: string; content_text: string }> {
  return dbAll<{ id: string; content_text: string }>(
    `SELECT m.id, m.content_text
     FROM messages m
     LEFT JOIN message_embeddings e ON e.message_id = m.id
     WHERE e.message_id IS NULL
       AND length(m.content_text) >= 8
     ORDER BY m.rowid DESC
     LIMIT ?`,
    [limit],
  );
}

export function countEmbedStatus(): { total: number; embedded: number; pending: number } {
  const total = (dbGet<{ n: number }>("SELECT COUNT(*) AS n FROM messages") ?? { n: 0 }).n;
  const embedded = (dbGet<{ n: number }>("SELECT COUNT(*) AS n FROM message_embeddings") ?? { n: 0 }).n;
  return { total, embedded, pending: Math.max(0, total - embedded) };
}

// ─── Vector search ────────────────────────────────────────────────────────────

export interface VecHit {
  message_id: string;
  conversation_id: string;
  score: number;
  content_text: string;
}

export function searchByVector(queryVec: Float32Array, topK: number): VecHit[] {
  const rows = dbAll<{
    message_id: string;
    conversation_id: string;
    content_text: string;
    vec: Uint8Array;
  }>(
    `SELECT e.message_id, m.conversation_id, m.content_text, e.vec
     FROM message_embeddings e
     JOIN messages m ON m.id = e.message_id
     WHERE e.model = ?`,
    [EMBED_MODEL],
  );

  const hits: VecHit[] = [];
  for (const r of rows) {
    // sql.js returns BLOBs as Uint8Array — reinterpret as Float32Array.
    const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4);
    let s = 0;
    for (let i = 0; i < EMBED_DIMS; i++) s += (queryVec[i] as number) * (v[i] as number);
    hits.push({ message_id: r.message_id, conversation_id: r.conversation_id, content_text: r.content_text, score: s });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}
