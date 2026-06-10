import { defineContentScript } from "wxt/sandbox";
import { isInjectMessage } from "../capture/messages";

export default defineContentScript({
  matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  runAt: "document_idle",
  main() {
    window.addEventListener("message", (ev: MessageEvent) => {
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
