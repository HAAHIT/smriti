// Message identity — the dedup key, isolated from the DB so it can be tested.
//
// Kept out of lib/ingest.ts because that file imports lib/db.ts, which pulls in
// sql.js and a Vite-only `?url` import and therefore cannot be loaded under
// Node. Same split as extract.ts / sync-merge.ts / sidebar-helpers.ts.

import { createHash } from "./crypto.js";
import type { CaptureEventMessageAppended } from "@smriti/shared";

/** The three identity schemes, strongest first. Exported for the test suite. */
export type HashScheme = "external-id" | "platform-time" | "role-text";

/** Which scheme applies to this event. */
export function hashSchemeFor(ev: CaptureEventMessageAppended): HashScheme {
  if (ev.platform_msg_id) return "external-id";
  if (ev.created_at_source === "platform") return "platform-time";
  return "role-text";
}

/**
 * The dedup key for a message, as strong as the source allows.
 *
 * This key does two jobs at once, and they pull in opposite directions:
 *
 *   * **Distinguish** genuinely repeated messages. The original formula was
 *     `hash(role + "\\0" + text)`, which silently dropped every repeat in a
 *     conversation — every second "ok", "haha", "👍". Invisible in AI chat,
 *     fatal for human chat.
 *   * **Collapse** re-captures of a message already stored, so re-reading a
 *     conversation is idempotent.
 *
 * Which formula can serve both depends on what identity the source offers:
 *
 *   1. `platform_msg_id` — the platform's own id. Stable across re-capture and
 *      distinct per message. Always preferred.
 *   2. A platform-issued timestamp — distinct for repeats, and stable because
 *      the platform minted it, not us.
 *   3. Neither — the original role+text formula. A DOM-observed source
 *      re-emits every turn on screen on each page load with a fresh
 *      `Date.now()`, so hashing an observed timestamp (or a position derived
 *      from row count) would re-insert the entire conversation on every
 *      reload. Repeats collapse, as they always have. That is the price of
 *      having no identity to key on, and it applies only to sources offering
 *      none.
 *
 * The scheme prefix keeps the three from ever colliding with each other.
 *
 * Historical rows keep their old hashes — deliberately. Recomputing them would
 * mean an UPDATE over every message, and the FTS triggers turn that into a
 * full-index rewrite. The cost of not doing so is bounded: at most one
 * duplicate the first time a pre-upgrade message is re-captured, and the
 * partial unique index on `platform_msg_id` catches most of those.
 */
export function messageHash(ev: CaptureEventMessageAppended): string {
  switch (hashSchemeFor(ev)) {
    case "external-id":
      return createHash("id\0" + ev.platform_msg_id);
    case "platform-time":
      return createHash("t\0" + ev.role + "\0" + ev.created_at + "\0" + ev.content_text);
    case "role-text":
      return createHash("r\0" + ev.role + "\0" + ev.content_text);
  }
}
