// MAIN-world content script: intercept ChatGPT completion endpoint.
//
// Endpoint: POST https://chatgpt.com/backend-api/conversation
// Returns SSE. Payload shapes have shifted across releases — Phase 1
// supports both legacy ("data: {message: {...}}") and newer delta-encoded
// ("data: {v: ..., p: ..., o: append}") streams.

import { defineContentScript } from "wxt/sandbox";
import { SMRITI_TAG, type InjectToContentMessage } from "../capture/messages";
import type { CaptureEvent } from "@smriti/shared";

export default defineContentScript({
  matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  world: "MAIN",
  runAt: "document_start",
  main() {
    // eslint-disable-next-line no-console
    console.debug("[smriti] chatgpt-main: fetch interceptor active");

    const COMPLETION_RE = /\/backend-api\/conversation(?:\/|$|\?)/;

    const origFetch = window.fetch.bind(window);

    window.fetch = async function smritiFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const url = urlOf(input);
      if (!COMPLETION_RE.test(url) || (init?.method ?? "GET").toUpperCase() !== "POST") {
        return origFetch(input, init);
      }

      const { userText, convIdFromReq, model } = await readRequestBody(input, init);
      const res = await origFetch(input, init);

      try {
        const cloned = res.clone();
        void consumeStream(cloned, convIdFromReq, userText, model);
      } catch {
        /* clone failed; ignore */
      }
      return res;
    };

    async function readRequestBody(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<{ userText: string | null; convIdFromReq: string | null; model: string | null }> {
      try {
        let text: string | null = null;
        if (init?.body) {
          if (typeof init.body === "string") text = init.body;
          else if (init.body instanceof Blob) text = await init.body.text();
          else if (init.body instanceof ArrayBuffer)
            text = new TextDecoder().decode(init.body);
        } else if (input instanceof Request) {
          text = await input.clone().text();
        }
        if (!text) return { userText: null, convIdFromReq: null, model: null };
        const json = JSON.parse(text) as Record<string, unknown>;
        const convId = typeof json.conversation_id === "string" ? json.conversation_id : null;
        const model = typeof json.model === "string" ? json.model : null;
        // Find the freshly-authored user message.
        const messages = (json.messages as Array<Record<string, unknown>> | undefined) ?? [];
        let userText: string | null = null;
        for (const m of messages) {
          const role = (m.author as { role?: string } | undefined)?.role;
          if (role !== "user") continue;
          const content = m.content as
            | { parts?: unknown[]; content_type?: string; text?: string }
            | undefined;
          // Handle both string parts and object parts (multimodal format).
          const parts = content?.parts ?? [];
          const joined = parts
            .map((p) => {
              if (typeof p === "string") return p;
              // Multimodal part: { content_type: "text", text: "..." }
              if (typeof p === "object" && p !== null) {
                const po = p as { text?: string; content_type?: string };
                if (po.content_type === "text" && typeof po.text === "string") return po.text;
              }
              return "";
            })
            .join("\n")
            .trim();
          if (joined) userText = joined;
        }
        return { userText, convIdFromReq: convId, model };
      } catch {
        return { userText: null, convIdFromReq: null, model: null };
      }
    }

    async function consumeStream(
      res: Response,
      convIdSeed: string | null,
      userText: string | null,
      modelSeed: string | null,
    ): Promise<void> {
      const body = res.body;
      if (!body) return;
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let convId = convIdSeed;
      let model = modelSeed;
      let assistantAccum = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            let obj: unknown;
            try {
              obj = JSON.parse(payload);
            } catch {
              continue;
            }
            const extracted = extractFromEvent(obj);
            if (extracted.convId && !convId) convId = extracted.convId;
            if (extracted.model && !model) model = extracted.model;
            if (extracted.fullAssistantText) {
              // Initial / authoritative snapshot — use as base.
              assistantAccum = extracted.fullAssistantText;
            } else if (extracted.deltaText) {
              assistantAccum += extracted.deltaText;
            }
          }
        }
      }

      if (!convId) return; // can't link to a conversation; drop quietly
      emit(buildEvents(convId, userText, assistantAccum, model));
    }

    interface Extracted {
      convId: string | null;
      model: string | null;
      fullAssistantText: string | null;
      deltaText: string | null;
    }

    function extractFromEvent(obj: unknown): Extracted {
      if (typeof obj !== "object" || obj === null) {
        return { convId: null, model: null, fullAssistantText: null, deltaText: null };
      }
      const o = obj as Record<string, unknown>;

      // Legacy: { message: { author: {role}, content: {parts: []} }, conversation_id, model_slug }
      if (o.message && typeof o.message === "object") {
        const msg = o.message as {
          author?: { role?: string };
          content?: { parts?: unknown[] };
        };
        if (msg.author?.role === "assistant" && msg.content?.parts) {
          const text = msg.content.parts
            .map((p) => (typeof p === "string" ? p : ""))
            .join("");
          return {
            convId: typeof o.conversation_id === "string" ? o.conversation_id : null,
            model: typeof o.model_slug === "string" ? o.model_slug : null,
            fullAssistantText: text,
            deltaText: null,
          };
        }
      }

      // New delta format: { v: ..., p: "/message/content/parts/0", o: "append" }
      // or initial event: { v: { message: {...}, conversation_id, ... } } with p == undefined
      if ("v" in o) {
        const v = o.v;
        const p = typeof o.p === "string" ? o.p : "";
        const op = typeof o.o === "string" ? o.o : "";
        // Initial snapshot
        if (typeof v === "object" && v !== null && !p) {
          const vv = v as Record<string, unknown>;
          const inner = vv.message as { author?: { role?: string }; content?: { parts?: unknown[] } } | undefined;
          let snapshot: string | null = null;
          if (inner?.author?.role === "assistant" && inner.content?.parts) {
            snapshot = inner.content.parts
              .map((x) => (typeof x === "string" ? x : ""))
              .join("");
          }
          return {
            convId: typeof vv.conversation_id === "string" ? vv.conversation_id : null,
            model: typeof vv.model === "string" ? vv.model : null,
            fullAssistantText: snapshot,
            deltaText: null,
          };
        }
        // Append op to a parts path
        if (
          (op === "append" || op === "patch") &&
          typeof v === "string" &&
          /\/message\/content\/parts\/\d+/.test(p)
        ) {
          return { convId: null, model: null, fullAssistantText: null, deltaText: v };
        }
      }

      return { convId: null, model: null, fullAssistantText: null, deltaText: null };
    }

    function buildEvents(
      convId: string,
      userText: string | null,
      assistantText: string,
      model: string | null,
    ): CaptureEvent[] {
      const now = new Date().toISOString();
      const events: CaptureEvent[] = [
        {
          kind: "conversation_seen",
          platform: "chatgpt",
          platform_conv_id: convId,
          title: getCurrentTitle(),
          url: `https://chatgpt.com/c/${convId}`,
          observed_at: now,
        },
      ];
      if (userText) {
        events.push({
          kind: "message_appended",
          platform: "chatgpt",
          platform_conv_id: convId,
          role: "user",
          content_text: userText,
          model: model ?? undefined,
          created_at: now,
          position: Date.now(),
        });
      }
      if (assistantText.trim().length > 0) {
        events.push({
          kind: "message_appended",
          platform: "chatgpt",
          platform_conv_id: convId,
          role: "assistant",
          content_text: assistantText,
          model: model ?? undefined,
          created_at: new Date().toISOString(),
          position: Date.now() + 1,
        });
      }
      return events;
    }

    function getCurrentTitle(): string | undefined {
      const t = document.title;
      if (!t || t === "ChatGPT") return undefined;
      return t.replace(/\s*[-–|]\s*ChatGPT.*$/i, "").trim() || undefined;
    }

    function urlOf(input: RequestInfo | URL): string {
      if (typeof input === "string") return input;
      if (input instanceof Request) return input.url;
      return input.toString();
    }

    function emit(events: CaptureEvent[]): void {
      if (events.length === 0) return;
      const msg: InjectToContentMessage = {
        smriti: SMRITI_TAG,
        source: "chatgpt-inject",
        events,
      };
      window.postMessage(msg, window.location.origin);
    }
  },
});
