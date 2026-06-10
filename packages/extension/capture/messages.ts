// Window.postMessage protocol between MAIN-world inject and ISOLATED content script.
// Tagged with SMRITI_TAG so we ignore the page's own postMessages.

import type { CaptureEvent } from "@smriti/shared";

export const SMRITI_TAG = "smriti:v1";

export type InjectSource =
  | "claude-inject"
  | "chatgpt-inject"
  | "gemini-inject";

export interface InjectToContentMessage {
  smriti: typeof SMRITI_TAG;
  source: InjectSource;
  events: CaptureEvent[];
}

export function isInjectMessage(data: unknown): data is InjectToContentMessage {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  if (d.smriti !== SMRITI_TAG) return false;
  if (typeof d.source !== "string" || !d.source.endsWith("-inject")) return false;
  if (!Array.isArray(d.events)) return false;
  return true;
}
