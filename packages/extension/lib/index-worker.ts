// Background embedding indexer.
//
// Periodically pulls unembedded messages from the DB, embeds them via
// Transformers.js, and stores vectors back. Runs inside the Offscreen Document.
//
// Design:
//   - Lazy: doesn't load the model until there's actual work or a search.
//   - Bounded: BATCH_SIZE per tick, then yields via setTimeout.
//   - Resilient: single embed failure logs and continues; unembedded rows
//     stay pending and are retried next tick.
//   - Backs off with MAX_CONSECUTIVE_ERRORS circuit-breaker.

import {
  embedBatch,
  embedText,
  getPendingMessages,
  storeEmbedding,
  countEmbedStatus,
} from "./embeddings.js";
import {
  extractionSweep,
  getPendingMemoryEmbeddings,
  storeMemoryEmbedding,
} from "./memory.js";

const TICK_INTERVAL_MS = 5_000;
const IDLE_INTERVAL_MS = 30_000;
const BATCH_SIZE = 16;
const MEMORY_BATCH_SIZE = 12;
const EXTRACT_BATCH_SIZE = 64;
const MAX_CONSECUTIVE_ERRORS = 5;

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let totalEmbedded = 0;
let consecutiveErrors = 0;

export function startIndexWorker(): void {
  if (running) return;
  running = true;
  consecutiveErrors = 0;
  // Small initial delay so the offscreen document finishes DB boot first.
  scheduleNext(2_000);
  console.log("[smriti:index] worker started");
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

  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    console.warn("[smriti:index] too many consecutive errors, backing off", consecutiveErrors);
    scheduleNext(IDLE_INTERVAL_MS * 4);
    return;
  }

  // ── Memory extraction (cheap, no model) — runs every tick so memory builds
  //    itself from both live capture and imported history. ──
  let extracted = 0;
  try {
    extracted = extractionSweep(EXTRACT_BATCH_SIZE).created;
  } catch (e) {
    console.warn("[smriti:index] extraction sweep failed", String(e));
  }

  const pending = getPendingMessages(BATCH_SIZE);
  const pendingMem = getPendingMemoryEmbeddings(MEMORY_BATCH_SIZE);

  if (pending.length === 0 && pendingMem.length === 0) {
    consecutiveErrors = 0;
    // If extraction just created memories, come back promptly to embed them.
    scheduleNext(extracted > 0 ? TICK_INTERVAL_MS : IDLE_INTERVAL_MS);
    return;
  }

  const t0 = Date.now();
  try {
    let batchStored = 0;
    if (pending.length > 0) {
      const vecs = await embedBatch(pending.map((p) => p.content_text));
      for (let i = 0; i < pending.length; i++) {
        const row = pending[i]!;
        const v = vecs[i];
        if (!v) continue;
        try {
          storeEmbedding(row.id, v);
          totalEmbedded++;
          batchStored++;
        } catch (e) {
          console.warn("[smriti:index] store failed", row.id, String(e));
        }
      }
    }

    // ── Embed pending memories (smaller, separate store) ──
    let memStored = 0;
    for (const mem of pendingMem) {
      try {
        const v = await embedText(mem.text);
        storeMemoryEmbedding(mem.id, v);
        memStored++;
      } catch (e) {
        console.warn("[smriti:index] memory embed failed", mem.id, String(e));
      }
    }
    consecutiveErrors = 0;

    if (totalEmbedded % 50 === 0 || pending.length < BATCH_SIZE || memStored > 0) {
      const s = countEmbedStatus();
      console.log(
        `[smriti:index] msgs=${batchStored} mem=${memStored} extracted=${extracted}` +
        ` ms=${Date.now() - t0} embedded=${s.embedded} pending=${s.pending}`,
      );
    }
  } catch (e) {
    consecutiveErrors++;
    const msg = String(e);
    const hint = msg.includes("fetch") || msg.includes("network")
      ? " (model download may have failed)"
      : msg.includes("onnx") || msg.includes("ONNX")
      ? " (ONNX runtime error)"
      : "";
    console.error(`[smriti:index] batch failed${hint}`, msg);
    const backoff = Math.min(IDLE_INTERVAL_MS * consecutiveErrors, IDLE_INTERVAL_MS * 8);
    scheduleNext(backoff);
    return;
  }

  scheduleNext(TICK_INTERVAL_MS);
}
