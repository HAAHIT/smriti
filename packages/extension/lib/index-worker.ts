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
import {
  conversationsNeedingEpisodes,
  embedEpisode,
  episodesNeedingVectors,
  rebuildEpisodes,
} from "./episodes.js";
import { isVectorsReady } from "./vectors.js";

const TICK_INTERVAL_MS = 5_000;
const IDLE_INTERVAL_MS = 30_000;
const BATCH_SIZE = 16;
const MEMORY_BATCH_SIZE = 12;
const EXTRACT_BATCH_SIZE = 64;
// Episode work is cheap per unit (segmentation needs no model) but each rebuild
// touches a whole conversation, so keep the batch small to stay responsive.
const EPISODE_BATCH_SIZE = 4;
const EPISODE_EMBED_BATCH_SIZE = 8;
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
  const t0 = Date.now();

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

  // ── Episode segmentation (cheap, no model) — runs before embedding so a
  //    newly captured conversation becomes navigable immediately.
  //
  //    Gated on the vector store being loaded: rebuilding drops the old
  //    episodes AND their vectors, and a removeVector() against an unloaded
  //    store is a silent no-op that would leave the file full of vectors for
  //    episode ids that no longer exist. ──
  let episodesBuilt = 0;
  if (isVectorsReady()) {
    try {
      for (const convId of conversationsNeedingEpisodes(EPISODE_BATCH_SIZE)) {
        episodesBuilt += rebuildEpisodes(convId).length;
      }
    } catch (e) {
      console.warn("[smriti:index] episode rebuild failed", String(e));
    }
  }

  const pending = getPendingMessages(BATCH_SIZE);
  const pendingMem = getPendingMemoryEmbeddings(MEMORY_BATCH_SIZE);
  const pendingEpisodes = episodesNeedingVectors(EPISODE_EMBED_BATCH_SIZE);

  if (pending.length === 0 && pendingMem.length === 0 && pendingEpisodes.length === 0) {
    consecutiveErrors = 0;
    console.debug(`[smriti:index] tick ms=${Date.now() - t0} extracted=${extracted} idle`);
    // If extraction or segmentation just created work, come back promptly.
    scheduleNext(extracted > 0 || episodesBuilt > 0 ? TICK_INTERVAL_MS : IDLE_INTERVAL_MS);
    return;
  }

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
    // ── Embed episode gists (the retrieval unit — see lib/vectors.ts) ──
    // One at a time rather than embedBatch: gists are short, the batch is 8,
    // and each putVector wants to land even if a later one throws.
    let epStored = 0;
    for (const ep of pendingEpisodes) {
      try {
        await embedEpisode(ep.id, ep.gist);
        epStored++;
      } catch (e) {
        console.warn("[smriti:index] episode embed failed", ep.id, String(e));
      }
    }
    consecutiveErrors = 0;

    if (totalEmbedded % 50 === 0 || pending.length < BATCH_SIZE || memStored > 0 || epStored > 0) {
      const s = countEmbedStatus();
      console.log(
        `[smriti:index] msgs=${batchStored} mem=${memStored} eps=${epStored}` +
        ` extracted=${extracted} ms=${Date.now() - t0}` +
        ` embedded=${s.embedded} pending=${s.pending}`,
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
    console.error(`[smriti:index] batch failed ms=${Date.now() - t0}${hint}`, msg);
    const backoff = Math.min(IDLE_INTERVAL_MS * consecutiveErrors, IDLE_INTERVAL_MS * 8);
    scheduleNext(backoff);
    return;
  }

  scheduleNext(TICK_INTERVAL_MS);
}
