// ISOLATED-world bridge: relays capture events from any MAIN-world connector
// to the background service worker.
//
// This replaces claude-bridge.content.ts and chatgpt-bridge.content.ts, which
// were byte-identical except for their `matches`. Its `matches` is the union of
// every MAIN-world source's origins, so a new fetch-interceptor connector needs
// no bridge of its own — it just works. DOM-observer sources are excluded: they
// run ISOLATED and message the background directly.
//
// MAIN-world scripts cannot reach chrome.*, which is the whole reason this
// exists. `isInjectMessage()` guards against the page's own postMessages.

import { defineContentScript } from "wxt/sandbox";
import { isInjectMessage } from "../capture/messages";
import { bridgeOrigins } from "../lib/connectors/registry";

export default defineContentScript({
  matches: bridgeOrigins(),
  runAt: "document_idle",
  main() {
    window.addEventListener("message", (ev: MessageEvent) => {
      // Only accept messages this window posted to itself.
      if (ev.source !== window) return;
      if (!isInjectMessage(ev.data)) return;
      browser.runtime
        .sendMessage({ kind: "capture", events: ev.data.events })
        .catch((e) => {
          // eslint-disable-next-line no-console
          console.warn("[smriti] sendMessage failed", e);
        });
    });
  },
});
