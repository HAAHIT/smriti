// lib/sidebar-renderers.ts
import type { PanelState, PanelHandlers, HydratedHero, CurrentChat } from "./sidebar-types";
import type { SearchHit, MemoryRecallHit, OutlineSegment } from "@smriti/shared";
import {
  escapeHtml,
  formatDate,
  providerBadge,
  currentPlatform,
  reportIssueUrl,
  memoryKindMeta,
} from "./sidebar-helpers";

export function renderCollapsed(handlers: PanelHandlers): HTMLElement {
  const el = document.createElement("button");
  el.className = "rc-tab";
  el.setAttribute("title", "Open Smriti");
  el.innerHTML = `
    <span class="rc-tab-title">Smriti</span>
    <span class="rc-tab-sub">past you</span>
  `;
  el.addEventListener("click", () => {
    handlers.onExpand();
  });
  return el;
}

/**
 * Populate the `.rc-body` container with the correct children for the current
 * panel state.  Shared between renderExpanded() (initial mount) and the
 * incremental render() path so every state-machine branch is handled
 * identically.
 */
export function populateBody(body: HTMLElement, state: PanelState, handlers: PanelHandlers): void {
  body.innerHTML = "";

  // Memory recall — always at the very top when present.
  if (state.memories.length > 0) {
    body.appendChild(renderMemoryRecall(state.memories, handlers));
  }

  // Current chat outline — shown only when there's no active search query.
  const showCurrent = !state.query.trim() && state.currentChat?.meta;
  if (showCurrent) {
    body.appendChild(renderCurrentChat(state.currentChat!, handlers));
  } else if (!state.query.trim() && state.currentChat && !state.currentChat.meta) {
    body.appendChild(renderCurrentChatUnknown(state.currentChat));
  }

  // Main content: intro / empty / hero+others.
  const havingSomething = state.hero || state.query.trim() || state.proactiveQuery;
  if (!havingSomething && !showCurrent) {
    body.appendChild(renderIntro(handlers));
  } else if (state.query.trim() && !state.hero && !state.loading) {
    body.appendChild(renderEmpty(state.query));
  } else {
    if (state.hero) {
      body.appendChild(renderHero(state.hero, state, handlers));
    }
    if (state.others.length > 0) {
      body.appendChild(renderOthers(state.others, state, handlers));
    }
  }
}

/**
 * Create, update, or remove the `.rc-toast` overlay inside the panel.
 * Safe to call on every render — avoids a full remount.
 */
export function updateToast(panel: HTMLElement, toast: string | null): void {
  let el = panel.querySelector<HTMLElement>(".rc-toast");
  if (toast) {
    if (!el) {
      el = document.createElement("div");
      el.className = "rc-toast";
      panel.appendChild(el);
    }
    el.textContent = toast;
  } else {
    el?.remove();
  }
}

export function renderExpanded(state: PanelState, handlers: PanelHandlers): HTMLElement {
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
      <span class="rc-mono rc-muted-text rc-loading" style="display:${state.loading ? '' : 'none'}">…</span>
    </div>
  `;
  panel.appendChild(header);

  const input = header.querySelector<HTMLInputElement>(".rc-search-input")!;
  input.value = state.query;
  input.addEventListener("input", (e) => {
    const v = (e.target as HTMLInputElement).value;
    handlers.onSearch(v);
  });

  header.querySelector("[data-act=close]")?.addEventListener("click", () => {
    handlers.onCollapse();
  });

  // Body
  const body = document.createElement("div");
  body.className = "rc-body";
  populateBody(body, state, handlers);
  panel.appendChild(body);

  // Footer
  const footer = document.createElement("div");
  footer.className = "rc-footer";
  footer.innerHTML = `
    <span class="rc-dot rc-dot-green"></span>
    <span class="rc-mono">local</span>
    <span class="rc-divider">·</span>
    <span class="rc-mono"><span class="rc-stats-count">${state.msgsIndexed === null ? "—" : state.msgsIndexed}</span> msgs indexed</span>
    <div class="rc-spacer"></div>
    <span class="rc-mono rc-muted-text">MiniLM-L6</span>
    <span class="rc-divider">·</span>
    <a class="rc-link" href="${reportIssueUrl(currentPlatform())}" target="_blank" rel="noopener">Report an issue ↗</a>
  `;
  panel.appendChild(footer);

  updateToast(panel, state.toast);

  return panel;
}

export function renderHero(hero: HydratedHero, state: PanelState, handlers: PanelHandlers): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "rc-hero-wrap";

  const h = hero;
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
      <span>${escapeHtml(provider.label)}</span>
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
      ? renderChapterList(segments, h.matchedChapterIdx, h.hit.conversation_id, handlers)
      : `<div class="rc-empty-inline">Indexing this conversation — chapters appear as embeddings finish.</div>`}
    <button class="rc-cta" data-open-conv="${escapeHtml(h.hit.conversation_id)}" data-msg-id="${escapeHtml(h.hit.message_id)}">
      Open in Smriti →
    </button>
  `;

  // Click handlers for chapter buttons (they carry data-conv-id + data-msg-id).
  card.querySelectorAll<HTMLButtonElement>(".rc-chapter").forEach((b) => {
    b.addEventListener("click", () => {
      const cid = b.getAttribute("data-conv-id") ?? h.hit.conversation_id;
      const mid = b.getAttribute("data-msg-id") ?? h.hit.message_id;
      handlers.onOpenViewer(cid, mid, state.query.trim() || state.proactiveQuery || "");
    });
  });

  card.querySelector<HTMLButtonElement>(".rc-cta")?.addEventListener("click", () => {
    handlers.onOpenViewer(h.hit.conversation_id, h.hit.message_id, state.query.trim() || state.proactiveQuery || "");
  });

  wrap.appendChild(card);
  return wrap;
}

export function renderMemoryRecall(hits: MemoryRecallHit[], handlers: PanelHandlers): HTMLElement {
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
            ${prov ? `<div class="rc-mem-src"><span class="rc-provider" style="--p:${prov.color}"></span>${escapeHtml(prov.label)} · ${formatDate(h.created_at)}</div>` : ""}
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
      if (h) handlers.onInjectSingle(h);
    });
  });

  wrap.querySelector<HTMLButtonElement>("[data-inject-all]")?.addEventListener("click", () => {
    handlers.onInjectMemories(hits);
  });

  return wrap;
}

export function renderChapterList(
  segments: OutlineSegment[],
  matchedIdx: number,
  convId: string,
  handlers: PanelHandlers
): string {
  if (segments.length === 0) return "";
  return `
    <div class="rc-chapter-list">
      ${segments.map((s, i) => `
        <button class="rc-chapter ${i === matchedIdx ? "rc-chapter-active" : ""}"
                data-conv-id="${escapeHtml(convId)}" data-msg-id="${escapeHtml(s.start_message_id)}">
          <span class="rc-mono rc-chapter-num">${String(i + 1).padStart(2, "0")}</span>
          <span class="rc-chapter-title">${escapeHtml(s.preview || "(no preview)")}</span>
        </button>
      `).join("")}
    </div>
  `;
}

export function renderIntro(handlers: PanelHandlers): HTMLElement {
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
      handlers.onSearch(q);
    });
  });

  return el;
}

export function renderEmpty(query: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "rc-empty";
  el.innerHTML = `
    <div class="rc-empty-title">Nothing for &ldquo;${escapeHtml(query)}&rdquo; yet.</div>
    <div class="rc-empty-sub">Try a vaguer phrase — semantic recall catches paraphrase.</div>
  `;
  return el;
}

export function renderCurrentChat(cc: CurrentChat, handlers: PanelHandlers): HTMLElement {
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
        <span>${escapeHtml(provider.label)}</span>
        <span class="rc-divider">·</span>
        <span class="rc-mono">${meta.message_count} msgs</span>
        <span class="rc-divider">·</span>
        <span class="rc-mono">${total} ${total === 1 ? "chapter" : "chapters"}</span>
      </div>
      ${renderChapterList(cc.segments, -1, meta.id, handlers)}
      ${total === 0 ? `
        <div class="rc-empty-inline">Indexing this conversation — chapters appear as embeddings finish.</div>
      ` : ""}
    </div>
  `;

  wrap.querySelectorAll<HTMLButtonElement>("[data-conv-id][data-msg-id]").forEach((b) => {
    b.addEventListener("click", () => {
      handlers.onOpenViewer(b.getAttribute("data-conv-id")!, b.getAttribute("data-msg-id") ?? "", "");
    });
  });

  return wrap;
}

export function renderCurrentChatUnknown(cc: CurrentChat): HTMLElement {
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

export function renderOthers(
  items: Array<{ hit: SearchHit; matchPct: number; why: string }>,
  state: PanelState,
  handlers: PanelHandlers
): HTMLElement {
  const el = document.createElement("div");
  el.className = "rc-others";
  el.innerHTML = `
    <div class="rc-smallcaps rc-muted-text rc-others-header">Also relevant</div>
    <div class="rc-others-list">
      ${items.map((it) => {
        const provider = providerBadge(it.hit.platform);
        const date = formatDate(it.hit.last_message_at);
        return `
          <button class="rc-card" data-open-conv="${escapeHtml(it.hit.conversation_id)}" data-msg-id="${escapeHtml(it.hit.message_id)}">
            <div class="rc-card-title">${escapeHtml(it.hit.title ?? "(untitled)")}</div>
            <div class="rc-card-meta">
              <span class="rc-provider" style="--p:${provider.color}"></span>
              <span>${escapeHtml(provider.label)}</span>
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
      handlers.onOpenViewer(cid, mid, state.query.trim() || state.proactiveQuery || "");
    });
  });

  return el;
}