// Tiny browser-safe crypto utilities used across the lib/ layer.
// Replaces Node.js `crypto` module imports from the helper.

/** Generate a random UUID v4. */
export function randomUUID(): string {
  return crypto.randomUUID();
}

/**
 * Fast, synchronous, **non-cryptographic** 16-hex-char digest.
 *
 * Not SHA-256 and not a 64-bit hash, despite what earlier comments here
 * claimed. It is two 32-bit FNV-1a passes over the same input that differ only
 * in their starting seed, concatenated. Nothing is carried or mixed between the
 * halves, so they are not independent hashes of the input — the effective
 * collision resistance is materially weaker than the 64-bit output width
 * suggests.
 *
 * That is acceptable for what it does today: keying per-conversation message
 * dedup (`UNIQUE (conversation_id, content_hash)`), where the input space per
 * conversation is small and a collision costs one dropped duplicate, not a
 * security failure. Do not use it for anything where an adversary picks the
 * input, and re-check this bound before widening what gets hashed.
 *
 * It is synchronous by design: real SHA-256 in the browser means async Web
 * Crypto, which does not fit the synchronous sql.js transaction model.
 */
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
