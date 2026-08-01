// Episode segmentation — where one stretch of conversation ends and the next
// begins.
//
// This generalises what lib/outline.ts did. The old algorithm computed cosine
// similarity between *consecutive per-message embeddings* and needed 30% of a
// conversation embedded before it would run at all. Phase 2 stops embedding
// every message (768 MB of float32 vectors at WhatsApp volume is not a thing
// you can keep in SQLite), which would have left the very algorithm being
// generalised without its input.
//
// So segmentation is two-tier:
//
//   Tier 1 — ALWAYS. Time gaps and turn structure. A silence longer than
//     GAP_MS is the single strongest topic boundary there is in human chat,
//     and a hard size cap bounds episode length. Costs nothing, needs no model,
//     and works on the first message ever captured.
//
//   Tier 2 — WHEN VECTORS EXIST. The existing cosine-drop refinement, applied
//     on top. AI-platform messages stay individually embedded (they are small
//     and few), so `outline.ts` keeps the quality it had.
//
// Pure — no DB, no model, no browser globals. Its own test suite.

/** One message, as far as segmentation is concerned. */
export interface SegmentInput {
  /** Dense per-conversation position. Only used for reporting boundaries. */
  position: number;
  /** ISO 8601. */
  created_at: string;
  role: string;
  text: string;
  /**
   * Optional unit-normalised embedding. When enough of these are present the
   * tier-2 refinement runs; otherwise tier 1 stands alone.
   */
  vec?: Float32Array | null;
}

export interface SegmentOptions {
  /** Silence longer than this starts a new episode. Default 45 min. */
  gapMs?: number;
  /** Hard cap on episode length, in messages. */
  forceBoundary?: number;
  /** Episodes shorter than this are merged into the previous one. */
  minSegment?: number;
  /** Fraction of messages that must carry a vector before tier 2 runs. */
  embedThreshold?: number;
  /** Rolling window for the adaptive similarity threshold. */
  window?: number;
  /** How many standard deviations below the rolling mean counts as a drop. */
  kStd?: number;
  /** Absolute similarity floor — below this is always a boundary. */
  floorSim?: number;
}

export const DEFAULTS: Required<SegmentOptions> = {
  gapMs: 45 * 60 * 1000,
  forceBoundary: 15,
  minSegment: 2,
  embedThreshold: 0.3,
  window: 5,
  kStd: 1.5,
  floorSim: 0.45,
};

export interface SegmentResult {
  /** Indices into the input array at which an episode starts. Always includes 0. */
  boundaries: number[];
  /** Whether the tier-2 vector refinement contributed. */
  usedVectors: boolean;
}

/**
 * Compute episode boundaries.
 *
 * Returns start indices rather than slices so callers can decide what to build
 * from them (an OutlineSegment, an `episodes` row, …).
 */
export function segment(rows: SegmentInput[], opts: SegmentOptions = {}): SegmentResult {
  const o = { ...DEFAULTS, ...opts };
  if (rows.length === 0) return { boundaries: [], usedVectors: false };

  const withVec = rows.filter((r) => r.vec).length;
  const usedVectors = withVec / rows.length >= o.embedThreshold;

  // Tier 2 input: consecutive cosine similarities, NaN where either side is
  // missing a vector.
  const sims: number[] = [];
  if (usedVectors) {
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1]!.vec;
      const b = rows[i]!.vec;
      sims.push(a && b ? cosine(a, b) : NaN);
    }
  }

  const isBoundary: boolean[] = new Array(rows.length).fill(false);
  isBoundary[0] = true;

  const recent: number[] = [];
  let lastBoundary = 0;

  for (let i = 1; i < rows.length; i++) {
    let boundary = false;

    // ── Tier 1a: elapsed time ──
    const gap = msBetween(rows[i - 1]!.created_at, rows[i]!.created_at);
    if (gap !== null && gap >= o.gapMs) boundary = true;

    // ── Tier 2: semantic drift ──
    if (usedVectors) {
      const sim = sims[i - 1]!;
      if (!Number.isNaN(sim)) {
        if (recent.length >= o.window) {
          const m = mean(recent);
          const s = std(recent, m);
          if (sim < m - o.kStd * s) boundary = true;
        }
        if (sim < o.floorSim) boundary = true;
        recent.push(sim);
        if (recent.length > o.window) recent.shift();
      }
    }

    // ── Tier 1b: hard size cap ──
    // Applied after the others so an over-long run always breaks, even when
    // nothing else fired.
    if (i - lastBoundary >= o.forceBoundary) boundary = true;

    // ── Minimum length ──
    // Suppress boundaries that would leave a fragment — EXCEPT a time gap,
    // which is authoritative: two messages a day apart are not one episode
    // however short the first is.
    if (boundary && i - lastBoundary < o.minSegment) {
      const hardGap = gap !== null && gap >= o.gapMs;
      if (!hardGap) boundary = false;
    }

    if (boundary) {
      isBoundary[i] = true;
      lastBoundary = i;
    }
  }

  const boundaries: number[] = [];
  for (let i = 0; i < isBoundary.length; i++) if (isBoundary[i]) boundaries.push(i);
  return { boundaries, usedVectors };
}

/**
 * An extractive gist for an episode: the most representative sentence-ish span.
 *
 * Deliberately not abstractive — Phase 5's BYOK tier can improve on this, but
 * the no-key path must produce something useful, and a gist that exists is what
 * makes episode-level vectors beat message-level ones for vague queries (the
 * gist contains topical words the individual messages never say).
 *
 * Heuristic: prefer the first user message (it usually states the intent),
 * trimmed to one line.
 */
export function episodeGist(rows: SegmentInput[], maxLen = 160): string {
  if (rows.length === 0) return "";
  const firstUser = rows.find((r) => r.role === "user" && r.text.trim());
  const source = firstUser ?? rows.find((r) => r.text.trim()) ?? rows[0]!;
  const clean = source.text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  // Cut at a word boundary rather than mid-token.
  const cut = clean.slice(0, maxLen - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut) + "…";
}

// ─── math ────────────────────────────────────────────────────────────────────

/** Milliseconds between two ISO timestamps, or null if either is unparseable. */
export function msBetween(aIso: string, bIso: string): number | null {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.abs(b - a);
}

/** Dot product of two unit-normalised vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] as number) * (b[i] as number);
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
