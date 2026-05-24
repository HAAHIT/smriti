// Smoke test: scan the user's real Claude Code transcript dir,
// then verify the helper can search the ingested content.
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
    }
  }
});

function send(req) {
  return new Promise((resolve) => {
    const id = req.id ?? randomUUID();
    const msg = { ...req, id };
    pending.set(id, resolve);
    const payload = Buffer.from(JSON.stringify(msg), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    child.stdin.write(Buffer.concat([header, payload]));
  });
}

async function main() {
  console.log("scanning ~/.claude/projects/ ...");
  const scan = await send({ type: "claude_code_scan" });
  console.log("scan →", scan);

  const stats = await send({ type: "stats" });
  console.log("stats →", stats);

  // Re-run; should ingest 0 (idempotent).
  const scan2 = await send({ type: "claude_code_scan" });
  console.log("scan (repeat) →", scan2);

  const search = await send({ type: "search", query: "design", limit: 3 });
  console.log("search 'design' →", JSON.stringify(search, null, 2));

  child.kill();
  if (scan.ok && scan.files_scanned > 0 && scan2.events_ingested === 0) {
    console.log("\nCLAUDE CODE SMOKE OK");
    process.exit(0);
  } else {
    console.log("\nCLAUDE CODE SMOKE FAILED");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  child.kill();
  process.exit(1);
});
