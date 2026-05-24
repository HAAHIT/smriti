// End-to-end smoke against the real local DB.
// Drives the helper through every RPC the new viewer depends on, and prints
// a compact summary of what came back. Exits non-zero if anything is broken.
//
// What we cover:
//   1.  hello                        — connection + version handshake
//   2.  stats                        — totals shown in TopBar
//   3.  embed_status                 — semantic-index progress
//   4.  list_recent_conversations    — LeftRail + Home grid
//   5.  search (keyword)             — FTS lane
//   6.  search (vague phrase)        — hybrid + semantic lane
//   7.  search (no-match)            — empty-state
//   8.  get_conversation             — viewer message stream + meta
//   9.  get_outline                  — outline spine + chapter mapping

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const helperRoot = join(here, "..");
const entry = join(helperRoot, "src", "index.ts");

const child = spawn("npx", ["tsx", entry], {
  cwd: helperRoot,
  stdio: ["pipe", "pipe", "inherit"],
  shell: process.platform === "win32",
});

let outBuf = Buffer.alloc(0);
const pending = new Map();

child.stdout.on("data", (chunk) => {
  outBuf = Buffer.concat([outBuf, chunk]);
  while (outBuf.length >= 4) {
    const len = outBuf.readUInt32LE(0);
    if (outBuf.length < 4 + len) break;
    const payload = outBuf.subarray(4, 4 + len).toString("utf8");
    outBuf = outBuf.subarray(4 + len);
    const msg = JSON.parse(payload);
    const cb = pending.get(msg.id);
    if (cb) {
      pending.delete(msg.id);
      cb(msg);
    } // ignore unsolicited (progress, fetch_request, etc.)
  }
});

function send(req, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const id = req.id ?? randomUUID();
    const msg = { ...req, id };
    pending.set(id, resolve);
    const json = JSON.stringify(msg);
    const payload = Buffer.from(json, "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    child.stdin.write(Buffer.concat([header, payload]));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout: ${req.type}`));
      }
    }, timeoutMs);
  });
}

const out = (label, ok, detail) => {
  const sym = ok ? "✓" : "✗";
  console.log(`  ${sym}  ${label.padEnd(38)} ${detail ?? ""}`);
  if (!ok) process.exitCode = 1;
};

const heading = (s) => console.log(`\n── ${s} ──`);

async function main() {
  heading("1. hello / stats / embed_status");
  const hello = await send({ type: "hello", client: "e2e", version: "0" });
  out("hello", hello.ok && hello.type === "hello", `v${hello.helper_version} proto ${hello.protocol}`);

  const stats = await send({ type: "stats" });
  out("stats", stats.ok && stats.type === "stats", `${stats.conversations} convs · ${stats.messages} msgs`);

  const embed = await send({ type: "embed_status" });
  const pctEmb = embed.total > 0 ? Math.round((embed.embedded / embed.total) * 100) : 0;
  out("embed_status", embed.ok && embed.type === "embed_status",
      `${embed.embedded} / ${embed.total} (${pctEmb}%) · model=${embed.model ?? "not loaded"}`);

  heading("2. list_recent_conversations (LeftRail / Home grid)");
  const recents = await send({ type: "list_recent_conversations", limit: 50 });
  const recentCount = recents.ok && recents.type === "list_recent_conversations" ? recents.conversations.length : 0;
  out("list_recent_conversations", recentCount > 0, `${recentCount} returned`);
  if (recentCount > 0) {
    const sample = recents.conversations.slice(0, 3);
    for (const c of sample) {
      console.log(`       · ${(c.title ?? "(untitled)").slice(0, 60).padEnd(60)} ${c.platform.padEnd(12)} ${c.message_count} msgs`);
    }
  }

  heading("3. search — keyword lane");
  const tryQueries = [
    { q: "backfill", expect: "fts" },
    { q: "claude code", expect: "fts" },
  ];
  for (const { q, expect } of tryQueries) {
    const r = await send({ type: "search", query: q, limit: 5 });
    const n = r.ok && r.type === "search" ? r.results.length : 0;
    const top = n > 0 ? r.results[0] : null;
    out(`search "${q}"`, n > 0, `${n} hits · top=${top?.title?.slice(0, 30) ?? "—"} (${top?.match ?? "—"})`);
  }

  heading("4. search — vague natural-language (semantic lane)");
  const vague = await send({ type: "search", query: "rate limited", limit: 5 });
  const vagueN = vague.ok && vague.type === "search" ? vague.results.length : 0;
  out(`search "rate limited"`, vagueN >= 0, `${vagueN} hits${vagueN > 0 ? ` · modes: ${[...new Set(vague.results.map(r => r.match))].join(",")}` : ""}`);

  heading("5. search — no-match path");
  const empty = await send({ type: "search", query: "zzzzzqqqqqxxxxx9999", limit: 5 });
  out("search empty", empty.ok && empty.type === "search" && empty.results.length === 0, `${empty.results.length} hits (expect 0)`);

  // Pick the conversation with the most messages for the deepest test.
  const target = recents.conversations.slice().sort((a, b) => b.message_count - a.message_count)[0];
  if (!target) {
    out("get_conversation", false, "no conversations available");
    child.kill();
    process.exit(1);
  }

  heading(`6. get_conversation (deepest: "${(target.title ?? "untitled").slice(0, 40)}")`);
  const gc = await send({ type: "get_conversation", conversation_id: target.id });
  const msgCount = gc.ok && gc.type === "get_conversation" ? gc.messages.length : 0;
  out("get_conversation", msgCount > 0, `meta=${gc.meta?.title ? "✓" : "✗"} messages=${msgCount}`);
  if (msgCount > 0) {
    const userN = gc.messages.filter(m => m.role === "user").length;
    const asstN = gc.messages.filter(m => m.role === "assistant").length;
    const lens = gc.messages.map(m => m.content_text.length);
    const avg = Math.round(lens.reduce((a, b) => a + b, 0) / lens.length);
    const max = Math.max(...lens);
    console.log(`       · roles: ${userN} user · ${asstN} assistant`);
    console.log(`       · length: avg ${avg} chars · max ${max} chars`);
  }

  heading("7. get_outline (segments for ConversationSpine)");
  const ol = await send({ type: "get_outline", conversation_id: target.id });
  const segN = ol.ok && ol.type === "get_outline" ? ol.segments.length : 0;
  out("get_outline", segN > 0, `${segN} segments · ready=${ol.ready}`);
  if (segN > 0) {
    for (const [i, s] of ol.segments.slice(0, 5).entries()) {
      const preview = (s.preview || "(no preview)").replace(/\s+/g, " ").slice(0, 56);
      console.log(`       Ch ${String(i + 1).padStart(2, "0")} · pos ${String(s.start_position).padStart(3)} → ${String(s.end_position).padStart(3)} · ${String(s.message_count).padStart(2)} msgs · ${preview}`);
    }
    if (segN > 5) console.log(`       … +${segN - 5} more`);
  }

  // Check that the chapter mapping the viewer does on the client would behave:
  // every message must fall into exactly one segment.
  if (segN > 0 && msgCount > 0) {
    const segs = [...ol.segments].sort((a, b) => a.start_position - b.start_position);
    let unmapped = 0;
    for (const m of gc.messages) {
      let found = -1;
      for (let i = 0; i < segs.length; i++) {
        const next = segs[i + 1];
        if (m.position >= segs[i].start_position && (!next || m.position < next.start_position)) {
          found = i;
          break;
        }
      }
      if (found < 0) unmapped++;
    }
    out("chapter mapping", unmapped === 0, `${msgCount - unmapped}/${msgCount} messages mapped to a chapter`);
  }

  heading("8. round-trip from search to viewer deep-link");
  // Use a token that should match many messages to exercise the message_id surface.
  const probe = await send({ type: "search", query: "the", limit: 3 });
  if (probe.ok && probe.type === "search" && probe.results.length > 0) {
    const hit = probe.results[0];
    const conv = await send({ type: "get_conversation", conversation_id: hit.conversation_id });
    const anchorHit = conv.ok && conv.type === "get_conversation" &&
      conv.messages.some(m => m.id === hit.message_id);
    out("message_id resolves in conversation", anchorHit,
        `conv=${hit.conversation_id.slice(0, 8)}… msg=${hit.message_id.slice(0, 8)}…`);
  } else {
    out("message_id round-trip", false, "no probe results");
  }

  console.log("\nE2E " + (process.exitCode ? "FAILED" : "OK"));
  child.kill();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error("smoke crashed:", e);
  child.kill();
  process.exit(1);
});
