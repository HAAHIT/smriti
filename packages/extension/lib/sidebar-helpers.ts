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


export function detectCurrentChat(url: string): { platform: Platform; platformConvId: string } | null {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith("claude.ai")) {
      const m = u.pathname.match(/^\/chat\/([0-9a-f-]{8,})/i);
      if (m && m[1]) return { platform: "claude", platformConvId: m[1] };
      return null;
    }
    if (u.hostname.endsWith("chatgpt.com")) {
      const m = u.pathname.match(/\/c\/([\w-]{8,})/);
      if (m && m[1]) return { platform: "chatgpt", platformConvId: m[1] };
      return null;
    }
    if (u.hostname.endsWith("gemini.google.com")) {
      const m = u.pathname.match(/\/app\/([\w-]{8,})/);
      if (m && m[1]) return { platform: "gemini", platformConvId: m[1] };
      return null;
    }
  } catch { /* malformed url */ }
  return null;
}

// Which of the three supported hosts we're running on. The content script
// only matches these three, so this always resolves.
export function currentPlatform(): Platform {
  const h = location.hostname;
  if (h.endsWith("chatgpt.com")) return "chatgpt";
  if (h.endsWith("gemini.google.com")) return "gemini";
  return "claude";
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
  switch (p) {
    case "claude":      return { label: "Claude",      color: "#c96442" };
    case "chatgpt":     return { label: "ChatGPT",     color: "#1f7a64" };
    case "gemini":      return { label: "Gemini",      color: "#3b6cb5" };
    case "claude_code": return { label: "Code",        color: "#6d5fa6" };
    default:            return { label: "Other",        color: "#888" };
  }
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