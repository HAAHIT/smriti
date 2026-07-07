// Offscreen Document — the persistent compute engine of the extension.
//
// Responsibilities:
//   • Owns the sql.js SQLite database (loaded from / flushed to OPFS).
//   • Runs the Transformers.js embedding indexer loop.
//   • Handles all message requests from background / options / sidebar.
//
// Message protocol:
//   Sender sets { target: "offscreen", ... } on the message.
//   This document ignores any message not targeting it.
//
// Boot sequence:
//   1. initDb()     — load/create SQLite from OPFS, apply migrations.
//   2. startIndexWorker() — begins lazily embedding pending messages.
//   3. Signal "offscreen_ready" to background.

import { initDb, flushToOpfs, dbAll } from "../lib/db.js";
import { startIndexWorker } from "../lib/index-worker.js";
import { ingestEvents } from "../lib/ingest.js";
import {
  countEmbedStatus,
  isModelReady,
  EMBED_MODEL,
} from "../lib/embeddings.js";
import {
  search,
  getConversation,
  listRecentConversations,
  getStats,
  lookupByPlatform,
  wipeArchive,
} from "../lib/search.js";
import { getOutline } from "../lib/outline.js";
import {
  startBackfill,
  cancelBackfill,
  getBackfillStatuses,
} from "../lib/backfill.js";
import {
  recallMemories,
  listMemories,
  addMemory,
  editMemory,
  setMemoryPinned,
  deleteMemory,
  memoryStats,
  touchMemories,
  extractionSweep,
  pendingExtractionCount,
} from "../lib/memory.js";
import { getSyncStatus, setupSync, joinSync, syncNow, disableSync } from "../lib/sync.js";
import {
  getVaultStatus,
  enableVault,
  disableVault,
  syncRound,
  syncConversation,
  resyncAll,
  startVaultSyncLoop,
} from "./vault-sync.js";
import type { CaptureEvent, Platform, MemoryKind, MemorySource, SearchHit } from "@smriti/shared";

// ─── Boot ─────────────────────────────────────────────────────────────────────

// True once initDb() has completed. Surfaced via the "ping" RPC so a restarted
// background service worker can confirm this (surviving) doc is ready without
// waiting for the one-shot "offscreen_ready" broadcast it already missed.
let dbReady = false;

/** Initialize the DB, start the index worker, and signal readiness. */
async function boot(): Promise<void> {
  const t0 = Date.now();
  console.log("[smriti:offscreen] booting");
  try {
    await initDb();
    console.log("[smriti:offscreen] db ready");
    startIndexWorker();
    
    // Start vault sync loop if enabled
    startVaultSyncLoop();

    dbReady = true;
    // Notify background that offscreen is ready.
    chrome.runtime.sendMessage({ kind: "offscreen_ready" }).catch(() => {});
    console.log(`[smriti:offscreen] boot complete ms=${Date.now() - t0}`);
  } catch (e) {
    console.error("[smriti:offscreen] boot failed", e);
    chrome.runtime.sendMessage({ kind: "offscreen_error", error: String(e) }).catch(() => {});
  }
}

void boot();

// ─── Message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (msg: unknown, _sender, sendResponse: (r: unknown) => void): boolean => {
    if (
      typeof msg !== "object" ||
      msg === null ||
      (msg as { target?: string }).target !== "offscreen"
    ) {
      return false;
    }

    const m = msg as { target: "offscreen"; type: string; id?: string; [k: string]: unknown };
    handleMessage(m)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep channel open for async response
  },
);

// ─── Handler dispatch ─────────────────────────────────────────────────────────

/** Dispatch one offscreen RPC, selected by m.type, to its subsystem. */
async function handleMessage(
  m: { type: string; id?: string; [k: string]: unknown },
): Promise<unknown> {
  switch (m.type) {
    case "ping":
      return { pong: true, ready: dbReady };

    // hello — backward compat with options page version check.
    case "hello":
      return {
        helper_version: chrome.runtime.getManifest().version,
        protocol: 1,
        type: "hello",
      };

    // claude_code_scan — not implemented in browser context (no filesystem access).
    // Return a graceful no-op so options page doesn't show an error.
    case "claude_code_scan":
      return { files_scanned: 0, events_ingested: 0 };

    case "ingest": {
      const events = m.events as CaptureEvent[];
      const result = ingestEvents(events);
      return result;
    }

    case "search": {
      const results = await search(
        m.query as string,
        (m.limit as number | undefined) ?? 20,
      );
      return { results };
    }

    case "get_conversation": {
      return getConversation(m.conversation_id as string);
    }

    case "stats": {
      return getStats();
    }

    case "capture_state": {
      const rows = dbAll<{ platform: string; enabled: number; last_seen_at: string | null; health: string }>(
        "SELECT platform, enabled, last_seen_at, health FROM capture_state",
      );
      return { platforms: rows };
    }

    case "daily_stats": {
      const days = (m.days as number | undefined) ?? 7;
      const rows = dbAll<{ date: string; platform: string; messages_count: number; user_messages_count: number }>(
        `SELECT date, platform, messages_count, user_messages_count
         FROM daily_stats
         WHERE date >= date('now', ?)
         ORDER BY date DESC`,
        [`-${days} days`],
      );
      return { rows };
    }

    case "embed_status": {
      const s = countEmbedStatus();
      return {
        ...s,
        model: isModelReady() ? EMBED_MODEL : null,
      };
    }

    case "get_outline": {
      return getOutline(m.conversation_id as string);
    }

    case "list_recent_conversations": {
      const convos = listRecentConversations((m.limit as number | undefined) ?? 30);
      return { conversations: convos };
    }

    case "get_by_platform": {
      const meta = lookupByPlatform(m.platform as Platform, m.platform_conv_id as string);
      const segments = meta ? getOutline(meta.id).segments : [];
      return { meta, segments };
    }

    case "start_backfill": {
      const result = await startBackfill(m.platform as Platform);
      return result;
    }

    case "cancel_backfill": {
      cancelBackfill(m.platform as Platform);
      return { ok: true };
    }

    case "backfill_status": {
      const jobs = getBackfillStatuses(m.platform as Platform | undefined);
      return { jobs };
    }

    // ─── Memory layer ─────────────────────────────────────────────────────
    case "recall_memories": {
      const memories = await recallMemories(
        m.query as string,
        (m.limit as number | undefined) ?? 6,
      );
      return { memories };
    }

    case "list_memories": {
      const memories = listMemories({
        kind: m.kind as MemoryKind | "all" | undefined,
        query: m.query as string | undefined,
        limit: m.limit as number | undefined,
        sort: m.sort as "default" | "recent" | undefined,
      });
      return { memories };
    }

    case "add_memory": {
      const validKinds: MemoryKind[] = ["identity", "preference", "project", "decision", "fact"];
      const kind = validKinds.includes(m.kind as MemoryKind) ? (m.kind as MemoryKind) : "fact";
      const source: MemorySource = m.source === "auto" ? "auto" : "manual";
      const memory = addMemory(
        m.text as string,
        kind,
        source,
        {
          platform: (m.platform as Platform | null | undefined) ?? null,
          conversationId: (m.conversation_id as string | null | undefined) ?? null,
          messageId: (m.message_id as string | null | undefined) ?? null,
        },
      );
      return { memory };
    }

    case "edit_memory": {
      const ok = editMemory(m.id as string, m.text as string, m.kind as MemoryKind | undefined);
      return { ok };
    }

    case "pin_memory": {
      setMemoryPinned(m.id as string, !!m.pinned);
      return { ok: true };
    }

    case "delete_memory": {
      deleteMemory(m.id as string);
      return { ok: true };
    }

    case "memory_stats": {
      return memoryStats();
    }

    case "touch_memories": {
      touchMemories((m.ids as string[]) ?? []);
      return { ok: true };
    }

    // Run extraction over the whole backlog so the user sees their memory
    // materialize (the "Build my memory" button). Chunked and yielding so the
    // single offscreen thread stays responsive and can stream live progress to
    // the UI instead of blocking opaquely on one long synchronous pass.
    case "build_memory_now": {
      const total = pendingExtractionCount();
      let created = 0;
      let processed = 0;
      let guard = 0;
      const emitBuild = () =>
        chrome.runtime
          .sendMessage({ kind: "build_progress", processed, total, created })
          .catch(() => {});
      emitBuild();
      // 128-msg chunks (×800 guard ≈ 102k messages) — small enough for smooth
      // progress, with a yield between each so broadcasts flush and the
      // keepalive ping can run.
      while (guard < 800) {
        const r = extractionSweep(128);
        if (r.processed === 0) break;
        created += r.created;
        processed += r.processed;
        emitBuild();
        await new Promise((res) => setTimeout(res, 0));
        guard++;
      }
      return { created, processed, total, stats: memoryStats() };
    }

    case "wipe_archive": {
      const cleared = wipeArchive();
      return { cleared };
    }

    case "sync_status":
      return getSyncStatus();
    case "sync_setup":
      return setupSync();
    case "sync_join":
      return joinSync(m.recovery_code as string);
    case "sync_now":
      return syncNow();
    case "sync_disable": {
      await disableSync();
      return { ok: true };
    }

    case "flush": {
      await flushToOpfs();
      return { ok: true };
    }

    // ─── Vault sync ───────────────────────────────────────────────────────
    case "vault_status":
      return getVaultStatus();

    case "vault_enable":
      return enableVault();

    case "vault_disable":
      return disableVault();

    case "vault_sync_now":
      return syncRound();

    case "vault_sync_conversation":
      return syncConversation(m.conversation_id as string);

    case "vault_resync_all":
      return resyncAll();

    default:
      throw new Error(`unknown offscreen message type: ${String(m.type)}`);
  }
}
