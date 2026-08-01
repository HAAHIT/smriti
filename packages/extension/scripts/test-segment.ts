// Headless unit tests for episode segmentation.
// Run: npx tsx scripts/test-segment.ts
//
// lib/segment.ts is pure (no DB, no model, no browser globals), which is the
// whole reason it was split out of outline.ts — the boundary rules are the part
// worth pinning down, and they are testable without an embedding model.
//
// The two tiers are tested separately and then together, because tier 1 (time
// and size) is the one that has to work on the first message ever captured,
// with no vectors in existence.

import {
  segment,
  episodeGist,
  msBetween,
  cosine,
  DEFAULTS,
  type SegmentInput,
} from "../lib/segment.js";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  cond ? pass++ : fail++;
}

function eq<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── fixtures ────────────────────────────────────────────────────────────────

const T0 = Date.parse("2026-03-01T10:00:00.000Z");

/** n messages, `stepMs` apart, alternating roles. */
function run(n: number, stepMs = 60_000, startMs = T0): SegmentInput[] {
  const out: SegmentInput[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      position: i,
      created_at: new Date(startMs + i * stepMs).toISOString(),
      role: i % 2 === 0 ? "user" : "assistant",
      text: `message ${i}`,
    });
  }
  return out;
}

/** A unit vector pointing along `axis`, so two topics are orthogonal. */
function vec(axis: number, dims = 8): Float32Array {
  const v = new Float32Array(dims);
  v[axis % dims] = 1;
  return v;
}

// ─── Tier 1: time gaps ───────────────────────────────────────────────────────

console.log("\n=== tier 1: time gaps ===\n");

check(
  "an empty input has no boundaries",
  eq(segment([]).boundaries, []),
);

check(
  "a single message is one episode starting at 0",
  eq(segment(run(1)).boundaries, [0]),
);

check(
  "a steady conversation under the size cap is one episode",
  eq(segment(run(10, 60_000)).boundaries, [0]),
);

{
  // Six messages a minute apart, then a two-hour silence, then six more.
  const a = run(6, 60_000);
  const b = run(6, 60_000, T0 + 5 * 60_000 + 2 * 60 * 60 * 1000);
  const rows = [...a, ...b].map((r, i) => ({ ...r, position: i }));
  check(
    "a silence longer than gapMs starts a new episode",
    eq(segment(rows).boundaries, [0, 6]),
  );
}

check(
  "a gap just under the threshold does not split",
  eq(segment(run(4, DEFAULTS.gapMs - 1_000)).boundaries, [0]),
);

check(
  "a gap exactly at the threshold splits",
  // >= , not > — a message posted exactly gapMs later starts a new episode.
  segment(run(4, DEFAULTS.gapMs)).boundaries.length === 4,
);

check(
  "gapMs is configurable",
  eq(segment(run(4, 10_000), { gapMs: 5_000 }).boundaries, [0, 1, 2, 3]),
);

check(
  "an unparseable timestamp does not split and does not throw",
  // msBetween returns null; the run stays one episode on tier 1 alone.
  eq(
    segment([
      { position: 0, created_at: "not a date", role: "user", text: "a" },
      { position: 1, created_at: "also not a date", role: "assistant", text: "b" },
    ]).boundaries,
    [0],
  ),
);

// ─── Tier 1: hard size cap ───────────────────────────────────────────────────

console.log("\n=== tier 1: size cap ===\n");

{
  const b = segment(run(40, 60_000)).boundaries;
  check(
    "a long uninterrupted run is broken by the size cap",
    b.length > 1,
  );
  check(
    `no episode exceeds forceBoundary (${DEFAULTS.forceBoundary}) messages`,
    b.every((start, i) => {
      const end = i + 1 < b.length ? b[i + 1]! : 40;
      return end - start <= DEFAULTS.forceBoundary;
    }),
  );
  check(
    "the cap fires on a regular stride",
    eq(b, [0, 15, 30]),
  );
}

check(
  "forceBoundary is configurable",
  eq(segment(run(10, 60_000), { forceBoundary: 4 }).boundaries, [0, 4, 8]),
);

// ─── Minimum segment length ──────────────────────────────────────────────────

console.log("\n=== minimum segment length ===\n");

check(
  "a size cap of 1 is still held to minSegment",
  // Every message would be a boundary, but minSegment=2 suppresses the ones
  // that would leave a fragment.
  segment(run(6, 60_000), { forceBoundary: 1, minSegment: 3 }).boundaries.every(
    (start, i, arr) => i === 0 || start - arr[i - 1]! >= 3,
  ),
);

check(
  "a time gap overrides minSegment",
  // Two messages a day apart are not one episode however short the first is.
  eq(
    segment(
      [
        { position: 0, created_at: new Date(T0).toISOString(), role: "user", text: "a" },
        {
          position: 1,
          created_at: new Date(T0 + 24 * 60 * 60 * 1000).toISOString(),
          role: "user",
          text: "b",
        },
      ],
      { minSegment: 5 },
    ).boundaries,
    [0, 1],
  ),
);

// ─── Tier 2: semantic drift ──────────────────────────────────────────────────

console.log("\n=== tier 2: semantic drift ===\n");

check(
  "tier 2 stays off when too few messages carry a vector",
  segment(
    run(10, 60_000).map((r, i) => (i === 0 ? { ...r, vec: vec(0) } : r)),
  ).usedVectors === false,
);

check(
  "tier 2 turns on once embedThreshold is met",
  segment(run(10, 60_000).map((r) => ({ ...r, vec: vec(0) }))).usedVectors === true,
);

{
  // One topic for 8 messages, then an orthogonal one — a similarity of 0,
  // well under floorSim.
  const rows = run(16, 60_000).map((r, i) => ({ ...r, vec: vec(i < 8 ? 0 : 1) }));
  const b = segment(rows).boundaries;
  check(
    "an orthogonal topic switch is a boundary even with no time gap",
    b.includes(8),
  );
  check(
    "a run of identical vectors does not split on drift alone",
    // The only other boundary allowed here is the size cap at 15.
    b.every((x) => x === 0 || x === 8 || x === 15),
  );
}

check(
  "tier 1 still fires while tier 2 is active",
  // Same vector throughout, but a long silence in the middle.
  segment(
    [
      ...run(4, 60_000).map((r) => ({ ...r, vec: vec(0) })),
      ...run(4, 60_000, T0 + 3 * 60_000 + 3 * 60 * 60 * 1000).map((r, i) => ({
        ...r,
        position: 4 + i,
        vec: vec(0),
      })),
    ],
  ).boundaries.includes(4),
);

check(
  "a missing vector mid-run is skipped rather than treated as a drop",
  // NaN similarity must not count as "below the floor".
  segment(
    run(10, 60_000).map((r, i) => ({ ...r, vec: i === 5 ? null : vec(0) })),
  ).boundaries.every((x) => x === 0 || x >= DEFAULTS.forceBoundary),
);

// ─── episodeGist ─────────────────────────────────────────────────────────────

console.log("\n=== episodeGist ===\n");

check(
  "an empty episode has an empty gist",
  episodeGist([]) === "",
);

check(
  "the first user message is preferred over an earlier assistant one",
  episodeGist([
    { position: 0, created_at: "", role: "assistant", text: "How can I help?" },
    { position: 1, created_at: "", role: "user", text: "Explain lifetimes in Rust" },
  ]) === "Explain lifetimes in Rust",
);

check(
  "with no user message, the first non-empty message is used",
  episodeGist([
    { position: 0, created_at: "", role: "assistant", text: "" },
    { position: 1, created_at: "", role: "assistant", text: "Some answer" },
  ]) === "Some answer",
);

check(
  "whitespace is collapsed",
  episodeGist([
    { position: 0, created_at: "", role: "user", text: "  line one\n\n  line two  " },
  ]) === "line one line two",
);

{
  const long = "word ".repeat(80).trim();
  const g = episodeGist([{ position: 0, created_at: "", role: "user", text: long }]);
  check("a long gist is truncated to maxLen", g.length <= 160);
  check("a truncated gist is marked with an ellipsis", g.endsWith("…"));
  check("truncation cuts at a word boundary", !/\bwor…$/.test(g));
}

check(
  "a gist shorter than maxLen is returned whole, unmarked",
  episodeGist([{ position: 0, created_at: "", role: "user", text: "short" }]) === "short",
);

// ─── math helpers ────────────────────────────────────────────────────────────

console.log("\n=== math helpers ===\n");

check(
  "msBetween returns the absolute difference",
  msBetween("2026-03-01T10:00:00Z", "2026-03-01T10:01:00Z") === 60_000,
);

check(
  "msBetween is order-independent",
  msBetween("2026-03-01T10:01:00Z", "2026-03-01T10:00:00Z") === 60_000,
);

check(
  "msBetween returns null on an unparseable timestamp",
  msBetween("banana", "2026-03-01T10:00:00Z") === null,
);

check(
  "cosine of a unit vector with itself is 1",
  Math.abs(cosine(vec(0), vec(0)) - 1) < 1e-6,
);

check(
  "cosine of orthogonal vectors is 0",
  Math.abs(cosine(vec(0), vec(1))) < 1e-6,
);

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\nAssertions: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
