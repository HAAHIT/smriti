// Flat int8 vector store, outside SQLite.
//
// WHY THIS EXISTS
//
// 500k messages at 384 float32 dims is 768 MB of vectors. Even int8 in SQLite
// is 192 MB — and it is *inside* the database, which lib/db.ts persists by
// serialising the entire file on every debounced flush. So the vectors would
// be re-serialised wholesale every couple of seconds.
//
// Two changes fix that together:
//   1. The unit of embedding becomes the **episode**, not the message
//      (~1 per 15 messages) — a ~60x reduction on its own.
//   2. Vectors move out of SQLite into this store, so they are not part of the
//      db.export() payload at all.
//
// 500k messages ends up ~33k episodes × 384 int8 = ~12.8 MB. Trivial.
//
// PERSISTENCE
//
// The whole array is kept in memory and the whole file is rewritten on a
// debounced flush — deliberately, not for lack of trying something smarter.
// `createSyncAccessHandle()` is the only OPFS API with offset writes, and it is
// **Worker-only**; this module runs on the offscreen document's main thread
// alongside sql.js. At ~13 MB a whole-file rewrite is cheap, and it is exactly
// what makes the SQLite storage-engine swap (Phase 7) deferrable: the thing
// being deferred is the 60-100 MB db.export(), not this. If measurement later
// disagrees, moving this file into a dedicated Worker is a contained change
// behind the same interface.
//
// QUANTISATION
//
// Embeddings arrive L2-normalised, so every component is in [-1, 1]: scale by
// 127, round, clamp. Dot products accumulate in int32 and rescale once at the
// end. Cosine error is well under 1% — irrelevant at retrieval granularity,
// where we only need the right ~30 candidates in roughly the right order.

const FILE_NAME = "smriti-vectors.bin";
const MAGIC = 0x534d5631; // "SMV1"
const FLUSH_DEBOUNCE_MS = 2_000;
const SCALE = 127;

export interface VectorStoreStats {
  count: number;
  dims: number;
  bytes: number;
}

export interface ScoredId {
  id: string;
  score: number;
}

let _dims = 0;
/** Row-major int8 vectors: row i occupies [i*_dims, (i+1)*_dims). */
let _data: Int8Array = new Int8Array(0);
/** Number of rows currently in use (capacity may exceed this). */
let _count = 0;
/** id → row index. */
let _index = new Map<string, number>();
/** row index → id, kept in step with _index so rows can be enumerated. */
let _ids: string[] = [];

let _dirty = false;
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
let _loaded = false;

// ─── Quantisation ────────────────────────────────────────────────────────────

/** Quantise a unit-normalised float vector to int8. Exported for tests. */
export function quantise(vec: Float32Array): Int8Array {
  const out = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    const v = Math.round((vec[i] as number) * SCALE);
    out[i] = v > 127 ? 127 : v < -127 ? -127 : v;
  }
  return out;
}

/** Approximate cosine between a quantised pair. Exported for tests. */
export function dotInt8(a: Int8Array, b: Int8Array, offsetA = 0, offsetB = 0, dims?: number): number {
  const n = dims ?? a.length;
  let acc = 0;
  for (let i = 0; i < n; i++) acc += (a[offsetA + i] as number) * (b[offsetB + i] as number);
  return acc / (SCALE * SCALE);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export async function initVectors(dims: number): Promise<void> {
  _dims = dims;
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(FILE_NAME);
    const buf = new Uint8Array(await (await fh.getFile()).arrayBuffer());
    deserialise(buf);
    console.log(`[smriti:vec] loaded ${_count} vectors (${_dims}d)`);
  } catch {
    // No file yet — fresh install, or the dims changed and we discarded it.
    reset(dims);
  }
  _loaded = true;
}

/** Drop everything and start over — used when the embedding model changes. */
export function reset(dims: number): void {
  _dims = dims;
  _data = new Int8Array(0);
  _count = 0;
  _index = new Map();
  _ids = [];
  markVectorsDirty();
}

export function isVectorsReady(): boolean {
  return _loaded;
}

export function vectorStats(): VectorStoreStats {
  return { count: _count, dims: _dims, bytes: _count * _dims };
}

export function hasVector(id: string): boolean {
  return _index.has(id);
}

/** Every id currently stored. */
export function storedIds(): string[] {
  return _ids.slice(0, _count);
}

// ─── Writing ─────────────────────────────────────────────────────────────────

function ensureCapacity(rows: number): void {
  const needed = rows * _dims;
  if (_data.length >= needed) return;
  // Grow geometrically so bulk inserts stay amortised O(1).
  const next = new Int8Array(Math.max(needed, Math.ceil(_data.length * 1.5) || _dims * 64));
  next.set(_data);
  _data = next;
}

/** Insert or replace one vector. */
export function putVector(id: string, vec: Float32Array): void {
  if (_dims === 0) throw new Error("vector store not initialised");
  if (vec.length !== _dims) {
    throw new Error(`vector dims ${vec.length} != store dims ${_dims}`);
  }
  const q = quantise(vec);
  let row = _index.get(id);
  if (row === undefined) {
    row = _count;
    ensureCapacity(_count + 1);
    _index.set(id, row);
    _ids[row] = id;
    _count++;
  }
  _data.set(q, row * _dims);
  markVectorsDirty();
}

/**
 * Remove a vector. Swaps the last row into the hole so the array stays dense —
 * O(1), at the cost of not preserving insertion order (nothing depends on it).
 */
export function removeVector(id: string): boolean {
  const row = _index.get(id);
  if (row === undefined) return false;
  const last = _count - 1;
  if (row !== last) {
    _data.copyWithin(row * _dims, last * _dims, (last + 1) * _dims);
    const movedId = _ids[last]!;
    _ids[row] = movedId;
    _index.set(movedId, row);
  }
  _ids.length = last;
  _index.delete(id);
  _count = last;
  markVectorsDirty();
  return true;
}

// ─── Searching ───────────────────────────────────────────────────────────────

/**
 * Top-k by cosine.
 *
 * `allow` is the fix for what lib/embeddings.ts `searchByVector` did: it
 * selected every embedding row JOINed to its message, materialised every
 * message's full text, and scored the lot in a JS loop with no LIMIT and no
 * pre-filter. Callers now narrow by space / time / person in SQL first and pass
 * the surviving ids here, so the scan is over candidates rather than the corpus.
 */
export function searchVectors(
  query: Float32Array,
  topK: number,
  allow?: ReadonlySet<string>,
): ScoredId[] {
  if (_count === 0 || _dims === 0) return [];
  const q = quantise(query);

  // A bounded insertion sort beats sorting every candidate: topK is ~30 and
  // the candidate set can be large.
  const best: ScoredId[] = [];
  let worst = -Infinity;

  for (let row = 0; row < _count; row++) {
    const id = _ids[row]!;
    if (allow && !allow.has(id)) continue;

    let acc = 0;
    const base = row * _dims;
    for (let i = 0; i < _dims; i++) acc += (q[i] as number) * (_data[base + i] as number);
    const score = acc / (SCALE * SCALE);

    if (best.length < topK) {
      best.push({ id, score });
      if (best.length === topK) {
        best.sort((a, b) => b.score - a.score);
        worst = best[best.length - 1]!.score;
      }
    } else if (score > worst) {
      best[best.length - 1] = { id, score };
      // Bubble it up into place.
      for (let i = best.length - 1; i > 0 && best[i]!.score > best[i - 1]!.score; i--) {
        const t = best[i]!;
        best[i] = best[i - 1]!;
        best[i - 1] = t;
      }
      worst = best[best.length - 1]!.score;
    }
  }

  if (best.length < topK) best.sort((a, b) => b.score - a.score);
  return best;
}

// ─── Persistence ─────────────────────────────────────────────────────────────
//
// Format: [magic u32][dims u32][count u32][idLen u32][idBytes utf8][int8 data]
// Ids are newline-joined; none of ours contain a newline (UUIDs and
// "<convId>:<n>" episode keys).

// The explicit <ArrayBuffer> matters: the default Uint8Array<ArrayBufferLike>
// could in principle be backed by a SharedArrayBuffer, which the DOM's
// write()/Blob types reject.
export function serialise(): Uint8Array<ArrayBuffer> {
  const idBlob = new TextEncoder().encode(_ids.slice(0, _count).join("\n"));
  const header = 16;
  const out = new Uint8Array(header + idBlob.length + _count * _dims);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, _dims, true);
  dv.setUint32(8, _count, true);
  dv.setUint32(12, idBlob.length, true);
  out.set(idBlob, header);
  out.set(_data.subarray(0, _count * _dims), header + idBlob.length);
  return out;
}

export function deserialise(buf: Uint8Array): void {
  if (buf.length < 16) throw new Error("vector file too short");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error("bad vector file magic");
  const dims = dv.getUint32(4, true);
  const count = dv.getUint32(8, true);
  const idLen = dv.getUint32(12, true);

  // A dims change means a different embedding model — the old vectors are not
  // comparable with new ones, so discard rather than mixing two spaces.
  if (_dims !== 0 && dims !== _dims) {
    console.warn(`[smriti:vec] dims changed ${dims} -> ${_dims}, discarding stored vectors`);
    reset(_dims);
    return;
  }

  const idsText = new TextDecoder().decode(buf.subarray(16, 16 + idLen));
  const ids = idsText.length ? idsText.split("\n") : [];
  if (ids.length !== count) throw new Error("vector file id/count mismatch");

  _dims = dims;
  _count = count;
  _ids = ids;
  _index = new Map(ids.map((id, i) => [id, i]));
  _data = new Int8Array(buf.subarray(16 + idLen, 16 + idLen + count * dims));
}

export function markVectorsDirty(): void {
  _dirty = true;
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => { void flushVectors(); }, FLUSH_DEBOUNCE_MS);
}

export async function flushVectors(): Promise<void> {
  if (!_dirty) return;
  _dirty = false;
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(FILE_NAME, { create: true });
    const w = await fh.createWritable();
    // Wrapped in a Blob rather than passed as a bare Uint8Array: the DOM lib
    // types the write target as ArrayBufferView<ArrayBuffer>, which a
    // Uint8Array<ArrayBufferLike> does not satisfy.
    await w.write(new Blob([serialise()]));
    await w.close();
  } catch (e) {
    _dirty = true; // try again on the next write
    console.warn("[smriti:vec] flush failed", e);
  }
}

/** Test seam: load state without touching OPFS. */
export function __loadForTests(dims: number, entries: Array<[string, Float32Array]>): void {
  reset(dims);
  _loaded = true;
  for (const [id, v] of entries) putVector(id, v);
  _dirty = false;
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
}
