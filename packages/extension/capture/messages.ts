// Window.postMessage protocol between MAIN-world inject and ISOLATED content script.
// Tagged with SMRITI_TAG so we ignore the page's own postMessages.

import type { CaptureEvent } from "@smriti/shared";

export const SMRITI_TAG = "smriti:v1";

/**
 * `<sourceId>-inject`. Open rather than a closed union: sources are declared in
 * lib/connectors/registry.ts, and adding one must not require editing this
 * file. The `-inject` suffix is what `isInjectMessage` actually validates.
 */
export type InjectSource = `${string}-inject`;

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
