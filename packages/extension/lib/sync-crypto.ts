// E2E sync crypto — HKDF key derivation + AES-256-GCM, native Web Crypto only.
//
// A user-generated 128-bit "recovery code" is the single secret. From it we
// derive two values via HKDF-SHA256:
//   - an AES-256-GCM key, used to encrypt/decrypt the memories blob
//   - a sync ID, a non-secret lookup key for the zero-knowledge relay
// The relay sees only the sync ID and opaque ciphertext — never the recovery
// code or the derived key.

const SALT = new TextEncoder().encode("smriti-sync-salt-v1");
const ENC_KEY_INFO = new TextEncoder().encode("smriti-sync-enc-v1");
const SYNC_ID_INFO = new TextEncoder().encode("smriti-sync-id-v1");

// ─── Recovery code ──────────────────────────────────────────────────────────

/** Generate a fresh 128-bit recovery code, formatted as 8 groups of 4 hex chars. */
export function generateRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return groupHex(bytesToHex(bytes));
}

/** Strip formatting from a user-entered recovery code, returning 32 lowercase hex chars. */
export function normalizeRecoveryCode(input: string): string {
  const hex = input.trim().toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 32) {
    throw new Error("Recovery code must contain 32 hex characters");
  }
  return hex;
}

/** Format 32 hex chars as 8 dash-separated groups of 4 for readability. */
function groupHex(hex: string): string {
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += 4) groups.push(hex.slice(i, i + 4));
  return groups.join("-");
}

// ─── Key derivation ─────────────────────────────────────────────────────────

/** The pair derived from a recovery code: the AES key and the relay sync ID. */
export interface SyncKeys {
  encKey: CryptoKey;
  syncId: string;
}

/**
 * Derive the AES-GCM encryption key and the relay sync ID from a recovery
 * code. The same code always derives the same pair, so two devices that share
 * a recovery code read/write the same relay blob — without the relay ever
 * seeing the code or the key.
 */
export async function deriveSyncKeys(recoveryCode: string): Promise<SyncKeys> {
  const ikm = hexToBytes(normalizeRecoveryCode(recoveryCode));
  const baseKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveKey",
    "deriveBits",
  ]);

  const encKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info: ENC_KEY_INFO },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  const syncIdBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info: SYNC_ID_INFO },
    baseKey,
    128,
  );
  const syncId = bytesToHex(new Uint8Array(syncIdBits));

  return { encKey, syncId };
}

// ─── Encryption ─────────────────────────────────────────────────────────────

/**
 * Encrypt a JSON-serializable value. Output is `iv (12 bytes) || ciphertext`,
 * where the ciphertext includes the AES-GCM auth tag.
 */
export async function encryptJson(key: CryptoKey, data: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const out = new Uint8Array(iv.length + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), iv.length);
  return out;
}

/** Decrypt a blob produced by encryptJson() and parse it as JSON. */
export async function decryptJson<T>(key: CryptoKey, blob: Uint8Array): Promise<T> {
  const iv = blob.slice(0, 12);
  const ciphertext = blob.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

// ─── hex helpers ────────────────────────────────────────────────────────────

/** Lowercase-hex-encode a byte array. */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Decode a hex string into bytes (inverse of bytesToHex). */
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
