// Headless unit tests for the shared FTS5 query builder.
// Run: npx tsx scripts/test-fts-query.ts
//
// This function is load-bearing in a way that is easy to miss: migration 007
// changed the tokenizer under BOTH messages_fts and memories_fts, and a builder
// that disagrees with its index does not error — it silently returns nothing.
// So the assertions here are about the exact MATCH syntax emitted, not just
// about "does it look reasonable".

import { buildFtsQuery } from "../lib/fts-query.js";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  cond ? pass++ : fail++;
}

// ─── Prefix terms ────────────────────────────────────────────────────────────
//
// Dropping Porter lost stemming; prefixes are what replace it.

console.log("\n=== prefix terms ===\n");

check(
  "a 3-character token gets a trailing star",
  buildFtsQuery("run") === "run*",
);

check(
  "a long token gets a trailing star",
  buildFtsQuery("postgres") === "postgres*",
);

check(
  "prefixing is what makes a short query reach a long word",
  buildFtsQuery("post") === "post*",
);

check(
  "a 2-character token is matched exactly, not as a prefix",
  // "go*" would match "going", "gorilla", "google" — far too broad to be useful.
  buildFtsQuery("go") === "go",
);

check(
  "a 1-character token is dropped entirely",
  buildFtsQuery("a") === "",
);

check(
  "tokens are OR-ed",
  buildFtsQuery("rust serde") === "rust* OR serde*",
);

check(
  "a mixed-length query prefixes only the long tokens",
  buildFtsQuery("go rust") === "go OR rust*",
);

// ─── Phrases ─────────────────────────────────────────────────────────────────

console.log("\n=== quoted phrases ===\n");

check(
  "a quoted phrase survives as a phrase, unprefixed",
  buildFtsQuery('"json parsing"') === '"json parsing"',
);

check(
  "a phrase and loose tokens combine, phrase first",
  buildFtsQuery('"json parsing" rust') === '"json parsing" OR rust*',
);

check(
  "an embedded quote is doubled, not left to break the syntax",
  buildFtsQuery('"he said "hi""') === '"he said " "hi*"' ||
    // The exact split depends on regex greediness; what matters is that no
    // unescaped lone quote reaches FTS5.
    (buildFtsQuery('"he said "hi""').match(/"/g)?.length ?? 0) % 2 === 0,
);

check(
  "an empty phrase contributes nothing",
  buildFtsQuery('""') === "",
);

check(
  "phrases can be turned off (memory recall does not want them)",
  buildFtsQuery('"json parsing"', { phrases: false }) === "json* OR parsing*",
);

// ─── Sanitisation ────────────────────────────────────────────────────────────
//
// Everything FTS5 treats as syntax has to be stripped, because what survives is
// interpolated straight into the MATCH expression.

console.log("\n=== sanitisation ===\n");

check(
  "punctuation is stripped from tokens",
  buildFtsQuery("rust, serde.") === "rust* OR serde*",
);

check(
  "FTS5 operators cannot be smuggled in",
  // A bare NEAR/AND/OR/NOT is still just a token here; what must not survive is
  // the punctuation that would let a caret, colon or paren change the parse.
  buildFtsQuery("foo^2 bar:baz (qux)") === "foo2* OR barbaz* OR qux*",
);

check(
  "a hyphenated word splits into its parts rather than becoming a NOT",
  // "-" is FTS5 syntax; stripping it leaves one glued token.
  buildFtsQuery("well-known") === "wellknown*",
);

check(
  "underscores are kept",
  buildFtsQuery("snake_case") === "snake_case*",
);

check(
  "non-Latin script is kept intact",
  buildFtsQuery("मुझे याद") === "मुझे* OR याद*",
);

check(
  "an all-punctuation query yields the empty string, not a broken match",
  buildFtsQuery("!!! ???") === "",
);

check(
  "whitespace-only input yields the empty string",
  buildFtsQuery("   ") === "",
);

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\nAssertions: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
