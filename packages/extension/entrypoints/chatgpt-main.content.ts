// ChatGPT connector — `fetchInterceptor` strategy.
//
// Endpoint: POST https://chatgpt.com/backend-api/conversation, which returns
// SSE. Payload shapes have shifted across releases; the reducer below handles
// both the legacy `{ message: {...} }` frames and the newer delta-encoded
// `{ v, p, o }` frames.
//
// Everything structural is in lib/connectors/fetch-interceptor.ts — see the
// Claude connector for the same shape with different payload parsing.

import { defineContentScript } from "wxt/sandbox";
import { sourceById } from "../lib/connectors/registry";
import {
  installFetchInterceptor,
  type StreamState,
} from "../lib/connectors/fetch-interceptor";

const COMPLETION_RE = /\/backend-api\/conversation(?:\/|$|\?)/;

/** Join ChatGPT's `content.parts`, which mixes plain strings and typed blocks. */
function joinParts(parts: unknown[]): string {
  return parts
    .map((p) => {
      if (typeof p === "string") return p;
      if (typeof p === "object" && p !== null) {
        const po = p as { text?: string; content_type?: string };
        if (po.content_type === "text" && typeof po.text === "string") return po.text;
      }
      return "";
    })
    .join("\n")
    .trim();
}

export default defineContentScript({
  matches: sourceById("chatgpt")!.origins,
  world: "MAIN",
  runAt: "document_start",
  main() {
    installFetchInterceptor({
      sourceId: "chatgpt",

      matchRequest(url, method) {
        if (method !== "POST" || !COMPLETION_RE.test(url)) return null;
        // The id is not in the URL — it comes from the body or the stream.
        return { convId: null };
      },

      readRequest(json) {
        const messages = (json.messages as Array<Record<string, unknown>> | undefined) ?? [];
        let userText: string | null = null;
        let userMsgId: string | null = null;
        for (const m of messages) {
          if ((m.author as { role?: string } | undefined)?.role !== "user") continue;
          const content = m.content as { parts?: unknown[] } | undefined;
          const joined = joinParts(content?.parts ?? []);
          if (joined) {
            userText = joined;
            userMsgId = typeof m.id === "string" ? m.id : null;
          }
        }
        return {
          convId: typeof json.conversation_id === "string" ? json.conversation_id : null,
          model: typeof json.model === "string" ? json.model : null,
          userText,
          userMsgId,
        };
      },

      reduceEvent(payload, state: StreamState) {
        if (typeof payload !== "object" || payload === null) return;
        const o = payload as Record<string, unknown>;

        // Legacy frame:
        //   { message: { author: {role}, content: {parts} }, conversation_id, model_slug }
        if (o.message && typeof o.message === "object") {
          const msg = o.message as {
            id?: string;
            author?: { role?: string };
            content?: { parts?: unknown[] };
          };
          if (msg.author?.role === "assistant" && msg.content?.parts) {
            // Authoritative snapshot — replaces rather than appends.
            state.assistantText = joinParts(msg.content.parts);
            if (typeof msg.id === "string") state.assistantMsgId = msg.id;
            if (typeof o.conversation_id === "string") state.convId ??= o.conversation_id;
            if (typeof o.model_slug === "string") state.model ??= o.model_slug;
            return;
          }
        }

        if (!("v" in o)) return;
        const v = o.v;
        const p = typeof o.p === "string" ? o.p : "";
        const op = typeof o.o === "string" ? o.o : "";

        // Initial snapshot frame: { v: { message, conversation_id, … } }, no path.
        if (typeof v === "object" && v !== null && !p) {
          const vv = v as Record<string, unknown>;
          const inner = vv.message as
            | { id?: string; author?: { role?: string }; content?: { parts?: unknown[] } }
            | undefined;
          if (inner?.author?.role === "assistant" && inner.content?.parts) {
            state.assistantText = joinParts(inner.content.parts);
            if (typeof inner.id === "string") state.assistantMsgId = inner.id;
          }
          if (typeof vv.conversation_id === "string") state.convId ??= vv.conversation_id;
          if (typeof vv.model === "string") state.model ??= vv.model;
          return;
        }

        // Append/patch onto a parts path: { v: "…", p: "/message/content/parts/0", o: "append" }
        if (
          (op === "append" || op === "patch") &&
          typeof v === "string" &&
          /\/message\/content\/parts\/\d+/.test(p)
        ) {
          state.assistantText += v;
        }
      },

      conversationUrl: (convId) => `https://chatgpt.com/c/${convId}`,
      titleSuffix: /\s*[-–|]\s*ChatGPT.*$/i,
      bareTitle: "ChatGPT",
    });
  },
});
