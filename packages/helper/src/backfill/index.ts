// Backfill state machine.
//
// One job per platform may run at a time. Lifecycle:
//   pending → discovering → fetching → complete | partial | failed
//                                    ↘ rate_limited (auto-resumes) ↗
//
// Persists to backfill_state on every state change so a fresh helper process
// can resume mid-job. In-memory ActiveJob holds the run-loop's transient state
// (latest titles buffer, fetched count this run).

import type { BackfillProgress, BackfillState, Platform, BackfillJobStatus } from "@recall/shared";
import { getDb } from "../db.js";
import { log } from "../logger.js";
import { sendOutbound } from "../nm.js";
import { ingestEvents } from "../ingest.js";
import {
  listOrganizations,
  listConversations,
  fetchConversation,
  convToEvents,
} from "./claude.js";

const DETAIL_DELAY_MS = 2_000;
const RATE_LIMIT_PAUSE_MS = 30_000;
const PROGRESS_DEBOUNCE_MS = 750;

interface ActiveJob {
  platform: Platform;
  state: BackfillState;
  total_known: number | null;
  total_fetched: number;
  latest_titles: string[];
  errors: number;
  // Discovery-phase cursor (offset for Claude listings)
  list_offset: number;
  // Pending conversation IDs to fetch
  queue: Array<{ orgId: string; convId: string }>;
  startedAt: number;
  cancelled: boolean;
}

const active = new Map<Platform, ActiveJob>();
let lastProgressEmit = 0;

export function getBackfillStatuses(filter?: Platform): BackfillJobStatus[] {
  const db = getDb();
  const rows = filter
    ? db.prepare("SELECT * FROM backfill_state WHERE platform = ?").all(filter)
    : db.prepare("SELECT * FROM backfill_state").all();
  return rows.map((r) => {
    const row = r as {
      platform: Platform;
      status: BackfillState;
      total_known: number | null;
      total_fetched: number;
      started_at: string | null;
      updated_at: string | null;
      error_message: string | null;
    };
    return {
      platform: row.platform,
      state: row.status,
      total_known: row.total_known,
      total_fetched: row.total_fetched,
      started_at: row.started_at,
      updated_at: row.updated_at,
      error_message: row.error_message,
    };
  });
}

export async function startBackfill(
  platform: Platform,
): Promise<{ resuming: boolean }> {
  if (platform !== "claude") {
    throw new Error(`backfill for ${platform} not implemented yet`);
  }
  if (active.has(platform)) {
    return { resuming: true };
  }
  const persisted = readPersisted(platform);
  const resuming = !!persisted && persisted.status !== "complete";
  const job: ActiveJob = {
    platform,
    state: "discovering",
    total_known: persisted?.total_known ?? null,
    total_fetched: persisted?.total_fetched ?? 0,
    latest_titles: [],
    errors: 0,
    list_offset: 0,
    queue: [],
    startedAt: Date.now(),
    cancelled: false,
  };
  active.set(platform, job);
  persist(job, "starting");
  emitProgress(job);

  // Run the job out-of-band so we can return the ack to the extension.
  void runJob(job).catch((e) => {
    log.error("backfill crashed", { platform, err: String(e) });
    job.state = "failed";
    persist(job, String(e));
    emitProgress(job, true);
    sendDone(job);
    active.delete(platform);
  });

  return { resuming };
}

async function runJob(job: ActiveJob): Promise<void> {
  try {
    if (job.platform === "claude") {
      await runClaude(job);
    }
    job.state = job.errors > 0 ? "partial" : "complete";
  } catch (e) {
    log.error("backfill run failed", { err: String(e) });
    job.state = "failed";
    persist(job, String(e));
    emitProgress(job, true);
    sendDone(job);
    active.delete(job.platform);
    return;
  }
  persist(job, null);
  emitProgress(job, true);
  sendDone(job);
  active.delete(job.platform);
}

async function runClaude(job: ActiveJob): Promise<void> {
  // 1. Discover organizations.
  job.state = "discovering";
  emitProgress(job, true);
  const orgs = await listOrganizations();
  if (orgs.length === 0) throw new Error("no organizations returned");

  // 2. Enumerate conversation IDs across all orgs (and archived).
  for (const org of orgs) {
    for (const archived of [false, true]) {
      let offset = 0;
      while (!job.cancelled) {
        const page = await listConversations(org.uuid, offset, 100, archived);
        for (const c of page) {
          job.queue.push({ orgId: org.uuid, convId: c.uuid });
        }
        if (page.length < 100) break;
        offset += page.length;
        emitProgress(job);
      }
    }
  }
  job.total_known = job.queue.length;
  job.state = "fetching";
  persist(job, null);
  emitProgress(job, true);

  // 3. Fetch each conversation detail, ingest, emit progress.
  while (job.queue.length > 0 && !job.cancelled) {
    const { orgId, convId } = job.queue.shift()!;
    try {
      const detail = await fetchConversation(orgId, convId);
      if (!detail) continue;
      const events = convToEvents(detail, convId, `${"https://claude.ai/chat/"}${convId}`);
      ingestEvents(events);
      job.total_fetched++;
      if (detail.name) {
        job.latest_titles.push(detail.name);
        if (job.latest_titles.length > 5) job.latest_titles.shift();
      }
      if (job.total_fetched % 10 === 0) persist(job, null);
    } catch (e) {
      job.errors++;
      const msg = String(e);
      log.warn("claude detail failed", { convId, err: msg });
      if (msg.includes("status 429")) {
        job.state = "rate_limited";
        persist(job, "429 rate limit — pausing");
        emitProgress(job, true);
        await sleep(RATE_LIMIT_PAUSE_MS);
        job.state = "fetching";
        // Requeue this conv for retry.
        job.queue.unshift({ orgId, convId });
      }
    }
    emitProgress(job);
    await sleep(DETAIL_DELAY_MS);
  }
}

function emitProgress(job: ActiveJob, force = false): void {
  const now = Date.now();
  if (!force && now - lastProgressEmit < PROGRESS_DEBOUNCE_MS) return;
  lastProgressEmit = now;
  const elapsed = now - job.startedAt;
  const eta =
    job.total_known && job.total_fetched > 0
      ? Math.max(0, (elapsed / job.total_fetched) * (job.total_known - job.total_fetched))
      : null;
  const progress: BackfillProgress = {
    platform: job.platform,
    state: job.state,
    total_known: job.total_known,
    total_fetched: job.total_fetched,
    latest_titles: [...job.latest_titles],
    eta_ms: eta,
  };
  sendOutbound({ kind: "progress", progress });
}

function sendDone(job: ActiveJob): void {
  sendOutbound({
    kind: "done",
    platform: job.platform,
    summary: { fetched: job.total_fetched, errors: job.errors },
  });
}

function persist(job: ActiveJob, errorMsg: string | null): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO backfill_state
      (platform, status, total_known, total_fetched, started_at, updated_at, error_message)
     VALUES (@platform, @status, @total_known, @total_fetched, @started_at, @updated_at, @error_message)
     ON CONFLICT(platform) DO UPDATE SET
       status = excluded.status,
       total_known = COALESCE(excluded.total_known, backfill_state.total_known),
       total_fetched = excluded.total_fetched,
       updated_at = excluded.updated_at,
       error_message = excluded.error_message`,
  ).run({
    platform: job.platform,
    status: job.state,
    total_known: job.total_known,
    total_fetched: job.total_fetched,
    started_at: new Date(job.startedAt).toISOString(),
    updated_at: now,
    error_message: errorMsg,
  });
}

function readPersisted(platform: Platform): { status: BackfillState; total_known: number | null; total_fetched: number } | null {
  const db = getDb();
  const row = db
    .prepare("SELECT status, total_known, total_fetched FROM backfill_state WHERE platform = ?")
    .get(platform) as
    | { status: BackfillState; total_known: number | null; total_fetched: number }
    | undefined;
  return row ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
