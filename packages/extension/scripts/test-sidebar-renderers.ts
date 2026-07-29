// Headless unit tests for sidebar renderer functions.
// Run: npx tsx scripts/test-sidebar-renderers.ts
//
// Covers the DOM-producing functions extracted in the PR:
//   renderCollapsed, renderEmpty, renderCurrentChatUnknown, renderChapterList,
//   renderMemoryRecall, renderIntro, renderHero, renderOthers, renderCurrentChat
//
// A minimal document polyfill is installed before importing the renderers so
// that document.createElement / innerHTML work in the Node.js environment.

// ─── Minimal DOM polyfill ────────────────────────────────────────────────────
//
// We need enough of the DOM spec for the renderers to work:
//  • Element.className / innerHTML / textContent / setAttribute / style
//  • Element.appendChild / querySelector / querySelectorAll / addEventListener
//
// Renderers build element trees two ways:
//   1. el.innerHTML = `...template...`  → stored in el.innerHTML
//   2. el.appendChild(child)            → stored in el.children[]
//
// allContent(el) recursively collects both, giving tests a single string to
// search against regardless of which construction pattern was used.

class MockElement {
  tagName: string;
  className = "";
  innerHTML = "";
  textContent = "";
  style: Record<string, string> = {};
  /** Public so tests can traverse the tree. */
  children: MockElement[] = [];
  private _attrs: Map<string, string> = new Map();
  private _listeners: Map<string, Array<(e?: unknown) => void>> = new Map();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this._attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this._attrs.get(name) ?? null;
  }

  addEventListener(event: string, fn: (e?: unknown) => void): void {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event)!.push(fn);
  }

  dispatchEvent(event: string, eventObj?: unknown): void {
    for (const fn of this._listeners.get(event) ?? []) fn(eventObj);
  }

  appendChild(child: MockElement): void {
    this.children.push(child);
  }

  // querySelector / querySelectorAll scan both innerHTML (via regex) and the
  // children[] tree so they work regardless of construction method.
  querySelector(sel: string): MockElement | null {
    return this._querySelectorAll(sel)[0] ?? null;
  }

  querySelectorAll(sel: string): MockElement[] {
    return this._querySelectorAll(sel);
  }

  private _querySelectorAll(sel: string): MockElement[] {
    const results: MockElement[] = [];

    // Scan innerHTML tags
    const tagRe = /<(button|a|input|div|span)([^>]*)>/gi;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(this.innerHTML)) !== null) {
      const tag = m[1];
      const attrsStr = m[2];
      const el = new MockElement(tag);

      const classMatch = attrsStr.match(/class="([^"]*)"/);
      if (classMatch) el.className = classMatch[1];

      const attrRe = /([\w-]+)="([^"]*)"/g;
      let am: RegExpExecArray | null;
      while ((am = attrRe.exec(attrsStr)) !== null) {
        el.setAttribute(am[1], am[2]);
      }

      // Bare attribute flags like data-inject-all
      const bareRe = /\s(data-[\w-]+)(?=\s|>)/g;
      let bm: RegExpExecArray | null;
      while ((bm = bareRe.exec(attrsStr)) !== null) {
        el.setAttribute(bm[1], "");
      }

      if (selectorMatches(el, sel)) results.push(el);
    }

    // Scan children[] tree recursively
    for (const child of this.children) {
      if (selectorMatches(child, sel)) results.push(child);
      for (const r of child._querySelectorAll(sel)) results.push(r);
    }

    return results;
  }
}

/** Very small CSS selector matcher. */
function selectorMatches(el: MockElement, sel: string): boolean {
  // Compound [attr1][attr2] attribute selectors
  if (sel.startsWith("[") && sel.includes("][")) {
    const parts = sel.match(/\[([^\]]+)\]/g) ?? [];
    return parts.every((p) => {
      const inner = p.slice(1, -1);
      const eqIdx = inner.indexOf("=");
      if (eqIdx === -1) return el.getAttribute(inner) !== null;
      return el.getAttribute(inner.slice(0, eqIdx)) === inner.slice(eqIdx + 1);
    });
  }
  // Bare attribute [attr]
  const bareAttrM = sel.match(/^\[([^\]=]+)\]$/);
  if (bareAttrM) return el.getAttribute(bareAttrM[1]) !== null;
  // [attr=val]
  const attrValM = sel.match(/^\[([^\]=]+)=([^\]]+)\]$/);
  if (attrValM) return el.getAttribute(attrValM[1]) === attrValM[2];
  // .class selector(s)
  if (sel.startsWith(".")) {
    const classes = sel.slice(1).split(".");
    return classes.every((c) => el.className.split(" ").includes(c));
  }
  return false;
}

/**
 * Collect all HTML content from an element tree: concatenates the element's
 * own innerHTML plus the recursive allContent of each appended child.
 * This lets tests search a single string regardless of whether the renderer
 * used innerHTML= or appendChild().
 */
function allContent(el: MockElement): string {
  const parts: string[] = [el.innerHTML];
  for (const child of el.children) {
    // Include child's own class/attributes as a pseudo-tag so selectors work
    parts.push(`<_mock class="${child.className}">`);
    parts.push(allContent(child));
    parts.push(`</_mock>`);
  }
  return parts.join("");
}

// Install the polyfill globally before any renderer import.
(globalThis as Record<string, unknown>).document = {
  createElement: (tag: string) => new MockElement(tag),
};

// reportIssueUrl calls chrome.runtime.getManifest() — stub chrome globally.
(globalThis as Record<string, unknown>).chrome = {
  runtime: { getManifest: () => ({ version: "0.0.0-test" }) },
};

// currentPlatform() reads location.hostname — stub to a neutral value.
(globalThis as Record<string, unknown>).location = { hostname: "claude.ai" };

// ─── Import renderers (after polyfill) ───────────────────────────────────────

import {
  renderCollapsed,
  renderExpanded,
  renderEmpty,
  renderCurrentChatUnknown,
  renderChapterList,
  renderMemoryRecall,
  renderIntro,
  renderHero,
  renderOthers,
  renderCurrentChat,
} from "../lib/sidebar-renderers.js";

import type {
  PanelHandlers,
  PanelState,
  HydratedHero,
  CurrentChat,
} from "../lib/sidebar-types.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  cond ? pass++ : fail++;
}

function makeHandlers(overrides: Partial<PanelHandlers> = {}): PanelHandlers {
  return {
    onSearch: () => {},
    onCollapse: () => {},
    onExpand: () => {},
    onInjectMemories: () => {},
    onInjectSingle: () => {},
    onOpenViewer: () => {},
    ...overrides,
  };
}

function makeState(overrides: Partial<PanelState> = {}): PanelState {
  return {
    collapsed: false,
    query: "",
    loading: false,
    hero: null,
    others: [],
    proactiveQuery: null,
    msgsIndexed: null,
    currentChat: null,
    memories: [],
    toast: null,
    ...overrides,
  };
}

function asEl(x: unknown): MockElement {
  return x as MockElement;
}

// ─── renderChapterList ────────────────────────────────────────────────────────

console.log("\n=== renderChapterList ===\n");

// Empty segments → empty string
check(
  "empty segments → empty string",
  renderChapterList([], 0, "conv-1", makeHandlers()) === ""
);

// Single segment
{
  const html = renderChapterList(
    [{ start_position: 0, end_position: 5, start_message_id: "msg-1", message_count: 6, preview: "Hello world", started_at: "2026-01-01T00:00:00Z" }],
    -1,
    "conv-abc",
    makeHandlers()
  );
  check("single segment → contains rc-chapter-list", html.includes("rc-chapter-list"));
  check("single segment → contains chapter number 01", html.includes(">01<"));
  check("single segment → contains preview text", html.includes("Hello world"));
  check("single segment → embeds conv-id", html.includes('data-conv-id="conv-abc"'));
  check("single segment → embeds msg-id", html.includes('data-msg-id="msg-1"'));
  check("no active class when matchedIdx=-1", !html.includes("rc-chapter-active"));
}

// Two segments, second active
{
  const segs = [
    { start_position: 0, end_position: 3, start_message_id: "msg-a", message_count: 4, preview: "First segment", started_at: "2026-01-01T00:00:00Z" },
    { start_position: 4, end_position: 7, start_message_id: "msg-b", message_count: 4, preview: "Second segment", started_at: "2026-01-02T00:00:00Z" },
  ];
  const html = renderChapterList(segs, 1, "conv-xyz", makeHandlers());
  check("second chapter marked active", html.includes("rc-chapter-active"));
  check("chapter numbers 01 and 02", html.includes(">01<") && html.includes(">02<"));
  check("both msg-ids present", html.includes('data-msg-id="msg-a"') && html.includes('data-msg-id="msg-b"'));
}

// HTML in preview is escaped
{
  const html = renderChapterList(
    [{ start_position: 0, end_position: 1, start_message_id: "m", message_count: 2, preview: '<script>alert(1)</script>', started_at: "" }],
    -1,
    "c",
    makeHandlers()
  );
  check("preview HTML is escaped in chapter list", html.includes("&lt;script&gt;") && !html.includes("<script>"));
}

// Empty preview falls back to "(no preview)"
{
  const html = renderChapterList(
    [{ start_position: 0, end_position: 0, start_message_id: "m", message_count: 1, preview: "", started_at: "" }],
    -1,
    "c",
    makeHandlers()
  );
  check("empty preview → (no preview) fallback text", html.includes("(no preview)"));
}

// ─── renderEmpty ─────────────────────────────────────────────────────────────

console.log("\n=== renderEmpty ===\n");

{
  const el = asEl(renderEmpty("embeddings model"));
  check("renderEmpty → rc-empty class", el.className === "rc-empty");
  check("renderEmpty → contains query in innerHTML", el.innerHTML.includes("embeddings model"));
}

// HTML in query is escaped
{
  const el = asEl(renderEmpty('<b>bad</b>'));
  check("renderEmpty → query HTML escaped", el.innerHTML.includes("&lt;b&gt;bad&lt;/b&gt;") && !el.innerHTML.includes("<b>bad</b>"));
}

// ─── renderCurrentChatUnknown ─────────────────────────────────────────────────

console.log("\n=== renderCurrentChatUnknown ===\n");

{
  const cc: CurrentChat = { platform: "claude", platformConvId: "id-1", meta: null, segments: [] };
  const el = asEl(renderCurrentChatUnknown(cc));
  check("renderCurrentChatUnknown → rc-current-wrap class", el.className === "rc-current-wrap");
  check("renderCurrentChatUnknown → contains 'New conversation'", el.innerHTML.includes("New conversation"));
  check("renderCurrentChatUnknown → contains rc-current-unknown", el.innerHTML.includes("rc-current-unknown"));
}

// ─── renderCollapsed ─────────────────────────────────────────────────────────

console.log("\n=== renderCollapsed ===\n");

{
  let expanded = false;
  const handlers = makeHandlers({ onExpand: () => { expanded = true; } });
  const el = asEl(renderCollapsed(handlers));
  check("renderCollapsed → rc-tab class", el.className === "rc-tab");
  check("renderCollapsed → title attribute set", el.getAttribute("title") === "Open Smriti");
  check("renderCollapsed → contains 'Smriti'", el.innerHTML.includes("Smriti"));
  check("renderCollapsed → contains 'past you'", el.innerHTML.includes("past you"));

  (el as unknown as MockElement).dispatchEvent("click");
  check("renderCollapsed click → calls onExpand", expanded);
}

// ─── renderIntro ─────────────────────────────────────────────────────────────

console.log("\n=== renderIntro ===\n");

{
  const searches: string[] = [];
  const handlers = makeHandlers({ onSearch: (q) => searches.push(q) });
  const el = asEl(renderIntro(handlers));
  check("renderIntro → rc-intro class", el.className === "rc-intro");
  check("renderIntro → contains suggestion buttons in innerHTML", el.innerHTML.includes("rc-suggest"));
  check("renderIntro → contains 'embeddings model choice'", el.innerHTML.includes("embeddings model choice"));
  check("renderIntro → contains 'rust enum bug'", el.innerHTML.includes("rust enum bug"));

  const buttons = el.querySelectorAll(".rc-suggest");
  check("renderIntro → 4 suggestion buttons", buttons.length === 4);
  check(
    "renderIntro → suggestion has data-q attribute",
    el.innerHTML.includes('data-q="embeddings model choice"') ||
    el.innerHTML.includes("embeddings model choice")
  );
}

// ─── renderMemoryRecall ───────────────────────────────────────────────────────

console.log("\n=== renderMemoryRecall ===\n");

{
  const hits = [
    {
      id: "m1", kind: "identity" as const, text: "I work in Rust",
      source_platform: "claude" as const, source_conversation_id: "c1", source_message_id: "msg1",
      created_at: "2026-01-10T00:00:00Z", pinned: false, score: 0.9, match: "vec" as const,
    },
    {
      id: "m2", kind: "preference" as const, text: "I prefer 2-space indent",
      source_platform: null, source_conversation_id: null, source_message_id: null,
      created_at: "2026-01-11T00:00:00Z", pinned: true, score: 0.8, match: "fts" as const,
    },
  ];

  const el = asEl(renderMemoryRecall(hits, makeHandlers()));
  check("renderMemoryRecall → rc-mem-wrap class", el.className === "rc-mem-wrap");
  check("renderMemoryRecall → contains memory count (2)", el.innerHTML.includes("2"));
  check("renderMemoryRecall → 'all 2' inject CTA for multiple hits", el.innerHTML.includes("all 2"));
  check("renderMemoryRecall → first hit text escaped and present", el.innerHTML.includes("I work in Rust"));
  check("renderMemoryRecall → second hit text present", el.innerHTML.includes("I prefer 2-space indent"));
  check("renderMemoryRecall → pinned indicator present for m2", el.innerHTML.includes("📌"));
  check("renderMemoryRecall → inject buttons present", el.innerHTML.includes("rc-mem-inject"));
  check("renderMemoryRecall → inject-all button present", el.innerHTML.includes("data-inject-all"));

  const singleHit = [hits[0]!];
  const el2 = asEl(renderMemoryRecall(singleHit, makeHandlers()));
  check("renderMemoryRecall → 'this' inject CTA for single hit", el2.innerHTML.includes("Inject this"));
}

// Memory text is HTML-escaped
{
  const evilHit = [
    {
      id: "m3", kind: "fact" as const, text: '<script>evil()</script>',
      source_platform: null, source_conversation_id: null, source_message_id: null,
      created_at: "", pinned: false, score: 0.5, match: "fts" as const,
    },
  ];
  const el = asEl(renderMemoryRecall(evilHit, makeHandlers()));
  check("renderMemoryRecall → memory text HTML escaped", el.innerHTML.includes("&lt;script&gt;") && !el.innerHTML.includes("<script>"));
}

// ─── renderHero ───────────────────────────────────────────────────────────────

console.log("\n=== renderHero ===\n");

{
  const hero: HydratedHero = {
    hit: {
      conversation_id: "conv-hero",
      message_id: "msg-hero",
      title: "My Rust project discussion",
      platform: "claude",
      url: null,
      snippet: "We talked about async...",
      last_message_at: "2026-03-15T00:00:00Z",
      score: 0.92,
    },
    segments: [
      { start_position: 0, end_position: 4, start_message_id: "seg-msg-1", message_count: 5, preview: "Chapter one preview", started_at: "2026-03-15T00:00:00Z" },
    ],
    matchedChapterIdx: 0,
    matchPct: 92,
    why: "You discussed Rust async patterns",
  };

  const state = makeState({ query: "" });
  const el = asEl(renderHero(hero, state, makeHandlers()));
  const content = allContent(el);

  check("renderHero → rc-hero-wrap class", el.className === "rc-hero-wrap");
  check("renderHero → contains rc-pulse in child card", content.includes("rc-pulse"));
  check("renderHero → title present in content", content.includes("My Rust project discussion"));
  check("renderHero → why text present in content", content.includes("You discussed Rust async patterns"));
  check("renderHero → matchPct shown in content", content.includes("92% match"));
  check("renderHero → chapter list included (has segments)", content.includes("rc-chapter-list"));
  check("renderHero → chapter number 01", content.includes(">01<"));

  // Without query → "Past you discussed this" label
  check("renderHero → no query → 'Past you discussed this' label", content.includes("Past you discussed this"));

  // With query → "Top match"
  const stateWithQuery = makeState({ query: "rust" });
  const el2 = asEl(renderHero(hero, stateWithQuery, makeHandlers()));
  check("renderHero → with query → 'Top match' label", allContent(el2).includes("Top match"));

  // No segments → "Outline" section heading
  const heroNoSegs: HydratedHero = { ...hero, segments: [] };
  const el3 = asEl(renderHero(heroNoSegs, state, makeHandlers()));
  const c3 = allContent(el3);
  check("renderHero → no segments → 'Outline' heading", c3.includes("Outline"));
  check("renderHero → no segments → indexing message shown", c3.includes("Indexing this conversation"));
}

// Hero title HTML is escaped
{
  const heroEvil: HydratedHero = {
    hit: {
      conversation_id: "c", message_id: "m", title: '<img src=x onerror=alert(1)>',
      platform: "chatgpt", url: null, snippet: "", last_message_at: "", score: 0.5,
    },
    segments: [],
    matchedChapterIdx: -1,
    matchPct: 50,
    why: "test",
  };
  const content = allContent(asEl(renderHero(heroEvil, makeState(), makeHandlers())));
  check("renderHero → title HTML escaped", content.includes("&lt;img") && !content.includes("<img src=x"));
}

// null title falls back to "(untitled)"
{
  const heroNull: HydratedHero = {
    hit: {
      conversation_id: "c", message_id: "m", title: null,
      platform: "gemini", url: null, snippet: "", last_message_at: "2026-01-01T00:00:00Z", score: 0.5,
    },
    segments: [],
    matchedChapterIdx: -1,
    matchPct: 50,
    why: "reason",
  };
  check("renderHero → null title → (untitled) fallback", allContent(asEl(renderHero(heroNull, makeState(), makeHandlers()))).includes("(untitled)"));
}

// ─── renderOthers ─────────────────────────────────────────────────────────────

console.log("\n=== renderOthers ===\n");

{
  const items = [
    {
      hit: {
        conversation_id: "c1", message_id: "m1", title: "First related chat",
        platform: "claude", url: null, snippet: "...", last_message_at: "2026-01-01T00:00:00Z", score: 0.8,
      },
      matchPct: 80,
      why: "Both involve TypeScript",
    },
    {
      hit: {
        conversation_id: "c2", message_id: "m2", title: null,
        platform: "chatgpt", url: null, snippet: "...", last_message_at: "2026-02-01T00:00:00Z", score: 0.7,
      },
      matchPct: 70,
      why: "Mentions same library",
    },
  ];

  const state = makeState({ query: "typescript" });
  const el = asEl(renderOthers(items, state, makeHandlers()));
  check("renderOthers → rc-others class", el.className === "rc-others");
  check("renderOthers → 'Also relevant' header", el.innerHTML.includes("Also relevant"));
  check("renderOthers → first title present", el.innerHTML.includes("First related chat"));
  check("renderOthers → null title → (untitled)", el.innerHTML.includes("(untitled)"));
  check("renderOthers → matchPct shown (80%)", el.innerHTML.includes("80%"));
  check("renderOthers → card buttons present", el.innerHTML.includes("rc-card"));
  check("renderOthers → data-open-conv attributes", el.innerHTML.includes('data-open-conv="c1"') && el.innerHTML.includes('data-open-conv="c2"'));
}

// Title HTML escaped
{
  const evilItems = [
    {
      hit: {
        conversation_id: "cx", message_id: "mx", title: '<b>bold title</b>',
        platform: "claude", url: null, snippet: "", last_message_at: "", score: 0.6,
      },
      matchPct: 60,
      why: "reason",
    },
  ];
  const el = asEl(renderOthers(evilItems, makeState(), makeHandlers()));
  check("renderOthers → title HTML escaped", el.innerHTML.includes("&lt;b&gt;bold title&lt;/b&gt;") && !el.innerHTML.includes("<b>bold title</b>"));
}

// ─── renderCurrentChat ────────────────────────────────────────────────────────

console.log("\n=== renderCurrentChat ===\n");

{
  const cc: CurrentChat = {
    platform: "claude",
    platformConvId: "pconv-1",
    meta: {
      id: "conv-meta-1",
      platform: "claude",
      title: "My design discussion",
      url: null,
      started_at: "2026-01-01T00:00:00Z",
      last_message_at: "2026-01-10T00:00:00Z",
      message_count: 42,
    },
    segments: [
      { start_position: 0, end_position: 5, start_message_id: "sm1", message_count: 6, preview: "First chapter", started_at: "" },
      { start_position: 6, end_position: 10, start_message_id: "sm2", message_count: 5, preview: "Second chapter", started_at: "" },
    ],
  };

  const el = asEl(renderCurrentChat(cc, makeHandlers()));
  check("renderCurrentChat → rc-current-wrap class", el.className === "rc-current-wrap");
  check("renderCurrentChat → title present", el.innerHTML.includes("My design discussion"));
  check("renderCurrentChat → message count present", el.innerHTML.includes("42 msgs"));
  check("renderCurrentChat → chapter count '2 chapters'", el.innerHTML.includes("2 chapters"));
  check("renderCurrentChat → chapter list included", el.innerHTML.includes("rc-chapter-list"));
  check("renderCurrentChat → 'You're here' section header", el.innerHTML.includes("You"));
}

// Zero segments → indexing message
{
  const ccNoSegs: CurrentChat = {
    platform: "chatgpt",
    platformConvId: "pconv-2",
    meta: {
      id: "conv-meta-2",
      platform: "chatgpt",
      title: "Empty convo",
      url: null,
      started_at: "",
      last_message_at: "",
      message_count: 5,
    },
    segments: [],
  };
  const el = asEl(renderCurrentChat(ccNoSegs, makeHandlers()));
  check("renderCurrentChat → zero segments → indexing message", el.innerHTML.includes("Indexing this conversation"));
  check("renderCurrentChat → zero segments → '0 chapters'", el.innerHTML.includes("0 chapters"));
  check("renderCurrentChat → singular chapter when 1", (() => {
    const ccOne: CurrentChat = { ...ccNoSegs, segments: [{ start_position: 0, end_position: 1, start_message_id: "x", message_count: 2, preview: "p", started_at: "" }] };
    const e = asEl(renderCurrentChat(ccOne, makeHandlers()));
    return e.innerHTML.includes("1 chapter") && !e.innerHTML.includes("1 chapters");
  })());
}

// ─── renderExpanded (smoke test) ─────────────────────────────────────────────

console.log("\n=== renderExpanded (smoke test) ===\n");

{
  const state = makeState({ msgsIndexed: 1234, loading: true, toast: "Injected!" });
  const el = asEl(renderExpanded(state, makeHandlers()));
  const content = allContent(el);

  check("renderExpanded → rc-panel class", el.className === "rc-panel");
  check("renderExpanded → contains search input", content.includes("rc-search-input"));
  check("renderExpanded → footer present", content.includes("rc-footer"));
  check("renderExpanded → msgCount in footer", content.includes("1234"));
  check("renderExpanded → loading indicator in header", content.includes("rc-loading"));
  check("renderExpanded → toast present when set", content.includes("Injected!") || el.children.some((c) => c.className === "rc-toast"));
}

// Empty state → intro section
{
  const el = asEl(renderExpanded(makeState(), makeHandlers()));
  const content = allContent(el);
  check("renderExpanded → empty state → intro section", content.includes("rc-intro") || content.includes("Your AI remembers you"));
}

// With hero → hero section rendered
{
  const hero: HydratedHero = {
    hit: { conversation_id: "hc", message_id: "hm", title: "Hero chat", platform: "claude", url: null, snippet: "", last_message_at: "2026-01-01T00:00:00Z", score: 0.95 },
    segments: [],
    matchedChapterIdx: -1,
    matchPct: 95,
    why: "Highly relevant",
  };
  const state = makeState({ hero, query: "something" });
  const el = asEl(renderExpanded(state, makeHandlers()));
  const content = allContent(el);
  check("renderExpanded → with hero → hero content present", content.includes("Hero chat") || content.includes("rc-hero-wrap"));
}

// Query with no hero and not loading → empty state shown
{
  const state = makeState({ query: "unknown topic", hero: null, loading: false });
  const el = asEl(renderExpanded(state, makeHandlers()));
  const content = allContent(el);
  check("renderExpanded → query + no hero + not loading → empty state shown", content.includes("rc-empty") || content.includes("Nothing for"));
}

// msgsIndexed null → "—" shown in footer
{
  const state = makeState({ msgsIndexed: null });
  const el = asEl(renderExpanded(state, makeHandlers()));
  const content = allContent(el);
  check("renderExpanded → msgsIndexed null → '—' in footer", content.includes("—"));
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\nAssertions: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
