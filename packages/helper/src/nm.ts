// Native Messaging framing on stdio.
// Protocol: each message is a 4-byte little-endian length prefix
// followed by a UTF-8 JSON payload.
// IMPORTANT: stdout is reserved for framed messages only. All logs go to file.
//
// The helper supports bidirectional RPC:
//   - Extension → Helper: NMRequest (with id) → NMResponse (matching id)
//   - Helper → Extension: HelperOutbound (fetch_request with id, progress, done)
//   - Extension → Helper: FetchResponseMsg (matches helper's fetch_request id)
//
// We distinguish incoming kinds by their shape: presence of a `kind` field
// for unsolicited extension→helper messages, otherwise it's a request.

import { randomUUID } from "node:crypto";
import type {
  FetchResponseMsg,
  HelperOutbound,
  NMResponse,
} from "@recall/shared";
import { log } from "./logger.js";

const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;

export type MessageHandler = (msg: unknown) => Promise<NMResponse>;

const pendingFetches = new Map<string, (msg: FetchResponseMsg) => void>();

export function startNativeMessagingLoop(handle: MessageHandler): void {
  let buffer = Buffer.alloc(0);

  process.stdin.on("data", async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (buffer.length < 4) break;
      const len = buffer.readUInt32LE(0);
      if (len > MAX_MESSAGE_BYTES) {
        log.error("nm message too large", { len });
        process.exit(1);
      }
      if (buffer.length < 4 + len) break;
      const payload = buffer.subarray(4, 4 + len).toString("utf8");
      buffer = buffer.subarray(4 + len);

      let msg: unknown;
      try {
        msg = JSON.parse(payload);
      } catch (e) {
        log.error("nm bad json", { err: String(e) });
        continue;
      }
      void dispatchIncoming(msg, handle);
    }
  });

  process.stdin.on("end", () => {
    log.info("stdin closed, exiting");
    process.exit(0);
  });
}

async function dispatchIncoming(msg: unknown, handle: MessageHandler): Promise<void> {
  if (typeof msg !== "object" || msg === null) {
    log.warn("nm non-object payload");
    return;
  }
  const obj = msg as Record<string, unknown>;
  if (obj.kind === "fetch_response" && typeof obj.id === "string") {
    const cb = pendingFetches.get(obj.id);
    if (cb) {
      pendingFetches.delete(obj.id);
      cb(obj as unknown as FetchResponseMsg);
    } else {
      log.warn("orphan fetch_response", { id: obj.id });
    }
    return;
  }
  try {
    const reply = await handle(msg);
    sendNativeMessage(reply);
  } catch (e) {
    log.error("handler threw", { err: String(e) });
    sendNativeMessage({ id: typeof obj.id === "string" ? obj.id : "?", ok: false, error: String(e) });
  }
}

export function sendNativeMessage(msg: unknown): void {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

export function sendOutbound(msg: HelperOutbound): void {
  sendNativeMessage(msg);
}

export interface ProxyFetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
}

export interface ProxyFetchResult {
  ok: boolean;
  status: number;
  body: string;
}

export function proxyFetch(url: string, opts: ProxyFetchOpts = {}): Promise<ProxyFetchResult> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingFetches.has(id)) {
        pendingFetches.delete(id);
        reject(new Error(`proxy fetch timeout (${url})`));
      }
    }, opts.timeoutMs ?? FETCH_TIMEOUT_MS);

    pendingFetches.set(id, (msg) => {
      clearTimeout(timeout);
      if (!msg.ok) {
        reject(new Error(msg.error ?? `fetch failed (${url})`));
        return;
      }
      resolve({
        ok: msg.ok,
        status: msg.status ?? 0,
        body: msg.body ?? "",
      });
    });

    sendOutbound({
      kind: "fetch_request",
      id,
      url,
      method: opts.method ?? "GET",
      headers: opts.headers,
      body: opts.body ?? null,
    });
  });
}

// Dev-mode loop: one JSON message per line on stdin, plain JSON on stdout.
export function startDevLoop(handle: MessageHandler): void {
  process.stdout.write("smriti-helper dev mode — paste one JSON request per line\n");
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (data: string) => {
    buf += data;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const reply = await handle(msg);
        process.stdout.write(JSON.stringify(reply) + "\n");
      } catch (e) {
        process.stdout.write(JSON.stringify({ ok: false, error: String(e) }) + "\n");
      }
    }
  });
}
