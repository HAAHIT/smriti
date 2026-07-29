// Vault Sync Engine
// Orchestrates exporting conversations to OKF markdown files on Google Drive.

import { dbAll, dbGet, dbRun, markDirty } from "./db.js";
import {
  OkfMessage,
  OkfRelatedMemory,
  renderOkf
} from "./okf-renderer.js";
import {
  hasValidToken,
  getAuthToken,
  revokeAuthToken,
  loadPathCache,
  persistPathCache,
  clearPathCache,
  ensureFolder,
  uploadFile,
  updateFile,
  getApiCallsThisRound,
  resetApiCallCount,
  DriveApiError
} from "./drive-client.js";
import type { ConversationMeta } from "@smriti/shared";

const SYNC_INTERVAL_MS = 5 * 60 * 1000;    // 5 minutes
const IDLE_INTERVAL_MS = 30 * 60 * 1000;   // 30 minutes
const BATCH_SIZE = 10;                     // conversations per round

let _syncTimer: ReturnType<typeof setTimeout> | null = null;
let _running = false;

// ─── Interfaces ─────────────────────────────────────────────────────────────

interface VaultConfigRow {
  enabled: number;
  vault_root_id: string | null;
  last_sync_at: string | null;
  total_synced: number;
  sync_errors: number;
}

interface VaultSyncRow {
  conversation_id: string;
  drive_file_id: string | null;
  filename: string;
  vault_path: string;
  last_synced_at: string;
  synced_msg_count: number;
  status: "synced" | "pending" | "error";
}

export interface VaultSyncResult {
  synced: number;
  skipped: number;
  errors: number;
  total_in_vault: number;
  duration_ms: number;
}

export interface VaultStatus {
  enabled: boolean;
  connected: boolean;
  lastSyncAt: string | null;
  totalSynced: number;
  pendingCount: number;
  errorCount: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getVaultConfig(): VaultConfigRow {
  return (
    dbGet<VaultConfigRow>("SELECT * FROM vault_config WHERE id = 1") ?? {
      enabled: 0,
      vault_root_id: null,
      last_sync_at: null,
      total_synced: 0,
      sync_errors: 0,
    }
  );
}

function updateVaultConfig(patch: Partial<VaultConfigRow>): void {
  const cols = Object.keys(patch) as Array<keyof VaultConfigRow>;
  if (cols.length === 0) return;
  const sets = cols.map((c) => `${c} = ?`).join(", ");
  dbRun(`UPDATE vault_config SET ${sets} WHERE id = 1`, cols.map((c) => patch[c] ?? null));
  markDirty();
}

function countSyncedFiles(): number {
  return (dbGet<{ n: number }>("SELECT COUNT(*) AS n FROM vault_sync_state WHERE status = 'synced'") ?? { n: 0 }).n;
}

function markSyncError(conversationId: string): void {
  dbRun(
    "UPDATE vault_sync_state SET status = 'error' WHERE conversation_id = ?",
    [conversationId]
  );
  markDirty();
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function getVaultStatus(): Promise<VaultStatus> {
  const config = getVaultConfig();

  const pendingCount = (dbGet<{ n: number }>(`
    SELECT COUNT(*) AS n FROM conversations c
    LEFT JOIN vault_sync_state v ON v.conversation_id = c.id
    WHERE v.conversation_id IS NULL OR c.last_message_at > v.last_synced_at
  `) ?? { n: 0 }).n;

  const errorCount = (dbGet<{ n: number }>("SELECT COUNT(*) AS n FROM vault_sync_state WHERE status = 'error'") ?? { n: 0 }).n;

  return {
    enabled: !!config.enabled,
    connected: hasValidToken(),
    lastSyncAt: config.last_sync_at,
    totalSynced: countSyncedFiles(),
    pendingCount,
    errorCount,
  };
}

export async function enableVault(): Promise<{ ok: true }> {
  try {
    // Get token interactively
    await getAuthToken(true);

    // Ensure root folder is created and cache is initialized
    await loadPathCache();
    const rootId = await ensureFolder("root");
    await persistPathCache();

    updateVaultConfig({ enabled: 1, vault_root_id: rootId });

    // Kick off first sync immediately, but don't await it
    setTimeout(() => { void syncRound(); }, 1000);
    startVaultSyncLoop();

    return { ok: true };
  } catch (e) {
    console.error("[smriti:vault] failed to enable vault", e);
    throw e;
  }
}

export async function disableVault(): Promise<{ ok: true }> {
  stopVaultSyncLoop();
  await revokeAuthToken();
  clearPathCache();
  await persistPathCache();
  updateVaultConfig({ enabled: 0 });
  return { ok: true };
}

// ─── Sync Engine ────────────────────────────────────────────────────────────

export function startVaultSyncLoop(): void {
  const config = getVaultConfig();
  if (!config.enabled) return;
  if (_syncTimer) return;
  // Initial delay: let the DB and index worker settle first
  scheduleNext(30_000);
  console.log("[smriti:vault] sync loop started");
}

export function stopVaultSyncLoop(): void {
  if (_syncTimer) {
    clearTimeout(_syncTimer);
    _syncTimer = null;
  }
}

function scheduleNext(ms: number): void {
  if (_syncTimer) clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => { void tick(); }, ms);
}

async function tick(): Promise<void> {
  const config = getVaultConfig();
  if (!config.enabled) {
    scheduleNext(IDLE_INTERVAL_MS);
    return;
  }

  if (!hasValidToken()) {
    // Token expired and can't refresh silently — wait for user action
    console.warn("[smriti:vault] no valid token, skipping sync");
    scheduleNext(IDLE_INTERVAL_MS);
    return;
  }

  try {
    _running = true;
    const result = await syncRound();
    _running = false;

    const next = result.synced > 0 || result.errors > 0
      ? SYNC_INTERVAL_MS      // More work to do
      : IDLE_INTERVAL_MS;     // All caught up
    scheduleNext(next);
  } catch (e) {
    _running = false;
    console.error("[smriti:vault] sync round failed", String(e));
    scheduleNext(IDLE_INTERVAL_MS);
  }
}

export async function syncRound(): Promise<VaultSyncResult> {
  if (!hasValidToken()) {
    throw new Error("Cannot sync: not connected to Google Drive");
  }

  const t0 = Date.now();
  let synced = 0, skipped = 0, errors = 0;

  resetApiCallCount();

  // Load Drive path cache from storage
  await loadPathCache();

  // Find conversations that need syncing:
  // 1. Not in vault_sync_state at all (never synced)
  // 2. In vault_sync_state but last_message_at > last_synced_at (updated)
  // 3. Or status = 'error'
  const pending = dbAll<{
    id: string;
    platform: string;
    platform_conv_id: string;
    title: string | null;
    url: string | null;
    started_at: string;
    last_message_at: string;
  }>(`
    SELECT c.id, c.platform, c.platform_conv_id, c.title, c.url,
           c.started_at, c.last_message_at
    FROM conversations c
    LEFT JOIN vault_sync_state v ON v.conversation_id = c.id
    WHERE v.conversation_id IS NULL
       OR c.last_message_at > v.last_synced_at
       OR v.status = 'error'
    ORDER BY c.last_message_at DESC
    LIMIT ?
  `, [BATCH_SIZE]);

  for (const conv of pending) {
    if (!_running && _syncTimer !== null) {
      // Loop was disabled
      break;
    }

    try {
      await syncOneConversation(conv as ConversationMeta);
      synced++;
    } catch (e) {
      if (e instanceof DriveApiError && e.status === 429 && !e.retryable) {
        console.warn("[smriti:vault] aborting sync round early due to API quota", String(e));
        break; // Stop this round and try again next tick
      }

      console.error(`[smriti:vault] failed to sync ${conv.id}`, String(e));
      markSyncError(conv.id);
      errors++;
    }

    // Yield between conversations so the offscreen doc stays responsive
    await new Promise(r => setTimeout(r, 0));
  }

  // Persist path cache after the round
  await persistPathCache();

  // Update global vault config
  const totalInVault = countSyncedFiles();
  updateVaultConfig({
    last_sync_at: new Date().toISOString(),
    total_synced: totalInVault,
    sync_errors: errors,
  });

  const result: VaultSyncResult = {
    synced, skipped, errors,
    total_in_vault: totalInVault,
    duration_ms: Date.now() - t0,
  };

  console.log(
    `[smriti:vault] round: synced=${synced} errors=${errors} apiCalls=${getApiCallsThisRound()} ms=${result.duration_ms}`
  );
  return result;
}

export async function syncConversation(conversationId: string): Promise<VaultSyncResult> {
  const conv = dbGet<ConversationMeta>(
    "SELECT id, platform, platform_conv_id, title, url, started_at, last_message_at FROM conversations WHERE id = ?",
    [conversationId]
  );
  if (!conv) throw new Error("Conversation not found");

  const t0 = Date.now();
  resetApiCallCount();
  await loadPathCache();

  try {
    await syncOneConversation(conv);
    await persistPathCache();
    return {
      synced: 1, skipped: 0, errors: 0,
      total_in_vault: countSyncedFiles(),
      duration_ms: Date.now() - t0
    };
  } catch (e) {
    markSyncError(conversationId);
    await persistPathCache();
    throw e;
  }
}

export async function resyncAll(): Promise<VaultSyncResult> {
  dbRun("DELETE FROM vault_sync_state");
  markDirty();
  return syncRound();
}

async function syncOneConversation(conv: ConversationMeta): Promise<void> {
  // 1. Fetch messages
  const messages = dbAll<OkfMessage>(
    `SELECT id, role, content_text, created_at, position
     FROM messages WHERE conversation_id = ? ORDER BY position ASC`,
    [conv.id],
  );

  // 2. Fetch related memories (best-effort — empty array is fine)
  let memories: OkfRelatedMemory[] = [];
  try {
    const mems = dbAll<{ id: string; kind: string; text: string }>(
      `SELECT id, kind, text FROM memories
       WHERE source_conversation_id = ? AND status = 'active' AND deleted_at IS NULL
       LIMIT 10`,
      [conv.id],
    );
    memories = mems;
  } catch { /* memories are optional */ }

  // 3. Detect model from first assistant message
  const modelRow = dbGet<{ model: string | null }>(
    `SELECT model FROM messages
     WHERE conversation_id = ? AND model IS NOT NULL LIMIT 1`,
    [conv.id],
  );

  // 4. Render OKF
  // Create a proper OkfConversationMeta type since OkfConversationMeta may not exactly match ConversationMeta
  const okfMeta = {
    id: conv.id,
    platform: conv.platform,
    platform_conv_id: (conv as any).platform_conv_id ?? conv.id, // TS workaround for ConversationMeta
    title: conv.title,
    url: conv.url,
    started_at: conv.started_at,
    last_message_at: conv.last_message_at,
  };

  const okf = renderOkf(okfMeta, messages, memories, modelRow?.model);

  // 5. Ensure target folder exists on Drive
  const folderId = await ensureFolder(okf.directory);

  // 6. Check if already uploaded (has drive_file_id)
  const existing = dbGet<VaultSyncRow>(
    "SELECT * FROM vault_sync_state WHERE conversation_id = ?",
    [conv.id],
  );

  let driveFileId: string;

  try {
    if (existing?.drive_file_id) {
      // Update existing file
      const result = await updateFile(existing.drive_file_id, okf.markdown);
      driveFileId = result.fileId;
    } else {
      // Upload new file
      const result = await uploadFile(folderId, okf.filename, okf.markdown);
      driveFileId = result.fileId;
    }
  } catch (e) {
    // If updating fails with 404, it might have been deleted on Drive. Upload as new.
    if (existing?.drive_file_id && e instanceof DriveApiError && e.status === 404) {
      console.warn(`[smriti:vault] Drive file not found for ${conv.id}, uploading as new`);
      const result = await uploadFile(folderId, okf.filename, okf.markdown);
      driveFileId = result.fileId;
    } else {
      throw e;
    }
  }

  // 7. Update vault_sync_state
  const now = new Date().toISOString();
  dbRun(
    `INSERT INTO vault_sync_state
       (conversation_id, drive_file_id, filename, vault_path,
        last_synced_at, synced_msg_count, status)
     VALUES (?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(conversation_id) DO UPDATE SET
       drive_file_id = excluded.drive_file_id,
       filename = excluded.filename,
       vault_path = excluded.vault_path,
       last_synced_at = excluded.last_synced_at,
       synced_msg_count = excluded.synced_msg_count,
       status = 'synced'`,
    [conv.id, driveFileId, okf.filename, okf.directory, now, messages.length],
  );
  markDirty();
}
