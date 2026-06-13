// E2E-encrypted sync — memories + memory_embeddings only, via a
// zero-knowledge relay (see packages/sync-relay).
//
// Every sync_now does a full pull -> merge -> full push of the `memories`
// table (including tombstones). This is deliberately whole-state rather than
// incremental: memory stores are small by design, so the simplicity of
// "the relay blob is always the full current state" outweighs the cost of
// re-sending it. Last-write-wins by updated_at; a local soft-delete always
// wins over an incoming edit (no resurrection) and re-propagates on the next
// push.
//
// The recovery code (the only secret) lives in chrome.storage.local, never
// in the sql.js DB — so it can never end up in a JSON export.

import { dbAll, dbGet, dbRun, markDirty } from "./db.js";
import { randomUUID } from "./crypto.js";
import { deleteMemory, storeMemoryEmbedding } from "./memory.js";
import {
  deriveSyncKeys,
  generateRecoveryCode,
  normalizeRecoveryCode,
  encryptJson,
  decryptJson,
} from "./sync-crypto.js";
import type { MemoryKind, Platform } from "@smriti/shared";

// Replace after deploying packages/sync-relay (`wrangler deploy`) — also
// update the matching host_permissions / connect-src entries in
// wxt.config.ts.
const DEFAULT_RELAY_URL = "https://smriti-sync-relay.YOUR-SUBDOMAIN.workers.dev";

const SECRET_KEY = "smriti_sync_secret";

// ─── chrome.storage.local secret ───────────────────────────────────────────

interface SyncSecret {
  recoveryCode: string;
}

async function loadSecret(): Promise<SyncSecret | null> {
  const obj = await chrome.storage.local.get(SECRET_KEY);
  const v = obj[SECRET_KEY] as SyncSecret | undefined;
  return v && typeof v.recoveryCode === "string" ? v : null;
}

async function saveSecret(recoveryCode: string): Promise<void> {
  await chrome.storage.local.set({ [SECRET_KEY]: { recoveryCode } satisfies SyncSecret });
}

async function clearSecret(): Promise<void> {
  await chrome.storage.local.remove(SECRET_KEY);
}

// ─── sync_config row ────────────────────────────────────────────────────────

interface SyncConfigRow {
  enabled: number;
  sync_id: string | null;
  device_id: string | null;
  last_synced_at: string | null;
}

function getSyncConfigRow(): SyncConfigRow {
  return (
    dbGet<SyncConfigRow>(
      "SELECT enabled, sync_id, device_id, last_synced_at FROM sync_config WHERE id = 1",
    ) ?? { enabled: 0, sync_id: null, device_id: null, last_synced_at: null }
  );
}

function setSyncConfig(patch: Partial<SyncConfigRow>): void {
  const cols = Object.keys(patch) as Array<keyof SyncConfigRow>;
  if (cols.length === 0) return;
  const sets = cols.map((c) => `${c} = ?`).join(", ");
  dbRun(`UPDATE sync_config SET ${sets} WHERE id = 1`, cols.map((c) => patch[c] ?? null));
  markDirty();
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface SyncStatus {
  enabled: boolean;
  syncId: string | null;
  deviceId: string | null;
  lastSyncedAt: string | null;
}

export function getSyncStatus(): SyncStatus {
  const cfg = getSyncConfigRow();
  return {
    enabled: !!cfg.enabled,
    syncId: cfg.sync_id,
    deviceId: cfg.device_id,
    lastSyncedAt: cfg.last_synced_at,
  };
}

// Start a brand-new sync group: generate a recovery code, derive its keys,
// and persist it as this device's secret. The caller must show the returned
// recoveryCode to the user — it's the only way to join from another device.
export async function setupSync(): Promise<{ recoveryCode: string; syncId: string }> {
  const recoveryCode = generateRecoveryCode();
  const { syncId } = await deriveSyncKeys(recoveryCode);
  await saveSecret(recoveryCode);
  setSyncConfig({ enabled: 1, sync_id: syncId, device_id: randomUUID(), last_synced_at: null });
  return { recoveryCode, syncId };
}

// Join an existing sync group using a recovery code from another device.
export async function joinSync(recoveryCode: string): Promise<{ syncId: string }> {
  const { syncId } = await deriveSyncKeys(recoveryCode);
  await saveSecret(recoveryCode);
  setSyncConfig({ enabled: 1, sync_id: syncId, device_id: randomUUID(), last_synced_at: null });
  return { syncId };
}

// Stop syncing on this device. Local-only: does not touch the relay, so
// other devices in the sync group are unaffected.
export async function disableSync(): Promise<void> {
  await clearSecret();
  setSyncConfig({ enabled: 0, sync_id: null, device_id: null, last_synced_at: null });
}

export interface SyncResult {
  pulled: number;
  pushed: number;
  inserted: number;
  updated: number;
  deleted: number;
  skipped: number;
  lastSyncedAt: string;
}

export async function syncNow(): Promise<SyncResult> {
  const cfg = getSyncConfigRow();
  if (!cfg.enabled || !cfg.sync_id) throw new Error("sync is not enabled");
  const secret = await loadSecret();
  if (!secret) throw new Error("sync recovery code is missing");
  const { encKey } = await deriveSyncKeys(secret.recoveryCode);

  const tally = { inserted: 0, updated: 0, deleted: 0, skipped: 0 };
  let pulled = 0;
  const remoteBlob = await relayGet(cfg.sync_id);
  if (remoteBlob && remoteBlob.length > 0) {
    const remoteRows = await decryptJson<ChangesetMemory[]>(encKey, remoteBlob);
    pulled = remoteRows.length;
    for (const row of remoteRows) tally[mergeRemoteMemory(row)]++;
  }

  const localRows = exportAllMemories();
  await relayPut(cfg.sync_id, await encryptJson(encKey, localRows));

  const lastSyncedAt = new Date().toISOString();
  setSyncConfig({ last_synced_at: lastSyncedAt });
  return { pulled, pushed: localRows.length, lastSyncedAt, ...tally };
}

// ─── Changeset ──────────────────────────────────────────────────────────────
//
// A "full state" snapshot of the memories table. Tombstones (deleted_at set)
// carry only id/updated_at/deleted_at — nothing else about a deleted memory
// matters to a peer.

interface ChangesetTombstone {
  id: string;
  updated_at: string;
  deleted_at: string;
}

// Present in full only when deleted_at is null.
interface ChangesetMemoryData {
  id: string;
  updated_at: string;
  deleted_at: null;
  kind: MemoryKind;
  text: string;
  norm_text: string;
  source: "auto" | "manual";
  source_platform: Platform | null;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
  pinned: boolean;
  salience: number;
  embedding?: string; // base64-encoded Float32Array
}

type ChangesetMemory = ChangesetTombstone | ChangesetMemoryData;

interface MemoryRow {
  id: string;
  kind: MemoryKind;
  text: string;
  norm_text: string;
  source: "auto" | "manual";
  source_platform: Platform | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  last_used_at: string | null;
  use_count: number;
  pinned: number;
  salience: number;
}

function exportAllMemories(): ChangesetMemory[] {
  const rows = dbAll<MemoryRow>(
    `SELECT id, kind, text, norm_text, source, source_platform, created_at,
            updated_at, deleted_at, last_used_at, use_count, pinned, salience
     FROM memories`,
  );
  const embeddings = new Map(
    dbAll<{ memory_id: string; vec: Uint8Array }>(
      "SELECT memory_id, vec FROM memory_embeddings",
    ).map((r) => [r.memory_id, r.vec]),
  );
  return rows.map((r): ChangesetMemory => {
    if (r.deleted_at !== null) {
      return { id: r.id, updated_at: r.updated_at, deleted_at: r.deleted_at };
    }
    const out: ChangesetMemoryData = {
      id: r.id,
      updated_at: r.updated_at,
      deleted_at: null,
      kind: r.kind,
      text: r.text,
      norm_text: r.norm_text,
      source: r.source,
      source_platform: r.source_platform,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
      use_count: r.use_count,
      pinned: !!r.pinned,
      salience: r.salience,
    };
    const vec = embeddings.get(r.id);
    if (vec) out.embedding = bytesToBase64(vec);
    return out;
  });
}

// ─── Merge ──────────────────────────────────────────────────────────────────

type MergeOutcome = "inserted" | "updated" | "deleted" | "skipped";

function mergeRemoteMemory(remote: ChangesetMemory): MergeOutcome {
  const local = dbGet<{ id: string; norm_text: string; updated_at: string; deleted_at: string | null }>(
    "SELECT id, norm_text, updated_at, deleted_at FROM memories WHERE id = ?",
    [remote.id],
  );

  if (!local) {
    if (remote.deleted_at !== null) return "skipped"; // tombstone for an id we never had
    if (normTextCollides(remote.norm_text, remote.id)) return "skipped";
    insertRemoteMemory(remote);
    return "inserted";
  }

  // Local delete always wins — no resurrection. The tombstone re-propagates
  // to the peer on this device's next push.
  if (local.deleted_at) return "skipped";

  if (remote.deleted_at !== null) {
    if (remote.updated_at > local.updated_at) {
      deleteMemory(remote.id);
      return "deleted";
    }
    return "skipped";
  }

  if (remote.updated_at <= local.updated_at) return "skipped"; // local is newer (or equal); will be pushed

  if (remote.norm_text !== local.norm_text && normTextCollides(remote.norm_text, remote.id)) {
    return "skipped"; // remote's new text collides with a different local memory; resolves on a future sync
  }

  updateFromRemote(remote, local.norm_text);
  return "updated";
}

function normTextCollides(normText: string, exceptId: string): boolean {
  return !!dbGet<{ id: string }>(
    "SELECT id FROM memories WHERE norm_text = ? AND deleted_at IS NULL AND id != ?",
    [normText, exceptId],
  );
}

function insertRemoteMemory(remote: ChangesetMemoryData): void {
  dbRun(
    `INSERT INTO memories
       (id, kind, text, norm_text, source, source_platform,
        source_conversation_id, source_message_id, created_at, updated_at,
        last_used_at, use_count, pinned, salience, status, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, 'active', NULL)`,
    [
      remote.id, remote.kind, remote.text, remote.norm_text, remote.source,
      remote.source_platform, remote.created_at, remote.updated_at,
      remote.last_used_at, remote.use_count,
      remote.pinned ? 1 : 0, remote.salience,
    ],
  );
  if (remote.embedding) storeMemoryEmbedding(remote.id, base64ToFloat32(remote.embedding));
  markDirty();
}

// use_count / last_used_at / created_at / source_conversation_id /
// source_message_id are device-local and never overwritten by a remote
// update.
function updateFromRemote(remote: ChangesetMemoryData, oldNormText: string): void {
  dbRun(
    `UPDATE memories SET kind = ?, text = ?, norm_text = ?, source = ?,
       source_platform = ?, updated_at = ?, pinned = ?, salience = ?
     WHERE id = ?`,
    [
      remote.kind, remote.text, remote.norm_text, remote.source,
      remote.source_platform, remote.updated_at,
      remote.pinned ? 1 : 0, remote.salience, remote.id,
    ],
  );
  if (remote.embedding) {
    storeMemoryEmbedding(remote.id, base64ToFloat32(remote.embedding));
  } else if (remote.norm_text !== oldNormText) {
    // Text changed but no embedding was supplied — drop the stale one so the
    // index worker recomputes it against the new text.
    dbRun("DELETE FROM memory_embeddings WHERE memory_id = ?", [remote.id]);
  }
  markDirty();
}

// ─── Relay client ───────────────────────────────────────────────────────────

async function relayGet(syncId: string): Promise<Uint8Array | null> {
  const res = await fetch(`${DEFAULT_RELAY_URL}/v1/blob/${syncId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`relay GET failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function relayPut(syncId: string, blob: Uint8Array<ArrayBuffer>): Promise<void> {
  const res = await fetch(`${DEFAULT_RELAY_URL}/v1/blob/${syncId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: blob,
  });
  if (!res.ok) throw new Error(`relay PUT failed: ${res.status}`);
}

// ─── base64 <-> bytes ───────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function base64ToFloat32(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

// normalizeRecoveryCode is re-exported for the Settings UI to validate a
// pasted recovery code before calling join_sync.
export { normalizeRecoveryCode };
