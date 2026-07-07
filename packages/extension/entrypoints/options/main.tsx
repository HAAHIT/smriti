// Smriti — options page = the desktop archive viewer.
//
// Implements the design from the Recall.html prototype (variant A: Desktop app) against the
// real helper RPCs. Three-pane library/notebook layout:
//
//   ┌──────────┬─────────────────────────────────┬───────────────┐
//   │ Left     │ Center                          │ Right         │
//   │  rail    │   - results (when searching)    │  Outline      │
//   │ Recents  │   - conversation (otherwise)    │  spine        │
//   │ Clusters │                                 │  (the hero)   │
//   └──────────┴─────────────────────────────────┴───────────────┘
//
// The Outline spine on the right is the differentiating piece: every message
// in the open conversation is rendered as a horizontal tick whose length
// scales with message length, grouped into chapter bands derived from the
// helper's outline RPC. Click a tick to jump; the message pulses yellow.
//
// Routing (hash):
//   #/                    → recents + welcome
//   #/c/<conversation_id> → conversation
//   ?msg=<message_id>     → deep-link target (auto-scroll + pulse)
//   ?q=<query>            → seed the global search

import { createRoot } from "react-dom/client";
import React, { useCallback, useEffect, useMemo, useRef, useState, Component } from "react";
import type { ErrorInfo } from "react";
import type {
  BackfillProgress,
  ConversationMessageRow,
  ConversationMeta,
  MemoryItem,
  MemoryKind,
  MemoryStats,
  OutlineSegment,
  RecentConversation,
  SearchHit,
} from "@smriti/shared";

// ─── messaging ───────────────────────────────────────────────────────────────

// Internal request/response types — looser than the NM protocol for in-browser routing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyReq = { type: string; [key: string]: any };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyResp = { ok: boolean; type: string; id: string; [key: string]: any };

// Route requests through the background → offscreen document (new architecture).
async function sendToHelper(req: AnyReq): Promise<AnyResp> {
  const resp = await browser.runtime.sendMessage({ kind: "to_offscreen", ...req }) as
    | { ok: boolean; res?: unknown; error?: string }
    | undefined;
  if (!resp) throw new Error("no response from background");
  if (!resp.ok) throw new Error((resp as { error?: string }).error ?? "offscreen error");
  // Offscreen wraps results as { ok: true, result: <data> }.
  const inner = resp.res as { ok?: boolean; result?: unknown } | undefined;
  const data = inner?.result ?? inner ?? {};
  return { ok: true, type: req.type, id: "", ...((data && typeof data === "object") ? data : {}) };
}

// Pre-filled "report a broken site" GitHub issue link — selectors on these
// sites change often and we have no telemetry, so the user is the sensor.
function reportIssueUrl(platform: string): string {
  const v = chrome.runtime.getManifest().version;
  return (
    `https://github.com/HAAHIT/smriti/issues/new?title=${encodeURIComponent(`[${platform}] `)}` +
    `&body=${encodeURIComponent(`Platform: ${platform}\nExtension: v${v}\nWhat broke:\n`)}`
  );
}

// ─── route ──────────────────────────────────────────────────────────────────

interface Route {
  view: "home" | "conversation" | "welcome" | "settings" | "memory";
  conversationId?: string;
  msgId?: string;
  q?: string;
}

function parseHash(hash: string): Route {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!h || h === "/") return { view: "home" };
  const u = new URL(h, "http://x");
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs[0] === "c" && segs[1]) {
    return {
      view: "conversation",
      conversationId: segs[1],
      msgId: u.searchParams.get("msg") ?? undefined,
      q: u.searchParams.get("q") ?? undefined,
    };
  }
  if (segs[0] === "welcome") return { view: "welcome" };
  if (segs[0] === "settings") return { view: "settings" };
  if (segs[0] === "memory") return { view: "memory" };
  return { view: "home" };
}

function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const nav = useCallback((r: Route) => {
    if (r.view === "home") {
      location.hash = "/";
    } else if (r.view === "welcome") {
      location.hash = "/welcome";
    } else if (r.view === "settings") {
      location.hash = "/settings";
    } else if (r.view === "memory") {
      location.hash = "/memory";
    } else if (r.conversationId) {
      const p = new URLSearchParams();
      if (r.msgId) p.set("msg", r.msgId);
      if (r.q) p.set("q", r.q);
      const qs = p.toString();
      location.hash = `/c/${r.conversationId}${qs ? "?" + qs : ""}`;
    }
  }, []);
  return [route, nav];
}

// ─── theme ──────────────────────────────────────────────────────────────────

type Theme = "light" | "sepia" | "dark";
const THEMES: Theme[] = ["light", "sepia", "dark"];

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem("smriti:theme");
    if (stored === "light" || stored === "sepia" || stored === "dark") return stored;
    return "light";
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("smriti:theme", theme);
  }, [theme]);
  const cycle = useCallback(() => {
    setTheme((t) => THEMES[(THEMES.indexOf(t) + 1) % THEMES.length] ?? "light");
  }, []);
  return [theme, cycle];
}

// ─── providers ──────────────────────────────────────────────────────────────

const PROVIDERS: Record<string, { label: string; short: string; color: string }> = {
  claude:      { label: "Claude",       short: "Claude",  color: "var(--provider-claude)"  },
  chatgpt:     { label: "ChatGPT",      short: "ChatGPT", color: "var(--provider-chatgpt)" },
  gemini:      { label: "Gemini",       short: "Gemini",  color: "var(--provider-gemini)"  },
  claude_code: { label: "Claude Code",  short: "Code",    color: "var(--provider-code)"    },
};

function ProviderChip({ id, dim }: { id: string; dim?: boolean }) {
  const p = PROVIDERS[id] ?? PROVIDERS.claude!;
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      fontSize: 11,
      color: dim ? "var(--muted)" : "var(--ink-2)",
      fontWeight: 500,
    }}>
      <span className="provider-dot" style={{ background: p.color }} />
      {p.short}
    </span>
  );
}

// ─── text helpers ───────────────────────────────────────────────────────────

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function highlightTerms(text: string, terms: string[]): React.ReactNode {
  if (!terms || terms.length === 0) return text;
  const escaped = terms.filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escaped.length === 0) return text;
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts = text.split(re);
  return parts.map((p, i) =>
    re.test(p) ? <mark key={i} className="match">{p}</mark> : <React.Fragment key={i}>{p}</React.Fragment>,
  );
}

function makeSnippet(text: string, terms: string[], length = 200): string {
  const lower = text.toLowerCase();
  let firstAt = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0 && (firstAt < 0 || i < firstAt)) firstAt = i;
  }
  if (firstAt < 0) {
    return text.slice(0, length) + (text.length > length ? "…" : "");
  }
  const start = Math.max(0, firstAt - Math.floor(length / 3));
  const end = Math.min(text.length, start + length);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

// FTS snippets come back with <<word>> markers; convert those into a flat
// string with the matched terms returned alongside, so we can re-highlight
// in our own renderer (consistent with vec-only hits that have no markers).
function parseFtsSnippet(s: string): { text: string; terms: string[] } {
  const terms = new Set<string>();
  const text = s.replace(/<<([^>]*)>>/g, (_m, w) => {
    if (w) terms.add(String(w).toLowerCase());
    return w;
  });
  return { text, terms: [...terms] };
}

// ─── MessageBody ────────────────────────────────────────────────────────────
// Renders message text with fenced code blocks, lists, and inline `code`.

function MessageBody({ text, terms }: { text: string; terms: string[] }) {
  const parts = useMemo(() => {
    const out: Array<{ kind: "prose" | "code"; text: string }> = [];
    const fence = /```(?:\w+)?\n?([\s\S]*?)```/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = fence.exec(text)) !== null) {
      if (m.index > last) out.push({ kind: "prose", text: text.slice(last, m.index) });
      out.push({ kind: "code", text: m[1] ?? "" });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ kind: "prose", text: text.slice(last) });
    return out;
  }, [text]);

  return (
    <div className="msg-body">
      {parts.flatMap((p, i) => {
        if (p.kind === "code") {
          return [
            <pre key={`c-${i}`}>
              <code>{highlightTerms(p.text.replace(/\n+$/, ""), terms)}</code>
            </pre>,
          ];
        }
        // Paragraphs + lists
        const paragraphs = p.text.split(/\n\n+/);
        return paragraphs.map((para, j) => {
          if (!para.trim()) return null;
          const lines = para.split("\n");
          const isList = lines.every((l) => /^\s*(\d+\.|[-•*])\s+/.test(l) || !l.trim());
          if (isList && lines.length > 1) {
            const ordered = /^\s*\d+\./.test(lines[0]!);
            const Tag = (ordered ? "ol" : "ul") as keyof React.JSX.IntrinsicElements;
            const items = lines.filter((l) => l.trim());
            return (
              <Tag key={`l-${i}-${j}`}>
                {items.map((l, k) => (
                  <li key={k}>{renderInline(l.replace(/^\s*(\d+\.|[-•*])\s+/, ""), terms)}</li>
                ))}
              </Tag>
            );
          }
          return <p key={`p-${i}-${j}`}>{renderInline(para, terms)}</p>;
        });
      })}
    </div>
  );
}

function renderInline(s: string, terms: string[]): React.ReactNode {
  const parts: Array<{ kind: "t" | "c"; text: string }> = [];
  let last = 0;
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) parts.push({ kind: "t", text: s.slice(last, m.index) });
    parts.push({ kind: "c", text: m[1] ?? "" });
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push({ kind: "t", text: s.slice(last) });
  return parts.map((p, i) =>
    p.kind === "c"
      ? <code key={i}>{highlightTerms(p.text, terms)}</code>
      : <React.Fragment key={i}>{highlightTerms(p.text, terms)}</React.Fragment>,
  );
}

// ─── chapter mapping ────────────────────────────────────────────────────────
// Given outline segments (positions) and messages, derive a chapter index
// for each message.

interface ChapterMap {
  chapters: Array<{ title: string; startMsgIdx: number; messageCount: number }>;
  msgChapter: number[];   // chapter index per message (parallel to messages)
}

function buildChapterMap(messages: ConversationMessageRow[], segments: OutlineSegment[]): ChapterMap {
  if (segments.length === 0) {
    return {
      chapters: messages.length > 0 ? [{ title: messages[0]?.content_text.slice(0, 60) ?? "Conversation", startMsgIdx: 0, messageCount: messages.length }] : [],
      msgChapter: messages.map(() => 0),
    };
  }
  // Sort segments by start_position to be safe.
  const segs = [...segments].sort((a, b) => a.start_position - b.start_position);
  const msgChapter: number[] = new Array(messages.length).fill(0);
  let segIdx = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    while (segIdx + 1 < segs.length && m.position >= segs[segIdx + 1]!.start_position) {
      segIdx++;
    }
    msgChapter[i] = segIdx;
  }
  const chapters = segs.map((s, ci) => {
    const startMsgIdx = msgChapter.indexOf(ci);
    const messageCount = msgChapter.filter((c) => c === ci).length;
    return { title: s.preview || `Chapter ${ci + 1}`, startMsgIdx: Math.max(0, startMsgIdx), messageCount };
  });
  return { chapters, msgChapter };
}

// ─── ConversationSpine (the hero) ───────────────────────────────────────────
// Every message in the conversation rendered as a horizontal tick, grouped
// into chapter bands. User messages are taller and darker; bar length scales
// to message length. Active position highlighted in --accent.

const CHAPTER_HUES = [
  "var(--provider-claude)",
  "var(--provider-chatgpt)",
  "var(--provider-gemini)",
  "var(--provider-code)",
  "#9a7b3d",
  "#5e7a3d",
  "#8a4570",
  "#3d6e7a",
];

function ConversationSpine({
  messages,
  chapterMap,
  activeIdx,
  pulseIdx,
  filterMatches,
  onJump,
}: {
  messages: ConversationMessageRow[];
  chapterMap: ChapterMap;
  activeIdx: number;
  pulseIdx: number | null;
  filterMatches: Set<number> | null;
  onJump: (msgIdx: number) => void;
}) {
  const maxLen = useMemo(
    () => Math.max(1, ...messages.map((m) => m.content_text.length)),
    [messages],
  );

  return (
    <div style={{ padding: "12px 0", display: "flex", flexDirection: "column", gap: 14 }}>
      {chapterMap.chapters.map((ch, ci) => {
        const msgs = messages
          .map((m, idx) => ({ m, idx }))
          .filter(({ idx }) => chapterMap.msgChapter[idx] === ci);
        const hue = CHAPTER_HUES[ci % CHAPTER_HUES.length] ?? "var(--muted-2)";
        const active = msgs.some(({ idx }) => idx === activeIdx);
        return (
          <div key={ci} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <button
              type="button"
              onClick={() => onJump(ch.startMsgIdx)}
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                textAlign: "left",
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                color: active ? "var(--ink)" : "var(--ink-2)",
              }}
            >
              <span className="mono" style={{ fontSize: 10, color: "var(--muted)", width: 18, flex: "0 0 18px" }}>
                {String(ci + 1).padStart(2, "0")}
              </span>
              <span className="serif" style={{
                fontSize: 13.5,
                lineHeight: 1.3,
                fontWeight: active ? 600 : 500,
                overflow: "hidden",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
              }}>
                {ch.title}
              </span>
            </button>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, marginLeft: 26 }}>
              {msgs.map(({ m, idx }) => {
                const w = 30 + (m.content_text.length / maxLen) * 70;
                const isActive = idx === activeIdx;
                const isPulse = idx === pulseIdx;
                const isFilterMatch = filterMatches?.has(idx);
                const isUser = m.role === "user";
                return (
                  <button
                    key={m.id}
                    type="button"
                    title={`#${idx + 1} · ${m.role} · ${m.content_text.length} chars`}
                    onClick={() => onJump(idx)}
                    style={{
                      background: "transparent",
                      border: "none",
                      padding: "2px 0",
                      cursor: "pointer",
                      textAlign: "left",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <span style={{
                      width: 3,
                      height: 12,
                      background: isActive
                        ? "var(--accent)"
                        : isPulse
                          ? "var(--highlight-strong)"
                          : isFilterMatch
                            ? "var(--ink)"
                            : hue,
                      opacity: isActive || isPulse || isFilterMatch ? 1 : (isUser ? 0.85 : 0.4),
                      flex: "0 0 3px",
                      transition: "background 0.15s, opacity 0.15s",
                    }} />
                    <span style={{
                      height: isUser ? 4 : 3,
                      width: `${w}%`,
                      background: isActive
                        ? "var(--accent)"
                        : isPulse
                          ? "var(--highlight-strong)"
                          : isFilterMatch
                            ? "var(--ink)"
                            : (isUser ? "var(--ink-2)" : "var(--muted-2)"),
                      opacity: filterMatches && !isFilterMatch && !isActive ? 0.2 : 1,
                      transition: "background 0.15s, opacity 0.15s",
                      borderRadius: 1,
                    }} />
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── MiniSpine (used in results) ────────────────────────────────────────────
// Vertical compact column showing the whole conversation, with the matched
// message highlighted. Density-only view for the result-card sidebar.

function MiniSpine({
  messages,
  hitMessageId,
  width = 42,
  height = 40,
}: {
  messages: ConversationMessageRow[];
  hitMessageId: string | null;
  width?: number;
  height?: number;
}) {
  const total = messages.length;
  if (total === 0) return null;
  const rowH = Math.max(1, Math.floor((height - 2) / total));
  return (
    <div style={{
      width,
      height,
      display: "flex",
      flexDirection: "column",
      gap: 1,
      padding: 1,
      background: "var(--surface-2)",
      borderRadius: 2,
      flex: `0 0 ${width}px`,
    }}>
      {messages.map((m) => {
        const isHit = hitMessageId === m.id;
        const w = Math.min(100, 30 + (m.content_text.length / 1500) * 70);
        return (
          <div key={m.id} style={{
            height: rowH,
            width: `${w}%`,
            background: isHit
              ? "var(--highlight-strong)"
              : (m.role === "user" ? "var(--ink-2)" : "var(--muted-2)"),
            opacity: isHit ? 1 : 0.55,
            borderRadius: 0.5,
          }} />
        );
      })}
    </div>
  );
}

// ─── TopBar ─────────────────────────────────────────────────────────────────

function TopBar({
  query,
  setQuery,
  searching,
  resultCount,
  totals,
  theme,
  onCycleTheme,
  helperOk,
  onOpenSettings,
  onOpenMemory,
  memoryCount,
}: {
  query: string;
  setQuery: (s: string) => void;
  searching: boolean;
  resultCount: number;
  totals: { conversations: number; messages: number };
  theme: Theme;
  onCycleTheme: () => void;
  helperOk: boolean;
  onOpenSettings: () => void;
  onOpenMemory: () => void;
  memoryCount: number;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const inField = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA");
      // "/" or Ctrl+K / Cmd+K → focus search
      if ((e.key === "/" && !inField) || (e.key === "k" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
      if (e.key === "Escape" && active === inputRef.current) {
        setQuery("");
        inputRef.current?.blur();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setQuery]);

  return (
    <div style={{
      height: 52,
      flex: "0 0 52px",
      display: "flex",
      alignItems: "center",
      padding: "0 20px",
      gap: 16,
      borderBottom: "1px solid var(--hairline)",
      background: "var(--bg)",
    }}>
      <a href="#/" className="serif" style={{
        fontSize: 22,
        fontWeight: 600,
        letterSpacing: "-0.01em",
        lineHeight: 1,
        color: "var(--ink)",
        textDecoration: "none",
      }}>Smriti</a>
      <div className="smallcaps" style={{ color: "var(--muted)", display: "flex", alignItems: "center", gap: 8 }}>
        <span
          title={helperOk ? "Helper connected" : "Helper not reachable"}
          style={{
            display: "inline-block",
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: helperOk ? "var(--provider-chatgpt)" : "var(--accent)",
          }}
        />
        local archive · {totals.conversations} conversation{totals.conversations === 1 ? "" : "s"} · {totals.messages} messages
      </div>
      <div style={{ flex: 1 }} />
      <div style={{
        flex: "0 1 520px",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "7px 12px",
        border: "1px solid var(--hairline-strong)",
        borderRadius: 6,
        background: "var(--surface)",
      }}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ color: "var(--muted)", flex: "0 0 14px" }}>
          <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your archive… (Ctrl+K)"
          style={{
            flex: 1,
            border: "none",
            background: "transparent",
            outline: "none",
            fontSize: 13,
          }}
        />
        {query ? (
          <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
            {searching ? "…" : `${resultCount} ${resultCount === 1 ? "match" : "matches"}`}
          </span>
        ) : (
          <span className="kbd">/</span>
        )}
      </div>
      <button
        type="button"
        onClick={onOpenMemory}
        title="Your memory — facts that travel across every AI"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--hairline-strong)",
          borderRadius: 4,
          padding: "5px 12px",
          fontSize: 12,
          color: "var(--ink-2)",
          cursor: "pointer",
          fontFamily: "var(--sans)",
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          gap: 7,
        }}
      >
        <span style={{ color: "var(--accent)" }}>✦</span>
        Memory
        {memoryCount > 0 && (
          <span className="mono" style={{
            fontSize: 10.5, color: "var(--muted)",
            background: "var(--surface-2)", borderRadius: 8, padding: "0 6px",
          }}>{memoryCount}</span>
        )}
      </button>
      <button
        type="button"
        onClick={onCycleTheme}
        title={`Theme: ${theme} — click to cycle`}
        style={{
          background: "var(--surface)",
          border: "1px solid var(--hairline-strong)",
          borderRadius: 4,
          padding: "5px 10px",
          fontSize: 11,
          color: "var(--ink-2)",
          cursor: "pointer",
          fontFamily: "var(--mono)",
          letterSpacing: "0.04em",
        }}
      >
        {theme}
      </button>
      <button
        type="button"
        onClick={onOpenSettings}
        title="Settings &amp; privacy"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--hairline-strong)",
          borderRadius: 4,
          padding: "5px 8px",
          color: "var(--ink-2)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4"
                stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

// ─── LeftRail ───────────────────────────────────────────────────────────────

const VAGUE_QUERIES = [
  "rust enum",
  "fuzzy search index",
  "monkey patch fetch",
  "embedding model",
  "name product",
];

function LeftRail({
  recents,
  activeConvId,
  onPickConv,
  onSuggest,
  embed,
}: {
  recents: RecentConversation[];
  activeConvId: string | null;
  onPickConv: (id: string) => void;
  onSuggest: (s: string) => void;
  embed: { total: number; embedded: number; pending: number } | null;
}) {
  return (
    <div className="scroll" style={{
      width: 260,
      flex: "0 0 260px",
      display: "flex",
      flexDirection: "column",
      padding: "20px 16px 16px 20px",
      gap: 22,
      overflow: "auto",
      background: "var(--bg)",
    }}>
      <div>
        <div className="smallcaps" style={{ marginBottom: 8 }}>Try a vague query</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {VAGUE_QUERIES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onSuggest(s)}
              style={{
                background: "transparent",
                border: "none",
                padding: "4px 8px",
                margin: "0 -4px",
                borderRadius: 4,
                textAlign: "left",
                fontSize: 12.5,
                color: "var(--ink-2)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <span style={{ color: "var(--muted-2)", fontFamily: "var(--mono)", fontSize: 10 }}>↩</span>
              <span style={{ fontStyle: "italic" }}>{s}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="smallcaps" style={{
          marginBottom: 8,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}>
          <span>Recent</span>
          <span className="mono" style={{ fontSize: 10, color: "var(--muted-2)" }}>{recents.length}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {recents.map((c) => {
            const active = c.id === activeConvId;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onPickConv(c.id)}
                style={{
                  background: active ? "var(--surface-2)" : "transparent",
                  border: "none",
                  borderRadius: 4,
                  padding: "7px 8px",
                  margin: "1px -4px",
                  textAlign: "left",
                  display: "flex",
                  flexDirection: "column",
                  gap: 3,
                  cursor: "pointer",
                  color: "var(--ink)",
                }}
              >
                <div className="serif" style={{
                  fontSize: 13,
                  fontWeight: active ? 600 : 500,
                  lineHeight: 1.25,
                  color: active ? "var(--ink)" : "var(--ink-2)",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical" as const,
                  overflow: "hidden",
                }}>
                  {c.title ?? "(untitled)"}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10.5, color: "var(--muted)" }}>
                  <ProviderChip id={c.platform} dim />
                  <span>·</span>
                  <span className="mono">{c.message_count}</span>
                </div>
              </button>
            );
          })}
          {recents.length === 0 && (
            <div className="stat" style={{ color: "var(--muted)", fontStyle: "italic", fontSize: 12 }}>
              No conversations yet. Use the popup to backfill or capture live.
            </div>
          )}
        </div>
      </div>

      <BackfillSection embed={embed} />

      <div>
        <div className="smallcaps" style={{
          marginBottom: 8,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}>
          <span>Topic clusters</span>
          <span className="mono" style={{ fontSize: 10, color: "var(--muted-2)" }}>—</span>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--muted)", fontStyle: "italic", lineHeight: 1.5 }}>
          Coming soon. Embedding clustering across conversations will group what you've been thinking about, regardless of which AI you used.
        </div>
      </div>
    </div>
  );
}

// ─── BackfillSection ─────────────────────────────────────────────────────────
// Lives in the LeftRail. Replaces the old popup's backfill UI. Sends
// start_backfill to background (which holds the long-lived NM port) and
// listens for live progress broadcasts.

type BackfillPhase = "idle" | "starting" | "running" | "done" | "failed";

function BackfillSection({ embed }: { embed: { total: number; embedded: number; pending: number } | null }) {
  const [phase, setPhase] = useState<BackfillPhase>("idle");
  const [progress, setProgress] = useState<BackfillProgress | null>(null);

  // Restore prior state from chrome.storage.local (background persisted it).
  useEffect(() => {
    browser.runtime.sendMessage({ kind: "get_backfill_progress" })
      .then((resp: unknown) => {
        const r = resp as { ok?: boolean; progress?: BackfillProgress } | undefined;
        if (!r?.ok || !r.progress) return;
        const p = r.progress;
        setProgress(p);
        if (p.state === "complete" || p.state === "partial") setPhase("done");
        else if (p.state === "failed") setPhase("failed");
        else setPhase("running");
      }).catch(() => {});
  }, []);

  // Listen for live progress broadcasts.
  useEffect(() => {
    const handler = (msg: unknown) => {
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as { kind?: string; progress?: BackfillProgress };
      if (m.kind !== "backfill_progress" || !m.progress) return;
      setProgress(m.progress);
      const s = m.progress.state;
      if (s === "complete" || s === "partial") setPhase("done");
      else if (s === "failed") setPhase("failed");
      else setPhase("running");
    };
    browser.runtime.onMessage.addListener(handler);
    return () => browser.runtime.onMessage.removeListener(handler);
  }, []);

  const start = useCallback((platform: "claude" | "chatgpt" = "claude") => {
    if (phase === "starting" || phase === "running") return;
    setPhase("starting");
    browser.runtime.sendMessage({ kind: "start_backfill", platform })
      .then((resp: unknown) => {
        const r = resp as { ok?: boolean } | undefined;
        if (!r?.ok) { setPhase("failed"); return; }
        setPhase("running");
      })
      .catch(() => setPhase("failed"));
  }, [phase]);

  const canStart = phase === "idle" || phase === "done" || phase === "failed";
  const isActive = phase === "starting" || phase === "running";
  const pct = progress?.total_known && progress.total_known > 0
    ? Math.round((progress.total_fetched / progress.total_known) * 100)
    : null;
  const embedPct = embed && embed.total > 0
    ? Math.round((embed.embedded / embed.total) * 100)
    : null;

  return (
    <div>
      <div className="smallcaps" style={{ marginBottom: 8 }}>Backfill &amp; index</div>

      <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
        {(["claude", "chatgpt"] as const).map((p) => (
          <button
            key={p}
            onClick={() => start(p)}
            disabled={!canStart}
            style={{
              flex: 1,
              padding: "7px 6px",
              fontSize: 11,
              background: canStart ? "var(--accent)" : "var(--surface-2)",
              color: canStart ? "#f6f0e3" : "var(--muted)",
              border: "none",
              borderRadius: 3,
              cursor: canStart ? "pointer" : "default",
              fontWeight: 600,
              letterSpacing: "0.02em",
              fontFamily: "var(--sans)",
            }}
          >
            {isActive && progress?.platform === p
              ? "Running…"
              : phase === "starting"
              ? "Starting…"
              : `Import ${p === "claude" ? "Claude" : "ChatGPT"}`}
          </button>
        ))}
      </div>

      {isActive && progress && (
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--muted)" }}>
          {progress.state === "discovering" && <div>Discovering conversations…</div>}
          {progress.state === "fetching" && (
            <div>{progress.total_fetched}{progress.total_known ? ` / ${progress.total_known}` : ""} fetched</div>
          )}
          {progress.state === "rate_limited" && <div style={{ color: "var(--accent)" }}>Rate limited — pausing…</div>}
          {pct !== null && (
            <div style={{ background: "var(--surface-2)", borderRadius: 3, height: 4, marginTop: 5, overflow: "hidden" }}>
              <div style={{ width: `${pct}%`, height: "100%", background: "var(--accent)", transition: "width 0.5s ease" }} />
            </div>
          )}
        </div>
      )}

      {phase === "done" && progress && (
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>
          {progress.state === "complete" ? "Last import complete ✓" : "Last import partial"}
        </div>
      )}

      {phase === "failed" && (
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--accent)", fontStyle: "italic" }}>
          Last import failed. Click to retry.
        </div>
      )}

      {/* Semantic index progress — always visible if we have data */}
      {embed && embed.total > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 10.5,
            color: "var(--muted)",
            marginBottom: 4,
          }}>
            <span>Semantic index</span>
            <span className="mono">
              {embed.embedded} / {embed.total}
              {embed.pending === 0 ? " ✓" : ""}
            </span>
          </div>
          <div style={{ background: "var(--surface-2)", borderRadius: 3, height: 3, overflow: "hidden" }}>
            <div style={{
              width: `${embedPct ?? 0}%`,
              height: "100%",
              background: embed.pending === 0 ? "var(--provider-chatgpt)" : "var(--provider-gemini)",
              transition: "width 0.6s ease",
            }} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ResultsView ────────────────────────────────────────────────────────────
// Hybrid search results, grouped by conversation. Mini-spine alongside each
// conversation's hits to show where in the thread the matches fall.

function ResultsView({
  query,
  results,
  onPick,
}: {
  query: string;
  results: SearchHit[];
  onPick: (hit: SearchHit) => void;
}) {
  // Group hits by conversation (current search returns one per conv, but the
  // shape supports multiple; the UI handles either).
  const byConv = useMemo(() => {
    const m = new Map<string, SearchHit[]>();
    for (const r of results) {
      const a = m.get(r.conversation_id) ?? [];
      a.push(r);
      m.set(r.conversation_id, a);
    }
    return m;
  }, [results]);

  if (results.length === 0) {
    return (
      <div style={{ padding: "60px 40px", color: "var(--muted)" }}>
        <div className="serif" style={{ fontSize: 18, marginBottom: 8 }}>
          No matches for “{query}”.
        </div>
        <div style={{ fontSize: 13 }}>
          Try a vaguer phrase — semantic recall catches paraphrase.
        </div>
      </div>
    );
  }

  return (
    <div className="scroll" style={{ flex: 1, overflow: "auto", padding: "16px 28px 60px" }}>
      <div style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        padding: "4px 0 14px",
      }}>
        <div className="serif" style={{ fontSize: 14, color: "var(--muted)" }}>
          <span style={{ color: "var(--ink-2)" }}>{results.length}</span> matches across{" "}
          <span style={{ color: "var(--ink-2)" }}>{byConv.size}</span> conversation{byConv.size === 1 ? "" : "s"}{" "}
          for <span className="serif" style={{ color: "var(--ink)", fontStyle: "italic" }}>“{query}”</span>
        </div>
        <div style={{ display: "flex", gap: 12, fontSize: 11, color: "var(--muted)" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 8, height: 2, background: "var(--ink-2)" }} />
            keyword (FTS5)
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 8, height: 2, background: "var(--accent)" }} />
            semantic
          </span>
          <span>· fused via RRF</span>
        </div>
      </div>

      {[...byConv.entries()].map(([convId, rs]) => {
        const first = rs[0]!;
        return (
          <ResultGroup key={convId} hits={rs} primary={first} onPick={onPick} />
        );
      })}
    </div>
  );
}

function ResultGroup({
  hits,
  primary,
  onPick,
}: {
  hits: SearchHit[];
  primary: SearchHit;
  onPick: (h: SearchHit) => void;
}) {
  const [convMsgs, setConvMsgs] = useState<ConversationMessageRow[]>([]);
  // Lazily fetch conversation messages so we can render the mini-spine
  // and give the user a sense of where the hit sits.
  useEffect(() => {
    sendToHelper({ type: "get_conversation", conversation_id: primary.conversation_id })
      .then((r) => {
        if (r.ok && r.type === "get_conversation") setConvMsgs(r.messages);
      })
      .catch(() => {});
  }, [primary.conversation_id]);

  return (
    <div style={{ marginBottom: 22, paddingBottom: 18, borderBottom: "1px solid var(--hairline)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 10 }}>
        <div className="serif" style={{ fontSize: 17, fontWeight: 600, color: "var(--ink)", flex: 1 }}>
          {primary.title ?? "(untitled)"}
        </div>
        <ProviderChip id={primary.platform} />
        <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>
          {convMsgs.length || "…"} msgs
        </span>
      </div>
      <div style={{ display: "flex", gap: 18 }}>
        <MiniSpine
          messages={convMsgs}
          hitMessageId={primary.message_id}
          width={42}
          height={Math.max(40, convMsgs.length * 2)}
        />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
          {hits.map((r) => (
            <ResultRow key={r.message_id} r={r} onClick={() => onPick(r)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ResultRow({ r, onClick }: { r: SearchHit; onClick: () => void }) {
  const { text, terms } = parseFtsSnippet(r.snippet);
  const snippet = makeSnippet(text, terms, 220);
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        padding: "8px 10px",
        margin: "0 -10px",
        borderRadius: 4,
        textAlign: "left",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        color: "var(--ink-2)",
        transition: "background 0.12s",
      }}
      onMouseOver={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
      onMouseOut={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10.5, color: "var(--muted)" }}>
        <span style={{
          width: 8,
          height: 2,
          background: r.match === "vec" ? "var(--accent)" : r.match === "hybrid" ? "var(--accent-soft)" : "var(--ink-2)",
          flex: "0 0 8px",
        }} />
        <span className="smallcaps" style={{ fontSize: 10, letterSpacing: "0.08em" }}>
          {r.match === "vec" ? "Semantic" : r.match === "hybrid" ? "Keyword + Semantic" : "Keyword"}
        </span>
        <span>·</span>
        <span className="mono">score {r.score.toFixed(3)}</span>
      </div>
      <div className="serif" style={{ fontSize: 13.5, lineHeight: 1.5, color: "var(--ink-2)" }}>
        {highlightTerms(snippet, terms)}
      </div>
    </button>
  );
}

// ─── ConversationView ───────────────────────────────────────────────────────

function ConversationView({
  convId,
  msgIdAnchor,
  initialQuery,
  onConvDataLoaded,
  registerJumpTo,
  registerActive,
}: {
  convId: string;
  msgIdAnchor: string | undefined;
  initialQuery: string | undefined;
  onConvDataLoaded: (data: {
    meta: ConversationMeta | null;
    messages: ConversationMessageRow[];
    chapterMap: ChapterMap;
  }) => void;
  registerJumpTo: (jump: (idx: number, withPulse?: boolean) => void) => void;
  registerActive: (idx: number) => void;
}) {
  const [meta, setMeta] = useState<ConversationMeta | null>(null);
  const [messages, setMessages] = useState<ConversationMessageRow[]>([]);
  const [segments, setSegments] = useState<OutlineSegment[]>([]);
  const [outlineReady, setOutlineReady] = useState<boolean | null>(null);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [pulseIdx, setPulseIdx] = useState<number | null>(null);

  const messagesRef = useRef<HTMLDivElement | null>(null);
  const messageRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Load messages + meta when conv changes.
  useEffect(() => {
    setMeta(null);
    setMessages([]);
    setSegments([]);
    setOutlineReady(null);
    setFilter("");
    setActiveIdx(0);
    setErr("");
    messageRefs.current.clear();

    sendToHelper({ type: "get_conversation", conversation_id: convId })
      .then((r) => {
        if (r.ok && r.type === "get_conversation") {
          setMeta(r.meta);
          setMessages(r.messages);
        }
      })
      .catch((e) => setErr(String(e)));
    sendToHelper({ type: "get_outline", conversation_id: convId })
      .then((r) => {
        if (r.ok && r.type === "get_outline") {
          setSegments(r.segments);
          setOutlineReady(r.ready);
        }
      })
      .catch(() => {});
  }, [convId]);

  const chapterMap = useMemo(() => buildChapterMap(messages, segments), [messages, segments]);

  // Notify parent (so it can render right rail).
  useEffect(() => {
    onConvDataLoaded({ meta, messages, chapterMap });
  }, [meta, messages, chapterMap, onConvDataLoaded]);

  // Filter logic
  const filterTokens = useMemo(() => tokenize(filter), [filter]);
  const filterMatches = useMemo(() => {
    if (!filter.trim()) return null;
    const s = new Set<number>();
    for (let i = 0; i < messages.length; i++) {
      const lower = messages[i]!.content_text.toLowerCase();
      if (filterTokens.every((t) => lower.includes(t))) s.add(i);
    }
    return s;
  }, [filter, filterTokens, messages]);

  // Pulse cleanup
  useEffect(() => {
    if (pulseIdx === null) return;
    const t = setTimeout(() => setPulseIdx(null), 2400);
    return () => clearTimeout(t);
  }, [pulseIdx]);

  const jumpTo = useCallback((idx: number, withPulse = true) => {
    const el = messageRefs.current.get(idx);
    const scrollEl = messagesRef.current;
    if (el && scrollEl) {
      scrollEl.scrollTo({ top: el.offsetTop - 80, behavior: "smooth" });
    }
    setActiveIdx(idx);
    if (withPulse) setPulseIdx(idx);
  }, []);

  // Register imperative API for parent (right rail).
  useEffect(() => {
    registerJumpTo(jumpTo);
  }, [jumpTo, registerJumpTo]);
  useEffect(() => {
    registerActive(activeIdx);
  }, [activeIdx, registerActive]);

  // Auto-jump on deep-link.
  useEffect(() => {
    if (!msgIdAnchor || messages.length === 0) return;
    const idx = messages.findIndex((m) => m.id === msgIdAnchor);
    if (idx >= 0) {
      const t = setTimeout(() => jumpTo(idx, true), 80);
      return () => clearTimeout(t);
    }
    return;
  }, [msgIdAnchor, messages, jumpTo]);

  // Track active message via scroll position.
  const onScroll = useCallback(() => {
    const scrollEl = messagesRef.current;
    if (!scrollEl) return;
    const top = scrollEl.scrollTop + 120;
    let best = 0;
    messageRefs.current.forEach((el, idx) => {
      if (el.offsetTop <= top) best = idx;
    });
    setActiveIdx(best);
  }, []);

  if (err) {
    return <div style={{ padding: 40, color: "var(--accent)" }}>{err}</div>;
  }

  return (
    <>
      {/* Conversation header */}
      <div style={{
        padding: "20px 36px 16px",
        borderBottom: "1px solid var(--hairline)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          {meta && <ProviderChip id={meta.platform} />}
          <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
            {meta?.last_message_at ? new Date(meta.last_message_at).toLocaleDateString() : ""}
          </span>
          <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
            {messages.length} messages
          </span>
          <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
            {chapterMap.chapters.length} chapter{chapterMap.chapters.length === 1 ? "" : "s"}
          </span>
          <div style={{ flex: 1 }} />
          {meta?.url && /^https?:/.test(meta.url) && (
            <a href={meta.url} target="_blank" rel="noopener" className="pill mono"
              style={{ fontSize: 10.5, padding: "2px 7px", textDecoration: "none" }}>
              ↗ original
            </a>
          )}
        </div>
        <div className="serif" style={{
          fontSize: 24,
          fontWeight: 600,
          lineHeight: 1.2,
          letterSpacing: "-0.01em",
        }}>
          {meta?.title ?? "Loading…"}
        </div>
        {/* In-conversation filter */}
        <div style={{
          marginTop: 8,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 10px",
          border: "1px solid var(--hairline-strong)",
          borderRadius: 4,
          background: "var(--surface)",
        }}>
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" style={{ color: "var(--muted)" }}>
            <path d="M2 3h12M4 8h8M6 13h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter messages inside this conversation…"
            style={{
              flex: 1,
              border: "none",
              background: "transparent",
              outline: "none",
              fontSize: 12.5,
            }}
          />
          {filter && (
            <>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>
                {filterMatches?.size ?? 0} / {messages.length}
              </span>
              <button
                type="button"
                onClick={() => setFilter("")}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--muted)",
                  cursor: "pointer",
                  fontSize: 14,
                  padding: 0,
                  width: 16,
                  height: 16,
                }}
              >×</button>
            </>
          )}
        </div>
        {outlineReady === false && (
          <div style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic", marginTop: 4 }}>
            Indexing still in progress — outline will refine as embeddings finish.
          </div>
        )}
      </div>

      {/* Messages */}
      <div
        ref={messagesRef}
        onScroll={onScroll}
        className="scroll"
        style={{ flex: 1, overflow: "auto", padding: "12px 0" }}
      >
        {chapterMap.chapters.map((ch, ci) => {
          const msgs = messages
            .map((m, idx) => ({ m, idx }))
            .filter(({ idx }) => chapterMap.msgChapter[idx] === ci);
          const visible = filter.trim()
            ? msgs.filter(({ idx }) => filterMatches?.has(idx))
            : msgs;
          if (filter.trim() && visible.length === 0) return null;
          return (
            <div key={ci}>
              <div style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "20px 36px 8px",
              }}>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--muted-2)" }}>
                  Ch {String(ci + 1).padStart(2, "0")}
                </span>
                <div style={{ flex: 1, height: 1, background: "var(--hairline)" }} />
                <span className="serif" style={{
                  fontSize: 13.5,
                  fontStyle: "italic",
                  color: "var(--muted)",
                  maxWidth: 460,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>
                  {ch.title}
                </span>
                <div style={{ flex: 1, height: 1, background: "var(--hairline)" }} />
              </div>
              {visible.map(({ m, idx }) => (
                <MessageBlock
                  key={m.id}
                  m={m}
                  idx={idx}
                  isPulse={pulseIdx === idx}
                  highlightTerms={filter.trim() ? filterTokens : (initialQuery ? tokenize(initialQuery) : [])}
                  setRef={(el) => {
                    if (el) messageRefs.current.set(idx, el);
                    else messageRefs.current.delete(idx);
                  }}
                />
              ))}
            </div>
          );
        })}
        {filter.trim() && filterMatches?.size === 0 && (
          <div style={{ padding: "60px 40px", color: "var(--muted)", fontStyle: "italic" }}>
            No messages match “{filter}” in this conversation.
          </div>
        )}
        <div style={{ height: 200 }} />
      </div>
    </>
  );
}

function MessageBlock({
  m,
  idx,
  isPulse,
  highlightTerms,
  setRef,
}: {
  m: ConversationMessageRow;
  idx: number;
  isPulse: boolean;
  highlightTerms: string[];
  setRef: (el: HTMLDivElement | null) => void;
}) {
  const isUser = m.role === "user";
  return (
    <div
      ref={setRef}
      className={isPulse ? "pulse-target" : ""}
      style={{
        padding: "12px 36px 16px",
        borderRadius: 2,
        scrollMarginTop: 80,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
        <span className="smallcaps" style={{
          color: isUser ? "var(--ink-2)" : "var(--muted)",
          fontWeight: 600,
        }}>
          {isUser ? "You" : "Assistant"}
        </span>
        <span className="mono" style={{ fontSize: 10.5, color: "var(--muted-2)" }}>
          #{String(idx + 1).padStart(2, "0")}
        </span>
        {m.created_at && (
          <span className="mono" style={{ fontSize: 10.5, color: "var(--muted-2)" }}>
            {new Date(m.created_at).toLocaleString()}
          </span>
        )}
      </div>
      <div style={{
        fontSize: 14,
        lineHeight: 1.62,
        color: isUser ? "var(--ink)" : "var(--ink-2)",
        maxWidth: 720,
      }}>
        <MessageBody text={m.content_text} terms={highlightTerms} />
      </div>
    </div>
  );
}

// ─── RightRail (outline) ────────────────────────────────────────────────────

function RightRail({
  conv,
  activeIdx,
  pulseIdx,
  filterMatches,
  onJump,
  hidden,
}: {
  conv: { messages: ConversationMessageRow[]; chapterMap: ChapterMap } | null;
  activeIdx: number;
  pulseIdx: number | null;
  filterMatches: Set<number> | null;
  onJump: (idx: number) => void;
  hidden: boolean;
}) {
  if (hidden || !conv || conv.messages.length === 0) {
    return (
      <div style={{
        width: 60,
        flex: "0 0 60px",
        background: "var(--bg)",
        borderLeft: "1px solid var(--hairline)",
      }} />
    );
  }
  return (
    <div style={{
      width: 290,
      flex: "0 0 290px",
      background: "var(--bg)",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      borderLeft: "1px solid var(--hairline)",
    }}>
      <div style={{
        padding: "14px 18px 8px 20px",
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        borderBottom: "1px solid var(--hairline)",
      }}>
        <div className="smallcaps">Outline</div>
        <div className="mono" style={{ fontSize: 10, color: "var(--muted-2)" }}>
          #{String(activeIdx + 1).padStart(2, "0")} / {conv.messages.length}
        </div>
      </div>
      <div className="scroll" style={{ flex: 1, overflow: "auto", padding: "0 18px 24px 20px" }}>
        <ConversationSpine
          messages={conv.messages}
          chapterMap={conv.chapterMap}
          activeIdx={activeIdx}
          pulseIdx={pulseIdx}
          filterMatches={filterMatches}
          onJump={onJump}
        />
        <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--hairline)" }}>
          <div className="smallcaps" style={{ marginBottom: 6 }}>Legend</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--muted)" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 24, height: 4, background: "var(--ink-2)" }} />
              you
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 24, height: 3, background: "var(--muted-2)" }} />
              assistant
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 24, height: 4, background: "var(--accent)" }} />
              current position
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── HomeWelcome ────────────────────────────────────────────────────────────

function HomeWelcome({ recents, onPick }: { recents: RecentConversation[]; onPick: (id: string) => void }) {
  if (recents.length === 0) {
    return (
      <div style={{ padding: "64px 40px", maxWidth: 600, display: "flex", flexDirection: "column", gap: 0 }}>
        <div className="serif" style={{ fontSize: 28, fontWeight: 600, marginBottom: 12 }}>
          Your archive is empty.
        </div>
        <p style={{ color: "var(--muted)", fontSize: 14, fontStyle: "italic", margin: "0 0 28px" }}>
          Smriti captures conversations as you chat. Open one of the sites below and
          start a conversation — it'll appear here automatically.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[
            { href: "https://claude.ai/new", label: "Open Claude.ai", color: "#d97706" },
            { href: "https://chatgpt.com/", label: "Open ChatGPT", color: "#19c37d" },
            { href: "https://gemini.google.com/app", label: "Open Gemini", color: "#4285F4" },
          ].map((s) => (
            <a key={s.href} href={s.href} target="_blank" rel="noopener" style={{
              display: "flex", alignItems: "center", gap: 12,
              padding: "12px 16px",
              background: "var(--surface)", border: "1px solid var(--hairline)",
              borderRadius: 6, textDecoration: "none", color: "var(--ink)",
            }}>
              <div style={{ width: 8, height: 8, borderRadius: 4, background: s.color, flexShrink: 0 }} />
              <span style={{ fontSize: 14, fontWeight: 500 }}>{s.label}</span>
              <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 12 }}>↗</span>
            </a>
          ))}
        </div>
        <p style={{ color: "var(--muted)", fontSize: 12, marginTop: 20, fontStyle: "italic" }}>
          Or import your history from Settings → Backfill.
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: "48px 40px", maxWidth: 720 }}>
      <div className="serif" style={{ fontSize: 28, fontWeight: 600, marginBottom: 10 }}>
        Your local archive.
      </div>
      <p style={{ color: "var(--muted)", fontSize: 14, fontStyle: "italic", marginTop: 0, marginBottom: 26 }}>
        Everything you've discussed with Claude, ChatGPT, Gemini, and Claude Code — searchable, indexed, and outlined.
        Start by typing in the search bar above, or pick a recent conversation.
      </p>
      <div className="smallcaps" style={{ marginBottom: 10 }}>Recent</div>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {recents.slice(0, 8).map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onPick(c.id)}
              style={{
                width: "100%",
                background: "transparent",
                border: "none",
                borderBottom: "1px solid var(--hairline)",
                padding: "10px 4px",
                textAlign: "left",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <ProviderChip id={c.platform} dim />
              <span className="serif" style={{
                fontSize: 14,
                fontWeight: 500,
                color: "var(--ink)",
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>{c.title ?? "(untitled)"}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>{c.message_count} msgs</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Onboarding ──────────────────────────────────────────────────────────────
// Shown only on first run. In the new architecture there is no helper to
// install — everything runs inside the extension. The onboarding wizard now
// just introduces the product and offers to kick off a Claude backfill.

// Kept as a stub so references in App don't need changing.
type HelperState = "checking" | "ok" | "missing";

function useHelperState(): HelperState {
  // Offscreen document is always available — always report "ok".
  return "ok";
}

const ONBOARDED_KEY = "smriti:onboarded";

function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);

  return (
    <div style={{
      width: "100%",
      height: "100vh",
      display: "flex",
      flexDirection: "column",
      background: "var(--bg)",
      color: "var(--ink)",
      overflow: "auto",
    }} className="scroll">
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "60px 32px 80px", width: "100%" }}>
        {/* Brand row */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 32 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 6,
            background: "var(--accent)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "#f6f0e3", fontFamily: "var(--serif)", fontSize: 18, fontWeight: 700,
          }}>स</div>
          <div>
            <div className="serif" style={{ fontSize: 22, fontWeight: 600, lineHeight: 1, letterSpacing: "-0.01em" }}>Smriti</div>
            <div className="smallcaps" style={{ marginTop: 4 }}>your AI memory · स्मृति</div>
          </div>
        </div>

        {/* Step dots */}
        <div style={{ display: "flex", gap: 8, marginBottom: 30 }}>
          {[1, 2, 3].map((i) => (
            <div key={i} style={{
              width: 24, height: 3, borderRadius: 2,
              background: i <= step ? "var(--accent)" : "var(--hairline)",
              transition: "background 0.2s",
            }} />
          ))}
        </div>

        {step === 1 && <OnboardingStep1 onNext={() => setStep(2)} />}
        {step === 2 && <OnboardingStep2 onNext={() => setStep(3)} />}
        {step === 3 && <OnboardingStep3 onDone={onDone} />}
      </div>
    </div>
  );
}

function OnboardingStep1({ onNext }: { onNext: () => void }) {
  return (
    <div>
      <h1 className="serif" style={{ fontSize: 30, fontWeight: 600, lineHeight: 1.15, letterSpacing: "-0.01em", margin: "0 0 12px" }}>
        Your AI is about to remember you.
      </h1>
      <p style={{ fontSize: 15, color: "var(--ink-2)", lineHeight: 1.6, margin: "0 0 24px", maxWidth: 580 }}>
        Smriti quietly turns your conversations into a memory of who you are — then hands
        that context back to Claude, ChatGPT, and Gemini, so you never have to re-explain
        yourself.
      </p>
      <ul style={{ listStyle: "none", padding: 0, marginBottom: 20, display: "flex", flexDirection: "column", gap: 10 }}>
        {[
          { t: "Captured automatically", d: "Smriti reads your conversations on claude.ai, chatgpt.com, and gemini.google.com as they happen — no setup." },
          { t: "Distilled into durable facts", d: "Who you are, how you like to work, what you're building — extracted from those chats and kept up to date." },
          { t: "Injected in one click", d: "Start typing in a new chat and Smriti recalls what's relevant, ready to drop straight into your prompt." },
        ].map((row) => (
          <li key={row.t} style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: "0 0 10px", marginTop: 8, width: 10, height: 2, background: "var(--accent)" }} />
            <div>
              <div className="serif" style={{ fontSize: 16, fontWeight: 600, color: "var(--ink)" }}>{row.t}</div>
              <div style={{ fontSize: 13.5, color: "var(--muted)", lineHeight: 1.5 }}>{row.d}</div>
            </div>
          </li>
        ))}
      </ul>
      <div style={{
        background: "var(--surface)", border: "1px solid var(--hairline)",
        borderRadius: 6, padding: "12px 16px", marginBottom: 28,
        fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6,
      }}>
        <strong style={{ color: "var(--ink)" }}>Everything stays on your device.</strong>{" "}
        Your memory is built and stored locally. The only network calls are Smriti reading your
        own chat history from the AI sites you're already signed into — plus optional
        end-to-end-encrypted sync, if you turn it on.
      </div>
      <PrimaryButton onClick={onNext}>Next</PrimaryButton>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function OnboardingStep2({ onNext }: { onNext: () => void }) {
  return (
    <div>
      <h1 className="serif" style={{ fontSize: 26, fontWeight: 600, lineHeight: 1.2, letterSpacing: "-0.01em", margin: "0 0 8px" }}>
        Import your history.
      </h1>
      <p style={{ fontSize: 14, color: "var(--muted)", margin: "0 0 22px", fontStyle: "italic", maxWidth: 560 }}>
        Pull in your past conversations so Smriti has something to learn from right away —
        the more it can read, the more it remembers.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
        <ImportCard platform="claude" label="Claude" color="var(--provider-claude)" />
        <ImportCard platform="chatgpt" label="ChatGPT" color="var(--provider-chatgpt)" />
      </div>

      <p style={{ fontSize: 12.5, color: "var(--muted)", fontStyle: "italic", margin: "0 0 28px", lineHeight: 1.6 }}>
        Smriti imports using your existing signed-in session on each site — no password, and it
        works even with no tab open; just make sure you're signed in to claude.ai / chatgpt.com in
        this browser. Gemini is captured live as you chat — no import needed. Imports keep running
        in the background, so it's safe to continue even while one is in progress.
      </p>

      <div style={{ display: "flex", gap: 10 }}>
        <GhostButton onClick={onNext}>Skip for now</GhostButton>
        <PrimaryButton onClick={onNext}>Continue →</PrimaryButton>
      </div>
    </div>
  );
}

// Per-platform import card for onboarding step 2. Mirrors BackfillSection's
// start / listen / restore pattern (start_backfill + backfill_progress
// broadcasts + get_backfill_progress restore-on-mount), scoped to one platform.
type ImportPhase = "idle" | "starting" | "running" | "done" | "failed";

function ImportCard({ platform, label, color }: { platform: "claude" | "chatgpt"; label: string; color: string }) {
  const [phase, setPhase] = useState<ImportPhase>("idle");
  const [progress, setProgress] = useState<BackfillProgress | null>(null);

  const applyProgress = useCallback((p: BackfillProgress) => {
    setProgress(p);
    if (p.state === "complete" || p.state === "partial") setPhase("done");
    else if (p.state === "failed") setPhase("failed");
    else setPhase("running");
  }, []);

  // Restore prior state from chrome.storage.local (background persisted it).
  useEffect(() => {
    browser.runtime.sendMessage({ kind: "get_backfill_progress" })
      .then((resp: unknown) => {
        const r = resp as { ok?: boolean; progress?: BackfillProgress | null } | undefined;
        const p = r?.ok ? r.progress : undefined;
        if (p && p.platform === platform) applyProgress(p);
      }).catch(() => {});
  }, [platform, applyProgress]);

  // Listen for live progress broadcasts.
  useEffect(() => {
    const handler = (msg: unknown) => {
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as { kind?: string; progress?: BackfillProgress };
      if (m.kind !== "backfill_progress" || !m.progress || m.progress.platform !== platform) return;
      applyProgress(m.progress);
    };
    browser.runtime.onMessage.addListener(handler);
    return () => browser.runtime.onMessage.removeListener(handler);
  }, [platform, applyProgress]);

  const start = useCallback(() => {
    if (phase === "starting" || phase === "running") return;
    setPhase("starting");
    browser.runtime.sendMessage({ kind: "start_backfill", platform })
      .then((resp: unknown) => {
        const r = resp as { ok?: boolean } | undefined;
        if (!r?.ok) { setPhase("failed"); return; }
        setPhase("running");
      })
      .catch(() => setPhase("failed"));
  }, [phase, platform]);

  const canStart = phase === "idle" || phase === "done" || phase === "failed";
  const isActive = phase === "starting" || phase === "running";
  const pct = progress?.total_known && progress.total_known > 0
    ? Math.round((progress.total_fetched / progress.total_known) * 100)
    : null;
  const notSignedIn = phase === "failed" && /signed in/i.test(progress?.message ?? "");
  const siteLabel = platform === "claude" ? "claude.ai" : "chatgpt.com";
  const siteUrl = `https://${siteLabel}`;

  return (
    <div style={{
      background: "var(--surface)", border: "1px solid var(--hairline)",
      borderRadius: 6, padding: "14px 16px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          className={isActive ? "smriti-dot-active" : undefined}
          style={{ width: 10, height: 10, borderRadius: 5, background: color, flexShrink: 0 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="serif" style={{ fontSize: 15, fontWeight: 600 }}>{label}</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
            {phase === "done" && progress
              ? progress.state === "complete"
                ? `Imported ${progress.total_fetched} conversation${progress.total_fetched === 1 ? "" : "s"} ✓`
                : `Imported ${progress.total_fetched} so far — partial`
              : phase === "failed"
              ? (progress?.message ?? "Import failed — click to retry")
              : isActive
              ? "Importing your history…"
              : "Pull in your past conversations"}
          </div>
        </div>
        <button
          onClick={start}
          disabled={!canStart}
          style={{
            background: canStart ? "var(--accent)" : "var(--surface-2)",
            color: canStart ? "#f6f0e3" : "var(--muted)",
            border: "none", borderRadius: 4, padding: "7px 14px",
            fontSize: 12, fontWeight: 600, cursor: canStart ? "pointer" : "default",
            whiteSpace: "nowrap", flexShrink: 0, fontFamily: "var(--sans)",
          }}
        >
          {phase === "starting"
            ? "Starting…"
            : isActive
            ? "Importing…"
            : phase === "done"
            ? "Re-import"
            : phase === "failed"
            ? "Retry"
            : "Import"}
        </button>
      </div>

      {isActive && progress && (
        <div style={{ marginTop: 10, fontSize: 11, color: "var(--muted)" }}>
          {progress.state === "discovering" && <div>Discovering conversations…</div>}
          {progress.state === "fetching" && (
            <div>{progress.total_fetched}{progress.total_known ? ` / ${progress.total_known}` : ""} fetched</div>
          )}
          {progress.state === "rate_limited" && <div style={{ color: "var(--accent)" }}>Rate limited — pausing…</div>}
          {pct !== null && (
            <div style={{ background: "var(--surface-2)", borderRadius: 3, height: 4, marginTop: 5, overflow: "hidden" }}>
              <div style={{ width: `${pct}%`, height: "100%", background: "var(--accent)", transition: "width 0.5s ease" }} />
            </div>
          )}
          {progress.latest_titles.length > 0 && (
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 2 }}>
              {progress.latest_titles.slice(-3).map((t, i) => (
                <div key={i} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontStyle: "italic" }}>
                  {t}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {notSignedIn && (
        <div style={{ marginTop: 8 }}>
          <a href={siteUrl} target="_blank" rel="noopener" style={{ fontSize: 11.5, color: "var(--accent)", fontWeight: 600, textDecoration: "none" }}>
            Open {siteLabel} to sign in ↗
          </a>
        </div>
      )}
    </div>
  );
}

type BuildProgress = { processed: number; total: number; created: number };

/**
 * In-onboarding "try it now" demo: type like you're starting an AI chat and
 * watch Smriti recall what it just learned. It's the recall half of the hero
 * loop, self-contained (uses the recall_memories RPC, no host site needed), so
 * the user sees the payoff work before leaving onboarding.
 */
function TryRecall() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<MemoryItem[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 3) { setHits(null); setLoading(false); return; }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await sendToHelper({ type: "recall_memories", query, limit: 4 });
        setHits((r.memories as MemoryItem[]) ?? []);
      } catch {
        setHits([]);
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [q]);

  const ready = q.trim().length >= 3;

  return (
    <div style={{ marginTop: 24 }}>
      <div className="smallcaps" style={{ marginBottom: 8 }}>Try it now</div>
      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Try recall"
        placeholder="Ask about yourself — e.g. “what am I working on?” or “what do I prefer?”"
        style={{
          width: "100%", boxSizing: "border-box",
          background: "var(--surface)", border: "1px solid var(--hairline)",
          borderRadius: 6, padding: "10px 12px", fontSize: 13.5,
          color: "var(--ink)", fontFamily: "var(--sans)", outline: "none",
        }}
      />

      {ready && hits && hits.length > 0 && (
        <div style={{
          marginTop: 12, background: "var(--surface)",
          border: "1px solid var(--hairline)", borderRadius: 6, padding: "12px 14px",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
            <span style={{ color: "var(--accent)" }}>✦</span>
            <span className="smallcaps" style={{ color: "var(--accent)" }}>Smriti remembers</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {hits.map((m) => (
              <div key={m.id} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <span className="mono" style={{
                  fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em",
                  color: kindColor(m.kind), padding: "1px 6px", borderRadius: 3, flexShrink: 0,
                  background: "color-mix(in srgb, " + kindColor(m.kind) + " 12%, transparent)",
                }}>{m.kind}</span>
                <span style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.45 }}>{m.text}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--muted)", fontStyle: "italic", lineHeight: 1.5 }}>
            This is what Smriti surfaces as you type in any AI chat — one click drops it into your prompt.
          </div>
        </div>
      )}

      {ready && !loading && hits && hits.length === 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--muted)", fontStyle: "italic", lineHeight: 1.5 }}>
          Nothing matched that yet — try a topic you've actually discussed with an AI, or keep chatting and Smriti will learn more.
        </div>
      )}
    </div>
  );
}

function OnboardingStep3({ onDone }: { onDone: () => void }) {
  const [building, setBuilding] = useState(false);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [progress, setProgress] = useState<BuildProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importActive, setImportActive] = useState(false);

  // Live progress streamed from the offscreen build loop (build_progress).
  useEffect(() => {
    const handler = (msg: unknown) => {
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as { kind?: string; processed?: number; total?: number; created?: number };
      if (m.kind !== "build_progress") return;
      setProgress({ processed: m.processed ?? 0, total: m.total ?? 0, created: m.created ?? 0 });
    };
    browser.runtime.onMessage.addListener(handler);
    return () => browser.runtime.onMessage.removeListener(handler);
  }, []);

  // Know whether a history import is still running, so a zero-result build
  // reads as "wait for the import" rather than a dead end.
  useEffect(() => {
    const ACTIVE = ["discovering", "fetching", "rate_limited"];
    browser.runtime.sendMessage({ kind: "get_backfill_progress" })
      .then((resp: unknown) => {
        const r = resp as { ok?: boolean; progress?: BackfillProgress | null } | undefined;
        const p = r?.ok ? r.progress : undefined;
        if (p) setImportActive(ACTIVE.includes(p.state));
      }).catch(() => {});
    const handler = (msg: unknown) => {
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as { kind?: string; progress?: BackfillProgress };
      if (m.kind !== "backfill_progress" || !m.progress) return;
      setImportActive(ACTIVE.includes(m.progress.state));
    };
    browser.runtime.onMessage.addListener(handler);
    return () => browser.runtime.onMessage.removeListener(handler);
  }, []);

  const buildNow = useCallback(async () => {
    setBuilding(true);
    setError(null);
    setProgress(null);
    setStats(null);
    try {
      const r = await sendToHelper({ type: "build_memory_now" });
      if (r.ok) setStats(r.stats as MemoryStats);
    } catch (e) {
      // Surface the failure (e.g. offscreen never became ready) instead of
      // silently leaving the button — the user gets a reason and a retry.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBuilding(false);
      setProgress(null);
    }
  }, []);

  const seeMyMemory = useCallback(() => {
    onDone();
    location.hash = "/memory";
  }, [onDone]);

  return (
    <div>
      <h1 className="serif" style={{ fontSize: 26, fontWeight: 600, lineHeight: 1.2, letterSpacing: "-0.01em", margin: "0 0 8px" }}>
        Build your memory.
      </h1>
      <p style={{ fontSize: 14, color: "var(--muted)", margin: "0 0 22px", fontStyle: "italic", maxWidth: 560 }}>
        Smriti scans everything it's captured so far and distills durable facts about you —
        your role, your stack, your preferences, what you're building.
      </p>

      {!stats && (
        <>
          <PrimaryButton onClick={buildNow} disabled={building}>
            {building ? "Building…" : error ? "Try again" : "Build my memory"}
          </PrimaryButton>

          {building && (
            <div style={{ marginTop: 14, maxWidth: 440 }}>
              <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                {progress && progress.total > 0
                  ? `Scanned ${Math.min(progress.processed, progress.total)} / ${progress.total} messages · learned ${progress.created} ${progress.created === 1 ? "fact" : "facts"} so far`
                  : "Scanning your conversations…"}
              </div>
              <div style={{ background: "var(--surface-2)", borderRadius: 3, height: 4, marginTop: 8, overflow: "hidden" }}>
                <div style={{
                  width: progress && progress.total > 0
                    ? `${Math.min(100, Math.round((Math.min(progress.processed, progress.total) / progress.total) * 100))}%`
                    : "8%",
                  height: "100%", background: "var(--accent)", transition: "width 0.4s ease",
                }} />
              </div>
            </div>
          )}

          {error && !building && (
            <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--accent)", maxWidth: 480, lineHeight: 1.5 }}>
              Couldn't build memory: {error}. Give the extension a moment to finish loading, then try again.
            </div>
          )}
        </>
      )}

      {stats && stats.total > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div className="serif" style={{ fontSize: 18, fontWeight: 600, marginBottom: 14 }}>
            <span style={{ color: "var(--accent)" }}>✦</span> Smriti learned <strong>{stats.total}</strong>{" "}
            {stats.total === 1 ? "thing" : "things"} about you
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {MEMORY_KINDS.filter((k) => k.id !== "all").map((k) => (
              <div key={k.id} style={{
                display: "flex", alignItems: "center", gap: 7,
                background: "var(--surface)", border: "1px solid var(--hairline)",
                borderRadius: 6, padding: "8px 12px", fontSize: 12, color: "var(--ink-2)",
              }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: kindColor(k.id) }} />
                {k.label}
                <span className="mono" style={{ color: "var(--muted)" }}>{stats.byKind[k.id as MemoryKind] ?? 0}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {stats && stats.total === 0 && (
        <>
          <div style={{
            background: "var(--surface)", border: "1px solid var(--hairline)",
            borderRadius: 6, padding: "14px 16px", marginBottom: 12,
            fontSize: 13.5, color: "var(--ink-2)", fontStyle: "italic",
          }}>
            {importActive
              ? "Your import is still running in the background — give it a moment, then build again."
              : "No history yet — import above, or just keep chatting and Smriti learns as you go."}
          </div>
          <PrimaryButton onClick={buildNow} disabled={building}>
            {building ? "Building…" : "Build again"}
          </PrimaryButton>
        </>
      )}

      {stats && stats.total > 0 && <TryRecall />}

      {stats && (
        <>
          {stats.total > 0 && (
            <div style={{ fontSize: 12.5, color: "var(--muted)", margin: "22px 0 0", lineHeight: 1.5 }}>
              Now see it live — open a chat and start typing; Smriti surfaces what it remembers,
              ready to inject into your prompt in one click.
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "12px 0" }}>
            {[
              { href: "https://claude.ai/new", label: "Open claude.ai", color: "var(--provider-claude)" },
              { href: "https://chatgpt.com/", label: "Open chatgpt.com", color: "var(--provider-chatgpt)" },
            ].map((s) => (
              <a key={s.href} href={s.href} target="_blank" rel="noopener" onClick={onDone} style={{
                display: "flex", alignItems: "center", gap: 12,
                padding: "12px 16px",
                background: "var(--surface)", border: "1px solid var(--hairline)",
                borderRadius: 6, textDecoration: "none", color: "var(--ink)",
              }}>
                <div style={{ width: 8, height: 8, borderRadius: 4, background: s.color, flexShrink: 0 }} />
                <span style={{ fontSize: 14, fontWeight: 500 }}>{s.label}</span>
                <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 12 }}>↗</span>
              </a>
            ))}
          </div>
          <PrimaryButton onClick={seeMyMemory}>See my memory →</PrimaryButton>
        </>
      )}
    </div>
  );
}

function PrimaryButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: disabled ? "var(--surface-2)" : "var(--accent)",
      color: disabled ? "var(--muted)" : "#f6f0e3",
      border: "none",
      borderRadius: 4,
      padding: "10px 18px",
      fontSize: 13.5,
      fontWeight: 600,
      letterSpacing: "0.01em",
      cursor: disabled ? "default" : "pointer",
      fontFamily: "var(--sans)",
    }}>{children}</button>
  );
}

function GhostButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      background: "transparent",
      color: "var(--ink-2)",
      border: "1px solid var(--hairline)",
      borderRadius: 4,
      padding: "10px 18px",
      fontSize: 13.5,
      fontWeight: 600,
      letterSpacing: "0.01em",
      cursor: "pointer",
      fontFamily: "var(--sans)",
    }}>{children}</button>
  );
}

// ─── Settings ────────────────────────────────────────────────────────────────
// Privacy controls. Critical for a privacy-positioned product — users need to
// see what's captured and be able to delete / export / wipe at any time.

function SettingsView({ totals, embed, nav }: {
  totals: { conversations: number; messages: number };
  embed: { total: number; embedded: number; pending: number } | null;
  nav: (r: Route) => void;
}) {
  const [captureOff, setCaptureOff] = useState<Record<string, boolean>>({});
  const [captureState, setCaptureState] = useState<Record<string, { last_seen_at: string | null; health: string }>>({});
  const [wipeConfirm, setWipeConfirm] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [helperVersion, setHelperVersion] = useState<string>("");

  // Read the real paused-hosts list from extension storage (the source of
  // truth that background.ts enforces against).
  useEffect(() => {
    browser.storage.local.get("smriti:paused-hosts").then((o) => {
      const list = o["smriti:paused-hosts"];
      if (Array.isArray(list)) {
        const next: Record<string, boolean> = {};
        list.forEach((h: string) => { next[h] = true; });
        setCaptureOff(next);
      }
    }).catch(() => {});
    // In the new architecture, no separate helper binary — version is the extension version.
    setHelperVersion(chrome.runtime.getManifest().version);

    // Load live capture state from the DB.
    sendToHelper({ type: "capture_state" })
      .then((r) => {
        const platforms = (r as { platforms?: Array<{ platform: string; last_seen_at: string | null; health: string }> }).platforms;
        if (Array.isArray(platforms)) {
          const next: Record<string, { last_seen_at: string | null; health: string }> = {};
          for (const p of platforms) next[p.platform] = { last_seen_at: p.last_seen_at, health: p.health };
          setCaptureState(next);
        }
      })
      .catch(() => {});
  }, []);

  const toggleCapture = (host: string) => {
    const next = { ...captureOff, [host]: !captureOff[host] };
    setCaptureOff(next);
    browser.runtime.sendMessage({ kind: "capture_toggle", host, off: next[host] }).catch(() => {});
  };

  const onExport = async () => {
    setExporting(true);
    try {
      const recents = await sendToHelper({ type: "list_recent_conversations", limit: 10000 });
      if (!recents.ok || recents.type !== "list_recent_conversations") return;
      const archive: Array<{ meta: unknown; messages: unknown }> = [];
      for (const c of recents.conversations) {
        const conv = await sendToHelper({ type: "get_conversation", conversation_id: c.id });
        if (conv.ok && conv.type === "get_conversation") {
          archive.push({ meta: conv.meta, messages: conv.messages });
        }
      }
      const memRes = await sendToHelper({ type: "list_memories", limit: 1000 });
      const memories = memRes.ok ? (memRes.memories as MemoryItem[] | undefined) ?? [] : [];

      const payload = {
        version: 2,
        exported_at: new Date().toISOString(),
        conversations: archive,
        memories,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `smriti-archive-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    setImporting(true);
    setImportMsg(null);
    try {
      let data: unknown;
      try {
        data = JSON.parse(await file.text());
      } catch {
        setImportMsg("That file isn't valid JSON.");
        return;
      }
      const obj = (data && typeof data === "object") ? data as Record<string, unknown> : {};
      const memories = Array.isArray(obj.memories) ? obj.memories as Array<Record<string, unknown>> : null;
      const conversations = Array.isArray(obj.conversations) ? obj.conversations : null;
      if (!memories && !conversations) {
        setImportMsg("Doesn't look like a Smriti export — no memories or conversations found.");
        return;
      }

      let imported = 0;
      for (const m of memories ?? []) {
        try {
          const r = await sendToHelper({
            type: "add_memory",
            text: m.text,
            kind: m.kind,
            source: m.source,
            platform: m.source_platform ?? null,
            conversation_id: m.source_conversation_id ?? null,
            message_id: m.source_message_id ?? null,
          });
          if (!r.ok) continue;
          imported++;
          const id = (r.memory as { id?: string } | null)?.id;
          if (m.pinned && id) {
            await sendToHelper({ type: "pin_memory", id, pinned: true }).catch(() => {});
          }
        } catch {
          // skip this memory, keep going
        }
      }
      setImportMsg(`Imported ${imported} ${imported === 1 ? "memory" : "memories"}.`);
    } finally {
      setImporting(false);
    }
  };

  const hosts: Array<{ id: string; label: string; platform: string }> = [
    { id: "claude.ai",         label: "Claude.ai",  platform: "claude"   },
    { id: "chatgpt.com",       label: "ChatGPT.com", platform: "chatgpt"  },
    { id: "gemini.google.com", label: "Gemini",      platform: "gemini"   },
  ];

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "32px 40px 80px", maxWidth: 820, margin: "0 auto", width: "100%" }} className="scroll">
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 18 }}>
        <a href="#/" style={{ fontSize: 12, color: "var(--muted)", textDecoration: "none" }}>← Back</a>
      </div>
      <h1 className="serif" style={{ fontSize: 26, fontWeight: 600, margin: "0 0 4px" }}>Settings &amp; privacy</h1>
      <p style={{ color: "var(--muted)", fontSize: 13, margin: "0 0 28px", fontStyle: "italic" }}>
        Everything Smriti captures is stored locally on your machine. You're in full control.
      </p>

      {/* Capture toggles */}
      <Section title="Capture">
        <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 10 }}>
          Toggle capture per site. Disabled sites won't have messages recorded.
        </div>
        {hosts.map((h) => {
          const st = captureState[h.platform];
          const lastSeen = st?.last_seen_at ? relativeTime(st.last_seen_at) : null;
          return (
            <SettingRow
              key={h.id}
              label={
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {h.label}
                  {lastSeen && !captureOff[h.id] && (
                    <span style={{
                      fontSize: 10, fontWeight: 600,
                      color: "var(--provider-chatgpt, #19c37d)",
                      background: "rgba(25,195,125,0.1)",
                      padding: "1px 6px", borderRadius: 10,
                    }}>● {lastSeen}</span>
                  )}
                </span>
              }
              right={
                <Toggle on={!captureOff[h.id]} onChange={() => toggleCapture(h.id)} />
              }
            />
          );
        })}
      </Section>

      {/* Local data */}
      <Section title="Local data">
        <SettingRow
          label="Archive size"
          right={<span className="mono" style={{ color: "var(--ink-2)" }}>{totals.conversations} conversations · {totals.messages} messages</span>}
        />
        <SettingRow
          label="Semantic index"
          right={
            <span className="mono" style={{ color: "var(--ink-2)" }}>
              {embed ? `${embed.embedded} / ${embed.total}${embed.pending === 0 ? " ✓" : " (indexing)"}` : "—"}
            </span>
          }
        />
        <SettingRow
          label="Extension version"
          right={<span className="mono" style={{ color: "var(--ink-2)" }}>{helperVersion || "—"}</span>}
        />
        <SettingRow
          label="Found a broken site?"
          right={
            <a href={reportIssueUrl("options")} target="_blank" rel="noopener"
              style={{ fontSize: 12.5, color: "var(--accent)", textDecoration: "none" }}>
              Report an issue ↗
            </a>
          }
        />
      </Section>

      {/* Sync */}
      <SyncSection />

      {/* Vault */}
      <VaultSection />

      {/* Export */}
      <Section title="Export">
        <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 10 }}>
          Download every conversation and memory Smriti has captured as a single JSON file. Use it
          for backup, to migrate to another tool, or to restore your memory later via Import.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={onExport} disabled={exporting} style={{
            background: "var(--surface)",
            border: "1px solid var(--hairline-strong)",
            borderRadius: 4,
            padding: "8px 14px",
            fontSize: 13,
            fontFamily: "var(--sans)",
            fontWeight: 500,
            color: "var(--ink)",
            cursor: exporting ? "default" : "pointer",
          }}>{exporting ? "Exporting…" : "Export archive as JSON"}</button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            onChange={onImportFile}
            style={{ display: "none" }}
          />
          <button onClick={() => fileInputRef.current?.click()} disabled={importing} style={{
            background: "var(--surface)",
            border: "1px solid var(--hairline-strong)",
            borderRadius: 4,
            padding: "8px 14px",
            fontSize: 13,
            fontFamily: "var(--sans)",
            fontWeight: 500,
            color: "var(--ink)",
            cursor: importing ? "default" : "pointer",
          }}>{importing ? "Importing…" : "Import from JSON"}</button>
        </div>
        {importMsg && (
          <div style={{ marginTop: 10, fontSize: 12, color: "var(--ink-2)", fontStyle: "italic" }}>{importMsg}</div>
        )}
      </Section>

      {/* Wipe */}
      <Section title="Danger zone" danger>
        <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 10 }}>
          Wipe deletes every captured message and conversation from the local database. The action is permanent.
        </div>
        {!wipeConfirm ? (
          <button onClick={() => setWipeConfirm(true)} style={{
            background: "transparent",
            border: "1px solid var(--accent)",
            color: "var(--accent)",
            borderRadius: 4,
            padding: "8px 14px",
            fontSize: 13,
            fontFamily: "var(--sans)",
            fontWeight: 500,
            cursor: "pointer",
          }}>Wipe local archive</button>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => {
              sendToHelper({ type: "wipe_archive" }).catch(() => {});
              setWipeConfirm(false);
              setTimeout(() => nav({ view: "home" }), 200);
            }} style={{
              background: "var(--accent)", color: "#f6f0e3",
              border: "none", borderRadius: 4, padding: "8px 14px",
              fontSize: 13, fontWeight: 600, cursor: "pointer",
            }}>Yes — wipe everything</button>
            <button onClick={() => setWipeConfirm(false)} style={{
              background: "transparent", border: "1px solid var(--hairline-strong)",
              color: "var(--ink-2)", borderRadius: 4, padding: "8px 14px",
              fontSize: 13, cursor: "pointer",
            }}>Cancel</button>
          </div>
        )}
      </Section>

      <p style={{ marginTop: 36, fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
        Smriti stores everything in <code style={{ background: "var(--chip-bg)", padding: "1px 4px", borderRadius: 2 }}>%APPDATA%\Smriti\smriti.db</code>{" "}
        (Windows) or <code style={{ background: "var(--chip-bg)", padding: "1px 4px", borderRadius: 2 }}>~/Library/Application Support/Smriti/smriti.db</code> (macOS).
        Nothing is sent over the network except the requests Claude.ai / ChatGPT / Gemini already
        make from your browser — unless you turn on Sync, which uploads only end-to-end-encrypted
        memory blobs that the relay cannot read.
      </p>
    </div>
  );
}

// ─── SyncSection ─────────────────────────────────────────────────────────────
/**
 * Settings panel for optional end-to-end-encrypted memory sync. The recovery
 * code is the only secret and never leaves the device unencrypted; the relay
 * sees opaque blobs. Wires the sync_* offscreen RPCs to setup/join/sync/disable.
 */
function SyncSection() {
  const [status, setStatus] = useState<{ enabled: boolean; syncId: string | null; lastSyncedAt: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [newCode, setNewCode] = useState<string | null>(null);
  const [showJoin, setShowJoin] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [copied, setCopied] = useState(false);

  /** Reload current sync status from the offscreen engine into state. */
  const refresh = () =>
    sendToHelper({ type: "sync_status" })
      .then((r) => setStatus({
        enabled: !!r.enabled,
        syncId: (r.syncId as string) ?? null,
        lastSyncedAt: (r.lastSyncedAt as string) ?? null,
      }))
      .catch(() => {});

  useEffect(() => { refresh(); }, []);

  /** Extract a display message from a thrown value. */
  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
  /** One-line summary of a sync result's insert/update/delete tallies. */
  const summary = (r: AnyResp) => {
    const ins = (r.inserted as number) ?? 0, upd = (r.updated as number) ?? 0, del = (r.deleted as number) ?? 0;
    return ins + upd + del === 0 ? "Already up to date." : `Synced — ${ins} added, ${upd} updated, ${del} removed.`;
  };

  /** Create a new sync group and reveal the generated recovery code. */
  const onSetup = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await sendToHelper({ type: "sync_setup" });
      if (r.recoveryCode) setNewCode(r.recoveryCode as string);
      await sendToHelper({ type: "sync_now" }).catch(() => {}); // first push; relay may not exist yet
      await refresh();
    } catch (e) { setMsg(errText(e)); } finally { setBusy(false); }
  };

  /** Join an existing sync group with a pasted recovery code, then sync. */
  const onJoin = async () => {
    setBusy(true); setMsg(null);
    try {
      await sendToHelper({ type: "sync_join", recovery_code: joinCode });
      setJoinCode(""); setShowJoin(false);
      // Join already succeeded — don't let a failed initial sync (e.g. the
      // relay isn't deployed yet) flip the UI back to a failed/disabled state.
      try {
        const r = await sendToHelper({ type: "sync_now" });
        setMsg(summary(r));
      } catch (e) {
        setMsg(`Joined. Initial sync failed: ${errText(e)}`);
      }
      await refresh();
    } catch (e) { setMsg(errText(e)); } finally { setBusy(false); }
  };

  /** Run a sync round now and show the result. */
  const onSyncNow = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await sendToHelper({ type: "sync_now" });
      setMsg(summary(r));
      await refresh();
    } catch (e) { setMsg(errText(e)); } finally { setBusy(false); }
  };

  /** Turn sync off on this device (local-only; the relay is untouched). */
  const onDisable = async () => {
    setBusy(true); setMsg(null);
    try {
      await sendToHelper({ type: "sync_disable" });
      setNewCode(null);
      await refresh();
    } catch (e) { setMsg(errText(e)); } finally { setBusy(false); }
  };

  /** Copy the freshly generated recovery code to the clipboard. */
  const copyCode = () => {
    if (!newCode) return;
    navigator.clipboard.writeText(newCode)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
      .catch(() => {});
  };

  /** Shared button style; primary renders an accent fill. */
  const btn = (primary?: boolean): React.CSSProperties => ({
    background: primary ? "var(--accent)" : "var(--surface)",
    border: primary ? "none" : "1px solid var(--hairline-strong)",
    borderRadius: 4, padding: "8px 14px", fontSize: 13,
    fontFamily: "var(--sans)", fontWeight: primary ? 600 : 500,
    color: primary ? "#f6f0e3" : "var(--ink)",
    cursor: busy ? "default" : "pointer",
  });

  return (
    <Section title="Sync">
      <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 10 }}>
        Sync your memories across devices, end-to-end encrypted. Smriti's relay only ever sees an
        opaque encrypted blob — never your memories, your recovery code, or the key.
      </div>

      {newCode && (
        <div style={{
          border: "1px solid var(--accent)", borderRadius: 6, padding: "12px 14px",
          marginBottom: 12, background: "var(--chip-bg)",
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: "var(--accent)" }}>
            Save your recovery code
          </div>
          <code className="mono" style={{
            display: "block", fontSize: 14, letterSpacing: 0.5, wordBreak: "break-all",
            background: "var(--surface)", border: "1px solid var(--hairline)",
            borderRadius: 4, padding: "8px 10px", marginBottom: 8,
          }}>{newCode}</code>
          <div style={{ fontSize: 11.5, color: "var(--ink-2)", lineHeight: 1.5, marginBottom: 10 }}>
            This is the <strong>only</strong> way to access your synced memories on another device.
            Store it somewhere safe — Smriti cannot recover it for you.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={copyCode} style={btn()}>{copied ? "Copied ✓" : "Copy code"}</button>
            <button onClick={() => setNewCode(null)} style={btn(true)}>I&apos;ve saved it</button>
          </div>
        </div>
      )}

      {status?.enabled ? (
        <>
          <SettingRow
            label="Status"
            right={
              <span className="mono" style={{ color: "var(--ink-2)", fontSize: 12 }}>
                {status.lastSyncedAt ? `Enabled · synced ${relativeTime(status.lastSyncedAt)}` : "Enabled · not yet synced"}
              </span>
            }
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            <button onClick={onSyncNow} disabled={busy} style={btn(true)}>{busy ? "Syncing…" : "Sync now"}</button>
            <button onClick={onDisable} disabled={busy} style={btn()}>Disable sync</button>
          </div>
        </>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={onSetup} disabled={busy} style={btn(true)}>{busy ? "Working…" : "Set up sync"}</button>
          <button onClick={() => setShowJoin((v) => !v)} disabled={busy} style={btn()}>Join with a recovery code</button>
        </div>
      )}

      {showJoin && !status?.enabled && (
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <input
            aria-label="Recovery code"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            placeholder="xxxx-xxxx-xxxx-xxxx-…"
            spellCheck={false}
            className="mono"
            style={{
              flex: 1, minWidth: 220, fontSize: 13, padding: "8px 10px",
              border: "1px solid var(--hairline-strong)", borderRadius: 4,
              background: "var(--surface)", color: "var(--ink)",
            }}
          />
          <button onClick={onJoin} disabled={busy || joinCode.trim().length === 0} style={btn(true)}>Join</button>
        </div>
      )}

      {msg && (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--ink-2)", fontStyle: "italic" }}>{msg}</div>
      )}
    </Section>
  );
}

// ─── VaultSection ─────────────────────────────────────────────────────────────
interface VaultStatus {
  enabled: boolean;
  connected: boolean;
  lastSyncAt: string | null;
  totalSynced: number;
  pendingCount: number;
  errorCount: number;
}

function VaultStatusCard({ status }: { status: VaultStatus }) {
  const lastSync = status.lastSyncAt
    ? relativeTime(status.lastSyncAt)
    : "never";

  return (
    <div style={{
      padding: "12px 16px",
      background: "var(--surface)",
      border: "1px solid var(--hairline)",
      borderRadius: 6,
      display: "flex",
      flexDirection: "column",
      gap: 6,
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        fontSize: 13, fontWeight: 500,
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: "50%",
          background: status.connected
            ? "var(--provider-chatgpt)"  // green
            : "var(--accent)",           // red
        }} />
        {status.connected
          ? "Connected to Google Drive"
          : "Drive disconnected — click Sync Now to reconnect"}
      </div>

      <div className="mono" style={{
        fontSize: 11, color: "var(--muted)",
        display: "flex", gap: 16,
      }}>
        <span>Last sync: {lastSync}</span>
        <span>{status.totalSynced} synced</span>
        {status.pendingCount > 0 && (
          <span style={{ color: "var(--ink-2)" }}>
            {status.pendingCount} pending
          </span>
        )}
        {status.errorCount > 0 && (
          <span style={{ color: "var(--accent)" }}>
            {status.errorCount} errors
          </span>
        )}
      </div>
    </div>
  );
}

function VaultSection() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch status on mount and after actions
  const refreshStatus = useCallback(async () => {
    try {
      const r = await sendToHelper({ type: "vault_status" });
      if (r && typeof r === "object" && "enabled" in r) {
        setStatus(r as unknown as VaultStatus);
      }
    } catch { /* quiet */ }
  }, []);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  // Poll status every 30s while enabled (to show live sync progress)
  useEffect(() => {
    if (!status?.enabled) return;
    const interval = setInterval(refreshStatus, 30_000);
    return () => clearInterval(interval);
  }, [status?.enabled, refreshStatus]);

  const handleEnable = async () => {
    setLoading(true);
    setError(null);
    try {
      await sendToHelper({ type: "vault_enable" });
      await refreshStatus();
    } catch (e) {
      setError(String(e));
    }
    setLoading(false);
  };

  const handleDisable = async () => {
    if (!confirm(
      "Disable vault export? Files already on Drive will not be deleted."
    )) return;
    setLoading(true);
    try {
      await sendToHelper({ type: "vault_disable" });
      await refreshStatus();
    } catch (e) {
      setError(String(e));
    }
    setLoading(false);
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    setError(null);
    try {
      await sendToHelper({ type: "vault_sync_now" });
      await refreshStatus();
    } catch (e) {
      setError(String(e));
    }
    setSyncing(false);
  };

  /** Shared button style; primary renders an accent fill. */
  const btn = (primary?: boolean, disabled?: boolean): React.CSSProperties => ({
    background: primary ? (disabled ? "var(--surface-2)" : "var(--accent)") : "var(--surface)",
    border: primary ? "none" : "1px solid var(--hairline-strong)",
    borderRadius: 4, padding: "8px 14px", fontSize: 13,
    fontFamily: "var(--sans)", fontWeight: primary ? 600 : 500,
    color: primary ? (disabled ? "var(--muted)" : "#f6f0e3") : "var(--ink)",
    cursor: disabled ? "default" : "pointer",
  });

  if (!status && loading) return null; // loading initial

  return (
    <Section title="Vault — Export to Google Drive">
      {status?.enabled ? (
        // ── Enabled state ──
        <>
          <VaultStatusCard status={status} />

          <p style={{ fontSize: 13, color: "var(--ink-2)", margin: "12px 0", lineHeight: 1.5 }}>
            Your conversations are exported as markdown files to a
            "smriti-vault" folder on your Google Drive.
            The original data stays local — this is a copy.
          </p>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            <button onClick={handleSyncNow} disabled={syncing} style={btn(true, syncing)}>
              {syncing ? "Syncing…" : "Sync Now"}
            </button>
            <button onClick={handleDisable} disabled={loading} style={btn(false, loading)}>
              Disable Vault
            </button>
          </div>
        </>
      ) : (
        // ── Disabled state ──
        <>
          <p style={{ fontSize: 13, color: "var(--ink-2)", margin: "0 0 12px", lineHeight: 1.5 }}>
            Export your conversations as Open Knowledge Format (OKF)
            markdown files to Google Drive. Compatible with Obsidian,
            Logseq, and any markdown tool.
          </p>
          <p style={{
            fontSize: 12, color: "var(--muted)",
            margin: "0 0 16px",
          }}>
            Only files created by Smriti are accessible.
            Your other Drive files are never touched.
          </p>

          <button onClick={handleEnable} disabled={loading} style={btn(true, loading)}>
            {loading ? "Connecting…" : "Enable Vault Export"}
          </button>
        </>
      )}

      {error && (
        <div style={{
          marginTop: 12, padding: "8px 12px",
          background: "var(--surface-2)",
          borderLeft: "3px solid var(--accent)",
          fontSize: 12, color: "var(--accent)",
        }}>
          {error}
        </div>
      )}
    </Section>
  );
}

function Section({ title, danger, children }: { title: string; danger?: boolean; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 className="smallcaps" style={{
        color: danger ? "var(--accent)" : "var(--muted)",
        margin: "0 0 12px",
        fontSize: 11,
      }}>{title}</h2>
      <div style={{
        background: "var(--surface)",
        border: `1px solid var(--hairline)`,
        borderRadius: 6,
        padding: "12px 16px",
      }}>{children}</div>
    </section>
  );
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function SettingRow({ label, right }: { label: React.ReactNode; right: React.ReactNode }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "8px 0",
      borderBottom: "1px solid var(--hairline)",
      fontSize: 13.5,
    }}>
      <span>{label}</span>
      {right}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange} aria-pressed={on} style={{
      width: 36, height: 20, borderRadius: 10,
      background: on ? "var(--accent)" : "var(--hairline-strong)",
      border: "none", padding: 0, position: "relative", cursor: "pointer",
      transition: "background 0.15s",
    }}>
      <span style={{
        position: "absolute", top: 2, left: on ? 18 : 2,
        width: 16, height: 16, borderRadius: "50%",
        background: "#fff", transition: "left 0.15s",
        boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
      }} />
    </button>
  );
}

// ─── MemoryView ──────────────────────────────────────────────────────────────
// "Your memory" — the durable facts Smriti has distilled from your chats, that
// now travel with you across every AI tool. Fully user-owned: edit, pin, delete.

const MEMORY_KINDS: Array<{ id: MemoryKind | "all"; label: string }> = [
  { id: "all",        label: "All" },
  { id: "identity",   label: "Identity" },
  { id: "preference", label: "Preferences" },
  { id: "project",    label: "Projects" },
  { id: "decision",   label: "Decisions" },
  { id: "fact",       label: "Facts" },
];

function kindColor(kind: string): string {
  switch (kind) {
    case "identity":   return "var(--accent)";
    case "preference": return "var(--provider-chatgpt)";
    case "project":    return "var(--provider-gemini)";
    case "decision":   return "#9a6b1f";
    default:           return "var(--provider-code)";
  }
}

// Surfaces the newest auto-extracted memories so users can quickly review
// (and pin/delete) what auto-extraction just learned, without digging
// through the full list. Dismiss hides it for the rest of the session.
function RecentlyLearnedStrip({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    sendToHelper({ type: "list_memories", sort: "recent", limit: 30 })
      .then((r) => {
        if (!r.ok) return;
        const recent = ((r.memories as MemoryItem[]) ?? [])
          .filter((m) => m.source === "auto")
          .slice(0, 15);
        setItems(recent);
      })
      .catch(() => {});
  }, [refreshKey]);

  const onPin = useCallback((m: MemoryItem) => {
    sendToHelper({ type: "pin_memory", id: m.id, pinned: !m.pinned }).then(() => {
      setItems((prev) => prev.map((x) => x.id === m.id ? { ...x, pinned: !x.pinned } : x));
      onChanged();
    });
  }, [onChanged]);

  const onDelete = useCallback((id: string) => {
    sendToHelper({ type: "delete_memory", id }).then(() => {
      setItems((prev) => prev.filter((x) => x.id !== id));
      onChanged();
    });
  }, [onChanged]);

  if (dismissed || items.length === 0) return null;

  return (
    <div style={{
      background: "var(--surface)", border: "1px solid var(--hairline)",
      borderRadius: 8, padding: "12px 16px", marginBottom: 18,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "var(--accent)" }}>✦</span>
        <span className="smallcaps" style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: "0.08em", color: "var(--ink-2)" }}>
          Recently learned
        </span>
        <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>{items.length}</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setCollapsed((c) => !c)} style={{
          background: "transparent", border: "none", color: "var(--muted)",
          fontSize: 11, cursor: "pointer", fontFamily: "var(--sans)",
        }}>{collapsed ? "Show" : "Hide"}</button>
        <button onClick={() => setDismissed(true)} title="Dismiss" style={{
          background: "transparent", border: "none", color: "var(--muted)",
          fontSize: 14, cursor: "pointer", lineHeight: 1, fontFamily: "var(--sans)",
        }}>×</button>
      </div>
      {!collapsed && (
        <div style={{ display: "flex", flexDirection: "column", marginTop: 8 }}>
          {items.map((m, i) => (
            <div key={m.id} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "7px 0",
              borderTop: i === 0 ? "none" : "1px solid var(--hairline)",
            }}>
              <span style={{
                fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.09em",
                color: kindColor(m.kind), padding: "1px 6px", borderRadius: 3, flexShrink: 0,
                background: "color-mix(in srgb, " + kindColor(m.kind) + " 12%, transparent)",
              }}>{m.kind}</span>
              <div className="serif" style={{
                fontSize: 13, color: "var(--ink)", flex: 1,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>{m.text}</div>
              <button onClick={() => onPin(m)} title={m.pinned ? "Unpin" : "Pin — always recalled"} style={{
                background: "transparent", border: "none", cursor: "pointer", fontSize: 13,
                opacity: m.pinned ? 1 : 0.35, flexShrink: 0,
              }}>📌</button>
              <button onClick={() => onDelete(m.id)} title="Delete" style={{
                background: "transparent", border: "none", cursor: "pointer", color: "var(--muted)",
                fontSize: 14, flexShrink: 0,
              }}>×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MemoryView({ nav }: { nav: (r: Route) => void }) {
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [kind, setKind] = useState<MemoryKind | "all">("all");
  const [q, setQ] = useState("");
  const [building, setBuilding] = useState(false);
  const [adding, setAdding] = useState("");

  const load = useCallback(() => {
    sendToHelper({ type: "list_memories", kind, query: q, limit: 500 })
      .then((r) => { if (r.ok) setMemories((r.memories as MemoryItem[]) ?? []); })
      .catch(() => {});
    sendToHelper({ type: "memory_stats" })
      .then((r) => { if (r.ok) setStats(r as unknown as MemoryStats); })
      .catch(() => {});
  }, [kind, q]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 6_000); return () => clearInterval(t); }, [load]);

  const buildNow = useCallback(async () => {
    setBuilding(true);
    try { await sendToHelper({ type: "build_memory_now" }); load(); }
    finally { setBuilding(false); }
  }, [load]);

  const onAdd = useCallback(async () => {
    const text = adding.trim();
    if (text.length < 4) return;
    await sendToHelper({ type: "add_memory", text, kind: kind === "all" ? "fact" : kind });
    setAdding("");
    load();
  }, [adding, kind, load]);

  const total = stats?.total ?? 0;
  const pending = stats?.pending_embeddings ?? 0;

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "32px 40px 80px", maxWidth: 860, margin: "0 auto", width: "100%" }} className="scroll">
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 18 }}>
        <a href="#/" style={{ fontSize: 12, color: "var(--muted)", textDecoration: "none" }}>← Back</a>
      </div>

      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 className="serif" style={{ fontSize: 26, fontWeight: 600, margin: "0 0 4px", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ color: "var(--accent)" }}>✦</span> Your memory
          </h1>
          <p style={{ color: "var(--muted)", fontSize: 13, margin: 0, fontStyle: "italic", maxWidth: 540 }}>
            The durable facts Smriti distilled from your own chats. These travel with you into Claude,
            ChatGPT, and Gemini — so you never have to re-explain yourself.
          </p>
        </div>
        <button
          onClick={buildNow}
          disabled={building}
          style={{
            background: "var(--accent)", color: "#f6f0e3", border: "none",
            borderRadius: 5, padding: "9px 16px", fontSize: 13, fontWeight: 600,
            fontFamily: "var(--sans)", cursor: building ? "default" : "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {building ? "Building…" : total === 0 ? "Build my memory" : "Refresh from history"}
        </button>
      </div>

      {/* Stat strip */}
      <div style={{ display: "flex", gap: 10, margin: "22px 0 20px", flexWrap: "wrap" }}>
        <div style={{
          display: "flex", alignItems: "baseline", gap: 8,
          background: "var(--surface)", border: "1px solid var(--hairline)",
          borderRadius: 6, padding: "10px 16px",
        }}>
          <span className="serif" style={{ fontSize: 24, fontWeight: 600, color: "var(--ink)" }}>{total}</span>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>{total === 1 ? "memory" : "memories"}</span>
        </div>
        {MEMORY_KINDS.filter((k) => k.id !== "all").map((k) => (
          <div key={k.id} style={{
            display: "flex", alignItems: "center", gap: 7,
            background: "var(--surface)", border: "1px solid var(--hairline)",
            borderRadius: 6, padding: "10px 14px", fontSize: 12, color: "var(--ink-2)",
          }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: kindColor(k.id) }} />
            {k.label}
            <span className="mono" style={{ color: "var(--muted)" }}>{stats?.byKind?.[k.id as MemoryKind] ?? 0}</span>
          </div>
        ))}
        {pending > 0 && (
          <div style={{ display: "flex", alignItems: "center", fontSize: 11.5, color: "var(--muted)", fontStyle: "italic", padding: "10px 4px" }}>
            indexing {pending}…
          </div>
        )}
      </div>

      {/* Add memory */}
      <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
        <input
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void onAdd(); }}
          placeholder="Teach Smriti something to remember about you…"
          style={{
            flex: 1, border: "1px solid var(--hairline-strong)", borderRadius: 5,
            padding: "9px 12px", fontSize: 13, fontFamily: "var(--sans)",
            background: "var(--surface)", color: "var(--ink)", outline: "none",
          }}
        />
        <button onClick={() => void onAdd()} disabled={adding.trim().length < 4} style={{
          background: "var(--surface)", border: "1px solid var(--hairline-strong)",
          borderRadius: 5, padding: "9px 16px", fontSize: 13, fontWeight: 500,
          fontFamily: "var(--sans)", color: "var(--ink)",
          cursor: adding.trim().length < 4 ? "default" : "pointer",
        }}>Remember</button>
      </div>

      {/* Filters + search */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {MEMORY_KINDS.map((k) => {
          const active = kind === k.id;
          return (
            <button key={k.id} onClick={() => setKind(k.id)} style={{
              background: active ? "var(--accent)" : "transparent",
              color: active ? "#f6f0e3" : "var(--ink-2)",
              border: `1px solid ${active ? "var(--accent)" : "var(--hairline-strong)"}`,
              borderRadius: 14, padding: "4px 12px", fontSize: 12,
              fontFamily: "var(--sans)", cursor: "pointer",
            }}>{k.label}</button>
          );
        })}
        <div style={{ flex: 1 }} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter…"
          style={{
            width: 180, border: "1px solid var(--hairline-strong)", borderRadius: 14,
            padding: "5px 12px", fontSize: 12, fontFamily: "var(--sans)",
            background: "var(--surface)", color: "var(--ink)", outline: "none",
          }}
        />
      </div>

      <RecentlyLearnedStrip refreshKey={total} onChanged={load} />

      {/* Memory list */}
      {memories.length === 0 ? (
        <div style={{
          textAlign: "center", padding: "60px 20px", color: "var(--muted)",
          border: "1px dashed var(--hairline-strong)", borderRadius: 8,
        }}>
          <div className="serif" style={{ fontSize: 17, color: "var(--ink-2)", marginBottom: 6 }}>
            {total === 0 ? "No memories yet" : "Nothing matches that filter"}
          </div>
          <div style={{ fontSize: 13, fontStyle: "italic", maxWidth: 420, margin: "0 auto" }}>
            {total === 0
              ? "Click “Build my memory” to distill durable facts from the conversations you've already had — or just keep chatting and Smriti learns as you go."
              : "Try a different category or clear the filter."}
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {memories.map((m) => (
            <MemoryCard key={m.id} m={m} nav={nav} onChanged={load} />
          ))}
        </div>
      )}
    </div>
  );
}

function MemoryCard({ m, nav, onChanged }: { m: MemoryItem; nav: (r: Route) => void; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.text);

  const save = async () => {
    const text = draft.trim();
    if (text.length >= 4 && text !== m.text) {
      await sendToHelper({ type: "edit_memory", id: m.id, text });
      onChanged();
    }
    setEditing(false);
  };

  return (
    <div style={{
      background: "var(--surface)", border: "1px solid var(--hairline)",
      borderLeft: `3px solid ${kindColor(m.kind)}`, borderRadius: 6,
      padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{
          fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.09em",
          color: kindColor(m.kind), padding: "1px 6px", borderRadius: 3,
          background: "color-mix(in srgb, " + kindColor(m.kind) + " 12%, transparent)",
        }}>{m.kind}</span>
        {m.source === "manual" && (
          <span className="mono" style={{ fontSize: 9.5, color: "var(--muted-2)" }}>added by you</span>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={() => sendToHelper({ type: "pin_memory", id: m.id, pinned: !m.pinned }).then(onChanged)}
          title={m.pinned ? "Unpin" : "Pin — always recalled"}
          style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 13, opacity: m.pinned ? 1 : 0.35 }}>📌</button>
        <button onClick={() => { setEditing(true); setDraft(m.text); }}
          title="Edit" style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: 12 }}>✎</button>
        <button onClick={() => sendToHelper({ type: "delete_memory", id: m.id }).then(onChanged)}
          title="Delete" style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: 14 }}>×</button>
      </div>

      {editing ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <textarea
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save(); if (e.key === "Escape") setEditing(false); }}
            rows={2}
            style={{
              width: "100%", border: "1px solid var(--hairline-strong)", borderRadius: 4,
              padding: "8px 10px", fontSize: 13.5, fontFamily: "var(--serif)",
              background: "var(--bg)", color: "var(--ink)", resize: "vertical", outline: "none",
            }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => void save()} style={{ background: "var(--accent)", color: "#f6f0e3", border: "none", borderRadius: 4, padding: "5px 12px", fontSize: 12, cursor: "pointer" }}>Save</button>
            <button onClick={() => setEditing(false)} style={{ background: "transparent", color: "var(--muted)", border: "1px solid var(--hairline-strong)", borderRadius: 4, padding: "5px 12px", fontSize: 12, cursor: "pointer" }}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="serif" style={{ fontSize: 14.5, lineHeight: 1.45, color: "var(--ink)" }}>{m.text}</div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10.5, color: "var(--muted)" }}>
        {m.source_platform && <ProviderChip id={m.source_platform} dim />}
        <span>·</span>
        <span className="mono">{relativeTime(m.created_at)}</span>
        {m.use_count > 0 && (<><span>·</span><span className="mono">injected {m.use_count}×</span></>)}
        {m.source_conversation_id && (
          <>
            <div style={{ flex: 1 }} />
            <button
              onClick={() => nav({ view: "conversation", conversationId: m.source_conversation_id!, msgId: m.source_message_id ?? undefined })}
              style={{ background: "transparent", border: "none", color: "var(--accent)", fontSize: 11, cursor: "pointer", fontFamily: "var(--sans)" }}
            >view source →</button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────

function App() {
  const [route, nav] = useRoute();
  const [theme, cycleTheme] = useTheme();
  const helperState = useHelperState();

  // First-run flag — once user finishes onboarding we remember not to show it.
  const [hasOnboarded, setHasOnboarded] = useState<boolean>(
    () => localStorage.getItem(ONBOARDED_KEY) === "1",
  );
  const finishOnboarding = useCallback(() => {
    localStorage.setItem(ONBOARDED_KEY, "1");
    setHasOnboarded(true);
    nav({ view: "home" });
  }, [nav]);

  // Force onboarding when:
  //   - user explicitly visits #/welcome
  //   - they've never finished onboarding
  // (No longer gated on helper state — everything runs inside the extension.)
  const needOnboarding =
    route.view === "welcome" ||
    !hasOnboarded;

  const [recents, setRecents] = useState<RecentConversation[]>([]);
  const [totals, setTotals] = useState({ conversations: 0, messages: 0 });
  const [embed, setEmbed] = useState<{ total: number; embedded: number; pending: number } | null>(null);
  const [memoryCount, setMemoryCount] = useState(0);

  // Global search state
  const [query, setQuery] = useState<string>(route.q ?? "");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchHit[]>([]);
  const lastQuery = useRef("");

  // Right-rail data shared with ConversationView
  const [convData, setConvData] = useState<{ meta: ConversationMeta | null; messages: ConversationMessageRow[]; chapterMap: ChapterMap } | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [pulseIdx] = useState<number | null>(null); // pulse comes from inside ConversationView; right rail just animates with msg refs
  const [filterMatches] = useState<Set<number> | null>(null); // not piped through yet; can extend later
  const jumpToRef = useRef<((idx: number, withPulse?: boolean) => void) | null>(null);

  const onConvDataLoaded = useCallback((data: { meta: ConversationMeta | null; messages: ConversationMessageRow[]; chapterMap: ChapterMap }) => {
    setConvData(data);
  }, []);
  const registerJumpTo = useCallback((jump: (idx: number, withPulse?: boolean) => void) => {
    jumpToRef.current = jump;
  }, []);
  const registerActive = useCallback((idx: number) => {
    setActiveIdx(idx);
  }, []);

  // Load recents + totals.
  useEffect(() => {
    const load = () => {
      sendToHelper({ type: "list_recent_conversations", limit: 30 })
        .then((r) => {
          if (r.ok && r.type === "list_recent_conversations") setRecents(r.conversations);
        })
        .catch(() => {});
      sendToHelper({ type: "stats" })
        .then((r) => {
          if (r.ok && r.type === "stats") setTotals({ conversations: r.conversations, messages: r.messages });
        })
        .catch(() => {});
      sendToHelper({ type: "embed_status" })
        .then((r) => {
          if (r.ok && r.type === "embed_status") {
            setEmbed({ total: r.total, embedded: r.embedded, pending: r.pending });
          }
        })
        .catch(() => {});
      sendToHelper({ type: "memory_stats" })
        .then((r) => { if (r.ok) setMemoryCount(Number((r as { total?: number }).total ?? 0)); })
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 8_000);
    return () => clearInterval(t);
  }, []);

  // Debounced search.
  useEffect(() => {
    const q = query.trim();
    lastQuery.current = q;
    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      sendToHelper({ type: "search", query: q, limit: 20 })
        .then((r) => {
          if (r.ok && r.type === "search" && lastQuery.current === q) {
            setResults(r.results);
          }
        })
        .catch(() => {})
        .finally(() => {
          if (lastQuery.current === q) setSearching(false);
        });
    }, 280);
    return () => clearTimeout(t);
  }, [query]);

  // Sync route.q → query on hash change.
  useEffect(() => {
    if (route.q && route.q !== query) setQuery(route.q);
    // intentional: only react to route changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.q]);

  const onPickResult = useCallback((hit: SearchHit) => {
    setQuery("");
    nav({ view: "conversation", conversationId: hit.conversation_id, msgId: hit.message_id, q: lastQuery.current });
  }, [nav]);

  const onPickConv = useCallback((id: string) => {
    nav({ view: "conversation", conversationId: id });
  }, [nav]);

  // Short-circuit: onboarding owns the entire viewport when needed.
  if (needOnboarding) {
    return <Onboarding onDone={finishOnboarding} />;
  }

  // Settings is also a full-page view.
  if (route.view === "settings") {
    return (
      <div style={{
        width: "100%", height: "100%",
        display: "flex", flexDirection: "column",
        background: "var(--bg)", color: "var(--ink)", overflow: "hidden",
      }}>
        <TopBar
          query={query} setQuery={setQuery}
          searching={searching} resultCount={results.length}
          totals={totals} theme={theme} onCycleTheme={cycleTheme}
          helperOk={helperState === "ok"}
          onOpenSettings={() => nav({ view: "settings" })}
          onOpenMemory={() => nav({ view: "memory" })}
          memoryCount={memoryCount}
        />
        <SettingsView totals={totals} embed={embed} nav={nav} />
      </div>
    );
  }

  // Memory is a full-page view too.
  if (route.view === "memory") {
    return (
      <div style={{
        width: "100%", height: "100%",
        display: "flex", flexDirection: "column",
        background: "var(--bg)", color: "var(--ink)", overflow: "hidden",
      }}>
        <TopBar
          query={query} setQuery={setQuery}
          searching={searching} resultCount={results.length}
          totals={totals} theme={theme} onCycleTheme={cycleTheme}
          helperOk={helperState === "ok"}
          onOpenSettings={() => nav({ view: "settings" })}
          onOpenMemory={() => nav({ view: "memory" })}
          memoryCount={memoryCount}
        />
        <MemoryView nav={nav} />
      </div>
    );
  }

  return (
    <div style={{
      width: "100%",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      background: "var(--bg)",
      color: "var(--ink)",
      overflow: "hidden",
    }}>
      <TopBar
        query={query}
        setQuery={setQuery}
        searching={searching}
        resultCount={results.length}
        totals={totals}
        theme={theme}
        onCycleTheme={cycleTheme}
        helperOk={helperState === "ok"}
        onOpenSettings={() => nav({ view: "settings" })}
        onOpenMemory={() => nav({ view: "memory" })}
        memoryCount={memoryCount}
      />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <LeftRail
          recents={recents}
          activeConvId={route.view === "conversation" ? (route.conversationId ?? null) : null}
          onPickConv={onPickConv}
          onSuggest={(s) => setQuery(s)}
          embed={embed}
        />
        <div style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          background: "var(--surface)",
          borderLeft: "1px solid var(--hairline)",
          borderRight: "1px solid var(--hairline)",
        }}>
          {query.trim() ? (
            <ResultsView
              query={query}
              results={results}
              onPick={onPickResult}
            />
          ) : route.view === "conversation" && route.conversationId ? (
            <ConversationView
              convId={route.conversationId}
              msgIdAnchor={route.msgId}
              initialQuery={route.q}
              onConvDataLoaded={onConvDataLoaded}
              registerJumpTo={registerJumpTo}
              registerActive={registerActive}
            />
          ) : (
            <HomeWelcome recents={recents} onPick={onPickConv} />
          )}
        </div>
        <RightRail
          conv={query.trim() ? null : convData}
          activeIdx={activeIdx}
          pulseIdx={pulseIdx}
          filterMatches={filterMatches}
          onJump={(idx) => jumpToRef.current?.(idx, true)}
          hidden={query.trim().length > 0 || route.view !== "conversation"}
        />
      </div>
    </div>
  );
}

// ─── Error boundary ───────────────────────────────────────────────────────────

interface EBState { error: Error | null }

class ErrorBoundary extends Component<{ children: React.ReactNode }, EBState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error): EBState {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[smriti] uncaught render error", error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", height: "100vh", gap: "16px",
          fontFamily: "system-ui, sans-serif", color: "#6b2737", background: "#fdf6f0",
        }}>
          <div style={{ fontSize: "32px" }}>⚠️</div>
          <div style={{ fontSize: "18px", fontWeight: 600 }}>Something went wrong</div>
          <div style={{ fontSize: "13px", color: "#888", maxWidth: "420px", textAlign: "center" }}>
            {this.state.error.message}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: "8px", padding: "8px 20px", borderRadius: "6px",
              border: "none", background: "#6b2737", color: "#fff",
              fontSize: "13px", cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── Mount ────────────────────────────────────────────────────────────────────

const root = document.getElementById("root");
if (root) createRoot(root).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
