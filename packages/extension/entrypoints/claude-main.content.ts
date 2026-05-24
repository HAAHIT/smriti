// MAIN-world content script: runs in the page's own JS context so it can
// monkey-patch window.fetch. Cannot use chrome.* APIs from here.
// Communicates with the ISOLATED content script via window.postMessage.
//
// Phase 1 strategy: intercept the streaming completion endpoint, tee the
// response body, accumulate assistant deltas, and emit one user + one
// assistant CaptureEvent per round-trip.
//
// Known fragility: Claude has changed SSE payload shapes more than once.
// The delta extractor below tries several common keys defensively.

import { defineContentScript } from "wxt/sandbox";
import { RECALL_TAG, type InjectToContentMessage } from "../capture/messages";
import type { CaptureEvent } from "@recall/shared";

export default defineContentScript({
  matches: ["https://claude.ai/*"],
  world: "MAIN",
  runAt: "document_start",
  main() {
    // eslint-disable-next-line no-console
    console.debug("[smriti] claude-main: fetch interceptor active");

    // Matches Claude.ai completion / retry / append_message endpoints.
    // We extract the conv-id from whichever capture group matched.
    // Covers:
    //   /api/organizations/{org}/chat_conversations/{conv}/completion
    //   /api/organizations/{org}/chat_conversations/{conv}/retry_completion
    //   /api/organizations/{org}/chat_conversations/{conv}/append_message (newer)
    //   /api/chat_conversations/{conv}/completion  (org-less variant)
    const COMPLETION_RE =
      /\/api\/(?:organizations\/[^/]+\/)?chat_conversations\/([^/?]+)\/(?:completion|retry_completion|append_message)/;

    const origFetch = window.fetch.bind(window);

    window.fetch = async function recallFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      let url: string;
      if (typeof input === "string") url = input;
      else if (input instanceof Request) url = input.url;
      else url = input.toString();

      const m = url.match(COMPLETION_RE);
      if (!m) return origFetch(input, init);

      const convId = m[1]!;
      // Best-effort user-text extraction from request body.
      const userText = await extractUserText(input, init);

      const res = await origFetch(input, init);

      // Tee the response so the page still gets its stream untouched.
      try {
        const cloned = res.clone();
        void consumeStream(cloned, convId, userText, url);
      } catch (e) {
        emitError("clone failed", e);
      }

      return res;
    };

    async function extractUserText(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<string | null> {
      try {
        let bodyText: string | null = null;
        if (init?.body) {
          if (typeof init.body === "string") {
            bodyText = init.body;
          } else if (init.body instanceof Blob) {
            bodyText = await init.body.text();
          } else if (init.body instanceof ArrayBuffer) {
            bodyText = new TextDecoder().decode(init.body);
          } else if (init.body instanceof FormData) {
            return null;
          } else if (init.body instanceof URLSearchParams) {
            bodyText = init.body.toString();
          }
        } else if (input instanceof Request) {
          bodyText = await input.clone().text();
        }
        if (!bodyText) return null;
        const json = JSON.parse(bodyText) as Record<string, unknown>;

        // Modern Claude API (2025+): { messages: [{role, content: [{type:"text",text:"..."}]}] }
        // Iterate from the END — the last user message is the freshly typed one.
        if (Array.isArray(json.messages)) {
          const msgs = json.messages as Array<{
            role?: string;
            content?: string | Array<{ type?: string; text?: string }>;
          }>;
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (!m || m.role !== "user") continue;
            if (typeof m.content === "string" && m.content.length > 0) return m.content;
            if (Array.isArray(m.content)) {
              const parts = m.content
                .filter((b) => b?.type === "text" && typeof b.text === "string")
                .map((b) => b.text ?? "");
              const joined = parts.join("\n").trim();
              if (joined.length > 0) return joined;
            }
          }
        }

        // Legacy Claude API shapes (kept for compatibility).
        const legacy = [
          json.prompt,
          (json.message as { text?: string } | undefined)?.text,
          (json.message as { content?: string } | undefined)?.content,
          json.text,
        ];
        for (const c of legacy) {
          if (typeof c === "string" && c.length > 0) return c;
        }
        return null;
      } catch {
        return null;
      }
    }

    async function consumeStream(
      res: Response,
      convId: string,
      userText: string | null,
      url: string,
    ): Promise<void> {
      const body = res.body;
      if (!body) return;
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantAccum = "";
      let model: string | null = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE event delimiter is a blank line.
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const eventBlock = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const { text, modelHint } = parseSseEvent(eventBlock);
          if (text) assistantAccum += text;
          if (modelHint && !model) model = modelHint;
        }
      }

      const observedAt = new Date().toISOString();
      const events: CaptureEvent[] = [];

      events.push({
        kind: "conversation_seen",
        platform: "claude",
        platform_conv_id: convId,
        title: getCurrentChatTitle(),
        url: `https://claude.ai/chat/${convId}`,
        observed_at: observedAt,
      });

      if (userText && userText.length > 0) {
        events.push({
          kind: "message_appended",
          platform: "claude",
          platform_conv_id: convId,
          role: "user",
          content_text: userText,
          model: model ?? undefined,
          created_at: observedAt,
          position: Date.now(),
        });
      }

      if (assistantAccum.length > 0) {
        events.push({
          kind: "message_appended",
          platform: "claude",
          platform_conv_id: convId,
          role: "assistant",
          content_text: assistantAccum,
          model: model ?? undefined,
          created_at: new Date().toISOString(),
          position: Date.now() + 1,
        });
      }

      emit(events);
    }

    function parseSseEvent(block: string): { text: string; modelHint: string | null } {
      let text = "";
      let modelHint: string | null = null;
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const obj = JSON.parse(payload) as Record<string, unknown>;
          const eventType = typeof obj.type === "string" ? obj.type : "";

          // Extract model hint from wherever it appears.
          if (typeof obj.model === "string" && !modelHint) modelHint = obj.model;
          if (
            eventType === "message_start" &&
            typeof (obj.message as Record<string, unknown> | undefined)?.model === "string" &&
            !modelHint
          ) {
            modelHint = ((obj.message as Record<string, unknown>).model) as string;
          }

          // Use first-wins semantics: pick exactly one text fragment per event.
          // Modern Claude streaming (content_block_delta):
          //   {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"..."}}
          if (eventType === "content_block_delta") {
            const delta = obj.delta as { type?: string; text?: string } | undefined;
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              text += delta.text;
              continue;
            }
          }

          // Older Claude streaming formats (kept for compatibility):
          // { completion: "..." }  or  { delta: { text: "..." } }
          if (typeof obj.completion === "string") { text += obj.completion; continue; }
          if (typeof obj.text === "string" && obj.text) { text += obj.text; continue; }
          const delta = obj.delta as { text?: string } | undefined;
          if (typeof delta?.text === "string") { text += delta.text; continue; }
        } catch {
          // Not JSON — ignore.
        }
      }
      return { text, modelHint };
    }

    function getCurrentChatTitle(): string | undefined {
      // document.title is usually "Title - Claude" once Claude sets it.
      const t = document.title;
      if (!t || t === "Claude") return undefined;
      return t.replace(/\s*[-–|]\s*Claude.*$/i, "").trim() || undefined;
    }

    function emit(events: CaptureEvent[]): void {
      if (events.length === 0) return;
      const msg: InjectToContentMessage = {
        recall: RECALL_TAG,
        source: "claude-inject",
        events,
      };
      window.postMessage(msg, window.location.origin);
    }

    function emitError(label: string, err: unknown): void {
      try {
        // eslint-disable-next-line no-console
        console.warn(`[recall:inject] ${label}`, err);
      } catch {
        /* noop */
      }
    }
  },
});
