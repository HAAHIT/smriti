// Claude connector — `fetchInterceptor` strategy.
//
// All the mechanism (patching fetch, teeing the response, SSE framing, event
// building, postMessage) lives in lib/connectors/fetch-interceptor.ts. What
// remains here is only what is specific to Claude: which endpoints carry a
// completion, how its request body encodes the user's message, and how its SSE
// frames encode assistant deltas.
//
// Known fragility: Claude has changed SSE payload shapes more than once, so the
// reducer below stays deliberately defensive across several known formats.

import { defineContentScript } from "wxt/sandbox";
import { sourceById } from "../lib/connectors/registry";
import {
  installFetchInterceptor,
  type StreamState,
} from "../lib/connectors/fetch-interceptor";

// Completion / retry / append_message endpoints; the conversation id is the
// capture group. Covers:
//   /api/organizations/{org}/chat_conversations/{conv}/completion
//   /api/organizations/{org}/chat_conversations/{conv}/retry_completion
//   /api/organizations/{org}/chat_conversations/{conv}/append_message
//   /api/chat_conversations/{conv}/completion          (org-less variant)
const COMPLETION_RE =
  /\/api\/(?:organizations\/[^/]+\/)?chat_conversations\/([^/?]+)\/(?:completion|retry_completion|append_message)/;

export default defineContentScript({
  matches: sourceById("claude")!.origins,
  world: "MAIN",
  runAt: "document_start",
  main() {
    installFetchInterceptor({
      sourceId: "claude",

      matchRequest(url) {
        const m = url.match(COMPLETION_RE);
        return m ? { convId: m[1]! } : null;
      },

      readRequest(json) {
        // Modern Claude API (2025+):
        //   { messages: [{ role, content: [{ type: "text", text }] }] }
        // Iterate from the END — the last user message is the freshly typed one.
        if (Array.isArray(json.messages)) {
          const msgs = json.messages as Array<{
            role?: string;
            content?: string | Array<{ type?: string; text?: string }>;
          }>;
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (!m || m.role !== "user") continue;
            if (typeof m.content === "string" && m.content.length > 0) {
              return { userText: m.content };
            }
            if (Array.isArray(m.content)) {
              const joined = m.content
                .filter((b) => b?.type === "text" && typeof b.text === "string")
                .map((b) => b.text ?? "")
                .join("\n")
                .trim();
              if (joined.length > 0) return { userText: joined };
            }
          }
        }

        // Legacy shapes, kept for compatibility.
        const legacy = [
          json.prompt,
          (json.message as { text?: string } | undefined)?.text,
          (json.message as { content?: string } | undefined)?.content,
          json.text,
        ];
        for (const c of legacy) {
          if (typeof c === "string" && c.length > 0) return { userText: c };
        }
        return {};
      },

      reduceEvent(payload, state: StreamState) {
        if (typeof payload !== "object" || payload === null) return;
        const obj = payload as Record<string, unknown>;
        const eventType = typeof obj.type === "string" ? obj.type : "";

        // Model hint, from wherever it shows up first.
        if (typeof obj.model === "string" && !state.model) state.model = obj.model;
        const startMsg = obj.message as Record<string, unknown> | undefined;
        if (eventType === "message_start" && startMsg) {
          if (typeof startMsg.model === "string" && !state.model) {
            state.model = startMsg.model;
          }
          if (typeof startMsg.id === "string" && !state.assistantMsgId) {
            state.assistantMsgId = startMsg.id;
          }
        }

        // First-wins: exactly one text fragment per frame.
        // Modern streaming:
        //   {"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}
        if (eventType === "content_block_delta") {
          const delta = obj.delta as { type?: string; text?: string } | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            state.assistantText += delta.text;
            return;
          }
        }

        // Older formats: { completion } | { text } | { delta: { text } }
        if (typeof obj.completion === "string") {
          state.assistantText += obj.completion;
          return;
        }
        if (typeof obj.text === "string" && obj.text) {
          state.assistantText += obj.text;
          return;
        }
        const delta = obj.delta as { text?: string } | undefined;
        if (typeof delta?.text === "string") state.assistantText += delta.text;
      },

      conversationUrl: (convId) => `https://claude.ai/chat/${convId}`,
      titleSuffix: /\s*[-–|]\s*Claude.*$/i,
      bareTitle: "Claude",
    });
  },
});
