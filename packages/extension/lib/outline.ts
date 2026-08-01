// Conversation outline — a long chat as a navigable table of contents.
//
// This is now a thin projection of lib/segment.ts. It used to own its own
// boundary algorithm, which required 30% of a conversation's messages to be
// individually embedded before it would produce anything but fixed-size chunks.
// Phase 2 moved the embedding unit to episodes, so that precondition can no
// longer be assumed — the shared segmenter always produces boundaries from time
// gaps and turn structure, and refines them with cosine drift only when vectors
// happen to be there.
//
// Practical effect: an outline now appears immediately on a freshly captured
// conversation instead of after the indexer catches up.

import { dbAll } from "./db.js";
import { EMBED_MODEL } from "./embeddings.js";
import { segment, type SegmentInput } from "./segment.js";
import type { OutlineSegment } from "@smriti/shared";

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

  const inputs: SegmentInput[] = rows.map((r) => ({
    position: r.position,
    created_at: r.created_at,
    role: r.role,
    text: r.content_text,
    vec: r.vec ? new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4) : null,
  }));

  const { boundaries, usedVectors } = segment(inputs);

  const segments: OutlineSegment[] = [];
  for (let b = 0; b < boundaries.length; b++) {
    const start = boundaries[b]!;
    const end = (b + 1 < boundaries.length ? boundaries[b + 1]! : rows.length) - 1;
    const slice = rows.slice(start, end + 1);
    const firstUser = slice.find((r) => r.role === "user") ?? slice[0]!;
    segments.push({
      start_position:   rows[start]!.position,
      end_position:     rows[end]!.position,
      start_message_id: rows[start]!.id,
      message_count:    slice.length,
      preview:          previewText(firstUser.content_text),
      started_at:       rows[start]!.created_at,
    });
  }

  // `ready` now means "refined by vectors", not "usable" — the segments are
  // always usable. The UI uses it only to show an "indexing" hint.
  return { ready: usedVectors, segments };
}

function previewText(s: string): string {
  const clean = s.replace(/\s+/g, " ").trim();
  if (clean.length <= PREVIEW_LEN) return clean;
  return clean.slice(0, PREVIEW_LEN - 1) + "…";
}
