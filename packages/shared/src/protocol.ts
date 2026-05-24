import type { CaptureEvent, Platform } from "./types.js";

export const PROTOCOL_VERSION = 1;

// ─── Extension → Helper: request/response (initiated by extension) ───────────

export type NMRequest =
  | { id: string; type: "hello"; client: string; version: string }
  | { id: string; type: "ingest"; events: CaptureEvent[] }
  | { id: string; type: "search"; query: string; limit?: number }
  | { id: string; type: "get_conversation"; conversation_id: string }
  | { id: string; type: "stats" }
  | { id: string; type: "claude_code_scan"; root?: string }
  | { id: string; type: "start_backfill"; platform: Platform }
  | { id: string; type: "backfill_status"; platform?: Platform }
  | { id: string; type: "embed_status" }
  | { id: string; type: "get_outline"; conversation_id: string }
  | { id: string; type: "list_recent_conversations"; limit?: number }
  | { id: string; type: "service_start" }
  | { id: string; type: "get_by_platform"; platform: Platform; platform_conv_id: string }
  | { id: string; type: "wipe_archive" };

export type NMResponse =
  | { id: string; ok: true; type: "hello"; helper_version: string; protocol: number }
  | { id: string; ok: true; type: "ingest"; accepted: number }
  | { id: string; ok: true; type: "search"; results: SearchHit[] }
  | { id: string; ok: true; type: "get_conversation"; meta: ConversationMeta | null; messages: ConversationMessageRow[] }
  | { id: string; ok: true; type: "stats"; conversations: number; messages: number }
  | { id: string; ok: true; type: "claude_code_scan"; files_scanned: number; events_ingested: number }
  | { id: string; ok: true; type: "start_backfill"; accepted: true; resuming: boolean }
  | { id: string; ok: true; type: "backfill_status"; jobs: BackfillJobStatus[] }
  | { id: string; ok: true; type: "embed_status"; total: number; embedded: number; pending: number; model: string | null }
  | { id: string; ok: true; type: "get_outline"; ready: boolean; segments: OutlineSegment[] }
  | { id: string; ok: true; type: "list_recent_conversations"; conversations: RecentConversation[] }
  | { id: string; ok: true; type: "service_start" }
  | { id: string; ok: true; type: "get_by_platform"; meta: ConversationMeta | null; segments: OutlineSegment[] }
  | { id: string; ok: true; type: "wipe_archive"; cleared: number }
  | { id: string; ok: false; error: string };

// ─── Outline & recents shapes ───────────────────────────────────────────────

export interface OutlineSegment {
  start_position: number;       // position of first message in segment
  end_position: number;         // position of last message in segment
  start_message_id: string;     // jump target
  message_count: number;
  preview: string;              // short preview drawn from the first user message
  started_at: string;
}

export interface RecentConversation {
  id: string;
  title: string | null;
  platform: string;
  url: string | null;
  message_count: number;
  last_message_at: string;
}

// ─── Helper → Extension: unsolicited messages during backfill ────────────────

export type HelperOutbound =
  | { kind: "fetch_request"; id: string; url: string; method?: string; headers?: Record<string, string>; body?: string | null }
  | { kind: "progress"; progress: BackfillProgress }
  | { kind: "done"; platform: Platform; summary: { fetched: number; errors: number } };

// ─── Extension → Helper: fetch responses (initiated by helper's RPC) ─────────

export interface FetchResponseMsg {
  kind: "fetch_response";
  id: string;
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
}

// ─── Backfill state shapes ──────────────────────────────────────────────────

export type BackfillState =
  | "pending"
  | "discovering"
  | "fetching"
  | "paused"
  | "rate_limited"
  | "complete"
  | "partial"
  | "failed";

export interface BackfillProgress {
  platform: Platform;
  state: BackfillState;
  total_known: number | null;
  total_fetched: number;
  latest_titles: string[]; // last 3-5 ingested titles, for "materializing value" UX
  eta_ms: number | null;
  message?: string;
}

export interface BackfillJobStatus {
  platform: Platform;
  state: BackfillState;
  total_known: number | null;
  total_fetched: number;
  started_at: string | null;
  updated_at: string | null;
  error_message: string | null;
}

// ─── Search results ─────────────────────────────────────────────────────────

export interface SearchHit {
  conversation_id: string;
  message_id: string;       // jump anchor — viewer scrolls to this message
  title: string | null;
  platform: string;
  url: string | null;
  snippet: string;
  last_message_at: string;
  score: number;
  // Optional: which mode contributed (helps the UI debug ranking and label hits).
  // "fts" = keyword only, "vec" = semantic only, "hybrid" = both matched.
  match?: "fts" | "vec" | "hybrid";
}

export interface ConversationMessageRow {
  id: string;
  role: string;
  content_text: string;
  created_at: string;
  position: number;
}

export interface ConversationMeta {
  id: string;
  platform: string;
  title: string | null;
  url: string | null;
  started_at: string;
  last_message_at: string;
  message_count: number;
}
