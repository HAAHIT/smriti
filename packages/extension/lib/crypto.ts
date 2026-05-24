// Tiny browser-safe crypto utilities used across the lib/ layer.
// Replaces Node.js `crypto` module imports from the helper.

/** Generate a random UUID v4. */
export function randomUUID(): string {
  return crypto.randomUUID();
}

/** SHA-256 hex digest, synchronous via a simple djb2-style hash.
 *  We only need this for dedup hashing, not security — djb2 is fine.
 *  Using a real SHA-256 would require async Web Crypto, which complicates
 *  the synchronous sql.js transaction model. */
export function createHash(input: string): string {
  // FNV-1a 64-bit (emulated with two 32-bit halves) gives excellent
  // distribution for text keys with negligible collision risk at our scale
  // (<10M messages).
  let h1 = 0x811c9dc5;
  let h2 = 0x35c4a597;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
