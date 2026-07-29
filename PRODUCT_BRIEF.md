# Smriti — Product & Engineering Brief

> **Your AI remembers you.**
> Smriti is a local-first **memory layer for AI**. It captures your conversations
> across Claude, ChatGPT, and Gemini, distills durable facts about you, and lets
> you inject that context into any AI prompt in one click — so every tool
> "remembers you" without you re-explaining yourself.

This document is the single place to understand Smriti end to end: **why** it
exists, **what** it does, and **how** it is built — in enough depth that a new
contributor can read it once and then navigate, modify, and extend the codebase
with confidence. It complements the shorter [README.md](README.md) (quick start)
and [CLAUDE.md](CLAUDE.md) (conventions + roadmap).

For **the current build health of the checkout** (what compiles, what tests pass,
what is blocked) see [docs/REPO_STATUS.md](docs/REPO_STATUS.md) — that file is a
point-in-time snapshot, this one describes the system's design.

---

## Table of contents

1. [Why Smriti exists](#1-why-smriti-exists)
2. [What Smriti is](#2-what-smriti-is-the-loop)
3. [Product principles (the non-negotiables)](#3-product-principles-the-non-negotiables)
4. [The mental model in one picture](#4-the-mental-model-in-one-picture)
5. [Architecture: an MV3 extension with a compute engine](#5-architecture-an-mv3-extension-with-a-compute-engine)
6. [Data flows, step by step](#6-data-flows-step-by-step)
7. [The memory layer in depth](#7-the-memory-layer-in-depth)
8. [Search (over the conversation archive)](#8-search-over-the-conversation-archive)
9. [Storage & data model](#9-storage--data-model)
10. [Embeddings](#10-embeddings)
11. [Optional end-to-end-encrypted sync](#11-optional-end-to-end-encrypted-sync)
12. [Vault export — OKF markdown to Google Drive](#12-vault-export--okf-markdown-to-google-drive)
13. [Privacy & security model](#13-privacy--security-model)
14. [Tech stack](#14-tech-stack)
15. [Repository map](#15-repository-map)
16. [Build, run, and test](#16-build-run-and-test)
17. [How to contribute](#17-how-to-contribute)
18. [Protocol reference (messages & RPCs)](#18-protocol-reference-messages--rpcs)
19. [Status, roadmap, and known gaps](#19-status-roadmap-and-known-gaps)
20. [Glossary](#20-glossary)

---

## 1. Why Smriti exists

**The problem.** Every AI tool starts from zero, every single time. You re-explain
who you are, what you're building, your stack, your preferences — to Claude in the
morning, to ChatGPT in the afternoon, to Gemini the next day. The context you've
already given is trapped inside individual chat threads and siloed per vendor.
"Memory" features that exist are per-product, opaque, server-side, and don't move
with you across tools.

**The insight.** The valuable thing isn't your old chat transcripts — it's the
**durable facts about you** buried inside them. *"I'm a backend engineer who uses
Rust and Postgres, I'm building a CLI tool called X, I prefer terse answers and
tabs over spaces."* If a layer sits between you and every AI and re-supplies that
context on demand, each tool effectively "remembers you" — without any of them
needing to.

**The positioning.** Memory is the **product**, not a feature. Searching your old
chats is a nice-to-have; "your AI remembers you" is the pitch. We deliberately
avoid framing Smriti as "search your archive."

**Why it can be a company (the moat).** The wedge is **privacy via local-first
architecture**: your memory is built and stored on your own device, so Smriti can
credibly promise what server-side memory never can. That trust is the moat.
Optional **end-to-end-encrypted sync** (memories only, zero-knowledge relay) is
what turns a great local tool into a multi-device product you can build a business
around — without ever being able to read user data.

**Who this is for.**
- **Someone trying it out:** install, import history, click "Build my memory," then
  watch recall + one-click inject work on a real chat. See [§16](#16-build-run-and-test).
- **A contributor:** read [§5](#5-architecture-an-mv3-extension-with-a-compute-engine)
  → [§6](#6-data-flows-step-by-step) → [§15](#15-repository-map) →
  [§17](#17-how-to-contribute).
- **Anyone evaluating the idea:** [§1](#1-why-smriti-exists)–[§3](#3-product-principles-the-non-negotiables)
  and [§13](#13-privacy--security-model).

---

## 2. What Smriti is (the loop)

Smriti is a browser extension that runs a four-verb loop. Everything in the
product is in service of this loop:

```text
   CAPTURE  ─────▶  DISTILL  ─────▶  RECALL  ─────▶  INJECT
 (read your      (extract durable   (find what's    (drop it into
  chats, live     facts about you,   relevant as     the composer,
  + on import)    no LLM needed)     you type)       one click)
```

1. **Capture** — A read-only content script observes your conversation streams on
   claude.ai, chatgpt.com, and gemini.google.com as they happen. You can also
   **import history** (backfill) for Claude and ChatGPT in one click. No copy-paste,
   no API keys — it rides your existing signed-in session.
2. **Distill** — A pure, heuristic extractor pulls **durable first-person facts**
   out of your own messages and classifies them as `identity` / `preference` /
   `project` / `decision` / `fact`. No LLM call — it's fast, free, and 100% local.
3. **Recall** — As you type a new prompt, hybrid keyword + semantic search surfaces
   the memories most relevant to what you're writing — across all three tools.
4. **Inject** — One click writes a clean context block into the host tool's message
   box, ahead of what you've typed.

Two capabilities sit alongside the loop, both **opt-in** and both off by default:

5. **Sync** — Mirror your memories across devices, end-to-end encrypted. Smriti's
   relay only ever stores opaque ciphertext. See [§11](#11-optional-end-to-end-encrypted-sync).
6. **Vault export** — Mirror your *conversations* to your own Google Drive as
   plain Obsidian-style markdown files, so the archive is readable and portable
   outside Smriti. See [§12](#12-vault-export--okf-markdown-to-google-drive).

**User-facing surfaces:**
- **The sidebar** ([`entrypoints/sidebar.content.ts`](packages/extension/entrypoints/sidebar.content.ts))
  — an in-page panel (Shadow DOM) on the AI sites. This is the **hero surface**: it
  shows the "✦ Smriti remembers" recall card and the Inject button as you type.
- **The options page** ([`entrypoints/options/main.tsx`](packages/extension/entrypoints/options/main.tsx))
  — the desktop app: onboarding funnel, conversation archive + search, the Memory
  view (browse/pin/edit/delete), and Settings (capture toggles, export/import,
  sync, vault).

---

## 3. Product principles (the non-negotiables)

These are load-bearing. Changing one of them changes what Smriti *is*.

1. **Local-first by default.** All core features run in-browser. Nothing about your
   conversations or memories leaves the device — with three explicit, narrow, and
   individually opt-in exceptions ([§13](#13-privacy--security-model)): the
   read-only history import talks to the AI sites *you're already logged into*
   (not to any Smriti server), optional sync uploads *encrypted blobs only*, and
   optional vault export writes to *your own* Google Drive.
2. **Memory is the product.** Build, copy, and UX lead with "remembers you," not
   "search."
3. **No LLM for extraction.** Distillation is pure regex/heuristics
   ([`lib/extract.ts`](packages/extension/lib/extract.ts)) — zero cost, zero latency,
   zero data egress. (BYOK LLM extraction is a *possible future opt-in* to lift
   quality, never a default.)
4. **Zero runtime network dependency.** The embedding model is **vendored** into the
   package, so after install the extension makes no CDN calls to run.
5. **No telemetry.** There is no analytics, no phone-home. Users are the only sensor
   for breakage (hence the "report a broken site" affordances).
6. **Privacy is the moat, sync is the business.** Anything that weakens the
   local-first/zero-knowledge guarantees is a strategic regression, not just a bug.

---

## 4. The mental model in one picture

```text
                       YOUR BROWSER (everything below is on-device)
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                                │
│   claude.ai / chatgpt.com / gemini.google.com  (host tabs)                     │
│   ┌───────────────────────────┐     ┌─────────────────────────────┐           │
│   │ *-main.content.ts (MAIN)  │     │ sidebar.content.ts          │           │
│   │  patches window.fetch,    │     │  Shadow-DOM panel:           │           │
│   │  tees the response stream │     │  recall card + Inject button │           │
│   └─────────────┬─────────────┘     └───────────────┬─────────────┘           │
│        postMessage (smriti:v1)                       │ sendMessage              │
│   ┌─────────────▼─────────────┐                      │                          │
│   │ *-bridge.content.ts (ISO) │──── chrome.runtime.sendMessage ──┐             │
│   └───────────────────────────┘                                  │             │
│                                                                  ▼             │
│   ┌──────────────────────────────────────────────────────────────────────┐   │
│   │ background.ts  — service worker (router + offscreen lifecycle)         │   │
│   └───────────────────────────────┬──────────────────────────────────────┘   │
│                       sendMessage ({target:"offscreen", ...})                  │
│   ┌───────────────────────────────▼──────────────────────────────────────┐   │
│   │ offscreen.html + lib/offscreen-main.ts  — THE COMPUTE ENGINE          │   │
│   │   • SQLite (sql.js / WASM) over OPFS         (lib/db.ts)              │   │
│   │   • Embeddings (Transformers.js / ONNX WASM) (lib/embeddings.ts)     │   │
│   │   • Hybrid search   (lib/search.ts)                                   │   │
│   │   • Memory: extract / store / recall (lib/memory.ts, lib/extract.ts) │   │
│   │   • History backfill (lib/backfill.ts)                                │   │
│   │   • Background indexer loop (lib/index-worker.ts)                     │   │
│   │   • Sync engine (lib/sync.ts, lib/sync-crypto.ts, lib/sync-merge.ts) │   │
│   │   • Vault export (lib/vault-sync.ts, okf-renderer.ts, drive-client)  │   │
│   └──────────────────────────────────────────────────────────────────────┘   │
│                                                                                │
│   options page (main.tsx) ── sendMessage({kind:"to_offscreen"}) ──▶ background │
└──────────────────────────────────────────────────────────────────────────────┘
                 │ (only if user opts in)          │ (only if user opts in)
                 ▼ PUT/GET encrypted blob          ▼ upload markdown files
  ┌───────────────────────────────────────────┐  ┌──────────────────────────┐
  │ packages/sync-relay (CF Worker + KV)      │  │ the user's Google Drive  │
  │  stores opaque ciphertext keyed by syncId │  │  /smriti-vault/threads/  │
  └───────────────────────────────────────────┘  └──────────────────────────┘
```

**The one big idea to internalize:** there is a single **compute engine** — the
**Offscreen Document** — that owns all state and all heavy work (SQLite,
embeddings, search, memory, sync, vault). Every other context (content scripts,
background worker, options UI) is a thin client that talks to it by message
passing. If you understand the offscreen doc and how messages reach it, you
understand Smriti.

---

## 5. Architecture: an MV3 extension with a compute engine

Smriti is a **Chrome Manifest V3 extension** built with [WXT](https://wxt.dev)
(Vite-based) and React. MV3 imposes a hard constraint that shapes the whole
design: the background script is an **ephemeral service worker** that Chrome can
kill at any time, and it can't run long-lived WASM workloads. SQLite-in-WASM and
a 25 MB embedding model need a stable, long-lived home. That home is an
**Offscreen Document**.

### The five execution contexts (and why each exists)

| Context | File(s) | World | Why it exists / constraints |
|---|---|---|---|
| **MAIN-world content scripts** | [`*-main.content.ts`](packages/extension/entrypoints/), [`gemini-dom.content.ts`](packages/extension/entrypoints/gemini-dom.content.ts) | page's own JS context | Only here can you monkey-patch `window.fetch` to observe the site's API stream. **Cannot** use `chrome.*` APIs. Talks out via `window.postMessage`. |
| **ISOLATED content scripts (bridges)** | [`*-bridge.content.ts`](packages/extension/entrypoints/) | extension's isolated world | Can use `chrome.runtime.sendMessage`. Receives the MAIN script's tagged postMessages and forwards them to the background. |
| **Background service worker** | [`entrypoints/background.ts`](packages/extension/entrypoints/background.ts) | SW | The **router**. Owns the offscreen-doc lifecycle, forwards messages, holds the per-host capture toggle, updates the toolbar badge. Ephemeral — assume it dies and restarts constantly. |
| **Offscreen Document** | [`offscreen.html`](packages/extension/entrypoints/offscreen.html) + [`lib/offscreen-main.ts`](packages/extension/lib/offscreen-main.ts) | offscreen | The **compute engine**. Long-lived; owns SQLite, embeddings, search, memory, backfill, sync, vault. All real work happens here. |
| **UI pages** | [`entrypoints/options/main.tsx`](packages/extension/entrypoints/options/main.tsx) (React), [`entrypoints/sidebar.content.ts`](packages/extension/entrypoints/sidebar.content.ts) (Shadow DOM) | extension pages / content | The product's faces. They call the engine via `sendToHelper({ type, ... })` and read fields off a loose result. |

### The offscreen lifecycle (a subtle, important detail)

The offscreen document **outlives the background service worker**. The SW is
ephemeral; the offscreen doc persists until the extension is reloaded. This
creates a readiness handshake that every contributor should understand:

- On boot, the offscreen doc runs `boot()` → `initDb()` → `startIndexWorker()` →
  `startVaultSyncLoop()` → sets an internal `dbReady` flag → broadcasts
  `offscreen_ready`.
- `background.ts` tracks `offscreenReady`. `sendToOffscreen()` first calls
  `ensureOffscreen()` (creates the doc if missing) and `waitForOffscreen()`
  (resolves when ready, with a ~20 s timeout that rejects rather than hangs).
- **Gotcha:** when Chrome terminates the idle SW and later restarts it, the
  surviving offscreen doc has *already* sent its one-shot `offscreen_ready` to the
  now-dead SW. So a restarted SW **probes** the existing doc (a `ping` that returns
  `{ ready: dbReady }`) and marks it ready on reply — rather than waiting forever
  for a broadcast that won't come. If you touch the lifecycle code, preserve this
  recover-on-restart behavior or capture/search/memory silently break after the SW
  first sleeps.
- **Corollary for in-memory state:** anything the engine caches in module scope
  (e.g. the Drive OAuth token in [`lib/drive-client.ts`](packages/extension/lib/drive-client.ts))
  is lost when the *offscreen doc itself* is torn down on extension reload. State
  that must survive belongs in SQLite or `chrome.storage.local`.

### The sidebar is modular, not a monolith

The in-page panel was split out of a 1,532-line file (PR #6). The entrypoint
[`sidebar.content.ts`](packages/extension/entrypoints/sidebar.content.ts) now owns
mounting, host-page layout shift, state, and event wiring, and delegates to:

| Module | Responsibility |
|---|---|
| [`lib/sidebar-types.ts`](packages/extension/lib/sidebar-types.ts) | `PanelState`, `PanelHandlers`, `HydratedHero`, `CurrentChat` |
| [`lib/sidebar-styles.ts`](packages/extension/lib/sidebar-styles.ts) | the Shadow-DOM stylesheet (`SIDEBAR_CSS`) |
| [`lib/sidebar-helpers.ts`](packages/extension/lib/sidebar-helpers.ts) | pure helpers: `detectCurrentChat`, `providerBadge`, `memoryKindMeta`, `formatDate`, `escapeHtml`, `reportIssueUrl` |
| [`lib/sidebar-renderers.ts`](packages/extension/lib/sidebar-renderers.ts) | HTML rendering: `renderCollapsed`, `renderExpanded`, `populateBody`, `updateToast` |

The helpers and renderers are pure, so they have headless test suites
(`npm run test:sidebar-helpers`, `npm run test:sidebar-renderers`). All of these
modules obey the content-script import rule below.

### The golden rule for content-script imports

Content scripts (and anything they import) must be **DOM-only / dependency-light**.
[`lib/extract.ts`](packages/extension/lib/extract.ts),
[`lib/inject.ts`](packages/extension/lib/inject.ts), and the `sidebar-*` modules
are safe to import from a content script (pure functions, no heavy deps).
**Never** import [`lib/memory.ts`](packages/extension/lib/memory.ts),
[`lib/db.ts`](packages/extension/lib/db.ts), or
[`lib/embeddings.ts`](packages/extension/lib/embeddings.ts) from a content
script — they pull in sql.js and Transformers.js, which belong only to the
offscreen document. Breaking this rule bloats content scripts and can break the
page.

---

## 6. Data flows, step by step

### A. Live capture (as you chat)

```text
You send a message on claude.ai
  → window.fetch is called for the completion endpoint
  → claude-main.content.ts (MAIN) matches the URL, lets the real fetch run,
    then .clone()s the Response and reads the SSE stream WITHOUT disturbing the page
  → it accumulates the user text (from the request body) + the assistant text
    (from streamed content_block_delta events) into CaptureEvent[]
  → window.postMessage({ smriti: "smriti:v1", source: "claude-inject", events })
  → claude-bridge.content.ts (ISOLATED) validates the tag, forwards:
      chrome.runtime.sendMessage({ kind: "capture", events })
  → background.ts handleCapture(): drops events for paused hosts, then
      sendToOffscreen({ type: "ingest", events })
  → offscreen ingestEvents() writes conversations + messages into SQLite
  → the index worker later embeds the new messages and extracts memories
```

Key files: [`claude-main.content.ts`](packages/extension/entrypoints/claude-main.content.ts),
[`claude-bridge.content.ts`](packages/extension/entrypoints/claude-bridge.content.ts),
[`capture/messages.ts`](packages/extension/capture/messages.ts) (the `smriti:v1`
postMessage contract), [`lib/ingest.ts`](packages/extension/lib/ingest.ts).
ChatGPT and Gemini have their own `-main`/`-bridge`/`-dom` equivalents.

`ingestEvents()` also maintains two side tables on every accepted batch:
`capture_state` (so Settings can show a live green dot per platform) and
`daily_stats` (per-day message counts used by the activity strip). Message
dedup is by `UNIQUE(conversation_id, content_hash)`, so re-capturing the same
exchange is a no-op.

### B. History import (backfill)

```text
Onboarding Step 2 / Settings → "Import"
  → sendMessage({ kind: "start_backfill", platform })
  → background → offscreen startBackfill(platform)   (lib/backfill.ts)
  → fetch(claude.ai/chatgpt.com API, { credentials: "include" })  // your session
      Claude:  list orgs → list conversations (active+archived) → fetch each detail
      ChatGPT: page /backend-api/conversations → fetch each conversation tree
  → convert to CaptureEvent[] → ingestEvents() → SQLite
  → progress broadcast as { kind: "backfill_progress", progress } back to the UI
```

It rides your **existing logged-in session cookies** — no password, no OAuth, and
it works even with no tab open. A `401/403` is surfaced as an actionable
"Not signed in to <site>" message. Only Claude and ChatGPT support backfill;
Gemini is capture-only.

### C. The memory build loop (extract → embed)

```text
index-worker.ts tick (every ~5s active, ~30s idle):
  1. extractionSweep(): scan user messages past a rowid cursor, run extractCandidates(),
     storeMemory() each surviving fact (dedup along the way)         [no model, cheap]
  2. embed a batch of un-embedded messages                          [model]
  3. embed a batch of un-embedded memories                          [model]
```

"Build my memory" (`build_memory_now`) runs the extraction pass over the whole
backlog immediately (chunked into 128-message passes, yielding between each so
`build_progress` broadcasts flush and the panel can show live progress) so
onboarding has an instant payoff. See [§7](#7-the-memory-layer-in-depth).

### D. Recall + inject (the hero)

```text
You start typing in the host composer
  → sidebar.content.ts watches the composer (debounced ~600ms, min 6 chars)
  → sendToHelper({ type: "recall_memories", query, limit })
  → offscreen recallMemories(): hybrid FTS + vector RRF over memories, + pinned
    fold-in, + salience/pin/use-count boosts → top hits
  → sidebar renders the "✦ Smriti remembers" card
  → you click Inject
  → injectText(formatMemoryBlock(hits)) writes the context block into the composer
    (execCommand insertText for ProseMirror/Quill; native setter for <textarea>)
  → touch_memories records usage (feeds the recency/use-count boost)
```

If injection fails (selectors drift when sites change), it degrades to copying the
block to the clipboard so the action never dead-ends. Composer watching is also
gated on the per-host capture pause — pausing a site pauses *all* observation
there, not just writes.

### E. Sync (optional, opt-in)

```text
sync_now:
  pull encrypted blob from relay (GET /v1/blob/:syncId)
    → decrypt (AES-256-GCM) → ChangesetMemory[]
    → for each remote row: decideMerge() vs local → insert/update/delete/skip
    → carry forward remote rows we skipped but don't hold locally
  export full local memory state → union with carried rows
    → encrypt → push (PUT /v1/blob/:syncId)
```

See [§11](#11-optional-end-to-end-encrypted-sync).

### F. Vault export (optional, opt-in)

```text
vault sync round (every ~5 min busy / ~30 min idle, or on demand):
  SELECT conversations never synced OR changed since last sync OR status='error'
    → for each (batch of 10):
        render OKF markdown (frontmatter + transcript + related memories)
        ensureFolder("threads/<platform>/") on Drive  (path cache avoids re-lookup)
        upload new file, or PATCH the existing drive_file_id
        record drive_file_id + last_synced_at in vault_sync_state
```

See [§12](#12-vault-export--okf-markdown-to-google-drive).

---

## 7. The memory layer in depth

This is the differentiator. Four pieces:

### `lib/extract.ts` — the distiller (pure, unit-tested)

A dependency-free function `extractCandidates(text)` that turns one user message
into zero or more `Candidate { kind, text, salience }`. How it works:

- **Clause splitting** (`splitClauses`): strips fenced code, then splits on
  newlines, sentence boundaries, semicolons, bullets, and " - " dashes.
- **Filters**: skip clauses that are too short/long, that *look like code*
  (`looksLikeCode`), that are **requests to the AI** (`REQUEST_RE` — "write me…",
  "explain…", "how do I…"), or that lack a **first-person/possessive anchor**
  ("I", "my", "we", "our", "let's") — durable facts are about *you*.
- **Rule matching** (`RULES`): an ordered list of `{ kind, salience, regex }`.
  First match wins per clause. Kinds and example signals:
  - `identity` (~0.85–0.92): "I'm a…", "my name is", "I work at/as/in", "I live in".
  - `decision` (~0.80–0.88): "I/we decided/chose/went with/are using".
  - `project` (~0.78–0.85): "I'm building/working on", "my project/app/startup",
    "our stack".
  - `preference` (~0.72–0.80): "I prefer/like/hate/always/never", style directives.
  - `fact` (~0.58): broad "I/we need/want/use/own/maintain/have" (lower salience,
    stricter length).
- **Ephemerality** (`EPHEMERAL_RE`): time-anchored statements ("by Friday", "this
  week", "asap") decay fast. For the broad `fact` kind they're dropped entirely
  (a deadline is a task, not a fact about you); for other kinds salience is reduced.
- **Cleanup + caps**: `cleanMemoryText` trims filler ("so", "basically"), fixes
  casing, caps length (`MAX_MEMORY_LEN = 320`); at most **4** candidates per
  message (so one long message can't flood memory), highest-salience first.

Because it's pure, it's tested headlessly: `npm run test:extract`
([`scripts/test-extract.ts`](packages/extension/scripts/test-extract.ts)) asserts
real messages produce the right memories and that noise (e.g. "by Friday") is
*not* captured.

### `lib/memory.ts` — store, dedup, recall, CRUD

- **`storeMemory`**: rejects too-short text; **exact-dup** check via `UNIQUE(norm_text)`;
  **near-dup** guard — Jaccard token overlap ≥ `0.82` against recent active
  memories of the same kind (the 400 most recent, so it stays cheap). On a dup it
  bumps the existing memory's `salience` (+0.03, capped at 1) instead of inserting.
- **`extractionSweep`**: incremental — processes user messages past a stored rowid
  cursor (in `memory_meta`), so every message (live or imported) is extracted
  exactly once.
- **`recallMemories(query, limit)`** — the recall ranker:
  - **FTS lane**: `memories_fts MATCH` ranked by `bm25` (query tokens OR-joined).
  - **Vector lane**: embed the query, cosine-similarity over `memory_embeddings`.
  - **RRF fusion**: `score = Σ 1 / (k + rank)` with `k = 60` (merges the two rank
    lists without needing comparable scores).
  - **Pinned fold-in**: pinned memories are *always* eligible, even on a weak query.
  - **Boosts**: final score multiplies in `salience` (`1 + 0.5·s`), a `1.4×` pin
    bonus, and a use-count bonus (up to `1.3×`) — so curated/important/frequently
    used memories rise.
  - Degrades gracefully: if embeddings aren't ready yet, FTS alone still returns
    results (this is why the onboarding "Try it now" demo works immediately).
  - Logs timing; warns above 200 ms.
- **CRUD**: `addMemory`, `editMemory`, `setMemoryPinned`, `deleteMemory`,
  `touchMemories`, `listMemories`, `memoryStats`. Editing text drops the stale
  embedding so the worker recomputes it. Deletion is a **soft delete** /
  tombstone (see [§9](#9-storage--data-model) and [§11](#11-optional-end-to-end-encrypted-sync)).

### `lib/inject.ts` — composer injection (pure DOM)

- **`formatMemoryBlock(memories)`**: builds the human-readable context block
  ("Context about me, from my past conversations: …").
- **Per-platform selectors** with robust fallbacks (Claude/ChatGPT = ProseMirror
  `contenteditable`; Gemini = Quill `.ql-editor`; some surfaces still `<textarea>`).
  `findComposer()` prefers the visible editor nearest the bottom of the viewport.
- **Insertion strategy**: prefer `document.execCommand("insertText")` on a focused
  contenteditable (routes through the editor's own input pipeline so
  React/ProseMirror/Quill stay in sync); fall back to a `beforeinput`/`input`
  `InputEvent` pair, then to a native-setter path for `<textarea>`; hard fallback
  prepends a text node. Inserts at the **start** so context lands ahead of what
  you've typed.
- Selectors are the most fragile part of the product (host sites change UI often);
  this is the main "needs live tuning" maintenance surface.

### `lib/outline.ts` — conversation chaptering

Embedding-based segmentation of long conversations into chapters (no LLM) — used by
the archive viewer and by the sidebar's hero card (which highlights the chapter the
matched message falls in).

---

## 8. Search (over the conversation archive)

[`lib/search.ts`](packages/extension/lib/search.ts) powers the options-page archive
search (distinct from *memory* recall, though they share the RRF idea):

- **FTS5 lane**: `messages_fts MATCH` ranked by `bm25`, with `snippet()` highlights.
  Quoted `"phrases"` are preserved; loose tokens are OR-joined.
- **Vector lane**: embed the query, cosine over `message_embeddings`.
- **RRF fusion** (`k = 60`) merges both, then **collapses to one hit per
  conversation** (best message), so results are conversations, not duplicate
  fragments. Each hit is labelled `fts` / `vec` / `hybrid` so the UI can explain
  the ranking.
- Resilient: a malformed FTS query falls back to vector-only; no embeddings falls
  back to FTS-only. Timing is logged; a query over ~300 ms warns.

`search.ts` also holds the convenience readers used by the offscreen RPCs
(`getConversation`, `listRecentConversations`, `getStats`, `lookupByPlatform`) and
`wipeArchive()`, the transactional Danger-Zone wipe.

---

## 9. Storage & data model

### sql.js + OPFS ([`lib/db.ts`](packages/extension/lib/db.ts))

- **SQLite compiled to WASM** (sql.js, via the `fts5-sql-bundle` build) runs *in
  memory* inside the offscreen doc — full SQLite including **FTS5**. Query helpers
  `dbAll` / `dbGet` / `dbRun` are **synchronous** (sql.js runs on the offscreen
  thread), which keeps ported code clean.
- **Persistence** = the **Origin Private File System (OPFS)**. The whole DB is one
  file, `smriti.db`, in the extension's private storage — invisible to websites,
  survives restarts. Writes call `markDirty()`, which schedules a **2-second
  debounced flush** (`db.export()` → OPFS), so a burst of writes flushes once.
  A failed flush re-arms the dirty flag so the next write retries.
- `initDb()` requests `navigator.storage.persist()` (so Chrome won't evict the DB
  under disk pressure) and applies migrations idempotently via a `_migrations`
  table, each inside its own `BEGIN`/`COMMIT`.

### Schema ([`lib/migrations.ts`](packages/extension/lib/migrations.ts))

Migrations are an ordered list of `[id, sql]` applied once each: `001_init.sql`,
`002_embeddings.sql`, `003_memory.sql`, `004_sync.sql`, `005_vault.sql`.
**Never edit a shipped migration** — append a new one. The important tables:

| Table | Migration | Purpose |
|---|---|---|
| `conversations` | 001 | one row per captured chat (platform, title, url, timestamps); `UNIQUE(platform, platform_conv_id)` |
| `messages` | 001 | one row per message (role, `content_text`, `position`, `content_hash`); `UNIQUE(conversation_id, content_hash)` dedups re-captures |
| `messages_fts` | 001 | FTS5 virtual table mirroring `messages` (porter/unicode61), kept in sync by triggers |
| `capture_state`, `backfill_state`, `daily_stats`, `tags`, `conversation_tags`, `notes`, `ingest_state` | 001 | capture health, import progress, stats, tagging/notes, ingest cursors |
| `message_embeddings` | 002 | `vec` BLOB (Float32, 384 dims) per message + model name |
| **`memories`** | 003 | the memory layer: `kind`, `text`, `norm_text` (`UNIQUE`, for dedup), `source`, provenance FKs, `pinned`, `salience`, `use_count`, `status` |
| `memory_embeddings` | 003 | embeddings for semantic recall, mirrors `message_embeddings` |
| `memories_fts` | 003 | FTS5 over memory text |
| `memory_meta` | 003 | bookkeeping (e.g. the extraction rowid cursor `extract_through_rowid`) |
| `memories.deleted_at` | 004 | added column — the tombstone marker |
| `sync_config` | 004 | singleton row: `enabled`, `sync_id`, `device_id`, `last_synced_at` (all **non-secret**) |
| `vault_sync_state` | 005 | per-conversation vault export state: `drive_file_id`, `filename`, `vault_path`, `last_synced_at`, `synced_msg_count`, `status` |
| `vault_config` | 005 | singleton row: `enabled`, `vault_root_id`, `last_sync_at`, `total_synced`, `sync_errors` |

**Soft delete (tombstones).** `deleteMemory` doesn't hard-delete; it sets
`deleted_at`, bumps `updated_at`, and mutates `norm_text` (appending
`#deleted:<id>`) to free the `UNIQUE(norm_text)` slot for future re-extraction. It
also explicitly removes the row from `memories_fts` (the update trigger would
otherwise re-add it) — all three writes inside one transaction. The row remains so
sync can propagate the deletion to other devices. Every "is this memory active?"
query therefore filters `status = 'active' AND deleted_at IS NULL`.

---

## 10. Embeddings

[`lib/embeddings.ts`](packages/extension/lib/embeddings.ts) +
[`lib/index-worker.ts`](packages/extension/lib/index-worker.ts):

- **Model:** `Xenova/all-MiniLM-L6-v2`, **384 dims**, quantized ONNX (~25 MB), run
  via **Transformers.js** on the **ONNX WASM** backend.
- **Vendored, not downloaded.** `npm run fetch:model` copies the model + ONNX wasm
  into `public/models` and `public/ort` (gitignored). It runs automatically before
  `build`/`dev` (idempotent). At runtime `env.allowRemoteModels = false` — **zero
  network calls**.
- **Single-threaded** (`numThreads = 1`): offscreen documents can't use
  `SharedArrayBuffer` (needs COOP/COEP headers extensions can't set), so
  multi-threaded ONNX is unavailable.
- **Storage:** vectors are stored as raw `Float32Array` bytes in a BLOB; vector
  search reinterprets the BLOB and computes cosine similarity in JS (brute force —
  fine for the data volumes this product handles). Because vectors are stored
  `normalize: true`, the dot product *is* cosine similarity.
- **The index worker** lazily loads the model only when there's work, processes
  bounded batches per tick (16 messages, 12 memories, 64-message extraction
  sweeps), yields via `setTimeout`, and has a consecutive-error circuit breaker
  (5 strikes → long backoff). Embedding is best-effort and retried; recall/search
  degrade to FTS until vectors exist.

---

## 11. Optional end-to-end-encrypted sync

Built, opt-in, memories-only. The relay is **zero-knowledge** — it stores opaque
ciphertext and never sees plaintext, the recovery code, or any derived key.

- **Crypto** ([`lib/sync-crypto.ts`](packages/extension/lib/sync-crypto.ts)): a
  **recovery code** = 16 random bytes shown as grouped hex (128 bits). HKDF-SHA256
  derives two things from it: an **AES-256-GCM key** (`encKey`) and a **non-secret
  `syncId`** (the relay's lookup key). Payloads are `iv(12) || ciphertext`. All
  native WebCrypto — no new dependencies.
- **The secret never touches SQLite.** The recovery code lives only in
  `chrome.storage.local` (`smriti_sync_secret`), so it can never end up in a JSON
  export. `sync_config` holds only non-secret metadata.
- **Engine** ([`lib/sync.ts`](packages/extension/lib/sync.ts)): every `syncNow()` is
  a **whole-state** pull → merge → push (memories are small, so no diff tracking).
  It pulls the remote blob, decrypts, merges each row, **carries forward remote rows
  it skipped but doesn't hold locally** (so a full-state push never erases another
  device's data), then encrypts and pushes the union. Embeddings ride along
  base64-encoded, so a joining device doesn't recompute them.
- **Merge decider** ([`lib/sync-merge.ts`](packages/extension/lib/sync-merge.ts)): a
  **pure**, unit-tested function `decideMerge(remote, local, collides)` →
  `inserted | updated | deleted | skipped`. Rules: last-write-wins by `updated_at`;
  **delete wins** on conflict (a local tombstone is never resurrected);
  `norm_text` collisions skip and self-resolve on a later sync. Pure so it runs
  under `tsx`: `npm run test:sync`.
- **Device-local fields are never overwritten** by a remote update: `use_count`,
  `last_used_at`, `created_at`, and the `source_conversation_id` /
  `source_message_id` provenance FKs.
- **Relay** ([`packages/sync-relay/src/index.ts`](packages/sync-relay/src/index.ts)):
  a Cloudflare Worker + KV. `GET/PUT/DELETE /v1/blob/:syncId` where `syncId` is 32
  lowercase hex; 2 MB cap; wildcard CORS (safe — payload is ciphertext, no
  credentials, syncId is a 128-bit-derived secret). Documented v1 limitations: no
  per-user auth (mitigated by cap + Cloudflare rate limiting + KV quotas) and no
  compare-and-swap (a future Durable Object migration).
- **Deploy step (manual, still outstanding):** `wrangler deploy` the relay, then
  replace the `smriti-sync-relay.YOUR-SUBDOMAIN.workers.dev` placeholder in
  [`lib/sync.ts`](packages/extension/lib/sync.ts) and
  [`wxt.config.ts`](packages/extension/wxt.config.ts) (×2 — `host_permissions`
  *and* the `connect-src` CSP). Until then `syncNow()` throws a clear "relay not
  configured" error by design. See
  [`packages/sync-relay/README.md`](packages/sync-relay/README.md).

---

## 12. Vault export — OKF markdown to Google Drive

The newest subsystem (landed 2026-07-07), and the one least covered by the older
docs. It answers a different question than sync: **sync** keeps your *memories*
consistent across your devices, encrypted and opaque; **vault export** writes your
*conversations* to your own Google Drive as **plain, readable markdown** you can
open in Obsidian, grep, or keep after uninstalling Smriti.

Three modules:

| Module | Role |
|---|---|
| [`lib/okf-renderer.ts`](packages/extension/lib/okf-renderer.ts) | **pure** — turns a conversation + messages + related memories into `{ markdown, filename, directory }`. No DB, no network, unit-tested (`npm run test:okf`). |
| [`lib/drive-client.ts`](packages/extension/lib/drive-client.ts) | Google Drive REST client: OAuth token handling, folder find-or-create with a path cache, multipart upload / media PATCH, retry + quota guard. |
| [`lib/vault-sync.ts`](packages/extension/lib/vault-sync.ts) | the engine: picks pending conversations, renders, uploads, records `vault_sync_state`, and runs the periodic loop. |

**OKF (Obsidian Knowledge Format) output.** One markdown file per conversation at
`smriti-vault/threads/<platform>/<YYYY-MM-DD>_<slug>.md`, shaped as:

```markdown
---
type: thread
title: Building a Chrome extension
platform: claude
tags:
  - extension
  - chrome
  - claude
created: "2026-07-01T10:00:00Z"
updated: "2026-07-01T11:00:00Z"
source_url: "https://claude.ai/chat/abc"
message_count: 12
model: "claude-opus-4"
---

## User
…

## Assistant
…

---

## Related Memories

- I'm building a Chrome extension called Smriti (*project*)
```

Details worth knowing: consecutive same-role messages share one `##` heading;
`tool` messages are fenced as ```json; tags are the 5 most frequent non-stopword
tokens from the user's messages plus the platform; titles containing YAML-unsafe
characters (`: # [ ] { } "` or a leading `*`) are double-quoted and escaped.

**Scheduling and change detection.** `startVaultSyncLoop()` is kicked off at
offscreen boot and is a no-op unless `vault_config.enabled = 1`. A round selects
conversations that are new, changed (`conversations.last_message_at >
vault_sync_state.last_synced_at`), or previously errored, up to 10 per round, then
schedules the next tick at 5 minutes if it did work or 30 minutes if idle.

**Drive API discipline.** Folder IDs are cached in `chrome.storage.local` under
`smriti:drive_path_cache` with a 24-hour TTL (a deleted folder self-heals the next
day). `fetchWithRetry` caps a round at 50 API calls, refreshes the token once on a
`401`, honours `Retry-After` on `429`, backs off exponentially on `5xx`, and
treats `403 rateLimitExceeded` as a hard stop for the round. If a file recorded in
`vault_sync_state` returns `404` on update, it is re-uploaded as new.

**RPCs:** `vault_status`, `vault_enable`, `vault_disable`, `vault_sync_now`,
`vault_sync_conversation`, `vault_resync_all`. UI lives in `VaultSection` /
`VaultStatusCard` in [`options/main.tsx`](packages/extension/entrypoints/options/main.tsx).

> **This feature does not work on a fresh checkout yet** — it needs a real Google
> OAuth client ID and a manifest CSP change, and there are two known defects in
> the engine. The full setup procedure and defect list are in
> **[docs/VAULT_SYNC.md](docs/VAULT_SYNC.md)**. Read that before touching this code.

---

## 13. Privacy & security model

**What stays on your device (everything, by default):** conversations, messages,
embeddings, and memories live only in OPFS inside the offscreen document. No
account, no server, no telemetry.

**Scope of that claim.** This is about the data Smriti holds — your conversations,
messages, embeddings, and memories. It is not a claim that the browser sends no
network traffic: you are on claude.ai, the page itself is talking to its own
servers, and enabling vault export involves a Google OAuth exchange. The
guarantee is that *Smriti* does not transmit your archive anywhere except in the
three cases below.

**The only three times Smriti sends your data off the device — each opt-in:**
1. **History import** issues requests to **claude.ai / chatgpt.com themselves**
   (using *your* session cookies), exactly as your browser would — not to any
   Smriti server. It's read-only.
2. **Sync (opt-in)** uploads **AES-256-GCM ciphertext** to the relay. The relay is
   zero-knowledge: it can't read it, and the key never leaves your devices.
3. **Vault export (opt-in)** uploads **plaintext markdown** to **the user's own
   Google Drive**, scoped to `drive.file` (Smriti can only see files it created).
   This is the one path where readable content leaves the machine, so it must stay
   explicitly opt-in and clearly labelled in the UI — it is a deliberate
   user-chosen trade, not a default.

**Threat-model notes for contributors:**
- The `syncId` doubles as the lookup key *and* the bearer credential for a sync
  group's blob; it's 128-bit-derived, so not guessable, but anyone who has it can
  read/overwrite that (encrypted) blob. Don't log it or leak it.
- Never write the recovery code / derived keys into SQLite (they'd land in
  exports). They belong only in `chrome.storage.local`.
- Keep the Drive scope at `drive.file`. A broader scope (`drive`) would grant
  access to the user's entire Drive and would rightly fail store review.
- MAIN-world fetch interception on three major AI sites is exactly what Chrome Web
  Store reviewers scrutinize. Keep capture strictly read-only and the permission
  set minimal (`storage`, `offscreen`, `scripting`, `identity` + the host
  permissions). See [`STORE_LISTING.md`](STORE_LISTING.md) and
  [`PRIVACY_POLICY.md`](PRIVACY_POLICY.md) — **note that both currently describe a
  no-egress product and have not been updated for vault export.**

---

## 14. Tech stack

- **Extension framework:** [WXT](https://wxt.dev) `^0.19` (Vite-based, MV3).
- **UI:** React `^18` (options page); vanilla DOM + Shadow DOM (sidebar).
- **Database:** [sql.js](https://sql.js.org) `^1.12` / `fts5-sql-bundle`
  (SQLite/WASM with FTS5) over **OPFS**.
- **Embeddings:** [@xenova/transformers](https://github.com/xenova/transformers.js)
  `^2.17` (Transformers.js / ONNX WASM), model `all-MiniLM-L6-v2`.
- **Language/tooling:** TypeScript `^5.6`, Node `>= 20`, `tsx` for headless tests.
- **Sync relay:** Cloudflare Workers + KV, `wrangler`, `@cloudflare/workers-types`.
- **Vault:** Google Drive v3 REST + `chrome.identity` OAuth.
- **Browser target:** **Chrome/Chromium only** (`minimum_chrome_version: 116`).
  Firefox is intentionally unsupported because the engine needs the Offscreen
  Documents API.
- **No new runtime dependencies** unless truly necessary (a stated convention).

---

## 15. Repository map

```text
packages/
  shared/      @smriti/shared — TypeScript types + the message/protocol contract.
               src/types.ts (MemoryItem, CaptureEvent, …), src/protocol.ts
               (BackfillProgress, BackfillState, SearchHit, …). Imported everywhere.

  extension/   THE PRODUCT (WXT, Chrome MV3).
    entrypoints/
      background.ts                 service worker: router + offscreen lifecycle + badge
      offscreen.html                host page for the compute engine
      claude-main.content.ts        MAIN-world fetch interceptor (Claude)
      claude-bridge.content.ts      ISOLATED bridge (Claude)
      chatgpt-main.content.ts       MAIN-world fetch interceptor (ChatGPT)
      chatgpt-bridge.content.ts     ISOLATED bridge (ChatGPT)
      gemini-dom.content.ts         Gemini capture (DOM-based)
      sidebar.content.ts            the HERO in-page panel (Shadow DOM): recall + inject
      options/main.tsx              desktop app: onboarding, archive, Memory view, Settings
    lib/
      offscreen-main.ts             the compute engine: boot + RPC dispatch (handleMessage)
      db.ts                         sql.js + OPFS persistence; dbAll/dbGet/dbRun; flush
      migrations.ts                 the SQL schema (001_init … 005_vault)
      ingest.ts                     CaptureEvent[] → conversations/messages rows
      backfill.ts                   history import for Claude + ChatGPT (session-cookie fetch)
      embeddings.ts                 Transformers.js model + vector store/search
      index-worker.ts               background loop: extract + embed
      search.ts                     hybrid FTS5 + vector RRF over messages
      outline.ts                    embedding-based conversation chaptering (no LLM)
      extract.ts                    PURE heuristic memory extractor (unit-tested)
      memory.ts                     memory store/dedup/recall/CRUD
      inject.ts                     PURE DOM composer injection + formatMemoryBlock
      sidebar-types.ts              sidebar state/handler types
      sidebar-styles.ts             sidebar Shadow-DOM CSS
      sidebar-helpers.ts            PURE sidebar helpers (unit-tested)
      sidebar-renderers.ts          PURE sidebar HTML renderers (unit-tested)
      sync.ts                       whole-state sync engine
      sync-crypto.ts                HKDF + AES-256-GCM primitives
      sync-merge.ts                 PURE merge decider (unit-tested)
      okf-renderer.ts               PURE conversation → OKF markdown (unit-tested)
      drive-client.ts               Google Drive REST client (auth, folders, upload)
      vault-sync.ts                 vault export engine + periodic loop
      crypto.ts                     randomUUID / content hashing shims
    capture/messages.ts             the smriti:v1 postMessage contract (MAIN ↔ ISOLATED)
    scripts/
      fetch-model.mjs               vendor the embedding model + ONNX wasm
      generate-icons.mjs            build the toolbar icon set
      test-extract.ts               extraction-quality assertions   (npm run test:extract)
      test-sync.ts                  crypto + merge-decision assertions (npm run test:sync)
      test-sidebar-helpers.ts       sidebar helper assertions       (npm run test:sidebar-helpers)
      test-sidebar-renderers.ts     sidebar render assertions       (npm run test:sidebar-renderers)
      test-okf-renderer.ts          OKF markdown assertions         (npm run test:okf)
    wxt.config.ts                   manifest (permissions, hosts, oauth2, CSP, content scripts)

  sync-relay/  Cloudflare Worker + KV — the zero-knowledge encrypted-blob relay.

  helper/      LEGACY Node service — superseded by the offscreen doc. Ignore.
               (Not in the npm workspaces list, so it is never installed.)
  mcp-server/  LEGACY MCP server. Ignore for now (possible future B2B/dev surface).
               (Also outside the workspaces list.)
```

Root docs: [README.md](README.md) (quick start), [CLAUDE.md](CLAUDE.md)
(conventions + roadmap), [RELEASE_PLAN.md](RELEASE_PLAN.md) (the pre-release PRD,
tasks T1–T11), [STORE_LISTING.md](STORE_LISTING.md), [PRIVACY_POLICY.md](PRIVACY_POLICY.md).
Deeper docs: [docs/REPO_STATUS.md](docs/REPO_STATUS.md) (current build health),
[docs/VAULT_SYNC.md](docs/VAULT_SYNC.md) (vault subsystem + setup).
`docs/index.html` / `docs/privacy.html` are the GitHub Pages landing site.

---

## 16. Build, run, and test

Prereqs: **Node ≥ 20**, **Chrome/Chromium**.

```bash
npm install                 # from repo root (workspaces)
cd packages/extension

npm run fetch:model         # vendor the embedding model + ONNX wasm (~25 MB, one-time;
                            # also runs automatically before build/dev)

npx tsc --noEmit -p tsconfig.json   # typecheck (must be clean)
npm run test:extract                # extraction-quality assertions
npm run test:sync                   # crypto + merge-decision assertions
npm run test:sidebar-helpers        # sidebar helper assertions
npm run test:sidebar-renderers      # sidebar render assertions
npm run test:okf                    # OKF markdown assertions
npm run build                       # → .output/chrome-mv3
npm run dev                         # live dev (HMR)
```

> **Heads-up on a fresh clone:** the five `test:*` scripts invoke `tsx`, but `tsx`
> is not declared as a dependency of any installed workspace, so they fail with
> `'tsx' is not recognized`. Until that is fixed, run them as
> `npx --yes tsx scripts/<name>.ts`. See [docs/REPO_STATUS.md](docs/REPO_STATUS.md).

**Load it in Chrome:**
1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select `packages/extension/.output/chrome-mv3`.
3. Open claude.ai / chatgpt.com / gemini.google.com (signed in), click the Smriti
   toolbar icon → **✦ Memory** → **Build my memory**, then start typing a prompt to
   see recall + one-click inject.

**Inspecting the engine (essential for debugging):** `chrome://extensions` →
Smriti → **Inspect views: offscreen.html** opens the offscreen document's console
(DB / embeddings / sync / vault logs). The service-worker console is reachable the
same way. Capture logs appear in the **page** console on the AI site (look for
`[smriti] …`). Log prefixes: `[smriti:db]`, `[smriti:index]`, `[smriti:embed]`,
`[smriti:search]`, `[smriti:memory]`, `[smriti:offscreen]`, `[smriti:vault]`.

The Chrome Web Store build is not yet published; `STORE_LISTING.md` has the listing
copy and review notes.

---

## 17. How to contribute

**Before you start:** read [CLAUDE.md](CLAUDE.md). The two rules that prevent the
most damage:

1. **Content scripts stay DOM-only.** Never import `lib/memory.ts`, `lib/db.ts`, or
   `lib/embeddings.ts` from a content script (see [§5](#5-architecture-an-mv3-extension-with-a-compute-engine)).
2. **New engine capability = a new offscreen RPC.** Add a `case` in
   [`lib/offscreen-main.ts`](packages/extension/lib/offscreen-main.ts)
   `handleMessage()`; the UI calls it with `sendToHelper({ type, ... })` and reads
   fields off the loose result.

**Common recipes:**

- **Add an offscreen RPC:** implement the function in the right `lib/*.ts`; add a
  `case "your_rpc":` in `handleMessage`; call it from the UI via
  `sendToHelper({ type: "your_rpc", ... })`. No `background.ts` change is needed —
  `to_offscreen` already forwards arbitrary `{ type, ... }` payloads.
- **Add a schema change:** append a new `NNN_name.sql` migration tuple to `SCHEMA`
  in [`lib/migrations.ts`](packages/extension/lib/migrations.ts) (additive,
  idempotent — never edit a shipped migration).
- **Fix/extend capture for a site:** the API shapes drift. Update the URL regex /
  SSE parsing in the relevant `*-main.content.ts`, keeping it read-only and
  dependency-light. Verify with the page console.
- **Tune injection for a site:** update the selectors in
  [`lib/inject.ts`](packages/extension/lib/inject.ts) (`SELECTORS`). This is the
  most common breakage as sites change UI.
- **Improve extraction quality:** edit `RULES`/filters in
  [`lib/extract.ts`](packages/extension/lib/extract.ts) and **add assertions** to
  `scripts/test-extract.ts` — extraction quality is make-or-break, so it's the most
  valuable thing to pin with tests.
- **Reach a new external service:** add the origin to **both** `host_permissions`
  **and** the `connect-src` directive of `content_security_policy.extension_pages`
  in [`wxt.config.ts`](packages/extension/wxt.config.ts). The offscreen document is
  an extension page, so `connect-src` governs its `fetch()` calls — a host
  permission alone is not enough. (This is exactly the bug that currently blocks
  vault export.)

**Conventions:** match the existing style — section-comment headers
(`// ─── X ───`), serif/sans/mono CSS vars, the oxblood `--accent`. Commit messages
end with the `Co-Authored-By:` trailer (see `git log`). Keep the verification loop
green (`tsc --noEmit`, all `test:*`, `build`) after every change.

**Gotchas worth internalizing:**
- The background SW is ephemeral; **never** keep important state only in SW memory.
  The offscreen doc is the source of truth.
- The offscreen `ready` handshake must survive SW restarts (see
  [§5](#5-architecture-an-mv3-extension-with-a-compute-engine)).
- sql.js BLOBs come back as `Uint8Array` — reinterpret to `Float32Array` carefully
  (respect `byteOffset`).
- Recall must degrade to FTS when embeddings aren't ready yet (don't assume vectors
  exist).
- `ConversationMeta` (in `@smriti/shared`) includes `message_count` but **not**
  `platform_conv_id`. Rows selected straight from the `conversations` table are the
  other way round — don't `as ConversationMeta` a raw row.

---

## 18. Protocol reference (messages & RPCs)

**Offscreen RPCs** (`sendToHelper({ type, ... })` → a `case` in `handleMessage`):

| Area | Types |
|---|---|
| Health | `ping` (returns `{ pong, ready }`), `hello` |
| Capture/ingest | `ingest`, `capture_state`, `daily_stats` |
| Archive/search | `search`, `get_conversation`, `list_recent_conversations`, `get_by_platform`, `stats`, `get_outline`, `wipe_archive` |
| Embeddings | `embed_status` |
| Backfill | `start_backfill`, `cancel_backfill`, `backfill_status` |
| Memory | `recall_memories`, `list_memories`, `add_memory`, `edit_memory`, `pin_memory`, `delete_memory`, `memory_stats`, `touch_memories`, `build_memory_now` |
| Sync | `sync_status`, `sync_setup`, `sync_join`, `sync_now`, `sync_disable` |
| Vault | `vault_status`, `vault_enable`, `vault_disable`, `vault_sync_now`, `vault_sync_conversation`, `vault_resync_all` |
| Persistence | `flush` |
| Legacy no-op | `claude_code_scan` (returns zeros — no filesystem access in the browser) |

**Background message kinds** (`chrome.runtime.sendMessage({ kind, ... })`):
`capture`, `start_backfill`, `to_offscreen` (generic pass-through to the engine),
`capture_toggle`, `get_capture_paused`, `get_backfill_progress`, `health_check`,
plus lifecycle/broadcast kinds `offscreen_ready`, `offscreen_error`,
`backfill_progress`, `backfill_done`, `build_progress`.

**MAIN ↔ ISOLATED** ([`capture/messages.ts`](packages/extension/capture/messages.ts)):
`window.postMessage({ smriti: "smriti:v1", source: "<platform>-inject", events })`.

**Note on `packages/shared/src/protocol.ts`:** the `NMRequest` / `NMResponse`
unions there date from the native-messaging helper era and are **not** the current
offscreen RPC contract — today's RPCs are loosely typed (`AnyReq`/`AnyResp`) and
dispatched by the `switch` in `offscreen-main.ts`. The *shape* types in that file
(`SearchHit`, `OutlineSegment`, `BackfillProgress`, `ConversationMeta`, …) are very
much live. Treat the unions as historical, the interfaces as current.

---

## 19. Status, roadmap, and known gaps

**Shipped (and merged to `main`):** the full hero loop — automatic capture, history
import, heuristic extraction, hybrid recall, one-click injection — across Claude,
ChatGPT, and Gemini; the offline/vendored embedding model; a memory-first
onboarding funnel; optional E2E-encrypted sync; the sidebar modularization; and
(as of 2026-07-07) the vault export subsystem. The pre-release task list (T1–T11 in
[RELEASE_PLAN.md](RELEASE_PLAN.md)) is complete apart from manual QA items that
need a loaded extension.

**Blocking / near-term:**
- **`main` does not typecheck.** One error in `lib/vault-sync.ts`. Details and fix
  in [docs/REPO_STATUS.md](docs/REPO_STATUS.md).
- **The test scripts can't run on a fresh clone** (`tsx` undeclared), and two
  suites fail on content when run manually.
- **Vault export is not runnable** without an OAuth client ID and a CSP fix; two
  engine defects also need addressing. See [docs/VAULT_SYNC.md](docs/VAULT_SYNC.md).
- **Sync deployment** is a manual step: `wrangler deploy` the relay and swap the
  placeholder URL (×3).

**Longer-term:**
- **Injection selectors** need ongoing per-platform tuning — host sites change UI
  often; this is the main maintenance surface.
- **Extraction quality** is heuristic; an optional **BYOK LLM extraction** pass
  would lift it above regex (must stay opt-in to preserve the no-egress default).
- **Store listing / privacy copy** must be revised to describe vault export before
  submission — both currently claim nothing readable ever leaves the device.
- **Chrome Web Store:** not yet published.
- **Performance:** sql.js + single-threaded ONNX is fine into the thousands of
  messages; brute-force vector search and the near-dup guard are the first things
  to optimize for very large archives.
- The relay's v1 has no per-user auth and no CAS — a future Durable Object
  migration addresses both.

---

## 20. Glossary

- **Offscreen Document** — the long-lived hidden page that hosts the compute engine
  (SQLite, embeddings, search, memory, sync, vault). The heart of Smriti.
- **MAIN vs ISOLATED world** — MAIN runs in the page's own JS context (can patch
  `fetch`, no `chrome.*`); ISOLATED is the extension's sandboxed content-script
  context (`chrome.*` available). Capture spans both.
- **Capture** — read-only observation of your conversation streams.
- **Backfill / import** — bulk historical import via the AI sites' own APIs using
  your session cookies.
- **Distill / extract** — turning messages into durable first-person facts (no LLM).
- **Memory** — an atomic, durable fact about you (`identity`/`preference`/`project`/
  `decision`/`fact`).
- **Recall** — ranking memories relevant to what you're typing.
- **Inject** — writing the recalled context block into the host composer.
- **RRF (Reciprocal Rank Fusion)** — `Σ 1/(k+rank)`; merges keyword and vector rank
  lists without comparable scores.
- **OPFS** — Origin Private File System; the browser-private file storage where
  `smriti.db` lives.
- **Salience** — a 0–1 importance score on a memory that tunes recall ranking.
- **Tombstone** — a soft-deleted memory (`deleted_at` set) kept so sync can
  propagate the deletion.
- **syncId / recovery code** — the non-secret relay key and the secret from which
  the AES key + syncId are derived (HKDF). The recovery code is the only way to read
  your synced memories on another device.
- **Zero-knowledge relay** — the sync server; it stores only ciphertext it cannot
  read.
- **OKF** — Obsidian Knowledge Format; the frontmatter-plus-markdown shape vault
  export writes to Google Drive.
- **Vault** — the `smriti-vault` folder tree on the user's own Google Drive holding
  the exported OKF files.

---

*Smriti (स्मृति) is Sanskrit for "memory" / "that which is remembered."*
