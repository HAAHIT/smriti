// WhatsApp Web connector — `domObserver` strategy, and the first human source.
//
// Everything site-specific lives here; the mechanism (settle debounce, dedup,
// SPA re-scan) is lib/connectors/dom-observer.ts and the string parsing is
// lib/connectors/whatsapp-parse.ts, which is pure and tested.
//
// What makes this source different from the three AI ones:
//
//   * **The URL never changes.** web.whatsapp.com serves every chat from one
//     location, so the conversation id comes off each message row's `data-id`
//     rather than from the address bar.
//   * **The speaker changes per message.** A group has N participants, so every
//     turn carries an author and ingest resolves it to a person.
//   * **The bubble side is not evidence.** `data-id` states whether the user
//     sent a message; the CSS class is only the fallback.
//
// Selector note: WhatsApp ships obfuscated class names that rotate, so nothing
// here depends on one. `message-in` / `message-out`, `data-id`,
// `data-pre-plain-text` and `selectable-text` are the stable, semantic hooks.

import { defineContentScript } from "wxt/sandbox";
import { sourceById } from "../lib/connectors/registry";
import { installDomObserver, type TurnMeta } from "../lib/connectors/dom-observer";
import {
  authorIdOf,
  inferDateOrder,
  parseDataId,
  parsePrePlainText,
  toIsoTimestamp,
  type DateOrder,
} from "../lib/connectors/whatsapp-parse";

const source = sourceById("whatsapp")!;

// ─── Date order ──────────────────────────────────────────────────────────────
//
// WhatsApp renders dates in the browser's locale, so "7/8/2026" is ambiguous
// until some message in the chat falls after the 12th of a month. Samples are
// pooled across the whole page — seeded from whatever is already on screen, then
// topped up as rows arrive — and until the order is settled, messages are dated
// by observation instead. See whatsapp-parse.ts for why guessing is not an
// option.

const dateSamples: string[] = [];
let dateOrder: DateOrder | null = null;

function noteDateSample(date: string): void {
  if (dateOrder) return;
  dateSamples.push(date);
  if (dateSamples.length > 200) dateSamples.shift();
  dateOrder = inferDateOrder(dateSamples);
}

function seedDateOrder(): void {
  for (const el of document.querySelectorAll("[data-pre-plain-text]")) {
    const p = parsePrePlainText(el.getAttribute("data-pre-plain-text") ?? "");
    if (p) noteDateSample(p.date);
  }
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

/** `data-id` sits on the row, the bubble, or a wrapper, depending on the build. */
function dataIdOf(el: Element): string | null {
  return (
    el.getAttribute("data-id") ??
    el.closest("[data-id]")?.getAttribute("data-id") ??
    el.querySelector("[data-id]")?.getAttribute("data-id") ??
    null
  );
}

function prePlainTextOf(el: Element): string | null {
  return (
    el.getAttribute("data-pre-plain-text") ??
    el.querySelector("[data-pre-plain-text]")?.getAttribute("data-pre-plain-text") ??
    null
  );
}

/** The open chat's name, from the conversation header. */
function chatTitle(): string | undefined {
  const header = document.querySelector("#main header");
  const titled = header?.querySelector("[title]")?.getAttribute("title")?.trim();
  if (titled) return titled;
  const text = header?.textContent?.trim();
  return text || undefined;
}

/**
 * The message text only.
 *
 * `selectable-text` marks the message body; the surrounding bubble also holds
 * the timestamp, read receipts and reply chrome, so reading the element itself
 * would store "10:32Alice replied…" as the message.
 */
function textFrom(el: Element): string {
  const spans = el.querySelectorAll(".copyable-text span.selectable-text, span.selectable-text");
  if (spans.length > 0) {
    return Array.from(spans)
      .map((s) => s.textContent ?? "")
      .join("\n")
      .trim();
  }
  const copyable = el.querySelector(".copyable-text");
  return (copyable?.textContent ?? el.textContent ?? "").trim();
}

// ─── Per-turn metadata ───────────────────────────────────────────────────────

function metaFrom(el: Element): TurnMeta | null {
  const raw = dataIdOf(el);
  const id = raw ? parseDataId(raw) : null;

  const pre = prePlainTextOf(el);
  const parsed = pre ? parsePrePlainText(pre) : null;
  if (parsed) noteDateSample(parsed.date);
  const createdAt = parsed ? toIsoTimestamp(parsed, dateOrder) : null;

  // Without a parseable data-id there is no thread id, so the turn cannot be
  // stored at all — returning what we have lets the observer drop it cleanly.
  if (!id) {
    return createdAt ? { created_at: createdAt, created_at_source: "platform" } : null;
  }

  const externalId = authorIdOf(id);
  return {
    role: id.fromMe ? "user" : "assistant",
    platform_msg_id: id.msgId,
    conversation_id: id.chatId,
    conversation_title: chatTitle(),
    author: {
      external_id: externalId,
      // The rendered name is the sender's in an incoming message. On an outgoing
      // one it is the user's own, which `is_self` already says better, and in a
      // DM the header carries the contact's name instead.
      display_name: id.fromMe ? undefined : parsed?.author ?? undefined,
      is_self: id.fromMe,
    },
    space: {
      space_key: id.chatId,
      kind: id.isGroup ? "group" : "dm",
      label: chatTitle(),
    },
    ...(createdAt ? { created_at: createdAt, created_at_source: "platform" as const } : {}),
  };
}

export default defineContentScript({
  matches: source.origins,
  runAt: "document_idle",
  main() {
    seedDateOrder();
    installDomObserver({
      sourceId: source.id,
      // WhatsApp paints a row essentially at once; the settle window only has to
      // outlast the read-receipt tick swapping in.
      settleMs: 600,
      convIdFromUrl: (u) => source.convIdFromUrl(u),
      metaFrom,
      textFrom,
      titleSuffix: /\s*[-–|]\s*WhatsApp.*$/i,
      bareTitle: "WhatsApp",
      roleSelectors: [
        // Fallback only — `metaFrom` overrides the role from `data-id`, which is
        // WhatsApp's own statement of who sent what.
        { role: "user", selectors: ["div.message-out", "[data-id^='true_']"] },
        { role: "assistant", selectors: ["div.message-in", "[data-id^='false_']"] },
      ],
    });
  },
});
