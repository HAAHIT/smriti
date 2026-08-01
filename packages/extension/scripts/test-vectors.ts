// Headless unit tests for the int8 vector store.
// Run: npx tsx scripts/test-vectors.ts
//
// lib/vectors.ts holds the episode vectors OUTSIDE SQLite, which buys the space
// win but also means nothing else is checking its work: there is no schema, no
// foreign key, and no migration test that would notice if the file format drifted
// or a removal left a hole. Hence this suite.
//
// OPFS is not reachable under tsx, so initVectors()/flushVectors() are not
// exercised here — everything they wrap (deserialise, serialise, reset) is,
// via the __loadForTests seam.

import {
  __loadForTests,
  quantise,
  dotInt8,
  putVector,
  removeVector,
  hasVector,
  storedIds,
  searchVectors,
  serialise,
  deserialise,
  vectorStats,
  isVectorsReady,
  reset,
} from "../lib/vectors.js";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  cond ? pass++ : fail++;
}

const DIMS = 8;

/** A unit vector along one axis. */
function axis(i: number, dims = DIMS): Float32Array {
  const v = new Float32Array(dims);
  v[i % dims] = 1;
  return v;
}

/** A unit vector between two axes, so scores land strictly between 0 and 1. */
function mix(a: number, b: number, t: number, dims = DIMS): Float32Array {
  const v = new Float32Array(dims);
  v[a % dims] = Math.cos(t);
  v[b % dims] = Math.sin(t);
  return v;
}

// ─── Quantisation ────────────────────────────────────────────────────────────

console.log("\n=== quantisation ===\n");

{
  const q = quantise(axis(0));
  check("a unit component quantises to the full scale", q[0] === 127);
  check("a zero component quantises to zero", q[1] === 0);
  check("quantise returns one int8 per dimension", q.length === DIMS);
}

{
  const neg = new Float32Array(DIMS);
  neg[0] = -1;
  check("a negative unit component quantises to -127", quantise(neg)[0] === -127);
}

{
  // Embeddings arrive L2-normalised so this should not happen, but a component
  // slightly outside [-1, 1] must clamp rather than wrap around to positive.
  const over = new Float32Array(DIMS);
  over[0] = 2;
  const q = quantise(over);
  check("an out-of-range component clamps instead of wrapping", q[0] === 127);
}

check(
  "dotInt8 rescales back to a cosine — a unit vector with itself is 1",
  // The int32 accumulator is divided by SCALE² inside dotInt8, so callers get
  // a similarity in [-1, 1] and never see the quantised magnitudes.
  dotInt8(quantise(axis(0)), quantise(axis(0))) === 1,
);

check(
  "dotInt8 of orthogonal quantised vectors is 0",
  dotInt8(quantise(axis(0)), quantise(axis(1))) === 0,
);

{
  // The whole quantisation argument rests on the error being negligible at
  // retrieval granularity. Pin that down rather than trusting the comment.
  const a = mix(0, 1, 0.4);
  const b = mix(0, 1, 0.7);
  let exact = 0;
  for (let i = 0; i < DIMS; i++) exact += (a[i] as number) * (b[i] as number);
  const approx = dotInt8(quantise(a), quantise(b));
  check(
    `int8 cosine error stays under 1% (exact=${exact.toFixed(4)} approx=${approx.toFixed(4)})`,
    Math.abs(exact - approx) < 0.01,
  );
}

// ─── Basic storage ───────────────────────────────────────────────────────────

console.log("\n=== storage ===\n");

__loadForTests(DIMS, []);

check("the test seam marks the store loaded", isVectorsReady());
check("a fresh store is empty", vectorStats().count === 0);

putVector("a", axis(0));
putVector("b", axis(1));
putVector("c", axis(2));

check("stored vectors are counted", vectorStats().count === 3);
check("hasVector finds a stored id", hasVector("a"));
check("hasVector rejects an unknown id", !hasVector("zzz"));
check("storedIds lists everything", storedIds().sort().join(",") === "a,b,c");
check("stats report the byte size", vectorStats().bytes === 3 * DIMS);

check(
  "re-putting an id overwrites rather than appending",
  (() => {
    putVector("a", axis(3));
    return vectorStats().count === 3;
  })(),
);

check(
  "an overwrite actually changes the stored vector",
  searchVectors(axis(3), 1)[0]?.id === "a",
);

// ─── Removal ─────────────────────────────────────────────────────────────────

console.log("\n=== removal ===\n");

check("removing a stored id reports true", removeVector("b"));
check("removing an unknown id reports false", !removeVector("zzz"));
check("the count drops after removal", vectorStats().count === 2);
check("the removed id is gone", !hasVector("b"));
check("the survivors are still listed", storedIds().sort().join(",") === "a,c");

check(
  "a removed row does not linger in search results",
  searchVectors(axis(1), 10).every((h) => h.id !== "b"),
);

check(
  "the rows left behind are still addressable — no hole in the index",
  // Removal is a swap-with-last, so this is the case that would break.
  searchVectors(axis(2), 1)[0]?.id === "c",
);

check(
  "removing every row leaves an empty, still-usable store",
  (() => {
    removeVector("a");
    removeVector("c");
    return vectorStats().count === 0 && searchVectors(axis(0), 5).length === 0;
  })(),
);

// ─── Search ──────────────────────────────────────────────────────────────────

console.log("\n=== search ===\n");

__loadForTests(DIMS, [
  ["near", mix(0, 1, 0.05)],
  ["mid", mix(0, 1, 0.5)],
  ["far", mix(0, 1, 1.4)],
  ["orthogonal", axis(4)],
]);

{
  const hits = searchVectors(axis(0), 4);
  check("search returns every candidate when topK allows", hits.length === 4);
  check("search ranks by descending similarity", hits[0]?.id === "near");
  check(
    "scores are monotonically non-increasing",
    hits.every((h, i) => i === 0 || h.score <= hits[i - 1]!.score),
  );
  check("the orthogonal vector ranks last", hits[3]?.id === "orthogonal");
  check("an orthogonal score is ~0", Math.abs(hits[3]!.score) < 0.01);
  check("the best score is ~1", Math.abs(hits[0]!.score - 1) < 0.01);
}

check(
  "topK bounds the result set",
  searchVectors(axis(0), 2).length === 2,
);

check(
  "topK still returns the best ones, in order",
  (() => {
    const h = searchVectors(axis(0), 2);
    return h[0]?.id === "near" && h[1]?.id === "mid";
  })(),
);

check(
  "an empty store returns nothing rather than throwing",
  (() => {
    reset(DIMS);
    return searchVectors(axis(0), 5).length === 0;
  })(),
);

// ─── The allow pre-filter ────────────────────────────────────────────────────
//
// This is the reason searchVectors exists in this form: callers narrow by
// space/time in SQL first so the scan is over candidates, not the corpus.

console.log("\n=== allow pre-filter ===\n");

__loadForTests(DIMS, [
  ["near", mix(0, 1, 0.05)],
  ["mid", mix(0, 1, 0.5)],
  ["far", mix(0, 1, 1.4)],
]);

check(
  "an allow set restricts results to its members",
  searchVectors(axis(0), 5, new Set(["mid", "far"])).every((h) => h.id !== "near"),
);

check(
  "the best allowed candidate wins, not the best overall",
  searchVectors(axis(0), 5, new Set(["mid", "far"]))[0]?.id === "mid",
);

check(
  "an empty allow set returns nothing",
  searchVectors(axis(0), 5, new Set()).length === 0,
);

check(
  "an allow set naming unknown ids returns nothing",
  searchVectors(axis(0), 5, new Set(["nope"])).length === 0,
);

check(
  "omitting the allow set scans everything",
  searchVectors(axis(0), 5).length === 3,
);

// ─── Serialisation round-trip ────────────────────────────────────────────────

console.log("\n=== serialisation ===\n");

{
  __loadForTests(DIMS, [["a", axis(0)], ["b", axis(1)], ["c", mix(0, 1, 0.5)]]);
  const before = searchVectors(axis(0), 3);
  const bytes = serialise();

  __loadForTests(DIMS, []);
  deserialise(bytes);

  check("the count survives a round-trip", vectorStats().count === 3);
  check("the ids survive a round-trip", storedIds().sort().join(",") === "a,b,c");
  check(
    "the vectors survive a round-trip — same ranking",
    searchVectors(axis(0), 3).map((h) => h.id).join(",") ===
      before.map((h) => h.id).join(","),
  );
  check(
    "the scores survive a round-trip exactly (int8 in, int8 out)",
    searchVectors(axis(0), 3).every((h, i) => h.score === before[i]!.score),
  );
  check(
    "the store is writable after a round-trip",
    (() => {
      putVector("d", axis(3));
      return vectorStats().count === 4 && hasVector("d");
    })(),
  );
}

check(
  "an empty store round-trips to an empty store",
  (() => {
    __loadForTests(DIMS, []);
    const bytes = serialise();
    __loadForTests(DIMS, []);
    deserialise(bytes);
    return vectorStats().count === 0 && storedIds().length === 0;
  })(),
);

check(
  "ids containing a colon survive — episode keys look like <convId>:<n>",
  (() => {
    __loadForTests(DIMS, [["conv-abc:0", axis(0)], ["conv-abc:12", axis(1)]]);
    const bytes = serialise();
    __loadForTests(DIMS, []);
    deserialise(bytes);
    return storedIds().sort().join(",") === "conv-abc:0,conv-abc:12";
  })(),
);

// ─── Corrupt / incompatible input ────────────────────────────────────────────

console.log("\n=== corrupt input ===\n");

check(
  "a truncated file is rejected",
  (() => {
    try {
      deserialise(new Uint8Array(4));
      return false;
    } catch {
      return true;
    }
  })(),
);

check(
  "a bad magic number is rejected",
  (() => {
    __loadForTests(DIMS, [["a", axis(0)]]);
    const bytes = serialise();
    bytes[0] = 0xff;
    try {
      deserialise(bytes);
      return false;
    } catch {
      return true;
    }
  })(),
);

check(
  "a dims change discards the stored vectors instead of mixing two spaces",
  (() => {
    // Serialise at 8 dims, then load into a store expecting 16 — what a change
    // of embedding model looks like on disk.
    __loadForTests(DIMS, [["a", axis(0)], ["b", axis(1)]]);
    const bytes = serialise();
    __loadForTests(16, []);
    deserialise(bytes);
    return vectorStats().count === 0 && vectorStats().dims === 16;
  })(),
);

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\nAssertions: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
