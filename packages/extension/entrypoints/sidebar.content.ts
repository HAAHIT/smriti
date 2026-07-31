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
  MemoryRecallHit,
  OutlineSegment,
  SearchHit,
} from "@smriti/shared";
import { SIDEBAR_CSS } from "../lib/sidebar-styles";
import { injectFontFaces } from "../lib/fonts";
import { CurrentChat, PanelState, PanelHandlers, HydratedHero } from "../lib/sidebar-types";
import { detectCurrentChat, providerBadge, formatDate, escapeHtml } from "../lib/sidebar-helpers";
import { renderCollapsed, renderExpanded, populateBody, updateToast } from "../lib/sidebar-renderers";

const SMRITI_PANEL_ID = "smriti-sidebar-root";
const COLLAPSED_STATE_KEY = "smriti:sidebar:collapsed";
const PROACTIVE_DEBOUNCE_MS = 600;
const PROACTIVE_MIN_CHARS = 6;
const MAX_RESULTS = 5;
const PANEL_WIDTH = 400;   // keep in sync with .rc-panel width in CSS
const COLLAPSED_WIDTH = 36;

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

  let render: () => void = () => { };
  let proactiveTimer: number | null = null;
  let searchSeq = 0;
  // Set true while we inject, so the composer's resulting input event doesn't
  // re-trigger recall on the text we just wrote.
  let suppressComposerInput = false;
  // Mirrors the per-host capture pause (Settings → Capture). When true, the
  // composer watch below stops observing entirely — pausing capture should
  // pause all observation on this site, not just message ingestion.
  let capturePaused = false;
  // Hoisted above pollCapturePaused (which references it from an IIFE invoked
  // before the "Live composer watch" section runs).
  let composerEl: HTMLElement | null = null;

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
      .catch(() => { });

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

  // ─── Live composer watch (the core loop) ───
  // Recall memories from what the user is typing into the host AI's message box
  // — BEFORE they send — so they can inject context into the very prompt being
  // written. This is what turns Smriti from an archive into a memory layer.
  let composerTimer: number | null = null;
  function readComposerText(el: HTMLElement): string {
    return el.tagName === "TEXTAREA" || el.tagName === "INPUT"
      ? (el as HTMLTextAreaElement).value
      : el.innerText || el.textContent || "";
  }
  function onComposerInput(): void {
    if (suppressComposerInput) return;        // our own injection fired this
    if (capturePaused) return;                // pausing capture pauses observation
    if (!composerEl || state.query.trim()) return; // sidebar search takes priority
    const text = readComposerText(composerEl).trim();
    if (composerTimer !== null) clearTimeout(composerTimer);
    if (text.length < PROACTIVE_MIN_CHARS) {
      if (state.proactiveQuery) setState({ proactiveQuery: null, memories: [], hero: null, others: [] });
      return;
    }
    composerTimer = window.setTimeout(() => {
      if (capturePaused || state.query.trim()) return;
      const q = text.slice(0, 200);
      setState({ proactiveQuery: q });
      void runSearch(q);
    }, PROACTIVE_DEBOUNCE_MS);
  }
  function attachComposer(): void {
    if (capturePaused) return;                // don't attach if capture is paused
    const el = findComposer();
    if (el && el !== composerEl) {
      composerEl?.removeEventListener("input", onComposerInput);
      composerEl = el;
      composerEl.addEventListener("input", onComposerInput);
    }
  }
  function detachComposer(): void {
    // Detach immediately — an attached-but-no-op listener still observes
    // every keystroke, which "pause" should prevent.
    composerEl?.removeEventListener("input", onComposerInput);
    composerEl = null;
  }

  // Applies a capture-pause transition: tears down (or re-attaches) the
  // composer watch, and — when pausing — invalidates any in-flight
  // runSearch() and clears recall state, so a response that was already
  // dispatched can't repopulate the panel after the user paused.
  function applyCapturePaused(next: boolean): void {
    if (next === capturePaused) return;
    capturePaused = next;
    if (capturePaused) {
      searchSeq += 1;
      setState({ proactiveQuery: null, loading: false, hero: null, others: [], memories: [] });
      if (composerTimer !== null) { clearTimeout(composerTimer); composerTimer = null; }
      if (proactiveTimer !== null) { clearTimeout(proactiveTimer); proactiveTimer = null; }
      detachComposer();
    } else {
      attachComposer();
    }
  }

  // Fetches the paused-hosts list from background and applies it. Hostnames
  // are stored as claude.ai / chatgpt.com / gemini.google.com (see
  // platformToHost in background.ts).
  async function syncCapturePaused(): Promise<void> {
    try {
      const resp = await browser.runtime.sendMessage({ kind: "get_capture_paused" }) as
        | { ok: boolean; paused?: string[] }
        | undefined;
      const paused = resp?.ok && Array.isArray(resp.paused) ? resp.paused : [];
      applyCapturePaused(paused.includes(location.hostname.replace(/^www\./, "")));
    } catch { /* background not reachable; quiet */ }
  }

  // Hydrate pause state BEFORE attaching the composer watch, so a paused
  // host is never observed even briefly on boot. Re-sync every 60s as a
  // fallback — Settings toggles also broadcast capture_toggle (below) for
  // an instant update on open tabs.
  void (async function bootCapture() {
    await syncCapturePaused();
    attachComposer();
    // Re-attach across SPA navigation / editor remounts. Cheap.
    setInterval(attachComposer, 1500);
    setInterval(syncCapturePaused, 60_000);
  })();

  // Settings → Capture toggles broadcast this so open tabs react instantly
  // instead of waiting for the next 60s sync.
  browser.runtime.onMessage.addListener((msg: unknown) => {
    if (typeof msg !== "object" || msg === null) return;
    const m = msg as { kind?: string; host?: string; off?: boolean };
    if (m.kind !== "capture_toggle") return;
    if (m.host !== location.hostname.replace(/^www\./, "")) return;
    applyCapturePaused(!!m.off);
  });

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
    if (capturePaused) return;                 // pausing capture pauses observation
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
      if (capturePaused || state.query.trim()) return;
      const q = text.slice(0, 140);
      setState({ proactiveQuery: q });
      void runSearch(q);
    }, PROACTIVE_DEBOUNCE_MS);
  });

  const handlers: PanelHandlers = {
    onSearch: (query: string) => {
      if (!query.trim()) {
        searchSeq += 1;
        setState({
          query: "",
          loading: false,
          hero: null,
          others: [],
          memories: [],
          proactiveQuery: null,
        });
        return;
      }
      setState({ query });
      debouncedManualSearch(query);
    },
    onCollapse: () => {
      setState({ collapsed: true });
      localStorage.setItem(COLLAPSED_STATE_KEY, "1");
    },
    onExpand: () => {
      setState({ collapsed: false });
      localStorage.removeItem(COLLAPSED_STATE_KEY);
    },
    onInjectMemories: (hits: MemoryRecallHit[]) => {
      void injectMemories(hits);
    },
    onInjectSingle: (hit: MemoryRecallHit) => {
      void injectMemories([hit]);
    },
    onOpenViewer: (convId: string, msgId: string, query: string) => {
      openViewer(convId, msgId, query);
    },
  };

  render = () => {
    applyHostShift(state.collapsed);

    if (state.collapsed) {
      if (!ui.querySelector(".rc-tab")) {
        ui.innerHTML = "";
        ui.appendChild(renderCollapsed(handlers));
      }
      return;
    }

    // Create panel skeleton once
    if (!ui.querySelector(".rc-panel")) {
      ui.innerHTML = "";
      ui.appendChild(renderExpanded(state, handlers));
      return;
    }

    // Targeted updates — don't destroy the input or scroll container.
    // populateBody() handles the full state machine (memories, currentChat,
    // currentChatUnknown, intro, empty, hero, others) identically to
    // renderExpanded() so incremental renders stay in sync.
    const body = ui.querySelector<HTMLElement>(".rc-body");
    if (body) populateBody(body, state, handlers);

    // Toast — may appear/disappear on any render (e.g. flashToast()).
    const panel = ui.querySelector<HTMLElement>(".rc-panel");
    if (panel) updateToast(panel, state.toast);

    // Update footer without rebuilding
    const statsEl = ui.querySelector(".rc-stats-count");
    if (statsEl) statsEl.textContent = String(state.msgsIndexed ?? "—");

    // Update loading indicator
    const loadingEl = ui.querySelector(".rc-loading") as HTMLElement | null;
    if (loadingEl) loadingEl.style.display = state.loading ? "" : "none";
  };

  // ─── Memory recall (the hero) ───
  // The thing that makes "your AI remembers you" real: relevant memories with
  // one-click injection straight into the composer.
  async function copyToClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* clipboard API can be blocked — fall through */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      ui.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  }

  async function injectMemories(hits: MemoryRecallHit[]): Promise<void> {
    if (hits.length === 0) return;
    const block = formatMemoryBlock(hits.map((h) => ({ text: h.text })));
    suppressComposerInput = true;
    const ok = injectText(block);
    window.setTimeout(() => { suppressComposerInput = false; }, 400);
    if (ok) {
      void sendToHelper({ type: "touch_memories", ids: hits.map((h) => h.id) }).catch(() => { });
      flashToast(hits.length === 1 ? "Added to your prompt ✓" : `Added ${hits.length} memories ✓`);
    } else {
      const copied = await copyToClipboard(block);
      if (copied) {
        void sendToHelper({ type: "touch_memories", ids: hits.map((h) => h.id) }).catch(() => { });
        flashToast("Copied — paste into your message box (Ctrl+V)");
      } else {
        flashToast("Click your message box once, then retry.");
      }
    }
  }

  let toastTimer: number | null = null;
  function flashToast(msg: string): void {
    setState({ toast: msg });
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => setState({ toast: null }), 2800);
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
type AnyReq = { type: string;[key: string]: any };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyResp = { ok: boolean; type: string; id: string;[key: string]: any };

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

// ─── styles (shadow-DOM-scoped) ─────────────────────────────────────────────

function injectStyles(shadow: ShadowRoot): void {
  // Load the vendored fonts once into the host page. They must live in the host
  // document's head, not in the shadow root — Chrome does not apply @font-face
  // declared inside a shadow tree. Nothing is fetched over the network: the
  // files ship inside the extension. If they fail to load for any reason, the
  // var() fallback chains below degrade to system fonts.
  injectFontFaces(document, (file) => browser.runtime.getURL(`/fonts/${file}`));

  const style = document.createElement("style");
  style.textContent = SIDEBAR_CSS
  shadow.appendChild(style);
}
