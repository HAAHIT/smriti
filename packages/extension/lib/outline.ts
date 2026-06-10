// Conversation outline / topic segmentation.
//
// Turns a long chat into a navigable table-of-contents.
// Algorithm (no LLM):
//   1. Load messages + embeddings in chronological order.
//   2. Compute cosine similarity between consecutive messages.
//   3. A topic boundary is where similarity drops below an adaptive threshold
//      (rolling mean − K*std) AND a hard floor. Also force a boundary after
//      FORCE_BOUNDARY messages.
//   4. The first USER message in each segment becomes the preview title.
//
// Falls back to fixed-size chunks if fewer than EMBED_THRESHOLD fraction of
// messages are embedded yet.

import { dbAll } from "./db.js";
import { EMBED_DIMS, EMBED_MODEL } from "./embeddings.js";
import type { OutlineSegment } from "@smriti/shared";

const FORCE_BOUNDARY = 10;
const MIN_SEGMENT = 2;
const WINDOW = 5;
const K_STD = 1.5;
const FLOOR_SIM = 0.45;
const EMBED_THRESHOLD = 0.30;
const FALLBACK_CHUNK = 6;
const PREVIEW_LEN = 80;

interface Row {
  id: string;
  role: string;
  position: number;
  created_at: string;
  content_text: string;
  vec: Uint8Array | null;
}

export function getOutline(conversationId: string): {
  ready: boolean;
  segments: OutlineSegment[];
} {
  const rows = dbAll<Row>(
    `SELECT m.id           AS id,
            m.role         AS role,
            m.position     AS position,
            m.created_at   AS created_at,
            m.content_text AS content_text,
            e.vec          AS vec
     FROM messages m
     LEFT JOIN message_embeddings e
       ON e.message_id = m.id AND e.model = ?
     WHERE m.conversation_id = ?
     ORDER BY m.position ASC`,
    [EMBED_MODEL, conversationId],
  );

  if (rows.length === 0) return { ready: true, segments: [] };

  const haveVecs = rows.filter((r) => r.vec).length;
  const embeddedFraction = haveVecs / Math.max(1, rows.length);

  if (embeddedFraction < EMBED_THRESHOLD) {
    return { ready: false, segments: fixedChunks(rows) };
  }

  // Compute consecutive cosine similarities.
  const sims: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!.vec;
    const b = rows[i]!.vec;
    if (!a || !b) {
      sims.push(NaN);
      continue;
    }
    sims.push(cosineFromBytes(a, b));
  }

  // Find boundaries.
  const boundary: boolean[] = new Array(rows.length).fill(false);
  boundary[0] = true;

  const recent: number[] = [];
  let lastBoundary = 0;
  for (let i = 1; i < rows.length; i++) {
    const sim = sims[i - 1]!;
    let isBoundary = false;
    if (!Number.isNaN(sim)) {
      if (recent.length >= WINDOW) {
        const m = mean(recent);
        const s = std(recent, m);
        if (sim < m - K_STD * s) isBoundary = true;
      }
      if (sim < FLOOR_SIM) isBoundary = true;
      recent.push(sim);
      if (recent.length > WINDOW) recent.shift();
    }
    if (i - lastBoundary >= FORCE_BOUNDARY) isBoundary = true;
    if (isBoundary && i - lastBoundary < MIN_SEGMENT) isBoundary = false;
    if (isBoundary) {
      boundary[i] = true;
      lastBoundary = i;
    }
  }

  return { ready: true, segments: makeSegments(rows, boundary) };
}

function fixedChunks(rows: Row[]): OutlineSegment[] {
  const boundary: boolean[] = new Array(rows.length).fill(false);
  for (let i = 0; i < rows.length; i += FALLBACK_CHUNK) boundary[i] = true;
  return makeSegments(rows, boundary);
}

function makeSegments(rows: Row[], boundary: boolean[]): OutlineSegment[] {
  const segs: OutlineSegment[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (!boundary[i]) continue;
    let end = i;
    while (end + 1 < rows.length && !boundary[end + 1]) end++;
    const slice = rows.slice(i, end + 1);
    const firstUser = slice.find((r) => r.role === "user") ?? slice[0]!;
    segs.push({
      start_position:   rows[i]!.position,
      end_position:     rows[end]!.position,
      start_message_id: rows[i]!.id,
      message_count:    slice.length,
      preview:          previewText(firstUser.content_text),
      started_at:       rows[i]!.created_at,
    });
  }
  return segs;
}

function previewText(s: string): string {
  const clean = s.replace(/\s+/g, " ").trim();
  if (clean.length <= PREVIEW_LEN) return clean;
  return clean.slice(0, PREVIEW_LEN - 1) + "…";
}

// sql.js returns BLOBs as Uint8Array — reinterpret as Float32Array.
function cosineFromBytes(a: Uint8Array, b: Uint8Array): number {
  const va = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4);
  const vb = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  let s = 0;
  const n = Math.min(EMBED_DIMS, va.length, vb.length);
  for (let i = 0; i < n; i++) s += (va[i] as number) * (vb[i] as number);
  return s;
}

function mean(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function std(xs: number[], m: number): number {
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / Math.max(1, xs.length - 1));
}
