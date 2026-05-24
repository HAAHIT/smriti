// Gemini DOM-observation adapter.
//
// Gemini's network transport is a gRPC-web stream with double-encoded JSON
// arrays — too fragile to parse defensively. For Phase 1 we observe the DOM:
// watch for new user/assistant turn elements, wait for each to settle (no
// mutations for ~800ms), then emit CaptureEvents.
//
// Selectors cover Gemini UI variants observed through mid-2026. Adjust as
// Gemini's component names evolve; the multi-selector approach is deliberately
// defensive.

import { defineContentScript } from "wxt/sandbox";
import type { CaptureEvent } from "@recall/shared";

// Gemini renders turns as custom elements. We try several known names/attrs
// in priority order — first match wins for each candidate element.
const USER_SELECTORS = [
  "user-query",
  "message-content[data-role='user']",
  "[data-test-id='user-query']",
  ".user-query-bubble-container",
  ".user-query-text",
  "[class*='user-query']",
  "[class*='UserQuery']",
  "chat-window .human-turn",
  ".human-turn",
];

const ASSISTANT_SELECTORS = [
  "model-response",
  "message-content[data-role='model']",
  "[data-test-id='model-response']",
  ".model-response-text",
  "[class*='model-response']",
  "[class*='ModelResponse']",
  "chat-window .model-turn",
  ".model-turn",
  ".response-container",
];

const SETTLE_MS = 1000; // slightly longer than before — Gemini is slow to paint

export default defineContentScript({
  matches: ["https://gemini.google.com/*"],
  runAt: "document_idle",
  main() {
    // eslint-disable-next-line no-console
    console.debug("[smriti] gemini-dom: observer active");

    const seenIds = new Set<string>();
    let positionCounter = Date.now();

    function emit(events: CaptureEvent[]): void {
      if (events.length === 0) return;
      browser.runtime
        .sendMessage({ kind: "capture", events })
        .catch(() => {
          // Service worker may be inactive; retry once after a tick.
          setTimeout(() => {
            browser.runtime.sendMessage({ kind: "capture", events }).catch(() => {
              // eslint-disable-next-line no-console
              console.warn("[smriti:gemini] sendMessage failed twice — dropped");
            });
          }, 500);
        });
    }

    function getConvId(): string | null {
      // URL patterns observed in Gemini:
      //   /app/c_abc123            (older)
      //   /app/abc123              (newer — no c_ prefix)
      //   /chat/abc123
      const m =
        window.location.pathname.match(/\/app\/([^/?#]+)/) ??
        window.location.pathname.match(/\/chat\/([^/?#]+)/);
      const raw = m?.[1] ?? null;
      // Filter out non-id segments like "home", "compose", etc.
      if (!raw || /^(home|compose|settings|search)$/i.test(raw)) return null;
      return raw;
    }

    function getTitle(): string | undefined {
      const t = document.title;
      if (!t || t === "Gemini") return undefined;
      return t.replace(/\s*[-–|]\s*(Gemini|Google).*$/i, "").trim() || undefined;
    }

    function matchAny(el: Element, selectors: string[]): boolean {
      for (const sel of selectors) {
        try {
          if (el.matches(sel)) return true;
        } catch {
          /* invalid selector for el; skip */
        }
      }
      return false;
    }

    function roleOf(el: Element): "user" | "assistant" | null {
      if (matchAny(el, USER_SELECTORS)) return "user";
      if (matchAny(el, ASSISTANT_SELECTORS)) return "assistant";
      return null;
    }

    // Stable-ish dedup key: role + approximate DOM position + text prefix.
    function elementId(el: Element, role: string): string {
      const text = (el.textContent ?? "").trim().slice(0, 60);
      let pathIdx = 0;
      let cur: Element | null = el;
      let depth = 0;
      while (cur && cur.parentElement && depth < 8) {
        const siblings = Array.from(cur.parentElement.children);
        pathIdx = pathIdx * 31 + siblings.indexOf(cur);
        cur = cur.parentElement;
        depth++;
        if (cur === document.body) break;
      }
      return `${role}:${pathIdx}:${text}`;
    }

    // Extract visible text from the element, preferring text nodes over
    // aria-label or title attributes (to avoid capturing UI chrome).
    function extractText(el: Element): string {
      // Some Gemini turns wrap the actual text in a .markdown or .response-text child.
      const inner =
        el.querySelector(".markdown") ??
        el.querySelector("[class*='response-text']") ??
        el.querySelector("[class*='content']") ??
        el;
      return (inner.textContent ?? "").trim();
    }

    function settleAndCapture(el: Element, role: "user" | "assistant"): void {
      const convId = getConvId();
      if (!convId) return;
      const id = elementId(el, role);
      if (seenIds.has(id)) return;

      let timer: ReturnType<typeof setTimeout> | null = null;
      const obs = new MutationObserver(() => schedule());

      const schedule = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          obs.disconnect();
          const text = extractText(el);
          if (!text) return;
          if (seenIds.has(id)) return;
          seenIds.add(id);
          const now = new Date().toISOString();
          const events: CaptureEvent[] = [
            {
              kind: "conversation_seen",
              platform: "gemini",
              platform_conv_id: convId,
              title: getTitle(),
              url: window.location.href,
              observed_at: now,
            },
            {
              kind: "message_appended",
              platform: "gemini",
              platform_conv_id: convId,
              role,
              content_text: text,
              created_at: now,
              position: positionCounter++,
            },
          ];
          emit(events);
        }, SETTLE_MS);
      };

      obs.observe(el, { childList: true, subtree: true, characterData: true });
      schedule();
    }

    function scanRoot(root: Node): void {
      if (!(root instanceof Element)) return;
      const userHits = USER_SELECTORS.flatMap((s) => {
        try { return Array.from(root.querySelectorAll(s)); } catch { return []; }
      });
      const asstHits = ASSISTANT_SELECTORS.flatMap((s) => {
        try { return Array.from(root.querySelectorAll(s)); } catch { return []; }
      });
      // Also check root itself.
      if (matchAny(root, USER_SELECTORS)) userHits.push(root);
      if (matchAny(root, ASSISTANT_SELECTORS)) asstHits.push(root);

      // Deduplicate by reference.
      const seen = new Set<Element>();
      for (const el of [...userHits, ...asstHits]) {
        if (seen.has(el)) continue;
        seen.add(el);
        const role = roleOf(el);
        if (role) settleAndCapture(el, role);
      }
    }

    // Capture anything already on the page (resuming an existing chat).
    scanRoot(document.body);

    const rootObs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((n) => scanRoot(n));
      }
    });
    rootObs.observe(document.body, { childList: true, subtree: true });

    // Also re-scan on navigation (Gemini is a SPA; URL changes without full reload).
    let lastUrl = window.location.href;
    const navObs = new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        // Give the SPA a moment to render the new conversation.
        setTimeout(() => scanRoot(document.body), 1200);
      }
    });
    navObs.observe(document.documentElement, { childList: true, subtree: false });
  },
});
