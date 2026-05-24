// Background indexing worker.
//
// Periodically pulls unembedded messages from the DB, embeds them, stores
// the vectors. Runs in-process inside the helper. Designed to be unobtrusive:
//   - Lazy: doesn't load the model until there's actually work or a search.
//   - Bounded: processes BATCH_SIZE per tick, then yields control via setTimeout.
//   - Resilient: a single embed failure logs and moves on, never crashes the
//     worker. The unembedded row stays unembedded and will be picked next tick.

import { log } from "./logger.js";
import {
  embedBatch,
  getPendingMessages,
  storeEmbedding,
  countEmbedStatus,
} from "./embeddings.js";

const TICK_INTERVAL_MS = 5_000;       // when there's work
const IDLE_INTERVAL_MS = 30_000;      // when nothing pending (reduced from 60s)
const BATCH_SIZE = 16;                // messages per tick
const MAX_CONSECUTIVE_ERRORS = 5;     // stop retrying after this many failures in a row

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let totalEmbedded = 0;
let consecutiveErrors = 0;

export function startIndexWorker(): void {
  if (running) return;
  running = true;
  consecutiveErrors = 0;
  // Small initial delay so the helper can finish boot before paying model load.
  scheduleNext(2_000);
  log.info("index worker started");
}

export function stopIndexWorker(): void {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

function scheduleNext(ms: number): void {
  if (!running) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void tick(); }, ms);
}

async function tick(): Promise<void> {
  if (!running) return;

  // If we've been failing repeatedly, back off significantly to avoid hot-looping.
  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    log.warn("index worker: too many consecutive errors, backing off", { errors: consecutiveErrors });
    scheduleNext(IDLE_INTERVAL_MS * 4);
    return;
  }

  const pending = getPendingMessages(BATCH_SIZE);
  if (pending.length === 0) {
    consecutiveErrors = 0; // reset on idle — not an error state
    scheduleNext(IDLE_INTERVAL_MS);
    return;
  }

  const t0 = Date.now();
  try {
    const vecs = await embedBatch(pending.map((p) => p.content_text));
    let batchStored = 0;
    for (let i = 0; i < pending.length; i++) {
      const row = pending[i]!;
      const v = vecs[i];
      if (!v) continue;
      try {
        storeEmbedding(row.id, v);
        totalEmbedded++;
        batchStored++;
      } catch (e) {
        log.warn("store embedding failed", { id: row.id, err: String(e) });
      }
    }
    consecutiveErrors = 0; // success — reset error counter

    // Log progress periodically.
    if (totalEmbedded % 50 === 0 || pending.length < BATCH_SIZE) {
      const s = countEmbedStatus();
      log.info("indexing progress", {
        batch_stored: batchStored,
        batch_ms: Date.now() - t0,
        total_embedded: s.embedded,
        total_pending: s.pending,
      });
    }
  } catch (e) {
    consecutiveErrors++;
    log.error("index batch failed", {
      err: String(e),
      consecutive_errors: consecutiveErrors,
      // Surface model download errors explicitly.
      hint: String(e).includes("fetch") || String(e).includes("network")
        ? "model download may have failed — check internet connection"
        : String(e).includes("onnx") || String(e).includes("ONNX")
        ? "ONNX runtime error — try restarting the helper"
        : undefined,
    });
    // Back off with increasing delay on errors.
    const backoff = Math.min(IDLE_INTERVAL_MS * consecutiveErrors, IDLE_INTERVAL_MS * 8);
    scheduleNext(backoff);
    return;
  }

  scheduleNext(TICK_INTERVAL_MS);
}
