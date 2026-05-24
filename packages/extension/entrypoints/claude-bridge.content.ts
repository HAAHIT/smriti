// ISOLATED-world content script for claude.ai.
// Bridges window.postMessage from the MAIN-world inject script to the
// background service worker, which forwards to the helper via NM.

import { defineContentScript } from "wxt/sandbox";
import { isInjectMessage } from "../capture/messages";

export default defineContentScript({
  matches: ["https://claude.ai/*"],
  runAt: "document_idle",
  main() {
    window.addEventListener("message", (ev: MessageEvent) => {
      if (ev.source !== window) return;
      if (!isInjectMessage(ev.data)) return;
      browser.runtime
        .sendMessage({ kind: "capture", events: ev.data.events })
        .catch((e) => {
          // eslint-disable-next-line no-console
          console.warn("[recall] sendMessage failed", e);
        });
    });
  },
});
