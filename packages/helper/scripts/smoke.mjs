// Smoke test: spawn the helper, exchange Native Messaging frames over stdio,
// verify hello + ingest + search + stats. No browser needed.
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
    } else {
      console.log("unsolicited:", msg);
    }
  }
});

function send(req) {
  return new Promise((resolve) => {
    const id = req.id ?? randomUUID();
    const msg = { ...req, id };
    pending.set(id, resolve);
    const json = JSON.stringify(msg);
    const payload = Buffer.from(json, "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    child.stdin.write(Buffer.concat([header, payload]));
  });
}

async function main() {
  const hello = await send({ type: "hello", client: "smoke", version: "0" });
  console.log("hello →", hello);
  if (!hello.ok) process.exit(1);

  const now = new Date().toISOString();
  const ingest = await send({
    type: "ingest",
    events: [
      {
        kind: "conversation_seen",
        platform: "claude",
        platform_conv_id: "smoke-conv-1",
        title: "Smoke test conversation",
        url: "https://claude.ai/chat/smoke-conv-1",
        observed_at: now,
      },
      {
        kind: "message_appended",
        platform: "claude",
        platform_conv_id: "smoke-conv-1",
        role: "user",
        content_text: "How do I parse JSON in Rust with serde?",
        created_at: now,
        position: 0,
      },
      {
        kind: "message_appended",
        platform: "claude",
        platform_conv_id: "smoke-conv-1",
        role: "assistant",
        content_text: "Add serde and serde_json to Cargo.toml, then use serde_json::from_str.",
        created_at: now,
        position: 1,
      },
    ],
  });
  console.log("ingest →", ingest);

  const search = await send({ type: "search", query: "serde", limit: 5 });
  console.log("search →", search);

  const stats = await send({ type: "stats" });
  console.log("stats →", stats);

  child.kill();
  if (search.ok && search.results.length > 0) {
    console.log("\nSMOKE OK");
    process.exit(0);
  } else {
    console.log("\nSMOKE FAILED");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  child.kill();
  process.exit(1);
});
