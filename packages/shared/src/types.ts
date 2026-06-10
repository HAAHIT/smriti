export type Platform = "claude" | "chatgpt" | "gemini" | "claude_code";

export type Role = "user" | "assistant" | "system" | "tool";

export interface CaptureEventConversationSeen {
  kind: "conversation_seen";
  platform: Platform;
  platform_conv_id: string;
  title?: string;
  url: string;
  observed_at: string;
}

export interface CaptureEventMessageAppended {
  kind: "message_appended";
  platform: Platform;
  platform_conv_id: string;
  platform_msg_id?: string;
  role: Role;
  content_text: string;
  content_html?: string;
  model?: string;
  created_at: string;
  position: number;
}

export interface CaptureEventConversationUpdated {
  kind: "conversation_updated";
  platform: Platform;
  platform_conv_id: string;
  title?: string;
  archived?: boolean;
}

export type CaptureEvent =
  | CaptureEventConversationSeen
  | CaptureEventMessageAppended
  | CaptureEventConversationUpdated;

export interface Conversation {
  id: string;
  platform: Platform;
  platform_conv_id: string;
  title: string | null;
  model: string | null;
  url: string | null;
  started_at: string;
  last_message_at: string;
  archived: number;
  ingested_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  platform_msg_id: string | null;
  role: Role;
  content_text: string;
  content_html: string | null;
  model: string | null;
  created_at: string;
  position: number;
  token_count: number | null;
  content_hash: string;
}

// ─── Memory layer ───────────────────────────────────────────────────────────
//
// A "memory" is an atomic, durable fact distilled from the user's own
// conversations — the thing that makes every AI tool remember them. Unlike a
// message (a transient utterance), a memory is meant to be recalled and
// re-injected into future prompts across any platform.

export type MemoryKind =
  | "identity"     // who the user is: role, name, location, background
  | "preference"   // how they like things: tools, style, conventions
  | "project"      // what they're working on: stack, goals, naming
  | "decision"     // choices they've locked in
  | "fact";        // any other durable, reusable fact

export type MemorySource = "auto" | "manual";

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  text: string;
  // Provenance — where this memory came from, so the user can verify it.
  source: MemorySource;
  source_platform: Platform | null;
  source_conversation_id: string | null;
  source_message_id: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  use_count: number;
  pinned: boolean;       // pinned memories are always eligible for recall
  salience: number;      // 0..1 confidence/importance; tunes ranking
  status: "active" | "archived";
}

// A memory matched against the current draft, ready to inject.
export interface MemoryRecallHit {
  id: string;
  kind: MemoryKind;
  text: string;
  source_platform: Platform | null;
  source_conversation_id: string | null;
  source_message_id: string | null;
  created_at: string;
  pinned: boolean;
  score: number;
  match: "fts" | "vec" | "hybrid" | "pinned";
}

export interface MemoryStats {
  total: number;
  byKind: Record<MemoryKind, number>;
  pending_embeddings: number;
  last_extracted_at: string | null;
}
