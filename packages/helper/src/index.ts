#!/usr/bin/env node
import { startNativeMessagingLoop, startDevLoop } from "./nm.js";
import { handleRequest } from "./handlers.js";
import { getDb } from "./db.js";
import { log } from "./logger.js";
import { startIndexWorker } from "./index-worker.js";

// Belt-and-suspenders: redirect any stray console.* to stderr so a chatty
// dependency (e.g. transformers.js / onnxruntime) can't corrupt the Native
// Messaging framed protocol on stdout.
for (const k of ["log", "info", "warn", "error", "debug"] as const) {
  const orig = console[k];
  console[k] = (...args: unknown[]) => {
    try {
      process.stderr.write("[" + k + "] " + args.map(String).join(" ") + "\n");
    } catch { /* noop */ }
    void orig;
  };
}

// Eagerly open DB so migrations run on startup; surface errors loudly.
try {
  getDb();
} catch (e) {
  log.error("db init failed", { err: String(e) });
  process.stderr.write(`smriti-helper: failed to open database: ${String(e)}\n`);
  process.exit(1);
}

const dev = process.argv.includes("--dev");
log.info("helper starting", { dev, argv: process.argv.slice(2) });

if (dev) {
  startDevLoop(handleRequest);
} else {
  startNativeMessagingLoop(handleRequest);
}

// Kick the embedding worker. It self-paces and yields when idle.
startIndexWorker();

process.on("uncaughtException", (e) => {
  log.error("uncaught", { err: String(e), stack: (e as Error).stack });
});
process.on("unhandledRejection", (e) => {
  log.error("unhandled rejection", { err: String(e) });
});
