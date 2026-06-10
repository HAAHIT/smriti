// Smriti — in-page sidebar (variant B of the design).
//
// Mounts a fixed-position panel on the right edge of claude.ai, chatgpt.com,
// and gemini.google.com. The panel is the "Past you discussed this" surface:
// it watches the user's current message via window.postMessage events fired by
// the MAIN-world capture scripts and proactively surfaces past conversations
// that match — across ALL four AI tools, not just the one you're in.
//
// Visual shape mirrors the Recall.html prototype (variant B):
//   ┌─────────────────────────────────────┐
//   │ Smriti  PAST YOU                  × │
//   │ ┌────────────────────────────────┐  │
//   │ │ search input                   │  │
//   │ └────────────────────────────────┘  │
//   ├─────────────────────────────────────┤
//   │ ✦ PAST YOU DISCUSSED THIS           │
//   │   Big serif title                   │
//   │   italic why reason                 │
//   │   Provider · date     94% match     │
//   │   ── 7 chapters ───                 │
//   │   01  Setting the stage…            │
//   │   02  GIN with pg_trgm…             │
//   │  *03* Why SP-GiST entered the chat* │  ← matched chapter
//   │   …                                 │
//   │   [ Open in Smriti → ]              │  ← oxblood CTA
//   ├─────────────────────────────────────┤
//   │ ALSO RELEVANT                       │
//   │ ┌ smaller secondary card ────────┐  │
//   │ └────────────────────────────────┘  │
//   ├─────────────────────────────────────┤
//   │ ● local · 213 msgs indexed · model  │
//   └─────────────────────────────────────┘
//
// We hydrate the top result with its outline + chapter-of-matched-message so
// the hero card can render the chapter list with the right one highlighted.

import { defineContentScript } from "wxt/sandbox";
import { isInjectMessage } from "../capture/messages";
import { injectText, formatMemoryBlock, findComposer } from "../lib/inject";
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

const SMRITI_PANEL_ID = "smriti-sidebar-root";
const COLLAPSED_STATE_KEY = "smriti:sidebar:collapsed";
const PROACTIVE_DEBOUNCE_MS = 600;
const PROACTIVE_MIN_CHARS = 6;
const MAX_RESULTS = 5;
const PANEL_WIDTH = 400;   // keep in sync with .rc-panel width in CSS
const COLLAPSED_WIDTH = 36;

interface HydratedHero {
  hit: SearchHit;
  segments: OutlineSegment[];
  matchedChapterIdx: number;
  matchPct: number;
  why: string;
}

interface CurrentChat {
  platform: Platform;
  platformConvId: string;
  meta: ConversationMeta | null;     // null = not in our archive yet
  segments: OutlineSegment[];
}

interface PanelState {
  collapsed: boolean;
  query: string;
  loading: boolean;
  hero: HydratedHero | null;
  others: Array<{ hit: SearchHit; matchPct: number; why: string }>;
  proactiveQuery: string | null;
  msgsIndexed: number | null;
  currentChat: CurrentChat | null;
  memories: MemoryRecallHit[];
  toast: string | null;
}

export default defineContentScript({
  matches: [
    "https://claude.ai/*",
    "https://chatgpt.com/*",
    "https://gemini.google.com/*",
  ],
  runAt: "document_idle",
  main() {
    if (document.getElementById(SMRITI_PANEL_ID)) return;
    mountSidebar();
  },
});

// Push the host page over so our panel doesn't overlap its content.
// Strategy: set margin-right + max-width on documentElement. Most modern AI
// host pages compute their layout off documentElement / body width, so they
// reflow gracefully. We set !important via a dedicated <style> tag so the
// host's own stylesheet can't easily override us. When the sidebar is
// collapsed, we narrow the shift to just the collapsed-tab width so the page
// extends almost full-width again.
const HOST_SHIFT_STYLE_ID = "smriti-host-shift-style";
function applyHostShift(collapsed: boolean): void {
  const w = collapsed ? COLLAPSED_WIDTH : PANEL_WIDTH;
  let style = document.getElementById(HOST_SHIFT_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = HOST_SHIFT_STYLE_ID;
    document.documentElement.appendChild(style);
  }
  // We use both margin-right on <html> (shifts the document) and a max-width
  // ceiling on <body> (catches pages that compute layout from body width).
  // The transition lets the host content slide in/out smoothly.
  style.textContent = `
    html {
      margin-right: ${w}px !important;
      transition: margin-right 0.18s ease-out;
    }
    body {
      max-width: calc(100vw - ${w}px) !important;
    }
  `;
}

function mountSidebar(): void {
  const host = document.createElement("div");
  host.id = SMRITI_PANEL_ID;
  host.style.cssText = `
    all: initial;
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: auto;
    z-index: 2147483646;
    pointer-events: none;
  `;
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  injectStyles(shadow);

  const ui = document.createElement("div");
  ui.style.pointerEvents = "auto";
  ui.style.height = "100%";
  shadow.appendChild(ui);

  const state: PanelState = {
    collapsed: localStorage.getItem(COLLAPSED_STATE_KEY) === "1",
    query: "",
    loading: false,
    hero: null,
    others: [],
    proactiveQuery: null,
    msgsIndexed: null,
    currentChat: null,
    memories: [],
    toast: null,
  };

  let render: () => void = () => {};
  let proactiveTimer: number | null = null;
  let searchSeq = 0;
  // Set true while we inject, so the composer's resulting input event doesn't
  // re-trigger recall on the text we just wrote.
  let suppressComposerInput = false;

  function setState(next: Partial<PanelState>): void {
    Object.assign(state, next);
    render();
  }

  async function runSearch(q: string): Promise<void> {
    const query = q.trim();
    if (!query) {
      setState({ hero: null, others: [], loading: false, memories: [] });
      return;
    }
    const mySeq = ++searchSeq;
    setState({ loading: true });

    // Recall relevant memories in parallel — this is the hero surface. We don't
    // block the conversation results on it.
    void sendToHelper({ type: "recall_memories", query, limit: 5 })
      .then((r) => {
        if (mySeq !== searchSeq) return;
        const mem = r.memories as MemoryRecallHit[] | undefined;
        if (r.ok && Array.isArray(mem)) {
          setState({ memories: mem });
        }
      })
      .catch(() => {});

    try {
      const res = await sendToHelper({ type: "search", query, limit: MAX_RESULTS });
      if (mySeq !== searchSeq) return; // a newer search superseded us
      if (!(res.ok && res.type === "search") || res.results.length === 0) {
        setState({ hero: null, others: [], loading: false });
        return;
      }
      const hits = res.results as SearchHit[];
      const top = hits[0]!;
      const topScore = top.score || 1;

      // Hydrate the hero (top result) — needs outline + matched chapter.
      const hero = await hydrateHero(top, topScore, query);
      if (mySeq !== searchSeq) return;

      const others = hits.slice(1).map((h) => ({
        hit: h,
        matchPct: pctFromScore(h.score, topScore),
        why: synthesizeWhy(h, query),
      }));

      setState({ hero, others, loading: false });
    } catch (e) {
      if (mySeq !== searchSeq) return;
      setState({ hero: null, others: [], loading: false });
    }
  }

  // ─── Detect "current chat" from URL and load its outline ───
  // Re-runs on SPA navigation so the panel always reflects the conversation
  // the user is actually looking at.
  let lastUrl = "";
  async function refreshCurrentChat(): Promise<void> {
    const url = location.href;
    if (url === lastUrl) return;
    lastUrl = url;
    const detected = detectCurrentChat(url);
    if (!detected) {
      setState({ currentChat: null });
      return;
    }
    try {
      const r = await sendToHelper({
        type: "get_by_platform",
        platform: detected.platform,
        platform_conv_id: detected.platformConvId,
      });
      if (r.ok && r.type === "get_by_platform") {
        setState({
          currentChat: {
            platform: detected.platform,
            platformConvId: detected.platformConvId,
            meta: r.meta,
            segments: r.segments,
          },
        });
      }
    } catch { /* helper not reachable; quiet */ }
  }
  void refreshCurrentChat();
  // SPA navigation watcher — claude.ai, chatgpt.com etc. don't fire popstate
  // on internal links, so we poll URL every 800ms. Cheap.
  setInterval(() => { void refreshCurrentChat(); }, 800);

  // Footer indexing status — polled.
  void (async function pollIndex() {
    try {
      const r = await sendToHelper({ type: "embed_status" });
      if (r.ok && r.type === "embed_status") {
        setState({ msgsIndexed: r.embedded });
      }
    } catch { /* helper not reachable */ }
    setTimeout(pollIndex, 12_000);
  })();

  // Proactive: live user message → search for related past conversations.
  window.addEventListener("message", (ev: MessageEvent) => {
    if (ev.source !== window) return;
    if (!isInjectMessage(ev.data)) return;
    const events = ev.data.events as CaptureEvent[];
    const userMsg = [...events]
      .reverse()
      .find(
        (e): e is CaptureEventMessageAppended =>
          e.kind === "message_appended" && e.role === "user",
      );
    if (!userMsg) return;
    const text = userMsg.content_text.trim();
    if (text.length < PROACTIVE_MIN_CHARS) return;

    if (proactiveTimer !== null) clearTimeout(proactiveTimer);
    proactiveTimer = window.setTimeout(() => {
      // Don't override what the user has typed in the sidebar input.
      if (state.query.trim()) return;
      const q = text.slice(0, 140);
      setState({ proactiveQuery: q });
      void runSearch(q);
    }, PROACTIVE_DEBOUNCE_MS);
  });

  // ─── Live composer watch (the core loop) ───
  // Recall memories from what the user is typing into the host AI's message box
  // — BEFORE they send — so they can inject context into the very prompt being
  // written. This is what turns Smriti from an archive into a memory layer.
  let composerEl: HTMLElement | null = null;
  let composerTimer: number | null = null;
  function readComposerText(el: HTMLElement): string {
    return el.tagName === "TEXTAREA" || el.tagName === "INPUT"
      ? (el as HTMLTextAreaElement).value
      : el.innerText || el.textContent || "";
  }
  function onComposerInput(): void {
    if (suppressComposerInput) return;        // our own injection fired this
    if (!composerEl || state.query.trim()) return; // sidebar search takes priority
    const text = readComposerText(composerEl).trim();
    if (composerTimer !== null) clearTimeout(composerTimer);
    if (text.length < PROACTIVE_MIN_CHARS) {
      if (state.proactiveQuery) setState({ proactiveQuery: null, memories: [], hero: null, others: [] });
      return;
    }
    composerTimer = window.setTimeout(() => {
      if (state.query.trim()) return;
      const q = text.slice(0, 200);
      setState({ proactiveQuery: q });
      void runSearch(q);
    }, PROACTIVE_DEBOUNCE_MS);
  }
  function attachComposer(): void {
    const el = findComposer();
    if (el && el !== composerEl) {
      composerEl?.removeEventListener("input", onComposerInput);
      composerEl = el;
      composerEl.addEventListener("input", onComposerInput);
    }
  }
  attachComposer();
  // Re-attach across SPA navigation / editor remounts. Cheap.
  setInterval(attachComposer, 1500);

  render = () => {
    ui.innerHTML = "";
    ui.appendChild(state.collapsed ? renderCollapsed() : renderExpanded());
    applyHostShift(state.collapsed);
  };

  // ─── Collapsed tab ───
  function renderCollapsed(): HTMLElement {
    const el = document.createElement("button");
    el.className = "rc-tab";
    el.setAttribute("title", "Open Smriti");
    el.innerHTML = `
      <span class="rc-tab-title">Smriti</span>
      <span class="rc-tab-sub">past you</span>
    `;
    el.addEventListener("click", () => {
      setState({ collapsed: false });
      localStorage.removeItem(COLLAPSED_STATE_KEY);
    });
    return el;
  }

  // ─── Expanded panel ───
  function renderExpanded(): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "rc-panel";

    // Header
    const header = document.createElement("div");
    header.className = "rc-header";
    header.innerHTML = `
      <div class="rc-title-row">
        <div class="rc-title">Smriti</div>
        <div class="rc-smallcaps">past you</div>
        <div class="rc-spacer"></div>
        <button class="rc-icon-btn" data-act="close" title="Hide Smriti">×</button>
      </div>
      <div class="rc-search">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" class="rc-search-icon">
          <circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.4"></circle>
          <path d="M11 11l3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path>
        </svg>
        <input type="text" class="rc-search-input" placeholder="Find anything from any AI…" />
        ${state.loading ? '<span class="rc-mono rc-muted-text">…</span>' : ""}
      </div>
    `;
    panel.appendChild(header);
    const input = header.querySelector<HTMLInputElement>(".rc-search-input")!;
    input.value = state.query;
    input.addEventListener("input", (e) => {
      const v = (e.target as HTMLInputElement).value;
      setState({ query: v });
      debouncedManualSearch(v);
    });
    header.querySelector("[data-act=close]")?.addEventListener("click", () => {
      setState({ collapsed: true });
      localStorage.setItem(COLLAPSED_STATE_KEY, "1");
    });

    // Body
    const body = document.createElement("div");
    body.className = "rc-body";

    // ── Memory recall (the hero) — whenever we have relevant memories for the
    //    current draft or query, surface them at the very top with one-click
    //    injection into the composer. ──
    if (state.memories.length > 0) {
      body.appendChild(renderMemoryRecall(state.memories));
    }

    // ── Current chat outline (always at the top when we know which chat
    //    the user is in and we have it in our archive). Hidden during an
    //    active search to keep the focus on results. ──
    const showCurrent = !state.query.trim() && state.currentChat?.meta;
    if (showCurrent) {
      body.appendChild(renderCurrentChat(state.currentChat!));
    } else if (!state.query.trim() && state.currentChat && !state.currentChat.meta) {
      body.appendChild(renderCurrentChatUnknown(state.currentChat));
    }

    const havingSomething = state.hero || state.query.trim() || state.proactiveQuery;
    if (!havingSomething && !showCurrent) {
      body.appendChild(renderIntro());
    } else if (state.query.trim() && !state.hero && !state.loading) {
      body.appendChild(renderEmpty());
    } else {
      if (state.hero) body.appendChild(renderHero(state.hero));
      if (state.others.length > 0) body.appendChild(renderOthers(state.others));
    }
    panel.appendChild(body);

    // Footer
    const footer = document.createElement("div");
    footer.className = "rc-footer";
    footer.innerHTML = `
      <span class="rc-dot rc-dot-green"></span>
      <span class="rc-mono">local</span>
      <span class="rc-divider">·</span>
      <span class="rc-mono">${state.msgsIndexed === null ? "—" : state.msgsIndexed} msgs indexed</span>
      <div class="rc-spacer"></div>
      <span class="rc-mono rc-muted-text">MiniLM-L6</span>
    `;
    panel.appendChild(footer);

    if (state.toast) {
      const toast = document.createElement("div");
      toast.className = "rc-toast";
      toast.textContent = state.toast;
      panel.appendChild(toast);
    }

    return panel;
  }

  // ─── Intro (no query) ───
  function renderIntro(): HTMLElement {
    const el = document.createElement("div");
    el.className = "rc-intro";
    el.innerHTML = `
      <div class="rc-smallcaps rc-muted-text">Your AI remembers you</div>
      <div class="rc-intro-blurb">
        Start typing a message and Smriti surfaces what you've already
        established — your tools, decisions, and projects — so you can drop
        it into the prompt in one click. No more re-explaining yourself to
        every AI.
      </div>
      <div class="rc-divider-h"></div>
      <div class="rc-smallcaps rc-muted-text">Or search your memory</div>
      <div class="rc-suggestions">
        ${["embeddings model choice", "rust enum bug", "rate limited backfill", "outline algorithm"]
          .map((s) => `<button class="rc-suggest" data-q="${s.replace(/"/g, "&quot;")}">${s}</button>`)
          .join("")}
      </div>
    `;
    el.querySelectorAll<HTMLButtonElement>(".rc-suggest").forEach((b) => {
      b.addEventListener("click", () => {
        const q = b.getAttribute("data-q") ?? "";
        setState({ query: q });
        void runSearch(q);
      });
    });
    return el;
  }

  // ─── Empty state ───
  function renderEmpty(): HTMLElement {
    const el = document.createElement("div");
    el.className = "rc-empty";
    el.innerHTML = `
      <div class="rc-empty-title">Nothing for &ldquo;${escapeHtml(state.query)}&rdquo; yet.</div>
      <div class="rc-empty-sub">Try a vaguer phrase — semantic recall catches paraphrase.</div>
    `;
    return el;
  }

  // ─── Current chat outline ───
  // Shown when the user is on a captured conversation. The whole point of
  // Smriti living inside claude.ai: a navigable index of the chat you're
  // actually looking at, without scrolling.
  function renderCurrentChat(cc: CurrentChat): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "rc-current-wrap";
    const meta = cc.meta!;
    const provider = providerBadge(meta.platform);
    const total = cc.segments.length;
    wrap.innerHTML = `
      <div class="rc-section-header">
        <span class="rc-smallcaps rc-muted-text">You're here</span>
      </div>
      <div class="rc-current">
        <div class="rc-current-title">${escapeHtml(meta.title ?? "(untitled)")}</div>
        <div class="rc-current-meta">
          <span class="rc-provider" style="--p:${provider.color}"></span>
          <span>${provider.label}</span>
          <span class="rc-divider">·</span>
          <span class="rc-mono">${meta.message_count} msgs</span>
          <span class="rc-divider">·</span>
          <span class="rc-mono">${total} ${total === 1 ? "chapter" : "chapters"}</span>
        </div>
        ${renderChapterList(cc.segments, -1, meta.id)}
        ${total === 0 ? `
          <div class="rc-empty-inline">Indexing this conversation — chapters appear as embeddings finish.</div>
        ` : ""}
      </div>
    `;
    wrap.querySelectorAll<HTMLButtonElement>("[data-conv-id][data-msg-id]").forEach((b) => {
      b.addEventListener("click", () => {
        openViewer(b.getAttribute("data-conv-id")!, b.getAttribute("data-msg-id") ?? "", "");
      });
    });
    return wrap;
  }

  function renderCurrentChatUnknown(cc: CurrentChat): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "rc-current-wrap";
    wrap.innerHTML = `
      <div class="rc-section-header">
        <span class="rc-smallcaps rc-muted-text">You're here</span>
      </div>
      <div class="rc-current rc-current-unknown">
        <div class="rc-current-title-muted">New conversation</div>
        <div class="rc-current-why">
          This chat isn't in your archive yet. Send a message and it'll be captured.
        </div>
      </div>
    `;
    return wrap;
  }

  // Shared chapter-list renderer used by both the Current-chat section and
  // the search hero card. matchedIdx = -1 means no highlight.
  function renderChapterList(segments: OutlineSegment[], matchedIdx: number, convId: string): string {
    if (segments.length === 0) return "";
    return `
      <div class="rc-chapter-list">
        ${segments.map((s, i) => `
          <button class="rc-chapter ${i === matchedIdx ? "rc-chapter-active" : ""}"
                  data-conv-id="${convId}" data-msg-id="${s.start_message_id}">
            <span class="rc-mono rc-chapter-num">${String(i + 1).padStart(2, "0")}</span>
            <span class="rc-chapter-title">${escapeHtml(s.preview || "(no preview)")}</span>
          </button>
        `).join("")}
      </div>
    `;
  }

  // ─── Memory recall (the hero) ───
  // The thing that makes "your AI remembers you" real: relevant memories with
  // one-click injection straight into the composer.
  async function injectMemories(hits: MemoryRecallHit[]): Promise<void> {
    if (hits.length === 0) return;
    const block = formatMemoryBlock(hits.map((h) => ({ text: h.text })));
    suppressComposerInput = true;
    const ok = injectText(block);
    window.setTimeout(() => { suppressComposerInput = false; }, 400);
    if (ok) {
      void sendToHelper({ type: "touch_memories", ids: hits.map((h) => h.id) }).catch(() => {});
      flashToast(hits.length === 1 ? "Added to your prompt ✓" : `Added ${hits.length} memories ✓`);
    } else {
      flashToast("Click your message box once, then retry.");
    }
  }

  let toastTimer: number | null = null;
  function flashToast(msg: string): void {
    setState({ toast: msg });
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => setState({ toast: null }), 2800);
  }

  function renderMemoryRecall(hits: MemoryRecallHit[]): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "rc-mem-wrap";
    const count = hits.length;
    wrap.innerHTML = `
      <div class="rc-mem-header">
        <span class="rc-spark">✦</span>
        <span class="rc-smallcaps rc-accent">Smriti remembers</span>
        <div class="rc-spacer"></div>
        <span class="rc-mono rc-muted-text">${count}</span>
      </div>
      <div class="rc-mem-list">
        ${hits.map((h, i) => {
          const meta = memoryKindMeta(h.kind);
          const prov = h.source_platform ? providerBadge(h.source_platform) : null;
          return `
            <div class="rc-mem">
              <div class="rc-mem-top">
                <span class="rc-mem-kind" style="--k:${meta.color}">${meta.label}</span>
                ${h.pinned ? '<span class="rc-mem-pin" title="Pinned">📌</span>' : ""}
                <div class="rc-spacer"></div>
                <button class="rc-mem-inject" data-idx="${i}" title="Add just this to your prompt">+ inject</button>
              </div>
              <div class="rc-mem-text">${escapeHtml(h.text)}</div>
              ${prov ? `<div class="rc-mem-src"><span class="rc-provider" style="--p:${prov.color}"></span>${prov.label} · ${formatDate(h.created_at)}</div>` : ""}
            </div>
          `;
        }).join("")}
      </div>
      <button class="rc-cta rc-mem-cta" data-inject-all>
        Inject ${count === 1 ? "this" : `all ${count}`} into prompt →
      </button>
    `;
    wrap.querySelectorAll<HTMLButtonElement>(".rc-mem-inject").forEach((b) => {
      b.addEventListener("click", () => {
        const i = Number(b.getAttribute("data-idx"));
        const h = hits[i];
        if (h) void injectMemories([h]);
      });
    });
    wrap.querySelector<HTMLButtonElement>("[data-inject-all]")?.addEventListener("click", () => {
      void injectMemories(hits);
    });
    return wrap;
  }

  // ─── Hero card ───
  function renderHero(h: HydratedHero): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "rc-hero-wrap";

    const headerLabel = state.query.trim() ? "Top match" : "Past you discussed this";
    const provider = providerBadge(h.hit.platform);
    const dateLabel = formatDate(h.hit.last_message_at);
    const segments = h.segments;
    const totalChapters = segments.length;

    const card = document.createElement("div");
    card.className = "rc-hero rc-pulse";
    card.innerHTML = `
      <div class="rc-hero-header">
        <span class="rc-spark">✦</span>
        <span class="rc-smallcaps rc-accent">${escapeHtml(headerLabel)}</span>
      </div>
      <div class="rc-hero-title">${escapeHtml(h.hit.title ?? "(untitled)")}</div>
      <div class="rc-hero-why">${escapeHtml(h.why)}</div>
      <div class="rc-hero-meta">
        <span class="rc-provider" style="--p:${provider.color}"></span>
        <span>${provider.label}</span>
        <span class="rc-divider">·</span>
        <span class="rc-mono">${dateLabel}</span>
        <div class="rc-spacer"></div>
        <span class="rc-mono rc-accent rc-bold">${h.matchPct}% match</span>
      </div>
      <div class="rc-hero-divider"></div>
      <div class="rc-smallcaps rc-muted-text" style="margin-bottom:6px">
        ${totalChapters > 0
          ? `${totalChapters} ${totalChapters === 1 ? "chapter" : "chapters"}`
          : "Outline"}
      </div>
      ${totalChapters > 0
        ? renderChapterList(segments, h.matchedChapterIdx, h.hit.conversation_id)
        : `<div class="rc-empty-inline">Indexing this conversation — chapters appear as embeddings finish.</div>`}
      <button class="rc-cta" data-open-conv="${h.hit.conversation_id}" data-msg-id="${h.hit.message_id}">
        Open in Smriti →
      </button>
    `;
    // Click handlers for chapter buttons (they carry data-conv-id + data-msg-id).
    card.querySelectorAll<HTMLButtonElement>(".rc-chapter").forEach((b) => {
      b.addEventListener("click", () => {
        const cid = b.getAttribute("data-conv-id") ?? h.hit.conversation_id;
        const mid = b.getAttribute("data-msg-id") ?? h.hit.message_id;
        openViewer(cid, mid, state.query.trim() || state.proactiveQuery || "");
      });
    });
    card.querySelector<HTMLButtonElement>(".rc-cta")?.addEventListener("click", () => {
      openViewer(h.hit.conversation_id, h.hit.message_id, state.query.trim() || state.proactiveQuery || "");
    });
    wrap.appendChild(card);
    return wrap;
  }

  // ─── Secondary cards ("Also relevant") ───
  function renderOthers(items: Array<{ hit: SearchHit; matchPct: number; why: string }>): HTMLElement {
    const el = document.createElement("div");
    el.className = "rc-others";
    el.innerHTML = `
      <div class="rc-smallcaps rc-muted-text rc-others-header">Also relevant</div>
      <div class="rc-others-list">
        ${items.map((it) => {
          const provider = providerBadge(it.hit.platform);
          const date = formatDate(it.hit.last_message_at);
          return `
            <button class="rc-card" data-open-conv="${it.hit.conversation_id}" data-msg-id="${it.hit.message_id}">
              <div class="rc-card-title">${escapeHtml(it.hit.title ?? "(untitled)")}</div>
              <div class="rc-card-meta">
                <span class="rc-provider" style="--p:${provider.color}"></span>
                <span>${provider.label}</span>
                <span class="rc-divider">·</span>
                <span class="rc-mono">${date}</span>
                <div class="rc-spacer"></div>
                <span class="rc-mono rc-muted-text">${it.matchPct}%</span>
              </div>
              <div class="rc-card-why">${escapeHtml(it.why)}</div>
            </button>
          `;
        }).join("")}
      </div>
    `;
    el.querySelectorAll<HTMLButtonElement>("[data-open-conv]").forEach((b) => {
      b.addEventListener("click", () => {
        const cid = b.getAttribute("data-open-conv")!;
        const mid = b.getAttribute("data-msg-id") ?? "";
        openViewer(cid, mid, state.query.trim() || state.proactiveQuery || "");
      });
    });
    return el;
  }

  let searchTimer: number | null = null;
  function debouncedManualSearch(q: string): void {
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => { void runSearch(q); }, 280);
  }

  render();
}

// ─── hydration ──────────────────────────────────────────────────────────────

async function hydrateHero(top: SearchHit, topScore: number, query: string): Promise<HydratedHero> {
  // Fetch outline + messages in parallel so we can map the matched message
  // to its chapter index for highlight.
  const [outlineRes, convRes] = await Promise.all([
    sendToHelper({ type: "get_outline", conversation_id: top.conversation_id }),
    sendToHelper({ type: "get_conversation", conversation_id: top.conversation_id }),
  ]);

  let segments: OutlineSegment[] = [];
  if (outlineRes.ok && outlineRes.type === "get_outline") {
    segments = outlineRes.segments;
  }
  let messages: ConversationMessageRow[] = [];
  if (convRes.ok && convRes.type === "get_conversation") {
    messages = convRes.messages;
  }

  const matchedChapterIdx = findChapterOf(top.message_id, messages, segments);
  return {
    hit: top,
    segments,
    matchedChapterIdx,
    matchPct: pctFromScore(top.score, topScore, /*isHero*/ true),
    why: synthesizeWhy(top, query),
  };
}

function findChapterOf(messageId: string, messages: ConversationMessageRow[], segments: OutlineSegment[]): number {
  if (segments.length === 0) return -1;
  const m = messages.find((x) => x.id === messageId);
  if (!m) return -1;
  const sorted = [...segments].sort((a, b) => a.start_position - b.start_position);
  let idx = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (m.position >= sorted[i]!.start_position) idx = i;
  }
  return idx;
}

// ─── scoring + why synthesis ────────────────────────────────────────────────

// Convert raw RRF score into a perceived "match %" for the UI.
// Top result anchors at ~94%; others scale relative.
function pctFromScore(score: number, top: number, isHero = false): number {
  const t = top > 0 ? top : 1;
  const ratio = Math.max(0, Math.min(1, score / t));
  const headline = isHero ? 94 : Math.round(ratio * 94);
  return Math.max(40, Math.min(99, headline));
}

function synthesizeWhy(hit: SearchHit, query: string): string {
  const mode = hit.match === "vec"
    ? "Semantic match"
    : hit.match === "hybrid"
      ? "Keyword + semantic match"
      : "Keyword match";
  const date = formatDate(hit.last_message_at);
  const q = query.length > 60 ? query.slice(0, 60) + "…" : query;
  // First-person tone like the design's "you went deep on this …"
  return `${mode} for ${q ? "“" + q + "”" : "your current message"} — you discussed this on ${date}.`;
}

// ─── messaging ──────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyReq = { type: string; [key: string]: any };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyResp = { ok: boolean; type: string; id: string; [key: string]: any };

async function sendToHelper(req: AnyReq): Promise<AnyResp> {
  const resp = await browser.runtime.sendMessage({ kind: "to_offscreen", ...req }) as
    | { ok: boolean; res?: unknown; error?: string }
    | undefined;
  if (!resp) throw new Error("no response");
  if (!resp.ok) throw new Error((resp as { error?: string }).error ?? "offscreen error");
  const inner = resp.res as { ok?: boolean; result?: unknown } | undefined;
  const data = inner?.result ?? inner ?? {};
  return { ok: true, type: req.type, id: "", ...((data && typeof data === "object") ? data : {}) };
}

function openViewer(convId: string, msgId: string, q: string): void {
  const params = new URLSearchParams();
  if (msgId) params.set("msg", msgId);
  if (q) params.set("q", q);
  const qs = params.toString();
  const url = browser.runtime.getURL(`/options.html#/c/${convId}${qs ? "?" + qs : ""}`);
  window.open(url, "_blank", "noopener");
}

// ─── helpers ────────────────────────────────────────────────────────────────

// Pull platform + platform_conv_id out of the current page URL.
// The URLs we care about:
//   claude.ai/chat/<uuid>
//   chatgpt.com/c/<uuid>      (or /g/g-xxx/c/<uuid> for custom GPTs)
//   gemini.google.com/app/<id>
function detectCurrentChat(url: string): { platform: Platform; platformConvId: string } | null {
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

function providerBadge(p: string): { label: string; color: string } {
  switch (p) {
    case "claude":      return { label: "Claude",      color: "#c96442" };
    case "chatgpt":     return { label: "ChatGPT",     color: "#1f7a64" };
    case "gemini":      return { label: "Gemini",      color: "#3b6cb5" };
    case "claude_code": return { label: "Code",        color: "#6d5fa6" };
    default:            return { label: p,             color: "#888" };
  }
}

function memoryKindMeta(kind: string): { label: string; color: string } {
  switch (kind) {
    case "identity":   return { label: "identity",   color: "#8b3a2f" };
    case "preference": return { label: "preference", color: "#1f7a64" };
    case "project":    return { label: "project",    color: "#3b6cb5" };
    case "decision":   return { label: "decision",   color: "#9a6b1f" };
    default:           return { label: "fact",       color: "#6d5fa6" };
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch { return ""; }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── styles (shadow-DOM-scoped) ─────────────────────────────────────────────

function injectStyles(shadow: ShadowRoot): void {
  // Load Inter + Source Serif 4 once into the page so the shadow DOM can use
  // them. Google Fonts CSS is fetched cross-origin; if blocked by host CSP we
  // gracefully fall back to system fonts via the var() chain.
  if (!document.getElementById("smriti-fonts-link")) {
    const link = document.createElement("link");
    link.id = "smriti-fonts-link";
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Source+Serif+4:opsz,wght@8..60,500;8..60,600&family=JetBrains+Mono:wght@400;500&display=swap";
    document.head.appendChild(link);
  }

  const style = document.createElement("style");
  style.textContent = `
    :host, * { box-sizing: border-box; }
    :host {
      --bg: #f6f1e6;
      --surface: #fcf9f1;
      --surface-2: #f1ebdb;
      --ink: #2a2620;
      --ink-2: #4a4338;
      --muted: #8a7f6b;
      --muted-2: #b5aa94;
      --hairline: #e3dac4;
      --hairline-strong: #d3c8ae;
      --accent: #8b3a2f;
      --accent-soft: #d9a59c;
      --highlight: #f3e1a6;
      --highlight-strong: #e8c45a;
      --chip-bg: rgba(0,0,0,0.04);
      --serif: 'Source Serif 4', ui-serif, Georgia, 'Times New Roman', serif;
      --sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --bg: #14130f;
        --surface: #1b1a15;
        --surface-2: #232118;
        --ink: #ece4d0;
        --ink-2: #c4bda9;
        --muted: #8a8270;
        --muted-2: #5f5947;
        --hairline: #2c2a22;
        --hairline-strong: #3a3729;
        --accent: #d69960;
        --accent-soft: #6b4d2e;
        --highlight: #5a4612;
        --highlight-strong: #c8983a;
        --chip-bg: rgba(255,247,228,0.05);
      }
    }

    /* ── Collapsed tab ── */
    .rc-tab {
      position: fixed;
      top: 50%;
      right: 0;
      transform: translateY(-50%);
      width: 36px;
      padding: 16px 6px;
      background: var(--bg);
      border: 1px solid var(--hairline-strong);
      border-right: none;
      border-radius: 8px 0 0 8px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      color: var(--ink);
      font-family: var(--sans);
      box-shadow: -2px 0 8px rgba(40,30,20,0.08);
    }
    .rc-tab-title {
      font-family: var(--serif);
      font-weight: 600;
      font-size: 14px;
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      letter-spacing: 0.04em;
    }
    .rc-tab-sub {
      font-family: var(--mono);
      font-size: 10px;
      color: var(--muted);
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }

    /* ── Expanded panel ── */
    .rc-panel {
      width: 400px;
      height: 100vh;
      background: var(--bg);
      color: var(--ink);
      font-family: var(--sans);
      display: flex;
      flex-direction: column;
      position: relative;
      border-left: 2px solid var(--hairline-strong);
      box-shadow: -8px 0 24px rgba(40,30,20,0.08);
      font-size: 14px;
      line-height: 1.5;
    }
    .rc-spacer { flex: 1; }
    .rc-divider { color: var(--muted-2); }
    .rc-divider-h { height: 1px; background: var(--hairline); margin: 14px 0; }
    .rc-mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
    .rc-bold { font-weight: 600; }
    .rc-accent { color: var(--accent); }
    .rc-smallcaps {
      font-family: var(--sans);
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-size: 10.5px;
      font-weight: 600;
      color: var(--muted);
    }
    .rc-muted-text { color: var(--muted); }

    /* ── Header ── */
    .rc-header {
      padding: 14px 18px 12px;
      border-bottom: 1px solid var(--hairline);
      display: flex;
      flex-direction: column;
      gap: 10px;
      flex: 0 0 auto;
    }
    .rc-title-row { display: flex; align-items: center; gap: 10px; }
    .rc-title {
      font-family: var(--serif);
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: var(--ink);
    }
    .rc-icon-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      width: 22px;
      height: 22px;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 3px;
    }
    .rc-icon-btn:hover { background: var(--surface-2); color: var(--ink); }
    .rc-search {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border: 1px solid var(--hairline-strong);
      border-radius: 5px;
      background: var(--surface);
    }
    .rc-search-icon { color: var(--muted); flex: 0 0 12px; }
    .rc-search-input {
      flex: 1;
      border: none;
      background: transparent;
      outline: none;
      font-size: 13px;
      font-family: var(--sans);
      color: var(--ink);
    }

    /* ── Body ── */
    .rc-body {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 0 0 24px 0;
    }
    .rc-body::-webkit-scrollbar { width: 8px; }
    .rc-body::-webkit-scrollbar-thumb { background: var(--hairline-strong); border-radius: 4px; }

    /* ── Intro ── */
    .rc-intro { padding: 18px 18px 24px; }
    .rc-intro-blurb {
      font-size: 12.5px;
      color: var(--ink-2);
      font-style: italic;
      margin-top: 8px;
      line-height: 1.55;
    }
    .rc-suggestions { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
    .rc-suggest {
      background: transparent;
      border: none;
      padding: 5px 8px;
      margin: 0 -4px;
      border-radius: 4px;
      text-align: left;
      font-size: 12.5px;
      color: var(--ink-2);
      cursor: pointer;
      font-family: var(--sans);
      font-style: italic;
    }
    .rc-suggest:hover { background: var(--surface-2); }

    /* ── Empty ── */
    .rc-empty { padding: 40px 22px; color: var(--muted); font-style: italic; }
    .rc-empty-title { font-family: var(--serif); font-size: 15px; margin-bottom: 6px; color: var(--ink-2); }
    .rc-empty-sub { font-size: 12.5px; }

    /* ── Current chat section ── */
    .rc-current-wrap { padding: 16px 18px 0; }
    .rc-section-header { margin-bottom: 6px; }
    .rc-current {
      padding: 12px 14px;
      background: var(--surface);
      border: 1px solid var(--hairline);
      border-radius: 4px;
    }
    .rc-current-title {
      font-family: var(--serif);
      font-size: 14px;
      font-weight: 600;
      color: var(--ink);
      line-height: 1.3;
      margin-bottom: 6px;
    }
    .rc-current-title-muted {
      font-family: var(--serif);
      font-size: 13.5px;
      font-style: italic;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .rc-current-meta {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 11px;
      color: var(--muted);
      margin-bottom: 10px;
    }
    .rc-current-why {
      font-size: 11.5px;
      color: var(--muted);
      font-style: italic;
      line-height: 1.5;
    }
    .rc-current-unknown { border-style: dashed; }
    .rc-empty-inline {
      font-size: 11.5px;
      color: var(--muted);
      font-style: italic;
      padding: 6px 0 4px;
    }

    /* ── Hero card ── */
    .rc-hero-wrap { padding: 16px 18px 0; }
    .rc-hero {
      padding: 14px 16px 14px;
      background: var(--surface);
      border: 1px solid var(--hairline-strong);
      border-radius: 4px;
      box-shadow: 0 1px 0 rgba(60,50,40,0.05);
    }
    .rc-pulse { animation: rcPulseGlow 2.4s ease-out 1; }
    @keyframes rcPulseGlow {
      0%   { box-shadow: 0 0 0 0 transparent; }
      15%  { box-shadow: 0 0 0 6px var(--highlight); }
      100% { box-shadow: 0 0 0 0 transparent; }
    }
    .rc-hero-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .rc-spark { color: var(--accent); font-size: 13px; }
    .rc-hero-title {
      font-family: var(--serif);
      font-size: 16px;
      font-weight: 600;
      line-height: 1.25;
      color: var(--ink);
      margin-bottom: 6px;
    }
    .rc-hero-why {
      font-size: 11.5px;
      color: var(--muted);
      font-style: italic;
      margin-bottom: 10px;
      line-height: 1.5;
    }
    .rc-hero-meta {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 11px;
      color: var(--muted);
      margin-bottom: 10px;
    }
    .rc-provider {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--p, var(--muted));
      display: inline-block;
    }
    .rc-hero-divider {
      height: 1px;
      background: var(--hairline);
      margin: 0 0 10px 0;
    }

    /* ── Chapter list ── */
    .rc-chapter-list { display: flex; flex-direction: column; gap: 1px; margin-bottom: 12px; }
    .rc-chapter {
      background: transparent;
      border: none;
      padding: 4px 6px;
      margin: 0 -6px;
      border-radius: 3px;
      cursor: pointer;
      text-align: left;
      display: flex;
      align-items: baseline;
      gap: 8px;
      font-family: var(--sans);
      color: var(--ink-2);
      line-height: 1.35;
    }
    .rc-chapter:hover { background: var(--surface-2); }
    .rc-chapter-num {
      font-size: 9.5px;
      color: var(--muted-2);
      flex: 0 0 18px;
    }
    .rc-chapter-title {
      font-family: var(--serif);
      font-size: 12.5px;
      font-weight: 500;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    .rc-chapter-active .rc-chapter-title {
      color: var(--accent);
      font-weight: 600;
      text-decoration: underline;
      text-decoration-color: var(--accent-soft);
      text-underline-offset: 2px;
    }

    /* ── CTA ── */
    .rc-cta {
      width: 100%;
      padding: 9px 12px;
      background: var(--accent);
      color: #f6f0e3;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12.5px;
      font-family: var(--sans);
      font-weight: 600;
      letter-spacing: 0.02em;
      text-align: center;
      transition: filter 0.1s;
    }
    .rc-cta:hover { filter: brightness(1.08); }

    /* ── Others ── */
    .rc-others { padding: 22px 18px 0; }
    .rc-others-header { margin-bottom: 8px; }
    .rc-others-list { display: flex; flex-direction: column; gap: 8px; }
    .rc-card {
      background: transparent;
      border: 1px solid var(--hairline);
      border-radius: 3px;
      padding: 10px 12px;
      cursor: pointer;
      text-align: left;
      display: flex;
      flex-direction: column;
      gap: 5px;
      color: var(--ink-2);
      font-family: var(--sans);
      transition: border-color 0.12s, background 0.12s;
    }
    .rc-card:hover { border-color: var(--hairline-strong); background: var(--surface); }
    .rc-card-title {
      font-family: var(--serif);
      font-size: 13px;
      font-weight: 600;
      line-height: 1.3;
      color: var(--ink);
    }
    .rc-card-meta {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 10.5px;
      color: var(--muted);
    }
    .rc-card-why {
      font-size: 11px;
      color: var(--muted);
      font-style: italic;
      line-height: 1.45;
    }

    /* ── Memory recall (hero) ── */
    .rc-mem-wrap {
      padding: 16px 18px 4px;
    }
    .rc-mem-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }
    .rc-mem-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 12px;
    }
    .rc-mem {
      padding: 10px 12px;
      background: var(--surface);
      border: 1px solid var(--hairline-strong);
      border-radius: 5px;
      border-left: 3px solid var(--accent-soft);
    }
    .rc-mem-top {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
    }
    .rc-mem-kind {
      font-family: var(--sans);
      font-size: 9.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.09em;
      color: var(--k, var(--accent));
      padding: 1px 6px;
      border-radius: 3px;
      background: color-mix(in srgb, var(--k, var(--accent)) 12%, transparent);
    }
    .rc-mem-pin { font-size: 10px; }
    .rc-mem-inject {
      background: transparent;
      border: 1px solid var(--hairline-strong);
      color: var(--accent);
      cursor: pointer;
      font-family: var(--mono);
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 4px;
      transition: background 0.1s, border-color 0.1s;
    }
    .rc-mem-inject:hover { background: var(--surface-2); border-color: var(--accent-soft); }
    .rc-mem-text {
      font-family: var(--serif);
      font-size: 13px;
      line-height: 1.4;
      color: var(--ink);
    }
    .rc-mem-src {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 6px;
      font-size: 10px;
      color: var(--muted);
      font-family: var(--mono);
    }
    .rc-mem-cta { margin-bottom: 4px; }

    /* ── Toast ── */
    .rc-toast {
      position: absolute;
      bottom: 52px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--ink);
      color: var(--bg);
      font-family: var(--sans);
      font-size: 12px;
      font-weight: 500;
      padding: 8px 16px;
      border-radius: 20px;
      box-shadow: 0 4px 16px rgba(40,30,20,0.25);
      animation: rcToastIn 0.18s ease-out;
      white-space: nowrap;
      z-index: 10;
    }
    @keyframes rcToastIn {
      from { opacity: 0; transform: translateX(-50%) translateY(6px); }
      to   { opacity: 1; transform: translateX(-50%) translateY(0); }
    }

    /* ── Footer ── */
    .rc-footer {
      padding: 8px 18px;
      border-top: 1px solid var(--hairline);
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 10.5px;
      color: var(--muted);
      background: var(--bg);
      flex: 0 0 auto;
    }
    .rc-dot { width: 6px; height: 6px; border-radius: 50%; }
    .rc-dot-green { background: #1f7a64; }
  `;
  shadow.appendChild(style);
}
