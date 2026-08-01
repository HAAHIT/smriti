// Gemini connector — `domObserver` strategy.
//
// Gemini's transport is a gRPC-web stream of double-encoded JSON arrays, too
// fragile to parse defensively, so this source is observed through the DOM
// instead. All the mechanism (settle debounce, dedup, SPA re-scan) is in
// lib/connectors/dom-observer.ts; what remains here is the selector set.
//
// Selectors cover Gemini UI variants observed through mid-2026. The
// multi-selector approach is deliberately defensive — adjust as Gemini's
// component names evolve.

import { defineContentScript } from "wxt/sandbox";
import { sourceById } from "../lib/connectors/registry";
import { installDomObserver } from "../lib/connectors/dom-observer";

const source = sourceById("gemini")!;

export default defineContentScript({
  matches: source.origins,
  runAt: "document_idle",
  main() {
    installDomObserver({
      sourceId: "gemini",
      settleMs: 1000, // Gemini is slow to paint
      // Conversation-id parsing is the registry's, so the sidebar and the
      // connector can never disagree about which chat is open.
      convIdFromUrl: (u) => source.convIdFromUrl(u),
      titleSuffix: /\s*[-–|]\s*(Gemini|Google).*$/i,
      bareTitle: "Gemini",
      roleSelectors: [
        {
          role: "user",
          selectors: [
            "user-query",
            "message-content[data-role='user']",
            "[data-test-id='user-query']",
            ".user-query-bubble-container",
            ".user-query-text",
            "[class*='user-query']",
            "[class*='UserQuery']",
            "chat-window .human-turn",
            ".human-turn",
          ],
        },
        {
          role: "assistant",
          selectors: [
            "model-response",
            "message-content[data-role='model']",
            "[data-test-id='model-response']",
            ".model-response-text",
            "[class*='model-response']",
            "[class*='ModelResponse']",
            "chat-window .model-turn",
            ".model-turn",
            ".response-container",
          ],
        },
      ],
    });
  },
});
