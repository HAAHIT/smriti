// Smriti sync relay — a zero-knowledge blob store on Cloudflare Workers + KV.
//
// It stores opaque encrypted bytes keyed by an opaque syncId, and nothing
// else. It never sees plaintext memories, the recovery code, or the derived
// AES key — all of that stays on the user's device. See
// packages/extension/lib/sync.ts + sync-crypto.ts for the client side.
//
// Wire protocol (all under /v1/blob/:syncId, syncId = 32 lowercase hex chars):
//   GET    -> 200 octet-stream | 404 if nothing stored yet
//   PUT    -> 200 (stores the body, max 2 MB)
//   DELETE -> 200 (forget this sync group's blob)

/** Worker bindings: the KV namespace that holds the encrypted blobs. */
export interface Env {
  SYNC_KV: KVNamespace;
}

const SYNC_ID_RE = /^[0-9a-f]{32}$/;
const MAX_BLOB_BYTES = 2 * 1024 * 1024; // 2 MB

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

/** Build a JSON response carrying the shared CORS headers. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export default {
  /** Route a request to GET/PUT/DELETE on /v1/blob/:syncId (else 404/405). */
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight. Origin is wildcard because the payload is ciphertext
    // the relay can't read, there are no cookies/credentials, and the syncId
    // is a 128-bit-derived secret (not guessable).
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const match = new URL(request.url).pathname.match(/^\/v1\/blob\/([^/]+)$/);
    if (!match) return json(404, { error: "not found" });

    const syncId = match[1]!;
    if (!SYNC_ID_RE.test(syncId)) return json(400, { error: "invalid sync id" });

    switch (request.method) {
      case "GET": {
        const blob = await env.SYNC_KV.get(syncId, "arrayBuffer");
        if (!blob) return json(404, { error: "no blob" });
        return new Response(blob, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream", ...CORS_HEADERS },
        });
      }

      case "PUT": {
        const declared = Number(request.headers.get("Content-Length") ?? "0");
        if (declared > MAX_BLOB_BYTES) return json(413, { error: "blob too large" });
        const body = await request.arrayBuffer();
        if (body.byteLength === 0) return json(400, { error: "empty body" });
        if (body.byteLength > MAX_BLOB_BYTES) return json(413, { error: "blob too large" });
        await env.SYNC_KV.put(syncId, body);
        return json(200, { ok: true });
      }

      case "DELETE": {
        await env.SYNC_KV.delete(syncId);
        return json(200, { ok: true });
      }

      default:
        return json(405, { error: "method not allowed" });
    }
  },
};
