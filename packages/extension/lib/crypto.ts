// Tiny browser-safe crypto utilities used across the lib/ layer.
// Replaces Node.js `crypto` module imports from the helper.

/** Generate a random UUID v4. */
export function randomUUID(): string {
  return crypto.randomUUID();
}

/** Fast non-cryptographic 64-bit-wide hex digest for dedup keys.
 *
 *  Two FNV-1a passes over the same input with different initial basis values,
 *  concatenated into 16 hex chars. Note this is NOT 64-bit FNV-1a: the halves
 *  share the 32-bit prime and never carry into each other, so the real strength
 *  is closer to a single 32-bit hash than to 64 bits.
 *
 *  That is adequate for its only job — `UNIQUE (conversation_id, content_hash)`
 *  in `001_init`, i.e. idempotency when the same message is captured twice. The
 *  scope is one conversation, not the whole table. It is NOT suitable for
 *  security, content addressing, or global uniqueness.
 *
 *  A real SHA-256 would need async Web Crypto, which the synchronous sql.js
 *  transaction model in lib/db.ts cannot await mid-statement. */
export function createHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x35c4a597;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
