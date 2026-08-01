/**
 * A capture source's stable key — "claude", "chatgpt", "whatsapp", …
 *
 * Deliberately an open `string`, not a closed union. Sources are declared in
 * `lib/connectors/registry.ts` and a new one must not require editing this
 * type; `conversations.platform` has always been a free-text column, so
 * widening the TS type needs no schema change. Validate against the registry
 * (`sourceById`) when you need to know a value is real.
 */
export type SourceId = string;

/** @deprecated Historical name for {@link SourceId}. Prefer `SourceId`. */
export type Platform = SourceId;

/**
 * `user` and `assistant` are the two-role AI shape. Human-chat sources are
 * N-party, and from Phase 1 the participant is carried by `messages.author_id`
 * → `people`; `role` then only distinguishes the user from everyone else.
 */
export type Role = "user" | "assistant" | "system" | "tool";

/**
 * Where a conversation happened, one level above the thread.
 *
 * An AI source has exactly one space (`kind: "app"`, key `"app"`) and connectors
 * there omit this entirely — ingest supplies it. A human source has one space
 * per DM or group, so the connector has to say which.
 */
export interface CaptureSpace {
  /** Source-local key: a phone number, a group jid, `"app"`. Unique per source. */
  space_key: string;
  kind: "app" | "dm" | "group";
  /** Human-readable name — the contact's name, the group's title. */
  label?: string;
}

/**
 * Who spoke a turn, when the source knows more than "the user or the bot".
 *
 * Omitted by AI connectors: for them `role` determines the author completely
 * (`user` → the user, `assistant` → that source's bot). A human source has to
 * name the participant, because a group thread has N of them and the same
 * person can appear in many threads.
 */
export interface CaptureAuthor {
  /**
   * The source's own stable id for this person — a phone number, a jid, a
   * handle. Normalised by `lib/people-identity.ts` before it reaches the DB;
   * emit it however the page gives it.
   */
  external_id: string;
  display_name?: string;
  /** True when this turn is the user's own. Decides `role: "user"`. */
  is_self?: boolean;
}

export interface CaptureEventConversationSeen {
  kind: "conversation_seen";
  platform: Platform;
  platform_conv_id: string;
  title?: string;
  url: string;
  observed_at: string;
  /** Defaults to the source's app space. */
  space?: CaptureSpace;
}

export interface CaptureEventMessageAppended {
  kind: "message_appended";
  platform: SourceId;
  platform_conv_id: string;
  /**
   * The platform's own message id, when it exposes one. This is the strongest
   * dedup key there is, and backs the partial unique index
   * `idx_msg_external (conversation_id, platform_msg_id)`.
   */
  platform_msg_id?: string;
  role: Role;
  content_text: string;
  content_html?: string;
  model?: string;
  created_at: string;
  /**
   * Whether `created_at` is the platform's own timestamp or one synthesised at
   * capture time. This decides whether it is safe to use in the dedup hash:
   * a DOM-observed source re-emits everything it can see on every page load
   * with a fresh `Date.now()`, so hashing an "observed" timestamp would insert
   * the whole conversation again on each reload.
   *
   * Defaults to `"observed"` — the safe assumption.
   */
  created_at_source?: "platform" | "observed";
  /**
   * Ordering. By default this is only a **within-batch hint** (0, 1, 2 …): a
   * connector cannot know a conversation's true turn index, so `lib/ingest.ts`
   * assigns the real dense per-conversation position at insert time.
   *
   * Set `position_authoritative` when the caller genuinely does know the true
   * index — backfill reads history in order and does.
   */
  position: number;
  position_authoritative?: boolean;
  /**
   * Who spoke. Omit on an AI source — `role` says everything there. A human
   * source must supply it, or every participant in the thread collapses into
   * "the assistant".
   */
  author?: CaptureAuthor;
  /**
   * The space this message's conversation belongs to. Carried on the message
   * event as well as `conversation_seen` because a message can be the first
   * thing we see of a thread, and the conversation row it creates needs a space.
   */
  space?: CaptureSpace;
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
