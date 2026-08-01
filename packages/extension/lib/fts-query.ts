// Turning a user's typed query into FTS5 MATCH syntax.
//
// There were two near-identical copies of this — lib/search.ts and
// lib/memory.ts — which had already drifted (only one supported quoted
// phrases). They are now one function over both FTS tables, which matters
// because both tables changed tokenizer in migration 007 and a builder that
// disagreed with its index would silently return nothing.
//
// WHY PREFIXES
//
// Both tables used `tokenize='porter unicode61'`. Porter is an English stemmer:
// it makes "running" match "run", and it makes a hash of code-switched text,
// stemming Hinglish tokens into nonsense that matches nothing. Migration 007
// drops it for `unicode61 remove_diacritics 2`.
//
// That loses the stemming, so this builder compensates by emitting `token*`
// for tokens of 3+ characters. The `prefix='2 3'` index is what makes that
// fast. The side effect is one users have been wanting anyway: typing "post"
// now matches "postgres".
//
// Pure — no DB, no browser globals. Its own test coverage.

/** Tokens this short are matched exactly; anything longer gets a prefix. */
const MIN_PREFIX_LEN = 3;
/** Tokens shorter than this are dropped entirely. */
const MIN_TOKEN_LEN = 2;

export interface FtsQueryOptions {
  /** Support "quoted phrases" as exact phrase matches. Default true. */
  phrases?: boolean;
}

/**
 * Build an FTS5 MATCH expression, or "" when the query has nothing usable in
 * it (callers skip the FTS lane on empty).
 */
export function buildFtsQuery(query: string, opts: FtsQueryOptions = {}): string {
  const usePhrases = opts.phrases ?? true;

  const phrases: string[] = [];
  let remainder = query;

  if (usePhrases) {
    remainder = query.replace(/"([^"]+)"/g, (_m, p: string) => {
      const inner = p.trim();
      // A phrase is only useful if something survives tokenisation.
      if (inner) phrases.push(`"${inner.replace(/"/g, '""')}"`);
      return " ";
    });
  }

  const tokens = remainder
    .split(/\s+/)
    // Strip everything FTS5 would treat as syntax. What's left is safe to
    // interpolate: letters, numbers, combining marks and underscore.
    //
    // \p{M} is not optional padding. In Devanagari the vowel signs (मात्रा) are
    // combining marks, NOT letters — so a letters-only class silently eats them
    // and turns "मुझे याद" into "मझ यद", which matches nothing and is also two
    // characters shorter, dropping the tokens below the prefix threshold. This
    // module exists because migration 007 dropped an English stemmer for the
    // sake of code-switched text; mangling Devanagari here would have given
    // that back with the other hand.
    .map((t) => t.replace(/[^\p{L}\p{N}\p{M}_]/gu, ""))
    .filter((t) => t.length >= MIN_TOKEN_LEN)
    .map((t) => (t.length >= MIN_PREFIX_LEN ? `${t}*` : t));

  const parts = [...phrases, ...tokens];
  if (parts.length === 0) return "";
  return parts.join(" OR ");
}
