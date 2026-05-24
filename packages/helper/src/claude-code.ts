// Claude Code transcript ingestion.
//
// Reads .jsonl session files from ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl.
// Each file is one conversation; each line is one record.
//
// Phase 1 captures user prompts and assistant "text" blocks only. Tool use,
// tool results, and thinking blocks are tracked as open question #1 in the
// PRD — wire them in later as separate message kinds.

import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import type { CaptureEvent, Role } from "@recall/shared";
import { getDb } from "./db.js";
import { ingestEvents } from "./ingest.js";
import { log } from "./logger.js";

interface ClaudeCodeRecord {
  type?: string;
  sessionId?: string;
  timestamp?: string;
  uuid?: string;
  cwd?: string;
  gitBranch?: string;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
  };
}

export function defaultClaudeCodeRoot(): string {
  return join(homedir(), ".claude", "projects");
}

export async function scanClaudeCode(
  root: string = defaultClaudeCodeRoot(),
): Promise<{ files_scanned: number; events_ingested: number }> {
  let filesScanned = 0;
  let eventsIngested = 0;

  let projects: string[];
  try {
    projects = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(root, d.name));
  } catch (e) {
    log.warn("claude_code: root not found", { root, err: String(e) });
    return { files_scanned: 0, events_ingested: 0 };
  }

  for (const projectDir of projects) {
    let files: string[];
    try {
      files = readdirSync(projectDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => join(projectDir, f));
    } catch {
      continue;
    }
    for (const file of files) {
      filesScanned++;
      try {
        eventsIngested += await ingestFileIfChanged(file);
      } catch (e) {
        log.warn("claude_code: file failed", { file, err: String(e) });
      }
    }
  }

  return { files_scanned: filesScanned, events_ingested: eventsIngested };
}

async function ingestFileIfChanged(file: string): Promise<number> {
  const db = getDb();
  const key = `claude_code:${file}`;
  const state = db
    .prepare(
      "SELECT last_offset, last_mtime FROM ingest_state WHERE source_key = ?",
    )
    .get(key) as { last_offset: number; last_mtime: string | null } | undefined;
  const stat = statSync(file);
  const mtime = stat.mtime.toISOString();
  if (state && state.last_mtime === mtime && state.last_offset === stat.size) {
    return 0;
  }
  const startOffset = state?.last_offset ?? 0;
  if (startOffset > stat.size) {
    // File truncated/replaced. Re-ingest from 0.
    log.warn("claude_code: file shorter than recorded offset, reingesting", { file });
    return doIngest(file, 0, stat.size, mtime, key);
  }
  return doIngest(file, startOffset, stat.size, mtime, key);
}

function doIngest(
  file: string,
  fromOffset: number,
  toOffset: number,
  mtime: string,
  key: string,
): number {
  if (fromOffset >= toOffset) {
    upsertState(key, toOffset, mtime);
    return 0;
  }
  const fd = openSync(file, "r");
  try {
    const length = toOffset - fromOffset;
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, fromOffset);
    const text = buf.toString("utf8");
    // Lines may be partial at the tail; if so, ingest up to the last newline
    // and roll the offset back so the partial line is re-read next time.
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) {
      // Whole chunk has no newline — nothing safely ingestible.
      upsertState(key, fromOffset, mtime);
      return 0;
    }
    const safeText = text.slice(0, lastNl);
    const advanced = fromOffset + Buffer.byteLength(safeText, "utf8") + 1; // +1 for \n
    const lines = safeText.split("\n");

    const events: CaptureEvent[] = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let rec: ClaudeCodeRecord;
      try {
        rec = JSON.parse(line) as ClaudeCodeRecord;
      } catch {
        continue;
      }
      const ev = recordToEvent(rec);
      if (ev) events.push(...ev);
    }

    if (events.length > 0) {
      ingestEvents(events);
    }
    upsertState(key, advanced, mtime);
    return events.length;
  } finally {
    closeSync(fd);
  }
}

function upsertState(key: string, offset: number, mtime: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO ingest_state (source_key, last_offset, last_mtime, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (source_key) DO UPDATE SET
       last_offset = excluded.last_offset,
       last_mtime  = excluded.last_mtime,
       updated_at  = excluded.updated_at`,
  ).run(key, offset, mtime, new Date().toISOString());
}

function recordToEvent(rec: ClaudeCodeRecord): CaptureEvent[] | null {
  const type = rec.type;
  if (type !== "user" && type !== "assistant") return null;
  const sessionId = rec.sessionId;
  const ts = rec.timestamp;
  if (!sessionId || !ts) return null;

  const role: Role = type === "user" ? "user" : "assistant";
  const content = rec.message?.content;
  const text = extractText(content);
  if (!text) return null;

  const url = rec.cwd ? `file:///${rec.cwd.replace(/\\/g, "/")}` : "";
  const events: CaptureEvent[] = [
    {
      kind: "conversation_seen",
      platform: "claude_code",
      platform_conv_id: sessionId,
      title: titleFromCwd(rec.cwd),
      url,
      observed_at: ts,
    },
    {
      kind: "message_appended",
      platform: "claude_code",
      platform_conv_id: sessionId,
      platform_msg_id: rec.uuid,
      role,
      content_text: text,
      model: rec.message?.model,
      created_at: ts,
      position: Date.parse(ts) || Date.now(),
    },
  ];
  return events;
}

function extractText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const out: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as { type?: string; text?: string };
    if (b.type === "text" && typeof b.text === "string") out.push(b.text);
  }
  return out.length ? out.join("\n") : null;
}

function titleFromCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1];
}
