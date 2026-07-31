// The source registry — one declaration per place Smriti can capture from.
//
// This file is the single source of truth for which origins Smriti touches.
// Before it existed, that list was written out in four places that disagreed:
// each connector's content-script `matches`, the sidebar's own `matches`,
// `host_permissions` in wxt.config.ts, and `platformToHost()` in background.ts.
// `chat.openai.com` appeared in the ChatGPT content scripts and in none of the
// other three, so the sidebar never mounted there and the capture pause could
// not reach it. That class of bug is a symptom of the duplication, so the
// duplication is what gets removed: every one of those four lists is now
// derived from `SOURCES` below.
//
// CONSTRAINT: this module is imported by content scripts *and* by
// wxt.config.ts at build time (in Node). Keep it pure data and pure functions —
// no browser globals, no DB, no runtime-only imports. The only import is
// type-only, so it erases at compile time.

import type { SourceId } from "@smriti/shared";

/**
 * What a source supports. These gate real behaviour rather than describing it:
 * a human-chat source has no composer to inject into, and a full-height app
 * like WhatsApp Web reacts badly to the sidebar's `margin-right` host shift.
 */
export interface SourceCapabilities {
  /** Capture messages live while the user is on the page. */
  live: boolean;
  /** Bulk-import existing history (lib/backfill.ts). */
  backfill: boolean;
  /** `injectText()` is meaningful here — there is a prompt composer to write into. */
  composer: boolean;
  /** The sidebar panel may mount on this source and shift the host page. */
  overlay: boolean;
}

export interface SourceDef {
  /** Stable key. Written to `conversations.platform`, so never change one. */
  id: SourceId;
  label: string;
  /** Badge colour, matching lib/sidebar-helpers.ts `providerBadge`. */
  color: string;
  /**
   * Match patterns. The single source of truth for content-script `matches`,
   * the sidebar's `matches`, and `host_permissions`.
   */
  origins: string[];
  /**
   * `ai` — a two-role assistant conversation.
   * `human` — people talking to each other; may be N-party.
   */
  kind: "ai" | "human";
  /** Can a conversation here have more than two participants? */
  multiParty: boolean;
  capabilities: SourceCapabilities;
  /**
   * The conversation id encoded in a page URL, or null if the URL doesn't
   * identify one (a root/compose/settings page). Pure — takes a parsed URL so
   * callers control error handling.
   */
  convIdFromUrl(u: URL): string | null;
}

// ─── The sources ─────────────────────────────────────────────────────────────

const AI_CAPABILITIES: SourceCapabilities = {
  live: true,
  backfill: true,
  composer: true,
  overlay: true,
};

export const SOURCES: SourceDef[] = [
  {
    id: "claude",
    label: "Claude",
    color: "#c96442",
    origins: ["https://claude.ai/*"],
    kind: "ai",
    multiParty: false,
    capabilities: AI_CAPABILITIES,
    convIdFromUrl(u) {
      const m = u.pathname.match(/^\/chat\/([0-9a-f-]{8,})/i);
      return m?.[1] ?? null;
    },
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    color: "#1f7a64",
    // chat.openai.com is the legacy origin and still redirects. It was already
    // in the ChatGPT content scripts; declaring it here propagates it to the
    // other three lists that were missing it.
    origins: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
    kind: "ai",
    multiParty: false,
    capabilities: AI_CAPABILITIES,
    convIdFromUrl(u) {
      // Covers /c/<id> and the custom-GPT form /g/g-xxx/c/<id>.
      const m = u.pathname.match(/\/c\/([\w-]{8,})/);
      return m?.[1] ?? null;
    },
  },
  {
    id: "gemini",
    label: "Gemini",
    color: "#3b6cb5",
    origins: ["https://gemini.google.com/*"],
    kind: "ai",
    multiParty: false,
    capabilities: AI_CAPABILITIES,
    convIdFromUrl(u) {
      const m =
        u.pathname.match(/\/app\/([\w-]{8,})/) ??
        u.pathname.match(/\/chat\/([\w-]{8,})/);
      const raw = m?.[1] ?? null;
      // Filter out non-id path segments.
      if (!raw || /^(home|compose|settings|search)$/i.test(raw)) return null;
      return raw;
    },
  },
];

/**
 * `claude_code` is a historical source id: rows exist with this platform from
 * imports, but there is no live connector and no origin to match, so it is
 * deliberately not in SOURCES. Kept here so display code can still label it.
 */
export const LEGACY_SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  claude_code: { label: "Code", color: "#6d5fa6" },
};

// ─── Derived views ───────────────────────────────────────────────────────────
//
// Everything below is computed from SOURCES. Nothing else in the codebase
// should hard-code an origin.

/** Every match pattern, across every source. */
export function allOrigins(): string[] {
  return SOURCES.flatMap((s) => s.origins);
}

/** Match patterns for the sources whose sidebar overlay is enabled. */
export function overlayOrigins(): string[] {
  return SOURCES.filter((s) => s.capabilities.overlay).flatMap((s) => s.origins);
}

export function sourceById(id: string): SourceDef | null {
  return SOURCES.find((s) => s.id === id) ?? null;
}

/**
 * The bare hostname for a match pattern, e.g.
 * "https://claude.ai/*" → "claude.ai". Used for the per-host capture pause,
 * which keys on hostname rather than match pattern.
 */
export function hostOfOrigin(origin: string): string {
  return origin
    .replace(/^\*:\/\//, "")
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^\*\./, "")
    .replace(/^www\./, "");
}

/** Every hostname Smriti captures from. */
export function allHosts(): string[] {
  return [...new Set(allOrigins().map(hostOfOrigin))];
}

/** Hostnames for one source — replaces background.ts's `platformToHost`. */
export function hostsForSource(id: string): string[] {
  const s = sourceById(id);
  return s ? [...new Set(s.origins.map(hostOfOrigin))] : [];
}

/**
 * Resolve a hostname to its source. Uses suffix matching so subdomains
 * (app.claude.ai) resolve the same way the old hand-written checks did.
 */
export function sourceForHostname(hostname: string): SourceDef | null {
  const h = hostname.replace(/^www\./, "");
  for (const s of SOURCES) {
    for (const host of s.origins.map(hostOfOrigin)) {
      if (h === host || h.endsWith(`.${host}`)) return s;
    }
  }
  return null;
}

/** Resolve a full URL to its source, or null if it isn't one we capture. */
export function sourceForUrl(url: string): SourceDef | null {
  try {
    return sourceForHostname(new URL(url).hostname);
  } catch {
    return null;
  }
}

/**
 * Resolve a URL to `{ source, conversation id }`, or null when the URL is on a
 * known source but doesn't identify a conversation. This is the registry-backed
 * replacement for the hand-written `detectCurrentChat()`.
 */
export function resolveConversation(
  url: string,
): { source: SourceDef; platformConvId: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const source = sourceForHostname(u.hostname);
  if (!source) return null;
  const platformConvId = source.convIdFromUrl(u);
  return platformConvId ? { source, platformConvId } : null;
}
