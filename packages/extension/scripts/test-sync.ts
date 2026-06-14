// Headless sanity check for E2E sync.
// Run: npx tsx scripts/test-sync.ts
//
// Two surfaces, both pure (no DB / no model), so they run under tsx the same
// way test-extract.ts does:
//   1. sync-crypto — the security-critical bit. Same recovery code on two
//      "devices" must derive the same key + syncId and round-trip a payload;
//      a different code must NOT be able to decrypt.
//   2. sync-merge — the last-write-wins / delete-wins decision table, the
//      highest-risk branching in the feature.

import {
  generateRecoveryCode,
  normalizeRecoveryCode,
  deriveSyncKeys,
  encryptJson,
  decryptJson,
} from "../lib/sync-crypto.js";
import { decideMerge, type MergeLocal, type MergeRemote, type MergeOutcome } from "../lib/sync-merge.js";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  cond ? pass++ : fail++;
}

async function checkThrows(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    check(name, false);
  } catch {
    check(name, true);
  }
}

// ─── Merge decision table ─────────────────────────────────────────────────────

const NEW = "2026-02-02T00:00:00.000Z";
const OLD = "2026-02-01T00:00:00.000Z";
const yes = () => true; // norm_text collides with a different active row
const no = () => false; // no collision

function remoteActive(updated_at: string, norm_text: string): MergeRemote {
  return { id: "r", updated_at, deleted_at: null, norm_text };
}
function remoteTomb(updated_at: string): MergeRemote {
  return { id: "r", updated_at, deleted_at: updated_at };
}
function local(updated_at: string, deleted_at: string | null, norm_text = "x"): MergeLocal {
  return { updated_at, deleted_at, norm_text };
}

const cases: Array<[string, MergeOutcome]> = [
  ["new active row, no collision → inserted", decideMerge(remoteActive(NEW, "x"), null, no)],
  ["tombstone for unknown id → skipped", decideMerge(remoteTomb(NEW), null, no)],
  ["new active row, norm_text collides → skipped", decideMerge(remoteActive(NEW, "x"), null, yes)],
  ["local is a tombstone (delete wins) → skipped", decideMerge(remoteActive(NEW, "x"), local(OLD, OLD), no)],
  ["remote delete newer than local → deleted", decideMerge(remoteTomb(NEW), local(OLD, null), no)],
  ["remote delete older than local → skipped", decideMerge(remoteTomb(OLD), local(NEW, null), no)],
  ["remote active newer, no collision → updated", decideMerge(remoteActive(NEW, "x"), local(OLD, null, "x"), no)],
  ["remote active older → skipped", decideMerge(remoteActive(OLD, "x"), local(NEW, null, "x"), no)],
  ["remote active newer, changed text collides → skipped", decideMerge(remoteActive(NEW, "y"), local(OLD, null, "x"), yes)],
  ["remote active equal updated_at → skipped", decideMerge(remoteActive(NEW, "x"), local(NEW, null, "x"), no)],
  ["remote active newer, same text, collide-fn true → updated", decideMerge(remoteActive(NEW, "x"), local(OLD, null, "x"), yes)],
];

const expected: MergeOutcome[] = [
  "inserted", "skipped", "skipped", "skipped", "deleted",
  "skipped", "updated", "skipped", "skipped", "skipped", "updated",
];

console.log("\n=== Merge decision table ===\n");
check("merge table length matches expected", cases.length === expected.length);
cases.forEach(([name, got], i) => check(`${name} (got ${got})`, got === expected[i]));

// ─── Crypto ───────────────────────────────────────────────────────────────────

async function cryptoTests(): Promise<void> {
  console.log("\n=== Crypto ===\n");

  const code = generateRecoveryCode();
  check("generateRecoveryCode → 32 hex chars in 8 dash groups",
    /^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/.test(code));

  check("normalizeRecoveryCode strips dashes/case → 32 lowercase hex",
    normalizeRecoveryCode("AAAA-bbbb-CCCC-dddd-EEEE-ffff-0000-1111").length === 32);
  await checkThrows("normalizeRecoveryCode rejects too-short input",
    async () => normalizeRecoveryCode("abcd-1234"));

  // Two devices, same recovery code → identical derived material.
  const a = await deriveSyncKeys(code);
  const b = await deriveSyncKeys(code);
  check("same code → same syncId on both devices", a.syncId === b.syncId);
  check("syncId is 32 lowercase hex chars", /^[0-9a-f]{32}$/.test(a.syncId));

  // Different code → different syncId.
  const other = await deriveSyncKeys(generateRecoveryCode());
  check("different code → different syncId", other.syncId !== a.syncId);

  // Round-trip a memory-shaped payload (incl. a base64 embedding) across devices.
  const payload = [
    { id: "m1", kind: "identity", text: "I work in Rust", deleted_at: null, embedding: "AQIDBA==" },
    { id: "m2", updated_at: NEW, deleted_at: NEW },
  ];
  const blob = await encryptJson(a.encKey, payload);
  const round = await decryptJson<typeof payload>(b.encKey, blob);
  check("device B decrypts device A's blob → identical payload",
    JSON.stringify(round) === JSON.stringify(payload));

  check("ciphertext is not plaintext (no 'Rust' bytes in blob)",
    !new TextDecoder().decode(blob).includes("Rust"));

  // Wrong key cannot decrypt (AES-GCM auth failure).
  await checkThrows("wrong recovery code cannot decrypt the blob",
    async () => decryptJson(other.encKey, blob));
}

await cryptoTests();

console.log(`\nAssertions: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
