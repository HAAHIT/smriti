// Window.postMessage protocol between MAIN-world inject and ISOLATED content script.
// Tagged with RECALL_TAG so we ignore the page's own postMessages.

import type { CaptureEvent } from "@recall/shared";

export const RECALL_TAG = "recall:v1";

export type InjectSource =
  | "claude-inject"
  | "chatgpt-inject"
  | "gemini-inject";

export interface InjectToContentMessage {
  recall: typeof RECALL_TAG;
  source: InjectSource;
  events: CaptureEvent[];
}

export function isInjectMessage(data: unknown): data is InjectToContentMessage {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  if (d.recall !== RECALL_TAG) return false;
  if (typeof d.source !== "string" || !d.source.endsWith("-inject")) return false;
  if (!Array.isArray(d.events)) return false;
  return true;
}
