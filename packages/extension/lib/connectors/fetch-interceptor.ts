// The `fetchInterceptor` capture strategy.
//
// Claude and ChatGPT were two ~250-line content scripts with the same six
// functions in the same order and different payload parsing: patch
// window.fetch, match the completion URL, read the request body, tee the
// response, walk the SSE frames, build events, postMessage them out. All of
// that lives here now. A connector supplies only what is genuinely
// site-specific — which requests to watch, how to read the request body, and
// how to fold one SSE payload into the accumulating turn.
//
// Runs in the MAIN world (it has to, to monkey-patch window.fetch), so it
// cannot touch chrome.* — events leave via window.postMessage and the ISOLATED
// bridge relays them. Keep this module dependency-light for the same reason.

import { SMRITI_TAG, type InjectToContentMessage } from "../../capture/messages";
import type { CaptureEvent, Role, SourceId } from "@smriti/shared";

/** Accumulating state for one intercepted request/response round-trip. */
export interface StreamState {
  /** Platform conversation id. May arrive from the URL, the body, or the stream. */
  convId: string | null;
  model: string | null;
  /** Assistant text built up across SSE frames. */
  assistantText: string;
  /** Platform message id for the assistant turn, when the stream exposes one. */
  assistantMsgId: string | null;
}

/** What a connector can pull out of the request body. */
export interface RequestSeed {
  convId: string | null;
  userText: string | null;
  model: string | null;
  /** Platform message id for the user turn, when the request exposes one. */
  userMsgId: string | null;
}

export interface FetchConnectorDef {
  sourceId: SourceId;

  /**
   * Should this request be captured? Return `null` to pass it straight
   * through. `convId` may be null when the id only becomes known from the
   * request body or the stream.
   */
  matchRequest(url: string, method: string): { convId: string | null } | null;

  /**
   * Pull what's available out of the parsed request-body JSON. Optional —
   * a connector whose request body carries nothing useful can omit it.
   * Never throws: malformed bodies are already caught for you.
   */
  readRequest?(json: Record<string, unknown>): Partial<RequestSeed>;

  /**
   * Fold one parsed SSE `data:` payload into `state`. Called once per frame.
   * This is where essentially all the per-site difference lives.
   */
  reduceEvent(payload: unknown, state: StreamState): void;

  /** Canonical URL for a conversation, stored on the conversation row. */
  conversationUrl(convId: string): string;

  /** Strip the site's own suffix off document.title, e.g. / - Claude$/. */
  titleSuffix: RegExp;
  /** document.title when no conversation is open; treated as "no title". */
  bareTitle: string;
}

// ─── Request body reading ────────────────────────────────────────────────────

/**
 * Read a request body to text regardless of how it was supplied. Returns null
 * for bodies we cannot read without consuming something the page still needs
 * (FormData, ReadableStream).
 */
async function bodyToText(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<string | null> {
  try {
    if (init?.body) {
      const b = init.body;
      if (typeof b === "string") return b;
      if (b instanceof Blob) return await b.text();
      if (b instanceof ArrayBuffer) return new TextDecoder().decode(b);
      if (b instanceof URLSearchParams) return b.toString();
      return null; // FormData / stream — not worth the risk
    }
    if (input instanceof Request) return await input.clone().text();
  } catch {
    /* fall through */
  }
  return null;
}

export function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof Request) return input.url;
  return input.toString();
}

// ─── SSE framing ─────────────────────────────────────────────────────────────

/**
 * Split an SSE byte stream into `data:` payloads and hand each parsed JSON
 * value to `onPayload`. Frames are delimited by a blank line; `[DONE]` and
 * non-JSON payloads are skipped.
 *
 * Exported for tests — the framing is the part most likely to break silently.
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onPayload: (payload: unknown) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      emitFrames(block, onPayload);
    }
  }
  // A final frame with no trailing blank line still counts.
  if (buffer.trim()) emitFrames(buffer, onPayload);
}

function emitFrames(block: string, onPayload: (payload: unknown) => void): void {
  for (const line of block.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      onPayload(JSON.parse(payload));
    } catch {
      /* not JSON — ignore, as the old connectors did */
    }
  }
}

// ─── Event building ──────────────────────────────────────────────────────────

/**
 * Turn one completed round-trip into capture events.
 *
 * `position` is a **within-batch ordering hint only**, not a turn index: it is
 * 0, 1, 2… for this batch. The connector cannot know a conversation's true
 * turn index, and no longer pretends to with `Date.now()`. lib/ingest.ts
 * assigns the real dense per-conversation position at insert time.
 *
 * Exported and pure so it can be tested without a browser.
 */
export function buildTurnEvents(args: {
  sourceId: SourceId;
  convId: string;
  url: string;
  title: string | undefined;
  userText: string | null;
  userMsgId: string | null;
  assistantText: string;
  assistantMsgId: string | null;
  model: string | null;
  now?: () => string;
}): CaptureEvent[] {
  const now = args.now ?? (() => new Date().toISOString());
  const observedAt = now();
  const events: CaptureEvent[] = [
    {
      kind: "conversation_seen",
      platform: args.sourceId,
      platform_conv_id: args.convId,
      title: args.title,
      url: args.url,
      observed_at: observedAt,
    },
  ];

  let position = 0;
  const push = (role: Role, text: string, msgId: string | null): void => {
    events.push({
      kind: "message_appended",
      platform: args.sourceId,
      platform_conv_id: args.convId,
      platform_msg_id: msgId ?? undefined,
      role,
      content_text: text,
      model: args.model ?? undefined,
      created_at: now(),
      position: position++,
    });
  };

  if (args.userText && args.userText.length > 0) {
    push("user", args.userText, args.userMsgId);
  }
  if (args.assistantText.trim().length > 0) {
    push("assistant", args.assistantText, args.assistantMsgId);
  }
  return events;
}

// ─── The strategy ────────────────────────────────────────────────────────────

export function installFetchInterceptor(def: FetchConnectorDef): void {
  // eslint-disable-next-line no-console
  console.debug(`[smriti] ${def.sourceId}: fetch interceptor active`);

  const origFetch = window.fetch.bind(window);

  window.fetch = async function smritiFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = urlOf(input);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();

    const matched = def.matchRequest(url, method);
    if (!matched) return origFetch(input, init);

    // Read the request body BEFORE issuing the request — `init.body` may be a
    // one-shot value the fetch itself consumes.
    const seed = await readSeed(def, input, init, matched.convId);

    const res = await origFetch(input, init);

    // Tee: the page must still receive its stream untouched.
    try {
      const cloned = res.clone();
      void consume(def, cloned, seed);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[smriti:${def.sourceId}] response clone failed`, e);
    }
    return res;
  };
}

async function readSeed(
  def: FetchConnectorDef,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  convIdFromUrl: string | null,
): Promise<RequestSeed> {
  const seed: RequestSeed = {
    convId: convIdFromUrl,
    userText: null,
    model: null,
    userMsgId: null,
  };
  if (!def.readRequest) return seed;

  const text = await bodyToText(input, init);
  if (!text) return seed;
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const partial = def.readRequest(json);
    // URL-derived convId wins — it is the most reliable source when present.
    return {
      convId: seed.convId ?? partial.convId ?? null,
      userText: partial.userText ?? null,
      model: partial.model ?? null,
      userMsgId: partial.userMsgId ?? null,
    };
  } catch {
    return seed;
  }
}

async function consume(
  def: FetchConnectorDef,
  res: Response,
  seed: RequestSeed,
): Promise<void> {
  if (!res.body) return;

  const state: StreamState = {
    convId: seed.convId,
    model: seed.model,
    assistantText: "",
    assistantMsgId: null,
  };

  try {
    await readSseStream(res.body, (payload) => def.reduceEvent(payload, state));
  } catch (e) {
    // A truncated stream still leaves a usable partial turn — fall through and
    // emit what we accumulated rather than dropping the user's message.
    // eslint-disable-next-line no-console
    console.warn(`[smriti:${def.sourceId}] stream read failed`, e);
  }

  if (!state.convId) return; // nothing to attach the turn to; drop quietly

  emit(
    def.sourceId,
    buildTurnEvents({
      sourceId: def.sourceId,
      convId: state.convId,
      url: def.conversationUrl(state.convId),
      title: currentTitle(def),
      userText: seed.userText,
      userMsgId: seed.userMsgId,
      assistantText: state.assistantText,
      assistantMsgId: state.assistantMsgId,
      model: state.model,
    }),
  );
}

function currentTitle(def: FetchConnectorDef): string | undefined {
  const t = document.title;
  if (!t || t === def.bareTitle) return undefined;
  return t.replace(def.titleSuffix, "").trim() || undefined;
}

function emit(sourceId: SourceId, events: CaptureEvent[]): void {
  if (events.length === 0) return;
  const msg: InjectToContentMessage = {
    smriti: SMRITI_TAG,
    source: `${sourceId}-inject`,
    events,
  };
  window.postMessage(msg, window.location.origin);
}
