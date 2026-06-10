import { randomUUID, createHash } from "node:crypto";
import type { CaptureEvent } from "@smriti/shared";
import { getDb } from "./db.js";

export function ingestEvents(events: CaptureEvent[]): { accepted: number } {
  const db = getDb();
  let accepted = 0;

  const upsertConv = db.prepare(`
    INSERT INTO conversations (id, platform, platform_conv_id, title, url, started_at, last_message_at, ingested_at)
    VALUES (@id, @platform, @platform_conv_id, @title, @url, @ts, @ts, @ts)
    ON CONFLICT (platform, platform_conv_id) DO UPDATE SET
      title = COALESCE(excluded.title, conversations.title),
      url   = COALESCE(excluded.url, conversations.url),
      last_message_at = excluded.last_message_at
  `);
  const getConv = db.prepare(
    "SELECT id FROM conversations WHERE platform = ? AND platform_conv_id = ?",
  );
  const insertMsg = db.prepare(`
    INSERT OR IGNORE INTO messages
      (id, conversation_id, platform_msg_id, role, content_text, content_html, model, created_at, position, content_hash)
    VALUES (@id, @conversation_id, @platform_msg_id, @role, @content_text, @content_html, @model, @created_at, @position, @content_hash)
  `);
  const updateConvLast = db.prepare(
    "UPDATE conversations SET last_message_at = ? WHERE id = ?",
  );
  const updateConvMeta = db.prepare(
    "UPDATE conversations SET title = COALESCE(?, title), archived = COALESCE(?, archived) WHERE platform = ? AND platform_conv_id = ?",
  );

  function ensureConvId(platform: string, platformConvId: string): string {
    const existing = getConv.get(platform, platformConvId) as { id: string } | undefined;
    return existing?.id ?? randomUUID();
  }

  const tx = db.transaction((evs: CaptureEvent[]) => {
    for (const ev of evs) {
      if (ev.kind === "conversation_seen") {
        const id = ensureConvId(ev.platform, ev.platform_conv_id);
        upsertConv.run({
          id,
          platform: ev.platform,
          platform_conv_id: ev.platform_conv_id,
          title: ev.title ?? null,
          url: ev.url ?? null,
          ts: ev.observed_at,
        });
        accepted++;
      } else if (ev.kind === "message_appended") {
        const conv = getConv.get(ev.platform, ev.platform_conv_id) as { id: string } | undefined;
        let convId: string;
        if (!conv) {
          convId = ensureConvId(ev.platform, ev.platform_conv_id);
          upsertConv.run({
            id: convId,
            platform: ev.platform,
            platform_conv_id: ev.platform_conv_id,
            title: null,
            url: null,
            ts: ev.created_at,
          });
        } else {
          convId = conv.id;
        }
        const hash = createHash("sha256")
          .update(ev.role + "\0" + ev.content_text)
          .digest("hex");
        insertMsg.run({
          id: randomUUID(),
          conversation_id: convId,
          platform_msg_id: ev.platform_msg_id ?? null,
          role: ev.role,
          content_text: ev.content_text,
          content_html: ev.content_html ?? null,
          model: ev.model ?? null,
          created_at: ev.created_at,
          position: ev.position,
          content_hash: hash,
        });
        updateConvLast.run(ev.created_at, convId);
        accepted++;
      } else if (ev.kind === "conversation_updated") {
        updateConvMeta.run(
          ev.title ?? null,
          ev.archived === undefined ? null : ev.archived ? 1 : 0,
          ev.platform,
          ev.platform_conv_id,
        );
        accepted++;
      }
    }
  });

  tx(events);
  return { accepted };
}
