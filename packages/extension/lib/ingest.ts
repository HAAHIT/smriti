// Capture event ingestion — ported from packages/helper/src/ingest.ts.
// Replaces better-sqlite3 prepared statements with sql.js helpers.

import { randomUUID, createHash } from "./crypto.js";
import type { CaptureEvent } from "@smriti/shared";
import { dbGet, dbRun, getDb, markDirty } from "./db.js";

export function ingestEvents(events: CaptureEvent[]): { accepted: number } {
  const db = getDb();
  let accepted = 0;

  db.run("BEGIN");
  try {
    for (const ev of events) {
      if (ev.kind === "conversation_seen") {
        const existing = dbGet<{ id: string }>(
          "SELECT id FROM conversations WHERE platform = ? AND platform_conv_id = ?",
          [ev.platform, ev.platform_conv_id],
        );
        const id = existing?.id ?? randomUUID();
        dbRun(
          `INSERT INTO conversations
             (id, platform, platform_conv_id, title, url, started_at, last_message_at, ingested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(platform, platform_conv_id) DO UPDATE SET
             title = COALESCE(excluded.title, conversations.title),
             url   = COALESCE(excluded.url, conversations.url),
             last_message_at = excluded.last_message_at`,
          [id, ev.platform, ev.platform_conv_id, ev.title ?? null, ev.url ?? null,
           ev.observed_at, ev.observed_at, ev.observed_at],
        );
        accepted++;
      } else if (ev.kind === "message_appended") {
        // Ensure conversation exists.
        let conv = dbGet<{ id: string }>(
          "SELECT id FROM conversations WHERE platform = ? AND platform_conv_id = ?",
          [ev.platform, ev.platform_conv_id],
        );
        let convId: string;
        if (!conv) {
          convId = randomUUID();
          dbRun(
            `INSERT INTO conversations
               (id, platform, platform_conv_id, title, url, started_at, last_message_at, ingested_at)
             VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)`,
            [convId, ev.platform, ev.platform_conv_id, ev.created_at, ev.created_at, ev.created_at],
          );
        } else {
          convId = conv.id;
        }

        const hash = createHash(ev.role + "\0" + ev.content_text);
        dbRun(
          `INSERT OR IGNORE INTO messages
             (id, conversation_id, platform_msg_id, role, content_text,
              content_html, model, created_at, position, content_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [randomUUID(), convId, ev.platform_msg_id ?? null, ev.role,
           ev.content_text, (ev as { content_html?: string }).content_html ?? null,
           ev.model ?? null, ev.created_at, ev.position, hash],
        );
        dbRun(
          "UPDATE conversations SET last_message_at = ? WHERE id = ?",
          [ev.created_at, convId],
        );
        accepted++;
      } else if (ev.kind === "conversation_updated") {
        dbRun(
          `UPDATE conversations SET
             title    = COALESCE(?, title),
             archived = COALESCE(?, archived)
           WHERE platform = ? AND platform_conv_id = ?`,
          [
            (ev as { title?: string }).title ?? null,
            (ev as { archived?: boolean }).archived === undefined
              ? null
              : (ev as { archived?: boolean }).archived ? 1 : 0,
            ev.platform,
            ev.platform_conv_id,
          ],
        );
        accepted++;
      }
    }
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }

  if (accepted > 0) {
    markDirty();
    const now = new Date().toISOString();
    const today = now.slice(0, 10); // YYYY-MM-DD

    // Count accepted by platform for this batch.
    const byPlatform = new Map<string, { messages: number; conversations: number; user_messages: number }>();
    for (const ev of events) {
      if (ev.kind === "message_appended" || ev.kind === "conversation_seen") {
        const entry = byPlatform.get(ev.platform) ?? { messages: 0, conversations: 0, user_messages: 0 };
        if (ev.kind === "message_appended") {
          entry.messages++;
          if (ev.role === "user") entry.user_messages++;
        } else {
          entry.conversations++;
        }
        byPlatform.set(ev.platform, entry);
      }
    }

    for (const [platform, counts] of byPlatform) {
      // Update capture_state — so Settings shows a live green dot per platform.
      dbRun(
        `INSERT INTO capture_state (platform, enabled, last_seen_at, health)
         VALUES (?, 1, ?, 'green')
         ON CONFLICT(platform) DO UPDATE SET
           last_seen_at = excluded.last_seen_at,
           health       = 'green'`,
        [platform, now],
      );

      // Upsert today's daily stats.
      dbRun(
        `INSERT INTO daily_stats (date, platform, conversations_count, messages_count, user_messages_count)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(date, platform) DO UPDATE SET
           conversations_count  = conversations_count  + excluded.conversations_count,
           messages_count       = messages_count       + excluded.messages_count,
           user_messages_count  = user_messages_count  + excluded.user_messages_count`,
        [today, platform, counts.conversations, counts.messages, counts.user_messages],
      );
    }
  }
  return { accepted };
}
