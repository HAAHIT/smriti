// The `domObserver` capture strategy.
//
// For sources whose network transport is not worth parsing — Gemini streams
// gRPC-web with double-encoded JSON arrays — we watch the DOM instead: spot
// turn elements, wait for each to stop mutating, then read its text. All of the
// mechanism (selector matching, settle debounce, dedup, SPA navigation
// re-scan) lives here; a connector supplies only its selectors.
//
// This is also the strategy a human-chat source uses, which is why `role` is a
// per-selector-group property rather than a hardcoded user/assistant pair.
//
// Runs in the ISOLATED world, so it can use browser.* directly and emits
// straight to the background worker — no postMessage bridge needed.

import type { CaptureEvent, Role, SourceId } from "@smriti/shared";

export interface RoleSelectors {
  role: Role;
  /** Tried in priority order; first match wins. Invalid selectors are skipped. */
  selectors: string[];
}

export interface DomConnectorDef {
  sourceId: SourceId;
  roleSelectors: RoleSelectors[];
  /** How long an element must stop mutating before we read it. */
  settleMs: number;
  /** Extract the conversation id from the current location. */
  convIdFromUrl(u: URL): string | null;
  /**
   * Pull the message text out of a turn element. Defaults to preferring a
   * markdown/content child over the element itself, to avoid capturing UI
   * chrome alongside the text.
   */
  textFrom?(el: Element): string;
  titleSuffix: RegExp;
  bareTitle: string;
}

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

/** Does `el` match any selector in the list? Invalid selectors are ignored. */
export function matchesAny(el: Element, selectors: string[]): boolean {
  for (const sel of selectors) {
    try {
      if (el.matches(sel)) return true;
    } catch {
      /* invalid selector for this element — skip */
    }
  }
  return false;
}

/** Which role, if any, does this element represent? First group wins. */
export function roleOf(el: Element, groups: RoleSelectors[]): Role | null {
  for (const g of groups) {
    if (matchesAny(el, g.selectors)) return g.role;
  }
  return null;
}

/**
 * A dedup key stable across re-renders of the same turn: role + a hash of the
 * element's sibling-index path + a text prefix.
 *
 * Deliberately not identity-based — the SPA re-creates nodes.
 */
export function elementKey(el: Element, role: string): string {
  const text = (el.textContent ?? "").trim().slice(0, 60);
  let pathIdx = 0;
  let cur: Element | null = el;
  let depth = 0;
  while (cur && cur.parentElement && depth < 8) {
    const siblings = Array.from(cur.parentElement.children);
    pathIdx = pathIdx * 31 + siblings.indexOf(cur);
    cur = cur.parentElement;
    depth++;
    if (cur === document.body) break;
  }
  return `${role}:${pathIdx}:${text}`;
}

function defaultTextFrom(el: Element): string {
  const inner =
    el.querySelector(".markdown") ??
    el.querySelector("[class*='response-text']") ??
    el.querySelector("[class*='content']") ??
    el;
  return (inner.textContent ?? "").trim();
}

// ─── The strategy ────────────────────────────────────────────────────────────

export function installDomObserver(def: DomConnectorDef): void {
  // eslint-disable-next-line no-console
  console.debug(`[smriti] ${def.sourceId}: DOM observer active`);

  const seenKeys = new Set<string>();
  const textFrom = def.textFrom ?? defaultTextFrom;
  const allSelectors = def.roleSelectors.flatMap((g) => g.selectors);

  function emit(events: CaptureEvent[]): void {
    if (events.length === 0) return;
    browser.runtime.sendMessage({ kind: "capture", events }).catch(() => {
      // The service worker may be dormant; one retry, then give up loudly.
      setTimeout(() => {
        browser.runtime.sendMessage({ kind: "capture", events }).catch(() => {
          // eslint-disable-next-line no-console
          console.warn(`[smriti:${def.sourceId}] sendMessage failed twice — dropped`);
        });
      }, 500);
    });
  }

  function convId(): string | null {
    try {
      return def.convIdFromUrl(new URL(window.location.href));
    } catch {
      return null;
    }
  }

  function title(): string | undefined {
    const t = document.title;
    if (!t || t === def.bareTitle) return undefined;
    return t.replace(def.titleSuffix, "").trim() || undefined;
  }

  function settleAndCapture(el: Element, role: Role): void {
    const cid = convId();
    if (!cid) return;
    const key = elementKey(el, role);
    if (seenKeys.has(key)) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const obs = new MutationObserver(() => schedule());

    const schedule = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        obs.disconnect();
        const text = textFrom(el);
        if (!text) return;
        // Re-check after settling: the key includes a text prefix, so it only
        // becomes final once the element has stopped changing.
        const finalKey = elementKey(el, role);
        if (seenKeys.has(finalKey)) return;
        seenKeys.add(finalKey);
        seenKeys.add(key);

        const now = new Date().toISOString();
        emit([
          {
            kind: "conversation_seen",
            platform: def.sourceId,
            platform_conv_id: cid,
            title: title(),
            url: window.location.href,
            observed_at: now,
          },
          {
            kind: "message_appended",
            platform: def.sourceId,
            platform_conv_id: cid,
            role,
            content_text: text,
            created_at: now,
            // Within-batch hint only — ingest assigns the real dense position.
            position: 0,
          },
        ]);
      }, def.settleMs);
    };

    obs.observe(el, { childList: true, subtree: true, characterData: true });
    schedule();
  }

  function scanRoot(root: Node): void {
    if (!(root instanceof Element)) return;

    const hits: Element[] = allSelectors.flatMap((s) => {
      try {
        return Array.from(root.querySelectorAll(s));
      } catch {
        return [];
      }
    });
    if (matchesAny(root, allSelectors)) hits.push(root);

    const seen = new Set<Element>();
    for (const el of hits) {
      if (seen.has(el)) continue;
      seen.add(el);
      const role = roleOf(el, def.roleSelectors);
      if (role) settleAndCapture(el, role);
    }
  }

  // Anything already rendered (resuming an existing conversation).
  scanRoot(document.body);

  const rootObs = new MutationObserver((mutations) => {
    for (const m of mutations) m.addedNodes.forEach((n) => scanRoot(n));
  });
  rootObs.observe(document.body, { childList: true, subtree: true });

  // SPA navigation changes the URL without a reload, so re-scan on change.
  let lastUrl = window.location.href;
  const navObs = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      setTimeout(() => scanRoot(document.body), 1200);
    }
  });
  navObs.observe(document.documentElement, { childList: true, subtree: false });
}
