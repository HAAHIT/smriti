// Backfill state machine — offscreen document edition.
//
// In the new architecture the offscreen document can make fetch() calls
// directly (unlike the native helper which needed the background to proxy them).
// Progress is communicated back to the background via chrome.runtime.sendMessage.
//
// Only Claude backfill is implemented; ChatGPT/Gemini are capture-only.

import type { BackfillProgress, BackfillState, Platform, BackfillJobStatus, CaptureEvent } from "@recall/shared";
import { dbAll, dbGet, dbRun, markDirty } from "./db.js";
import { ingestEvents } from "./ingest.js";

const BASE = "https://claude.ai";
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
  queue: Array<{ orgId: string; convId: string }>;
  startedAt: number;
  cancelled: boolean;
}

const active = new Map<Platform, ActiveJob>();
let lastProgressEmit = 0;

export function getBackfillStatuses(filter?: Platform): BackfillJobStatus[] {
  const rows = filter
    ? dbAll<{ platform: Platform; status: BackfillState; total_known: number | null; total_fetched: number; started_at: string | null; updated_at: string | null; error_message: string | null }>(
        "SELECT * FROM backfill_state WHERE platform = ?",
        [filter],
      )
    : dbAll<{ platform: Platform; status: BackfillState; total_known: number | null; total_fetched: number; started_at: string | null; updated_at: string | null; error_message: string | null }>(
        "SELECT * FROM backfill_state",
      );
  return rows.map((r) => ({
    platform: r.platform,
    state: r.status,
    total_known: r.total_known,
    total_fetched: r.total_fetched,
    started_at: r.started_at,
    updated_at: r.updated_at,
    error_message: r.error_message,
  }));
}

export async function startBackfill(platform: Platform): Promise<{ resuming: boolean }> {
  if (platform !== "claude" && platform !== "chatgpt") {
    throw new Error(`backfill for ${platform} not implemented yet`);
  }
  if (active.has(platform)) return { resuming: true };

  const persisted = readPersisted(platform);
  const resuming = !!persisted && persisted.status !== "complete";

  const job: ActiveJob = {
    platform,
    state: "discovering",
    total_known: persisted?.total_known ?? null,
    total_fetched: persisted?.total_fetched ?? 0,
    latest_titles: [],
    errors: 0,
    queue: [],
    startedAt: Date.now(),
    cancelled: false,
  };
  active.set(platform, job);
  persistJob(job, null);
  emitProgress(job, true);

  void runJob(job).catch((e) => {
    console.error("[smriti:backfill] job crashed", String(e));
    job.state = "failed";
    persistJob(job, String(e));
    emitProgress(job, true);
    sendDone(job);
    active.delete(platform);
  });

  return { resuming };
}

export function cancelBackfill(platform: Platform): void {
  const job = active.get(platform);
  if (job) job.cancelled = true;
}

// ─── Job runner ───────────────────────────────────────────────────────────────

async function runJob(job: ActiveJob): Promise<void> {
  try {
    if (job.platform === "claude") await runClaude(job);
    else if (job.platform === "chatgpt") await runChatGPT(job);
    job.state = job.errors > 0 ? "partial" : "complete";
  } catch (e) {
    job.state = "failed";
    persistJob(job, String(e));
    emitProgress(job, true);
    sendDone(job);
    active.delete(job.platform);
    return;
  }
  persistJob(job, null);
  emitProgress(job, true);
  sendDone(job);
  active.delete(job.platform);
}

async function runClaude(job: ActiveJob): Promise<void> {
  // 1. Discover organizations.
  job.state = "discovering";
  emitProgress(job, true);
  const orgs = await claudeGet<Array<{ uuid: string; name?: string }>>("/api/organizations");
  if (!orgs.length) throw new Error("no organizations returned");

  // 2. Enumerate conversation IDs.
  for (const org of orgs) {
    for (const archived of [false, true]) {
      let offset = 0;
      while (!job.cancelled) {
        const page = await claudeGet<Array<{ uuid: string; name?: string }>>(
          `/api/organizations/${org.uuid}/chat_conversations?limit=100&offset=${offset}&archived=${archived}`,
        );
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
  persistJob(job, null);
  emitProgress(job, true);

  // 3. Fetch conversation details and ingest.
  while (job.queue.length > 0 && !job.cancelled) {
    const { orgId, convId } = job.queue.shift()!;
    try {
      const detail = await claudeGetRaw(
        `/api/organizations/${orgId}/chat_conversations/${convId}?tree=True`,
      );
      if (!detail) continue;
      const events = convToEvents(detail, convId);
      ingestEvents(events);
      job.total_fetched++;
      if (detail.name) {
        job.latest_titles.push(detail.name as string);
        if (job.latest_titles.length > 5) job.latest_titles.shift();
      }
      if (job.total_fetched % 10 === 0) persistJob(job, null);
    } catch (e) {
      job.errors++;
      const msg = String(e);
      console.warn("[smriti:backfill] detail failed", convId, msg);
      if (msg.includes("status 429")) {
        job.state = "rate_limited";
        persistJob(job, "429 rate limit — pausing");
        emitProgress(job, true);
        await sleep(RATE_LIMIT_PAUSE_MS);
        job.state = "fetching";
        job.queue.unshift({ orgId, convId });
      }
    }
    emitProgress(job);
    await sleep(DETAIL_DELAY_MS);
  }
}

// ─── Claude API helpers ───────────────────────────────────────────────────────

async function claudeGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include" });
  if (!res.ok) throw new Error(`claude api ${path}: status ${res.status}`);
  return res.json() as Promise<T>;
}

async function claudeGetRaw(path: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`claude api ${path}: status ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

// ─── ChatGPT backfill ─────────────────────────────────────────────────────────
//
// Endpoints (verified May 2026):
//   GET https://chatgpt.com/backend-api/conversations?limit=100&offset=N
//     → { items: [{ id, title, create_time, update_time, ... }], total, ... }
//   GET https://chatgpt.com/backend-api/conversation/<id>
//     → { title, mapping: { <nodeId>: { message: { author, content, create_time } } } }

const CHATGPT_BASE = "https://chatgpt.com";
const CHATGPT_DELAY_MS = 1_500;    // gentler than Claude
const CHATGPT_PAGE = 100;

async function runChatGPT(job: ActiveJob): Promise<void> {
  job.state = "discovering";
  emitProgress(job, true);

  // 1. Enumerate all conversation stubs.
  let offset = 0;
  while (!job.cancelled) {
    const page = await chatGptGet<{
      items: Array<{ id: string; title?: string; create_time?: number; update_time?: number }>;
      total?: number;
    }>(`/backend-api/conversations?limit=${CHATGPT_PAGE}&offset=${offset}`);

    if (page.total != null) job.total_known = page.total;
    for (const c of page.items) {
      job.queue.push({ orgId: "", convId: c.id });
    }
    emitProgress(job);
    if (page.items.length < CHATGPT_PAGE) break;
    offset += page.items.length;
    await sleep(500);
  }
  job.total_known = job.queue.length;
  job.state = "fetching";
  persistJob(job, null);
  emitProgress(job, true);

  // 2. Fetch each conversation detail and ingest.
  while (job.queue.length > 0 && !job.cancelled) {
    const { convId } = job.queue.shift()!;
    try {
      const detail = await chatGptGetRaw(`/backend-api/conversation/${convId}`);
      if (!detail) continue;
      const events = chatGptConvToEvents(detail, convId);
      ingestEvents(events);
      job.total_fetched++;
      const title = detail.title as string | undefined;
      if (title) {
        job.latest_titles.push(title);
        if (job.latest_titles.length > 5) job.latest_titles.shift();
      }
      if (job.total_fetched % 10 === 0) persistJob(job, null);
    } catch (e) {
      job.errors++;
      const msg = String(e);
      console.warn("[smriti:backfill] chatgpt detail failed", convId, msg);
      if (msg.includes("status 429") || msg.includes("status 503")) {
        job.state = "rate_limited";
        persistJob(job, "rate limit — pausing");
        emitProgress(job, true);
        await sleep(RATE_LIMIT_PAUSE_MS);
        job.state = "fetching";
        job.queue.unshift({ orgId: "", convId });
      }
    }
    emitProgress(job);
    await sleep(CHATGPT_DELAY_MS);
  }
}

async function chatGptGet<T>(path: string): Promise<T> {
  const res = await fetch(`${CHATGPT_BASE}${path}`, { credentials: "include" });
  if (!res.ok) throw new Error(`chatgpt api ${path}: status ${res.status}`);
  return res.json() as Promise<T>;
}

async function chatGptGetRaw(path: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${CHATGPT_BASE}${path}`, { credentials: "include" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`chatgpt api ${path}: status ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

function chatGptConvToEvents(detail: Record<string, unknown>, convId: string): CaptureEvent[] {
  const url = `${CHATGPT_BASE}/c/${convId}`;
  const observedAt = new Date().toISOString();
  const events: CaptureEvent[] = [
    {
      kind: "conversation_seen",
      platform: "chatgpt",
      platform_conv_id: convId,
      title: (detail.title as string | undefined) ?? undefined,
      url,
      observed_at: observedAt,
    },
  ];

  // ChatGPT stores messages as a tree: mapping.<nodeId>.message
  const mapping = (detail.mapping ?? {}) as Record<string, {
    message?: {
      id?: string;
      author?: { role?: string };
      content?: { parts?: Array<string | { text?: string }> };
      create_time?: number;
    };
  }>;

  // Collect messages sorted by create_time.
  const msgs: Array<{ id: string; role: string; text: string; ts: number }> = [];
  for (const node of Object.values(mapping)) {
    const m = node.message;
    if (!m) continue;
    const role = m.author?.role;
    if (!role || role === "system" || role === "tool") continue;
    const text = extractChatGptText(m.content);
    if (!text) continue;
    msgs.push({
      id: m.id ?? crypto.randomUUID(),
      role: role === "user" ? "user" : "assistant",
      text,
      ts: m.create_time ? m.create_time * 1000 : Date.now(),
    });
  }
  msgs.sort((a, b) => a.ts - b.ts);

  for (const m of msgs) {
    const ts = new Date(m.ts).toISOString();
    events.push({
      kind: "message_appended",
      platform: "chatgpt",
      platform_conv_id: convId,
      platform_msg_id: m.id,
      role: m.role as "user" | "assistant",
      content_text: m.text,
      created_at: ts,
      position: m.ts,
    });
  }
  return events;
}

function extractChatGptText(content: unknown): string | null {
  if (!content || typeof content !== "object") return null;
  const c = content as { parts?: Array<string | { text?: string }> };
  if (!Array.isArray(c.parts)) return null;
  const parts: string[] = [];
  for (const p of c.parts) {
    if (typeof p === "string" && p.length > 0) parts.push(p);
    else if (p && typeof p === "object" && typeof (p as { text?: string }).text === "string") {
      const t = (p as { text: string }).text;
      if (t.length > 0) parts.push(t);
    }
  }
  return parts.length ? parts.join("\n") : null;
}

// ─── Event conversion ─────────────────────────────────────────────────────────

interface ChatMessage {
  uuid?: string;
  text?: string;
  content?: Array<{ type?: string; text?: string }> | string;
  sender?: string;
  role?: string;
  created_at?: string;
  model?: string;
}

function convToEvents(detail: Record<string, unknown>, fallbackId: string): CaptureEvent[] {
  const convId = (detail.uuid as string | undefined) ?? fallbackId;
  const url = `${BASE}/chat/${convId}`;
  const observedAt = new Date().toISOString();
  const messages = ((detail.chat_messages ?? detail.messages ?? []) as ChatMessage[]);

  const events: CaptureEvent[] = [
    {
      kind: "conversation_seen",
      platform: "claude",
      platform_conv_id: convId,
      title: (detail.name as string | undefined) ?? undefined,
      url,
      observed_at: observedAt,
    },
  ];

  for (const m of messages) {
    const text = extractText(m);
    if (!text) continue;
    const role = normalizeRole(m.sender ?? m.role);
    if (!role) continue;
    const ts = m.created_at ?? observedAt;
    events.push({
      kind: "message_appended",
      platform: "claude",
      platform_conv_id: convId,
      platform_msg_id: m.uuid,
      role,
      content_text: text,
      model: (m.model ?? detail.model) as string | undefined,
      created_at: ts,
      position: Date.parse(ts) || Date.now(),
    });
  }
  return events;
}

function extractText(m: ChatMessage): string | null {
  if (typeof m.text === "string" && m.text.length > 0) return m.text;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    const parts: string[] = [];
    for (const block of m.content) {
      if (block && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    if (parts.length) return parts.join("\n");
  }
  return null;
}

function normalizeRole(s: string | undefined): "user" | "assistant" | null {
  if (!s) return null;
  const lc = s.toLowerCase();
  if (lc === "user" || lc === "human") return "user";
  if (lc === "assistant" || lc === "ai" || lc === "claude") return "assistant";
  return null;
}

// ─── Progress & persistence ───────────────────────────────────────────────────

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
  // Send to background script (and any open UI pages listening).
  chrome.runtime.sendMessage({ kind: "backfill_progress", progress }).catch(() => {});
}

function sendDone(job: ActiveJob): void {
  chrome.runtime.sendMessage({
    kind: "backfill_done",
    platform: job.platform,
    summary: { fetched: job.total_fetched, errors: job.errors },
  }).catch(() => {});
}

function persistJob(job: ActiveJob, errorMsg: string | null): void {
  const now = new Date().toISOString();
  dbRun(
    `INSERT INTO backfill_state
       (platform, status, total_known, total_fetched, started_at, updated_at, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform) DO UPDATE SET
       status        = excluded.status,
       total_known   = COALESCE(excluded.total_known, backfill_state.total_known),
       total_fetched = excluded.total_fetched,
       updated_at    = excluded.updated_at,
       error_message = excluded.error_message`,
    [job.platform, job.state, job.total_known, job.total_fetched,
     new Date(job.startedAt).toISOString(), now, errorMsg],
  );
  markDirty();
}

function readPersisted(platform: Platform): { status: BackfillState; total_known: number | null; total_fetched: number } | null {
  return dbGet<{ status: BackfillState; total_known: number | null; total_fetched: number }>(
    "SELECT status, total_known, total_fetched FROM backfill_state WHERE platform = ?",
    [platform],
  ) ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
