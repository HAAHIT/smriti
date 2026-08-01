// The source layer: registry resolution, the connector SDK's pure parts, and
// message identity.
//
// Run: npx tsx scripts/test-connectors.ts
//
// The point of Phase 1 was to replace three hand-written connectors with a
// registry plus two reusable strategies. Two things need to stay true for that
// to have been worth doing, and both are asserted here:
//   1. every origin list is derived from the registry, so they cannot drift
//   2. a NEW connector is small — the synthetic sources at the bottom are the
//      exit test for the whole phase.
//
// Phase 3 added the first human source, and with it the parsing that decides who
// said what (lib/connectors/whatsapp-parse.ts). Those assertions live here too:
// attributing a message to the wrong person is the failure mode of this phase,
// and it is silent.

import {
  SOURCES,
  allHosts,
  allOrigins,
  bridgeOrigins,
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
  authorIdOf,
  inferDateOrder,
  parseDataId,
  parsePrePlainText,
  toIsoTimestamp,
} from "../lib/connectors/whatsapp-parse.js";
import {
  buildTurnEvents,
  readSseStream,
  urlOf,
  type FetchConnectorDef,
  type StreamState,
} from "../lib/connectors/fetch-interceptor.js";
import { hashSchemeFor, messageHash } from "../lib/ingest-identity.js";
import type { TurnMeta } from "../lib/connectors/dom-observer.js";
import type { CaptureEventMessageAppended } from "@smriti/shared";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  cond ? pass++ : fail++;
}

// ─── Registry ────────────────────────────────────────────────────────────────

console.log("\n=== registry ===\n");

check("four sources declared", SOURCES.length === 4);
check(
  "every source id is unique",
  new Set(SOURCES.map((s) => s.id)).size === SOURCES.length,
);
check(
  "every origin is an https match pattern",
  allOrigins().every((o) => /^https:\/\/[^/]+\/\*$/.test(o)),
);
check(
  "every source declares a capture strategy",
  SOURCES.every((s) => s.strategy === "fetch" || s.strategy === "dom"),
);
check(
  "a source that cannot be walked does not claim backfill",
  sourceById("gemini")?.capabilities.backfill === false,
);

check("hostOfOrigin strips scheme and path", hostOfOrigin("https://claude.ai/*") === "claude.ai");
check("hostOfOrigin strips a leading wildcard label", hostOfOrigin("https://*.example.com/*") === "example.com");

check("sourceById finds a known source", sourceById("claude")?.label === "Claude");
check("sourceById returns null for an unknown id", sourceById("signal") === null);

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

// ─── The human source ────────────────────────────────────────────────────────
//
// A human source differs from an AI one in ways that are *behavioural*, not
// cosmetic: no composer to inject into, no sidebar overlay, no history endpoint
// to walk, and — because the mechanism runs ISOLATED — no bridge script on the
// user's private messages.

console.log("\n=== the human source ===\n");

const wa = sourceById("whatsapp");

check("whatsapp is declared", wa?.kind === "human");
check("…and is multi-party", wa?.multiParty === true);
check("…captures live", wa?.capabilities.live === true);
check("…offers no composer to inject into", wa?.capabilities.composer === false);
check("…does not mount the sidebar overlay", wa?.capabilities.overlay === false);
check("…and cannot be backfilled", wa?.capabilities.backfill === false);
check("…via the DOM, not fetch", wa?.strategy === "dom");

check(
  "the sidebar does not mount on a human source",
  !overlayOrigins().some((o) => o.includes("whatsapp")),
);
check(
  "the bridge is not injected into a human source's pages",
  !bridgeOrigins().some((o) => o.includes("whatsapp")),
);
check(
  "…nor into any DOM-observer source",
  bridgeOrigins().every((o) => SOURCES.some((s) => s.strategy === "fetch" && s.origins.includes(o))),
);
check(
  "…but every fetch source still has one",
  SOURCES.filter((s) => s.strategy === "fetch").every((s) =>
    s.origins.every((o) => bridgeOrigins().includes(o)),
  ),
);
check(
  "capture can still be paused per host on a human source",
  hostsForSource("whatsapp").includes("web.whatsapp.com"),
);

// WhatsApp Web serves every chat from one URL. Returning anything from it would
// mint a second id shape for a chat the connector already identifies by jid.
check(
  "the URL never identifies a WhatsApp thread",
  wa!.convIdFromUrl(new URL("https://web.whatsapp.com/")) === null &&
    wa!.convIdFromUrl(new URL("https://web.whatsapp.com/send?phone=919812345678")) === null,
);

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

// ─── WhatsApp: who said what ─────────────────────────────────────────────────
//
// `data-id` is WhatsApp's own statement of chat, message, sender and direction.
// Every assertion here is really about one thing: a message must never be filed
// under the wrong person.

console.log("\n=== whatsapp: data-id ===\n");

const dmIn = parseDataId("false_919812345678@c.us_3EB0C2F1A2B3");
check("a DM's incoming message parses", dmIn !== null);
check("…is not from the user", dmIn?.fromMe === false);
check("…names the chat", dmIn?.chatId === "919812345678@c.us");
check("…names the message", dmIn?.msgId === "3EB0C2F1A2B3");
check("…has no participant", dmIn?.participant === null);
check("…and is not a group", dmIn?.isGroup === false);

const dmOut = parseDataId("true_919812345678@c.us_3EB0C2F1A2B3");
check("an outgoing message is flagged as the user's", dmOut?.fromMe === true);
check(
  "…and the jid is still the other party, so it is not who spoke",
  authorIdOf(dmOut!) === "self",
);
check("an incoming DM is authored by the chat itself", authorIdOf(dmIn!) === "919812345678@c.us");

const grp = parseDataId("false_120363019283746@g.us_3EB0ABC_919812345678@c.us");
check("a group message parses", grp !== null);
check("…is a group", grp?.isGroup === true);
check("…names the participant", grp?.participant === "919812345678@c.us");
check("…and the participant is the author, not the group", authorIdOf(grp!) === "919812345678@c.us");
check(
  "an outgoing group message is still the user's, by their own number",
  authorIdOf(parseDataId("true_120363019283746@g.us_3EB0ABC_919800000000@c.us")!) === "919800000000@c.us",
);
check(
  "a message id containing an underscore survives",
  parseDataId("false_919812345678@c.us_3EB0_ABC_DEF")?.msgId === "3EB0_ABC_DEF",
);
check("a legacy group jid is still a group", parseDataId("false_919812345678-1600000000@g.us_X")?.isGroup === true);

// Half-parsed is worse than unparsed: it would attribute a message to whoever
// happened to be in the wrong field.
check("a malformed id is rejected outright", parseDataId("garbage") === null);
check("…a missing direction flag is rejected", parseDataId("maybe_919812345678@c.us_X") === null);
check("…a non-jid chat is rejected", parseDataId("false_notajid_X") === null);
check("…and a missing message id is rejected", parseDataId("false_919812345678@c.us_") === null);

console.log("\n=== whatsapp: data-pre-plain-text ===\n");

const pre = parsePrePlainText("[10:32, 7/31/2026] Alice: ");
check("the timestamp and sender parse", pre?.time === "10:32" && pre?.date === "7/31/2026");
check("…and the name is trimmed of its colon", pre?.author === "Alice");
check(
  "a sender named by number still parses",
  parsePrePlainText("[10:32, 7/31/2026] +91 98123 45678: ")?.author === "+91 98123 45678",
);
check(
  "an outgoing row with no name parses with a null author",
  parsePrePlainText("[10:32, 7/31/2026] ")?.author === null,
);
check("anything else is rejected", parsePrePlainText("Alice said hello") === null);

console.log("\n=== whatsapp: ambiguous dates ===\n");

// The failure this guards: a wrong date shifts a message by weeks, and
// lib/segment.ts splits episodes on time gaps — so a bad date silently reshapes
// the index rather than showing up as a wrong timestamp somewhere visible.
check("a day past the 12th proves day-first", inferDateOrder(["31/07/2026", "1/2/2026"]) === "dmy");
check("…and in the second slot proves month-first", inferDateOrder(["7/31/2026"]) === "mdy");
check("an all-ambiguous chat stays unknown", inferDateOrder(["1/2/2026", "3/4/2026"]) === null);
check("contradictory samples are trusted no further", inferDateOrder(["31/07/2026", "7/31/2026"]) === null);
check("an ISO date needs no inference", inferDateOrder(["2026-07-31"]) === "iso");
check("nothing at all is unknown", inferDateOrder([]) === null);

check(
  "an unknown order dates nothing",
  toIsoTimestamp({ date: "1/2/2026", time: "10:32" }, null) === null,
);
check(
  "month-first resolves as rendered",
  toIsoTimestamp({ date: "7/31/2026", time: "10:32" }, "mdy") ===
    new Date(2026, 6, 31, 10, 32, 0).toISOString(),
);
check(
  "day-first resolves as rendered",
  toIsoTimestamp({ date: "31/07/2026", time: "10:32" }, "dmy") ===
    new Date(2026, 6, 31, 10, 32, 0).toISOString(),
);
check(
  "the same digits read both ways are three weeks apart",
  toIsoTimestamp({ date: "7/8/2026", time: "10:32" }, "mdy") !==
    toIsoTimestamp({ date: "7/8/2026", time: "10:32" }, "dmy"),
);
check(
  "a 12-hour clock is understood",
  toIsoTimestamp({ date: "7/31/2026", time: "10:32 pm" }, "mdy") ===
    new Date(2026, 6, 31, 22, 32, 0).toISOString(),
);
check(
  "midnight in 12-hour form is not noon",
  toIsoTimestamp({ date: "7/31/2026", time: "12:05 am" }, "mdy") ===
    new Date(2026, 6, 31, 0, 5, 0).toISOString(),
);
check(
  "a two-digit year is this century",
  toIsoTimestamp({ date: "7/31/26", time: "10:32" }, "mdy") ===
    new Date(2026, 6, 31, 10, 32, 0).toISOString(),
);
check(
  "a date that does not exist is refused, not rolled forward",
  toIsoTimestamp({ date: "2/31/2026", time: "10:32" }, "mdy") === null,
);
check("an unparseable time is refused", toIsoTimestamp({ date: "7/31/2026", time: "half past" }, "mdy") === null);

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

// Phase 3: `role` separates the user from everyone else, which is the entire
// cast on an AI source and nothing like enough in a group.
const alice = { external_id: "919812345678@c.us" };
const bob = { external_id: "919999999999@c.us" };
check(
  "two people agreeing in the same second stay distinct",
  messageHash(msg({ created_at_source: "platform", author: alice })) !==
    messageHash(msg({ created_at_source: "platform", author: bob })),
);
check(
  "…and with no platform timestamp either",
  messageHash(msg({ author: alice })) !== messageHash(msg({ author: bob })),
);
check(
  "the same person written two ways is still one person",
  messageHash(msg({ author: alice })) ===
    messageHash(msg({ author: { external_id: "+91 98123 45678" } })),
);
check(
  "re-capturing one person's message is still idempotent",
  messageHash(msg({ author: alice, created_at: "2026-07-31T10:00:00Z" })) ===
    messageHash(msg({ author: alice, created_at: "2026-07-31T11:22:33Z" })),
);

// Golden values. Every AI connector's hashes must be byte-for-byte what they
// were before authors existed — changing the formula for messages already in the
// archive would re-insert every one of them on its next re-capture.
check(
  "the role+text formula is unchanged for an authorless event",
  messageHash(msg({ role: "user", content_text: "hello" })) === "70efe6041f4ab3ce",
);
check(
  "…and so is the platform-time formula",
  messageHash(
    msg({
      role: "user",
      content_text: "hello",
      created_at: "2026-07-31T10:00:00Z",
      created_at_source: "platform",
    }),
  ) === "fe06691c14f6a8f6",
);
check(
  "…and the external-id formula",
  messageHash(msg({ platform_msg_id: "msg-1" })) === "e96d7dff871e2789",
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
  strategy: "fetch",
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

// ─── Exit test: a synthetic human source ─────────────────────────────────────
//
// Phase 3's exit criterion is that the *second* human source costs a registry
// entry and one function: given a rendered row, say who spoke and where. No new
// strategy, no schema change, no ingest change. Everything below is the whole
// definition of a hypothetical "Pigeon" messenger.

console.log("\n=== exit test: synthetic human source ===\n");

const PIGEON: SourceDef = {
  id: "pigeon",
  label: "Pigeon",
  color: "#5f7aa6",
  strategy: "dom",
  origins: ["https://pigeon.test/*"],
  kind: "human",
  multiParty: true,
  capabilities: { live: true, backfill: false, composer: false, overlay: false },
  convIdFromUrl: (u) => u.pathname.match(/^\/room\/([\w-]{4,})/)?.[1] ?? null,
};

/** The one site-specific function a human connector owes the DOM observer. */
function pigeonMeta(row: { room: string; sender: string; name?: string; mine?: boolean; id: string }): TurnMeta {
  return {
    role: row.mine ? "user" : "assistant",
    platform_msg_id: row.id,
    conversation_id: row.room,
    author: { external_id: row.sender, display_name: row.name, is_self: row.mine },
    space: { space_key: row.room, kind: "group", label: "Pigeon room" },
  };
}

const pigeonTurn = pigeonMeta({ room: "r-4821", sender: "@carol", name: "Carol", id: "m-9" });
check("the room is the conversation", pigeonTurn.conversation_id === "r-4821");
check("the sender is the author", pigeonTurn.author?.external_id === "@carol");
check("…and is not the user", pigeonTurn.role === "assistant");
check("the room is a group space", pigeonTurn.space?.kind === "group");
check(
  "the user's own turn is theirs",
  pigeonMeta({ room: "r-4821", sender: "@me", mine: true, id: "m-10" }).role === "user",
);
check("the URL still identifies a room here", PIGEON.convIdFromUrl(new URL("https://pigeon.test/room/r-4821")) === "r-4821");
check(
  "two participants in one room do not collapse",
  messageHash(msg({ author: { external_id: "@carol" }, content_text: "haha" })) !==
    messageHash(msg({ author: { external_id: "@dave" }, content_text: "haha" })),
);
check(
  "a handle is normalised the same everywhere",
  messageHash(msg({ author: { external_id: "@Carol" } })) ===
    messageHash(msg({ author: { external_id: "carol" } })),
);

console.log(`\nAssertions: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
