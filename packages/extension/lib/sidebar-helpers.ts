// ─── helpers ────────────────────────────────────────────────────────────────

// Pull platform + platform_conv_id out of the current page URL.
// The URLs we care about:
//   claude.ai/chat/<uuid>
//   chatgpt.com/c/<uuid>      (or /g/g-xxx/c/<uuid> for custom GPTs)
//   gemini.google.com/app/<id>

import type {
  CaptureEvent,
  CaptureEventMessageAppended,
  ConversationMessageRow,
  ConversationMeta,
  MemoryRecallHit,
  OutlineSegment,
  Platform,
  SearchHit,
} from "@smriti/shared";
import {
  LEGACY_SOURCE_LABELS,
  resolveConversation,
  sourceById,
  sourceForHostname,
} from "./connectors/registry.js";


// Registry-backed. The URL patterns used to be written out again here, which
// is how the sidebar ended up unable to recognise chat.openai.com while the
// ChatGPT connector captured it happily.
export function detectCurrentChat(url: string): { platform: Platform; platformConvId: string } | null {
  const hit = resolveConversation(url);
  return hit ? { platform: hit.source.id, platformConvId: hit.platformConvId } : null;
}

// Which source we're running on. The sidebar only mounts on registry origins,
// so this normally resolves; `claude` remains the historical fallback.
export function currentPlatform(): Platform {
  return sourceForHostname(location.hostname)?.id ?? "claude";
}

// Pre-filled "report a broken site" GitHub issue link — selectors on these
// sites change often and we have no telemetry, so the user is the sensor.
export function reportIssueUrl(platform: Platform): string {
  const v = chrome.runtime.getManifest().version;
  return (
    `https://github.com/HAAHIT/smriti/issues/new?title=${encodeURIComponent(`[${platform}] `)}` +
    `&body=${encodeURIComponent(`Platform: ${platform}\nExtension: v${v}\nWhat broke:\n`)}`
  );
}

export function providerBadge(p: string): { label: string; color: string } {
  const source = sourceById(p);
  if (source) return { label: source.label, color: source.color };
  // Sources with rows in the archive but no live connector (e.g. claude_code).
  const legacy = LEGACY_SOURCE_LABELS[p];
  if (legacy) return legacy;
  return { label: "Other", color: "#888" };
}

export function memoryKindMeta(kind: string): { label: string; color: string } {
  switch (kind) {
    case "identity":   return { label: "identity",   color: "#8b3a2f" };
    case "preference": return { label: "preference", color: "#1f7a64" };
    case "project":    return { label: "project",    color: "#3b6cb5" };
    case "decision":   return { label: "decision",   color: "#9a6b1f" };
    default:           return { label: "fact",       color: "#6d5fa6" };
  }
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
