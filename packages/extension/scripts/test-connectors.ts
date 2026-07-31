// The source layer: registry resolution, the connector SDK's pure parts, and
// message identity.
//
// Run: npx tsx scripts/test-connectors.ts
//
// The point of Phase 1 was to replace three hand-written connectors with a
// registry plus two reusable strategies. Two things need to stay true for that
// to have been worth doing, and both are asserted here:
//   1. every origin list is derived from the registry, so they cannot drift
//   2. a NEW connector is small — the synthetic fourth source at the bottom is
//      the exit test for the whole phase.

import {
  SOURCES,
  allHosts,
  allOrigins,
  hostOfOrigin,
  hostsForSource,
  overlayOrigins,
  resolveConversation,
  sourceById,
  sourceForHostname,
  sourceForUrl,
  type SourceDef,
} from "../lib/connectors/registry.js";
import {
  buildTurnEvents,
  readSseStream,
  urlOf,
  type FetchConnectorDef,
  type StreamState,
} from "../lib/connectors/fetch-interceptor.js";
import { hashSchemeFor, messageHash } from "../lib/ingest-identity.js";
import type { CaptureEventMessageAppended } from "@smriti/shared";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  cond ? pass++ : fail++;
}

// ─── Registry ────────────────────────────────────────────────────────────────

console.log("\n=== registry ===\n");

check("three sources declared", SOURCES.length === 3);
check(
  "every source id is unique",
  new Set(SOURCES.map((s) => s.id)).size === SOURCES.length,
);
check(
  "every origin is an https match pattern",
  allOrigins().every((o) => /^https:\/\/[^/]+\/\*$/.test(o)),
);

check("hostOfOrigin strips scheme and path", hostOfOrigin("https://claude.ai/*") === "claude.ai");
check("hostOfOrigin strips a leading wildcard label", hostOfOrigin("https://*.example.com/*") === "example.com");

check("sourceById finds a known source", sourceById("claude")?.label === "Claude");
check("sourceById returns null for an unknown id", sourceById("whatsapp") === null);

check(
  "sourceForHostname resolves the primary host",
  sourceForHostname("chatgpt.com")?.id === "chatgpt",
);
check(
  "sourceForHostname resolves subdomains",
  sourceForHostname("app.claude.ai")?.id === "claude",
);
check(
  "sourceForHostname strips www.",
  sourceForHostname("www.chatgpt.com")?.id === "chatgpt",
);
check("sourceForHostname rejects unrelated hosts", sourceForHostname("example.com") === null);
check(
  "a host that merely ends with the string is not a match",
  sourceForHostname("notclaude.ai") === null,
);

check("sourceForUrl handles a full URL", sourceForUrl("https://claude.ai/chat/abc")?.id === "claude");
check("sourceForUrl tolerates a malformed URL", sourceForUrl("not-a-url") === null);

// The bug that motivated the registry: chat.openai.com was declared in the
// ChatGPT content scripts and in none of the other three origin lists.
console.log("\n=== the four lists agree (chat.openai.com regression) ===\n");

check(
  "chat.openai.com is a declared origin",
  allOrigins().includes("https://chat.openai.com/*"),
);
check(
  "chat.openai.com resolves to the chatgpt source",
  sourceForHostname("chat.openai.com")?.id === "chatgpt",
);
check(
  "chat.openai.com is in the sidebar's overlay origins",
  overlayOrigins().includes("https://chat.openai.com/*"),
);
check(
  "chat.openai.com is one of the chatgpt source's hosts (so the capture pause reaches it)",
  hostsForSource("chatgpt").includes("chat.openai.com"),
);
check(
  "allHosts is deduplicated",
  allHosts().length === new Set(allHosts()).size,
);
check("hostsForSource is empty for an unknown source", hostsForSource("nope").length === 0);

// ─── Conversation id resolution ──────────────────────────────────────────────

console.log("\n=== conversation id resolution ===\n");

const cases: Array<[string, string | null]> = [
  ["https://claude.ai/chat/a1b2c3d4-e5f6-7890-abcd-ef1234567890", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"],
  ["https://claude.ai/chat/abcdef01", "abcdef01"],
  ["https://claude.ai/chat/abc1234", null],   // too short
  ["https://claude.ai/new", null],
  ["https://claude.ai/", null],
  ["https://chatgpt.com/c/abcdef01-2345-6789-abcd-ef0123456789", "abcdef01-2345-6789-abcd-ef0123456789"],
  ["https://chatgpt.com/g/g-XyZ123/c/abcdef0123456789", "abcdef0123456789"],
  ["https://chatgpt.com/", null],
  ["https://gemini.google.com/app/abcdef01234567890", "abcdef01234567890"],
  ["https://gemini.google.com/app/home", null],       // not an id
  ["https://gemini.google.com/", null],
  ["https://example.com/chat/abcdef0123", null],      // unknown source
];

for (const [url, expected] of cases) {
  const got = resolveConversation(url)?.platformConvId ?? null;
  check(`${url} → ${expected ?? "null"}`, got === expected);
}

// ─── SSE framing ─────────────────────────────────────────────────────────────

console.log("\n=== SSE framing ===\n");

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<unknown[]> {
  const out: unknown[] = [];
  await readSseStream(streamOf(chunks), (p) => out.push(p));
  return out;
}

check(
  "parses two frames",
  JSON.stringify(await collect(['data: {"a":1}\n\n', 'data: {"a":2}\n\n'])) === '[{"a":1},{"a":2}]',
);
check(
  "reassembles a frame split across chunks",
  JSON.stringify(await collect(['data: {"a":', '1}\n\n'])) === '[{"a":1}]',
);
check(
  "handles several frames in one chunk",
  JSON.stringify(await collect(['data: {"a":1}\n\ndata: {"a":2}\n\n'])) === '[{"a":1},{"a":2}]',
);
check("skips [DONE]", JSON.stringify(await collect(['data: [DONE]\n\n'])) === "[]");
check("skips non-JSON payloads", JSON.stringify(await collect(["data: not json\n\n"])) === "[]");
check("ignores non-data lines", JSON.stringify(await collect(['event: ping\ndata: {"a":1}\n\n'])) === '[{"a":1}]');
check(
  "a trailing frame with no blank line is still emitted",
  JSON.stringify(await collect(['data: {"a":1}'])) === '[{"a":1}]',
);
check("an empty stream yields nothing", JSON.stringify(await collect([])) === "[]");

// ─── urlOf ───────────────────────────────────────────────────────────────────

console.log("\n=== urlOf ===\n");

check("string input", urlOf("https://x.test/a") === "https://x.test/a");
check("URL input", urlOf(new URL("https://x.test/a")) === "https://x.test/a");

// ─── buildTurnEvents ─────────────────────────────────────────────────────────

console.log("\n=== buildTurnEvents ===\n");

const turn = buildTurnEvents({
  sourceId: "claude",
  convId: "c1",
  url: "https://claude.ai/chat/c1",
  title: "A chat",
  userText: "hello",
  userMsgId: null,
  assistantText: "hi there",
  assistantMsgId: "asst-1",
  model: "claude-opus-5",
  now: () => "2026-07-31T00:00:00.000Z",
});

check("emits conversation_seen first", turn[0]?.kind === "conversation_seen");
check("emits both turns", turn.length === 3);
check(
  "positions are a 0-based within-batch hint, not a clock",
  turn
    .filter((e) => e.kind === "message_appended")
    .map((e) => (e as CaptureEventMessageAppended).position)
    .join(",") === "0,1",
);
check(
  "assistant message id is carried through",
  (turn[2] as CaptureEventMessageAppended).platform_msg_id === "asst-1",
);
check(
  "positions are never authoritative from a live connector",
  turn
    .filter((e) => e.kind === "message_appended")
    .every((e) => !(e as CaptureEventMessageAppended).position_authoritative),
);

const noUser = buildTurnEvents({
  sourceId: "claude", convId: "c1", url: "u", title: undefined,
  userText: null, userMsgId: null, assistantText: "just me", assistantMsgId: null, model: null,
});
check("omits an absent user turn", noUser.length === 2);
check(
  "the lone assistant turn still starts at position 0",
  (noUser[1] as CaptureEventMessageAppended).position === 0,
);

const empty = buildTurnEvents({
  sourceId: "claude", convId: "c1", url: "u", title: undefined,
  userText: null, userMsgId: null, assistantText: "   ", assistantMsgId: null, model: null,
});
check("whitespace-only assistant text is dropped", empty.length === 1);

// ─── Message identity ────────────────────────────────────────────────────────

console.log("\n=== message identity ===\n");

function msg(over: Partial<CaptureEventMessageAppended> = {}): CaptureEventMessageAppended {
  return {
    kind: "message_appended",
    platform: "whatsapp",
    platform_conv_id: "g1",
    role: "user",
    content_text: "ok",
    created_at: "2026-07-31T10:00:00Z",
    position: 0,
    ...over,
  };
}

check("external id wins when present", hashSchemeFor(msg({ platform_msg_id: "abc" })) === "external-id");
check(
  "platform timestamps are used when there is no id",
  hashSchemeFor(msg({ created_at_source: "platform" })) === "platform-time",
);
check("otherwise falls back to role+text", hashSchemeFor(msg()) === "role-text");

check(
  "the same external id hashes the same regardless of text",
  messageHash(msg({ platform_msg_id: "abc", content_text: "one" })) ===
    messageHash(msg({ platform_msg_id: "abc", content_text: "two" })),
);
check(
  "different external ids differ",
  messageHash(msg({ platform_msg_id: "abc" })) !== messageHash(msg({ platform_msg_id: "def" })),
);

// The behaviour human chat needs: two identical messages sent at different
// times must NOT collapse.
check(
  "repeated 'ok' at different platform times are distinct",
  messageHash(msg({ created_at_source: "platform", created_at: "2026-07-31T10:00:00Z" })) !==
    messageHash(msg({ created_at_source: "platform", created_at: "2026-07-31T10:05:00Z" })),
);

// The behaviour DOM-observed sources need: re-capturing the same turn after a
// page reload (fresh Date.now(), no platform id) must stay idempotent.
check(
  "an observed-time re-capture of the same turn collapses",
  messageHash(msg({ created_at: "2026-07-31T10:00:00Z" })) ===
    messageHash(msg({ created_at: "2026-07-31T11:22:33Z" })),
);
check(
  "role is part of the fallback key",
  messageHash(msg({ role: "user" })) !== messageHash(msg({ role: "assistant" })),
);
check(
  "the three schemes cannot collide with each other",
  new Set([
    messageHash(msg({ platform_msg_id: "k" })),
    messageHash(msg({ created_at_source: "platform" })),
    messageHash(msg()),
  ]).size === 3,
);

// ─── Exit test: a synthetic fourth connector ─────────────────────────────────
//
// Phase 1's exit criterion is that adding a source is cheap. Everything below
// this line is the entire definition of a new fetch-interceptor connector for a
// hypothetical "Nova" assistant — no new strategy, no new bridge, no new
// plumbing. If this stops being small, the abstraction has stopped holding.

console.log("\n=== exit test: synthetic fourth connector ===\n");

const NOVA: SourceDef = {
  id: "nova",
  label: "Nova",
  color: "#7a5fa6",
  origins: ["https://nova.test/*"],
  kind: "ai",
  multiParty: false,
  capabilities: { live: true, backfill: false, composer: true, overlay: true },
  convIdFromUrl: (u) => u.pathname.match(/\/t\/([\w-]{6,})/)?.[1] ?? null,
};

const novaConnector: FetchConnectorDef = {
  sourceId: NOVA.id,
  matchRequest: (url, method) =>
    method === "POST" && url.includes("/api/talk") ? { convId: null } : null,
  readRequest: (json) => ({
    convId: typeof json.thread === "string" ? json.thread : null,
    userText: typeof json.say === "string" ? json.say : null,
  }),
  reduceEvent: (payload, state: StreamState) => {
    const o = payload as { chunk?: string; thread?: string; model?: string };
    if (typeof o?.thread === "string") state.convId ??= o.thread;
    if (typeof o?.model === "string") state.model ??= o.model;
    if (typeof o?.chunk === "string") state.assistantText += o.chunk;
  },
  conversationUrl: (id) => `https://nova.test/t/${id}`,
  titleSuffix: /\s*[-|]\s*Nova$/i,
  bareTitle: "Nova",
};

// Drive it exactly as installFetchInterceptor would, minus the browser bits.
const novaState: StreamState = { convId: null, model: null, assistantText: "", assistantMsgId: null };
await readSseStream(
  streamOf([
    'data: {"thread":"t-123456","model":"nova-1"}\n\n',
    'data: {"chunk":"Hel"}\n\n',
    'data: {"chunk":"lo!"}\n\n',
    "data: [DONE]\n\n",
  ]),
  (p) => novaConnector.reduceEvent(p, novaState),
);

check("matchRequest ignores unrelated requests", novaConnector.matchRequest("https://nova.test/x", "POST") === null);
check("matchRequest ignores GETs", novaConnector.matchRequest("https://nova.test/api/talk", "GET") === null);
check("matchRequest accepts the completion endpoint", novaConnector.matchRequest("https://nova.test/api/talk", "POST") !== null);
check("readRequest pulls the user text", novaConnector.readRequest!({ say: "hi", thread: "t-123456" }).userText === "hi");
check("reduceEvent accumulated the streamed answer", novaState.assistantText === "Hello!");
check("reduceEvent picked up the conversation id", novaState.convId === "t-123456");
check("reduceEvent picked up the model", novaState.model === "nova-1");
check("the source's own URL parsing works", NOVA.convIdFromUrl(new URL("https://nova.test/t/t-123456")) === "t-123456");

const novaEvents = buildTurnEvents({
  sourceId: NOVA.id,
  convId: novaState.convId!,
  url: novaConnector.conversationUrl(novaState.convId!),
  title: "Chat about X",
  userText: "hi",
  userMsgId: null,
  assistantText: novaState.assistantText,
  assistantMsgId: null,
  model: novaState.model,
  now: () => "2026-07-31T00:00:00.000Z",
});
check("a full turn comes out the other end", novaEvents.length === 3);
check(
  "…addressed to the new source",
  novaEvents.every((e) => e.platform === "nova"),
);

console.log(`\nAssertions: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
