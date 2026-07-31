// Capture event ingestion.
//
// This is where a connector's loose "here is a turn I saw" becomes a row with a
// real identity and a real place in the conversation. Three things were wrong
// here before Phase 1, all of them harmless for AI chat and fatal for human
// chat — see the notes on messageHash(), nextPosition() and the accepted count.

import { randomUUID } from "./crypto.js";
import type { CaptureEvent, Role, SourceId } from "@smriti/shared";
import { dbGet, dbRun, getDb, markDirty } from "./db.js";
import { messageHash } from "./ingest-identity.js";

/**
 * The next dense position in a conversation.
 *
 * `position` used to be `Date.now()` at capture time and `Date.parse(ts)` for
 * backfilled rows — a wall-clock tiebreaker, not a turn index, so backfilled
 * and live-captured messages in one conversation interleaved by capture time.
 * Ingest runs in the offscreen document with the DB in hand, so it is the only
 * place that can assign a true index; the connector's counter is just a
 * within-batch hint.
 */
function nextPosition(conversationId: string): number {
  const row = dbGet<{ next: number }>(
    "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM messages WHERE conversation_id = ?",
    [conversationId],
  );
  return row?.next ?? 0;
}

// ─── Spaces and people ───────────────────────────────────────────────────────
//
// Migration 006 backfilled these for existing rows; new rows have to keep them
// populated or the two halves of the archive diverge. For an AI source the
// mapping is fixed: one app-level space, the user is always `person:self`, and
// the assistant is the source's bot person. Human sources will resolve real
// people per message in Phase 3.

const SELF_PERSON_ID = "person:self";

function appSpaceId(source: SourceId): string {
  return `space:${source}`;
}

function botPersonId(source: SourceId): string {
  return `person:bot:${source}`;
}

function ensureSpaceAndPeople(source: SourceId, now: string): void {
  dbRun(
    `INSERT INTO spaces (id, source, space_key, label, kind, created_at, last_active_at)
     VALUES (?, ?, 'app', ?, 'app', ?, ?)
     ON CONFLICT(source, space_key) DO UPDATE SET last_active_at = excluded.last_active_at`,
    [appSpaceId(source), source, source, now, now],
  );
  dbRun(
    `INSERT INTO people (id, display_name, is_self, created_at)
     VALUES (?, 'You', 1, ?)
     ON CONFLICT(id) DO NOTHING`,
    [SELF_PERSON_ID, now],
  );
  dbRun(
    `INSERT INTO people (id, display_name, is_self, created_at)
     VALUES (?, ?, 0, ?)
     ON CONFLICT(id) DO NOTHING`,
    [botPersonId(source), source, now],
  );
}

/** Which person authored this turn. system/tool turns are not people. */
function authorFor(source: SourceId, role: Role): string | null {
  if (role === "user") return SELF_PERSON_ID;
  if (role === "assistant") return botPersonId(source);
  return null;
}

// ─── Ingest ──────────────────────────────────────────────────────────────────

export function ingestEvents(events: CaptureEvent[]): { accepted: number } {
  const db = getDb();
  let accepted = 0;
  // Real inserts, per source — what the badge and daily stats should report.
  const inserted = new Map<SourceId, { messages: number; conversations: number; user_messages: number }>();
  const bump = (
    source: SourceId,
    field: "messages" | "conversations" | "user_messages",
    n = 1,
  ): void => {
    const e = inserted.get(source) ?? { messages: 0, conversations: 0, user_messages: 0 };
    e[field] += n;
    inserted.set(source, e);
  };

  const seenSources = new Set<SourceId>();
  const now = new Date().toISOString();

  db.run("BEGIN");
  try {
    for (const ev of events) {
      if (!seenSources.has(ev.platform)) {
        seenSources.add(ev.platform);
        ensureSpaceAndPeople(ev.platform, now);
      }

      if (ev.kind === "conversation_seen") {
        const existing = dbGet<{ id: string }>(
          "SELECT id FROM conversations WHERE platform = ? AND platform_conv_id = ?",
          [ev.platform, ev.platform_conv_id],
        );
        const id = existing?.id ?? randomUUID();
        dbRun(
          `INSERT INTO conversations
             (id, platform, platform_conv_id, title, url, started_at, last_message_at, ingested_at, space_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(platform, platform_conv_id) DO UPDATE SET
             title = COALESCE(excluded.title, conversations.title),
             url   = COALESCE(excluded.url, conversations.url),
             last_message_at = excluded.last_message_at`,
          [id, ev.platform, ev.platform_conv_id, ev.title ?? null, ev.url ?? null,
           ev.observed_at, ev.observed_at, ev.observed_at, appSpaceId(ev.platform)],
        );
        if (!existing) bump(ev.platform, "conversations");
        accepted++;
      } else if (ev.kind === "message_appended") {
        // Ensure the conversation exists.
        const conv = dbGet<{ id: string }>(
          "SELECT id FROM conversations WHERE platform = ? AND platform_conv_id = ?",
          [ev.platform, ev.platform_conv_id],
        );
        let convId: string;
        if (!conv) {
          convId = randomUUID();
          dbRun(
            `INSERT INTO conversations
               (id, platform, platform_conv_id, title, url, started_at, last_message_at, ingested_at, space_id)
             VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
            [convId, ev.platform, ev.platform_conv_id, ev.created_at, ev.created_at,
             ev.created_at, appSpaceId(ev.platform)],
          );
          bump(ev.platform, "conversations");
        } else {
          convId = conv.id;
        }

        const position = ev.position_authoritative
          ? ev.position
          : nextPosition(convId);

        dbRun(
          `INSERT OR IGNORE INTO messages
             (id, conversation_id, platform_msg_id, role, content_text,
              content_html, model, created_at, position, content_hash, author_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [randomUUID(), convId, ev.platform_msg_id ?? null, ev.role,
           ev.content_text, ev.content_html ?? null,
           ev.model ?? null, ev.created_at, position, messageHash(ev),
           authorFor(ev.platform, ev.role)],
        );

        // INSERT OR IGNORE silently does nothing on a dedup hit. The old code
        // counted the *event* either way, so the badge over-reported every
        // duplicate as new work.
        const didInsert = db.getRowsModified() > 0;
        if (didInsert) {
          bump(ev.platform, "messages");
          if (ev.role === "user") bump(ev.platform, "user_messages");
          dbRun(
            "UPDATE conversations SET last_message_at = ? WHERE id = ?",
            [ev.created_at, convId],
          );
          accepted++;
        }
      } else if (ev.kind === "conversation_updated") {
        dbRun(
          `UPDATE conversations SET
             title    = COALESCE(?, title),
             archived = COALESCE(?, archived)
           WHERE platform = ? AND platform_conv_id = ?`,
          [
            ev.title ?? null,
            ev.archived === undefined ? null : ev.archived ? 1 : 0,
            ev.platform,
            ev.platform_conv_id,
          ],
        );
        if (db.getRowsModified() > 0) accepted++;
      }
    }
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }

  if (accepted > 0) {
    markDirty();
    const today = now.slice(0, 10); // YYYY-MM-DD

    for (const [source, counts] of inserted) {
      // capture_state drives the live green dot per source in Settings. Mark it
      // healthy even for a batch that was all duplicates — we did hear from the
      // connector, which is what "green" means.
      dbRun(
        `INSERT INTO capture_state (platform, enabled, last_seen_at, health)
         VALUES (?, 1, ?, 'green')
         ON CONFLICT(platform) DO UPDATE SET
           last_seen_at = excluded.last_seen_at,
           health       = 'green'`,
        [source, now],
      );

      if (counts.conversations === 0 && counts.messages === 0) continue;
      dbRun(
        `INSERT INTO daily_stats (date, platform, conversations_count, messages_count, user_messages_count)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(date, platform) DO UPDATE SET
           conversations_count  = conversations_count  + excluded.conversations_count,
           messages_count       = messages_count       + excluded.messages_count,
           user_messages_count  = user_messages_count  + excluded.user_messages_count`,
        [today, source, counts.conversations, counts.messages, counts.user_messages],
      );
    }
  }
  return { accepted };
}
