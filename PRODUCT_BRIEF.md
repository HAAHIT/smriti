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
12. [Privacy & security model](#12-privacy--security-model)
13. [Tech stack](#13-tech-stack)
14. [Repository map](#14-repository-map)
15. [Build, run, and test](#15-build-run-and-test)
16. [How to contribute](#16-how-to-contribute)
17. [Protocol reference (messages & RPCs)](#17-protocol-reference-messages--rpcs)
18. [Status, roadmap, and known gaps](#18-status-roadmap-and-known-gaps)
19. [Glossary](#19-glossary)

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
  watch recall + one-click inject work on a real chat. See [§15](#15-build-run-and-test).
- **A contributor:** read [§5](#5-architecture-an-mv3-extension-with-a-compute-engine)
  → [§6](#6-data-flows-step-by-step) → [§14](#14-repository-map) →
  [§16](#16-how-to-contribute).
- **Anyone evaluating the idea:** [§1](#1-why-smriti-exists)–[§3](#3-product-principles-the-non-negotiables)
  and [§12](#12-privacy--security-model).

---

## 2. What Smriti is (the loop)

Smriti is a browser extension that runs a four-verb loop. Everything in the
product is in service of this loop:

```
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

A fifth capability sits alongside the loop:

5. **Sync (optional)** — Mirror your memories across devices, end-to-end encrypted.
   Smriti's relay only ever stores opaque ciphertext.

**User-facing surfaces:**
- **The sidebar** ([`entrypoints/sidebar.content.ts`](packages/extension/entrypoints/sidebar.content.ts))
  — an in-page panel (Shadow DOM) on the AI sites. This is the **hero surface**: it
  shows the "✦ Smriti remembers" recall card and the Inject button as you type.
- **The options page** ([`entrypoints/options/main.tsx`](packages/extension/entrypoints/options/main.tsx))
  — the desktop app: onboarding funnel, conversation archive + search, the Memory
  view (browse/pin/edit/delete), and Settings (capture toggles, export/import, sync).

---

## 3. Product principles (the non-negotiables)

These are load-bearing. Changing one of them changes what Smriti *is*.

1. **Local-first by default.** All core features run in-browser. Nothing about your
   conversations or memories leaves the device — with two explicit, narrow
   exceptions ([§12](#12-privacy--security-model)): the read-only history import
   talks to the AI sites *you're already logged into* (not to any Smriti server),
   and optional sync uploads *encrypted blobs only*.
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

```
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
│   └──────────────────────────────────────────────────────────────────────┘   │
│                                                                                │
│   options page (main.tsx) ── sendMessage({kind:"to_offscreen"}) ──▶ background │
└──────────────────────────────────────────────────────────────────────────────┘
                                    │ (only if user opts in)
                                    ▼ PUT/GET encrypted blob
              ┌───────────────────────────────────────────────┐
              │ packages/sync-relay (Cloudflare Worker + KV)   │
              │  stores opaque ciphertext keyed by syncId only │
              └───────────────────────────────────────────────┘
```

**The one big idea to internalize:** there is a single **compute engine** — the
**Offscreen Document** — that owns all state and all heavy work (SQLite,
embeddings, search, memory, sync). Every other context (content scripts,
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
| **Offscreen Document** | [`offscreen.html`](packages/extension/entrypoints/offscreen.html) + [`lib/offscreen-main.ts`](packages/extension/lib/offscreen-main.ts) | offscreen | The **compute engine**. Long-lived; owns SQLite, embeddings, search, memory, backfill, sync. All real work happens here. |
| **UI pages** | [`entrypoints/options/main.tsx`](packages/extension/entrypoints/options/main.tsx) (React), [`entrypoints/sidebar.content.ts`](packages/extension/entrypoints/sidebar.content.ts) (Shadow DOM) | extension pages / content | The product's faces. They call the engine via `sendToHelper({ type, ... })` and read fields off a loose result. |

### The offscreen lifecycle (a subtle, important detail)

The offscreen document **outlives the background service worker**. The SW is
ephemeral; the offscreen doc persists until the extension is reloaded. This
creates a readiness handshake that every contributor should understand:

- On boot, the offscreen doc runs `boot()` → `initDb()` → `startIndexWorker()` →
  sets an internal `dbReady` flag → broadcasts `offscreen_ready`.
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

### The golden rule for content-script imports

Content scripts (and anything they import) must be **DOM-only / dependency-light**.
[`lib/extract.ts`](packages/extension/lib/extract.ts) and
[`lib/inject.ts`](packages/extension/lib/inject.ts) are safe to import from a
content script (pure functions, no heavy deps). **Never** import
[`lib/memory.ts`](packages/extension/lib/memory.ts),
[`lib/db.ts`](packages/extension/lib/db.ts), or
[`lib/embeddings.ts`](packages/extension/lib/embeddings.ts) from a content
script — they pull in sql.js and Transformers.js, which belong only to the
offscreen document. Breaking this rule bloats content scripts and can break the
page.

---

## 6. Data flows, step by step

### A. Live capture (as you chat)

```
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

### B. History import (backfill)

```
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

```
index-worker.ts tick (every ~5s active, ~30s idle):
  1. extractionSweep(): scan user messages past a rowid cursor, run extractCandidates(),
     storeMemory() each surviving fact (dedup along the way)         [no model, cheap]
  2. embed a batch of un-embedded messages                          [model]
  3. embed a batch of un-embedded memories                          [model]
```

"Build my memory" (`build_memory_now`) runs the extraction pass over the whole
backlog immediately (chunked + progress-reported) so onboarding has an instant
payoff. See [§7](#7-the-memory-layer-in-depth).

### D. Recall + inject (the hero)

```
You start typing in the host composer
  → sidebar.content.ts watches the composer (debounced)
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
block to the clipboard so the action never dead-ends.

### E. Sync (optional, opt-in)

```
sync_now:
  pull encrypted blob from relay (GET /v1/blob/:syncId)
    → decrypt (AES-256-GCM) → ChangesetMemory[]
    → for each remote row: decideMerge() vs local → insert/update/delete/skip
    → carry forward remote rows we skipped but don't hold locally
  export full local memory state → union with carried rows
    → encrypt → push (PUT /v1/blob/:syncId)
```

See [§11](#11-optional-end-to-end-encrypted-sync).

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
  memories of the same kind. On a dup it bumps the existing memory's `salience`
  instead of inserting.
- **`extractionSweep`**: incremental — processes user messages past a stored rowid
  cursor (in `memory_meta`), so every message (live or imported) is extracted
  exactly once.
- **`recallMemories(query, limit)`** — the recall ranker:
  - **FTS lane**: `memories_fts MATCH` ranked by `bm25`.
  - **Vector lane**: embed the query, cosine-similarity over `memory_embeddings`.
  - **RRF fusion**: `score = Σ 1 / (k + rank)` with `k = 60` (merges the two rank
    lists without needing comparable scores).
  - **Pinned fold-in**: pinned memories are *always* eligible, even on a weak query.
  - **Boosts**: final score multiplies in `salience`, a `1.4×` pin bonus, and a
    use-count bonus — so curated/important/frequently-used memories rise.
  - Degrades gracefully: if embeddings aren't ready yet, FTS alone still returns
    results (this is why the onboarding "Try it now" demo works immediately).
- **CRUD**: `addMemory`, `editMemory`, `setMemoryPinned`, `deleteMemory`,
  `touchMemories`, `listMemories`, `memoryStats`. Deletion is a **soft delete** /
  tombstone (see [§9](#9-storage--data-model) and [§11](#11-optional-end-to-end-encrypted-sync)).

### `lib/inject.ts` — composer injection (pure DOM)

- **`formatMemoryBlock(memories)`**: builds the human-readable context block
  ("Context about me, from my past conversations: …").
- **Per-platform selectors** with robust fallbacks (Claude/ChatGPT = ProseMirror
  `contenteditable`; Gemini = Quill `.ql-editor`; some surfaces still `<textarea>`).
  `findComposer()` prefers the visible editor nearest the bottom of the viewport.
- **Insertion strategy**: prefer `document.execCommand("insertText")` on a focused
  contenteditable (routes through the editor's own input pipeline so
  React/ProseMirror/Quill stay in sync); fall back to a native-setter +
  `InputEvent` path for `<textarea>`; hard fallback prepends a text node. Inserts at
  the **start** so context lands ahead of what you've typed.
- Selectors are the most fragile part of the product (host sites change UI often);
  this is the main "needs live tuning" maintenance surface.

### `lib/outline.ts` — conversation chaptering

Embedding-based segmentation of long conversations into chapters (no LLM) — used by
the archive viewer.

---

## 8. Search (over the conversation archive)

[`lib/search.ts`](packages/extension/lib/search.ts) powers the options-page archive
search (distinct from *memory* recall, though they share the RRF idea):

- **FTS5 lane**: `messages_fts MATCH` ranked by `bm25`, with `snippet()` highlights.
- **Vector lane**: embed the query, cosine over `message_embeddings`.
- **RRF fusion** (`k = 60`) merges both, then **collapses to one hit per
  conversation** (best message), so results are conversations, not duplicate
  fragments.
- Resilient: a malformed FTS query falls back to vector-only; no embeddings falls
  back to FTS-only. Timing is logged; a query over ~300 ms warns.

---

## 9. Storage & data model

### sql.js + OPFS ([`lib/db.ts`](packages/extension/lib/db.ts))

- **SQLite compiled to WASM** (sql.js) runs *in memory* inside the offscreen doc —
  full SQLite including **FTS5**. Query helpers `dbAll` / `dbGet` / `dbRun` are
  **synchronous** (sql.js runs on the offscreen thread), which keeps ported code
  clean.
- **Persistence** = the **Origin Private File System (OPFS)**. The whole DB is one
  file, `smriti.db`, in the extension's private storage — invisible to websites,
  survives restarts. Writes call `markDirty()`, which schedules a **2-second
  debounced flush** (`db.export()` → OPFS), so a burst of writes flushes once.
- `initDb()` requests `navigator.storage.persist()` (so Chrome won't evict the DB
  under disk pressure) and applies migrations idempotently via a `_migrations`
  table.

### Schema ([`lib/migrations.ts`](packages/extension/lib/migrations.ts))

Migrations are an ordered list of `[id, sql]` applied once each. The important
tables:

| Table | Purpose |
|---|---|
| `conversations` | one row per captured chat (platform, title, url, timestamps); `UNIQUE(platform, platform_conv_id)` |
| `messages` | one row per message (role, `content_text`, `position`, `content_hash`); `UNIQUE(conversation_id, content_hash)` dedups re-captures |
| `messages_fts` | FTS5 virtual table mirroring `messages` (porter/unicode61), kept in sync by triggers |
| `message_embeddings` | `vec` BLOB (Float32, 384 dims) per message + model name |
| **`memories`** | the memory layer: `kind`, `text`, `norm_text` (`UNIQUE`, for dedup), `source`, provenance FKs, `pinned`, `salience`, `use_count`, `status`, `deleted_at` |
| `memory_embeddings` | embeddings for semantic recall, mirrors `message_embeddings` |
| `memories_fts` | FTS5 over memory text |
| `memory_meta` | bookkeeping (e.g. the extraction rowid cursor) |
| `sync_config` | singleton row: `enabled`, `sync_id`, `device_id`, `last_synced_at` (all **non-secret**) |
| `capture_state`, `backfill_state`, `daily_stats`, `tags`, `notes`, `ingest_state` | capture health, import progress, stats, tagging/notes, ingest cursors |

**Soft delete (tombstones).** `deleteMemory` doesn't hard-delete; it sets
`deleted_at`, bumps `updated_at`, and mutates `norm_text` (appending
`#deleted:<id>`) to free the `UNIQUE(norm_text)` slot for future re-extraction. The
row remains so sync can propagate the deletion to other devices. Every "is this
memory active?" query therefore filters `status = 'active' AND deleted_at IS NULL`.

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
  fine for the data volumes this product handles).
- **The index worker** lazily loads the model only when there's work, processes
  bounded batches per tick, yields via `setTimeout`, and has a consecutive-error
  circuit breaker. Embedding is best-effort and retried; recall/search degrade to
  FTS until vectors exist.

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
  device's data), then encrypts and pushes the union.
- **Merge decider** ([`lib/sync-merge.ts`](packages/extension/lib/sync-merge.ts)): a
  **pure**, unit-tested function `decideMerge(remote, local, collides)` →
  `inserted | updated | deleted | skipped`. Rules: last-write-wins by `updated_at`;
  **delete wins** on conflict (a local tombstone is never resurrected);
  `norm_text` collisions skip and self-resolve on a later sync. Pure so it runs
  under `tsx`: `npm run test:sync`.
- **Relay** ([`packages/sync-relay/src/index.ts`](packages/sync-relay/src/index.ts)):
  a Cloudflare Worker + KV. `GET/PUT/DELETE /v1/blob/:syncId` where `syncId` is 32
  lowercase hex; 2 MB cap; wildcard CORS (safe — payload is ciphertext, no
  credentials, syncId is a 128-bit-derived secret). Documented v1 limitations: no
  per-user auth (mitigated by cap + Cloudflare rate limiting + KV quotas) and no
  compare-and-swap (a future Durable Object migration).
- **Deploy step (manual):** `wrangler deploy` the relay, then replace the
  `smriti-sync-relay.YOUR-SUBDOMAIN.workers.dev` placeholder in
  [`lib/sync.ts`](packages/extension/lib/sync.ts) and
  [`wxt.config.ts`](packages/extension/wxt.config.ts) (×2). Until then `syncNow()`
  throws a clear "relay not configured" error. See
  [`packages/sync-relay/README.md`](packages/sync-relay/README.md).

---

## 12. Privacy & security model

**What stays on your device (everything, by default):** conversations, messages,
embeddings, and memories live only in OPFS inside the offscreen document. No
account, no server, no telemetry.

**The only two times bytes leave the device:**
1. **History import** issues requests to **claude.ai / chatgpt.com themselves**
   (using *your* session cookies), exactly as your browser would — not to any
   Smriti server. It's read-only.
2. **Sync (opt-in)** uploads **AES-256-GCM ciphertext** to the relay. The relay is
   zero-knowledge: it can't read it, and the key never leaves your devices.

**Threat-model notes for contributors:**
- The `syncId` doubles as the lookup key *and* the bearer credential for a sync
  group's blob; it's 128-bit-derived, so not guessable, but anyone who has it can
  read/overwrite that (encrypted) blob. Don't log it or leak it.
- Never write the recovery code / derived keys into SQLite (they'd land in
  exports). They belong only in `chrome.storage.local`.
- MAIN-world fetch interception on three major AI sites is exactly what Chrome Web
  Store reviewers scrutinize. Keep capture strictly read-only and the permission
  set minimal (`storage`, `offscreen`, `scripting` + the three host permissions).
  See [`STORE_LISTING.md`](STORE_LISTING.md) and
  [`PRIVACY_POLICY.md`](PRIVACY_POLICY.md).

---

## 13. Tech stack

- **Extension framework:** [WXT](https://wxt.dev) `^0.19` (Vite-based, MV3).
- **UI:** React `^18`.
- **Database:** [sql.js](https://sql.js.org) `^1.12` (SQLite/WASM) over **OPFS**.
- **Embeddings:** [@xenova/transformers](https://github.com/xenova/transformers.js)
  `^2.17` (Transformers.js / ONNX WASM), model `all-MiniLM-L6-v2`.
- **Language/tooling:** TypeScript `^5.6`, Node `>= 20`, `tsx` for headless tests.
- **Sync relay:** Cloudflare Workers + KV, `wrangler`, `@cloudflare/workers-types`.
- **Browser target:** **Chrome/Chromium only** (`minimum_chrome_version: 116`).
  Firefox is intentionally unsupported because the engine needs the Offscreen
  Documents API.
- **No new runtime dependencies** unless truly necessary (a stated convention).

---

## 14. Repository map

```
packages/
  shared/      @smriti/shared — TypeScript types + the message/protocol contract.
               src/types.ts (MemoryItem, CaptureEvent, …), src/protocol.ts
               (BackfillProgress, BackfillState, …). Imported everywhere.

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
      migrations.ts                 the SQL schema (001_init … 004_sync)
      ingest.ts                     CaptureEvent[] → conversations/messages rows
      backfill.ts                   history import for Claude + ChatGPT (session-cookie fetch)
      embeddings.ts                 Transformers.js model + vector store/search
      index-worker.ts               background loop: extract + embed
      search.ts                     hybrid FTS5 + vector RRF over messages
      outline.ts                    embedding-based conversation chaptering (no LLM)
      extract.ts                    PURE heuristic memory extractor (unit-tested)
      memory.ts                     memory store/dedup/recall/CRUD
      inject.ts                     PURE DOM composer injection + formatMemoryBlock
      sync.ts                       whole-state sync engine
      sync-crypto.ts                HKDF + AES-256-GCM primitives
      sync-merge.ts                 PURE merge decider (unit-tested)
    capture/messages.ts             the smriti:v1 postMessage contract (MAIN ↔ ISOLATED)
    scripts/
      fetch-model.mjs               vendor the embedding model + ONNX wasm
      test-extract.ts               extraction-quality assertions  (npm run test:extract)
      test-sync.ts                  crypto + merge-decision assertions (npm run test:sync)
    wxt.config.ts                   manifest (permissions, hosts, CSP, content scripts)

  sync-relay/  Cloudflare Worker + KV — the zero-knowledge encrypted-blob relay.

  helper/      LEGACY Node service — superseded by the offscreen doc. Ignore.
  mcp-server/  LEGACY MCP server. Ignore for now (possible future B2B/dev surface).
```

Root docs: [README.md](README.md) (quick start), [CLAUDE.md](CLAUDE.md)
(conventions + roadmap), [RELEASE_PLAN.md](RELEASE_PLAN.md) (the pre-release PRD,
tasks T1–T11), [STORE_LISTING.md](STORE_LISTING.md), [PRIVACY_POLICY.md](PRIVACY_POLICY.md).

---

## 15. Build, run, and test

Prereqs: **Node ≥ 20**, **Chrome/Chromium**.

```bash
npm install                 # from repo root (workspaces)
cd packages/extension

npm run fetch:model         # vendor the embedding model + ONNX wasm (~25 MB, one-time;
                            # also runs automatically before build/dev)

npx tsc --noEmit -p tsconfig.json   # typecheck (must be clean)
npm run test:extract        # extraction-quality assertions
npm run test:sync           # crypto + merge-decision assertions
npm run build               # → .output/chrome-mv3
npm run dev                 # live dev (HMR)
```

**Load it in Chrome:**
1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select `packages/extension/.output/chrome-mv3`.
3. Open claude.ai / chatgpt.com / gemini.google.com (signed in), click the Smriti
   toolbar icon → **✦ Memory** → **Build my memory**, then start typing a prompt to
   see recall + one-click inject.

**Inspecting the engine (essential for debugging):** `chrome://extensions` →
Smriti → **Inspect views: offscreen.html** opens the offscreen document's console
(DB / embeddings / sync logs). The service-worker console is reachable the same
way. Capture logs appear in the **page** console on the AI site (look for
`[smriti] …`).

The Chrome Web Store build is not yet published; `STORE_LISTING.md` has the listing
copy and review notes.

---

## 16. How to contribute

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

**Conventions:** match the existing style — section-comment headers
(`// ─── X ───`), serif/sans/mono CSS vars, the oxblood `--accent`. Commit messages
end with the `Co-Authored-By:` trailer (see `git log`). Keep the verification loop
green (`tsc --noEmit`, `test:extract`, `test:sync`, `build`) after every change.

**Gotchas worth internalizing:**
- The background SW is ephemeral; **never** keep important state only in SW memory.
  The offscreen doc is the source of truth.
- The offscreen `ready` handshake must survive SW restarts (see
  [§5](#5-architecture-an-mv3-extension-with-a-compute-engine)).
- sql.js BLOBs come back as `Uint8Array` — reinterpret to `Float32Array` carefully
  (respect `byteOffset`).
- Recall must degrade to FTS when embeddings aren't ready yet (don't assume vectors
  exist).

---

## 17. Protocol reference (messages & RPCs)

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
| Persistence | `flush` |

**Background message kinds** (`chrome.runtime.sendMessage({ kind, ... })`):
`capture`, `start_backfill`, `to_offscreen` (generic pass-through to the engine),
`capture_toggle`, `get_capture_paused`, `get_backfill_progress`, `health_check`,
plus lifecycle/broadcast kinds `offscreen_ready`, `offscreen_error`,
`backfill_progress`, `backfill_done`, `build_progress`.

**MAIN ↔ ISOLATED** ([`capture/messages.ts`](packages/extension/capture/messages.ts)):
`window.postMessage({ smriti: "smriti:v1", source: "<platform>-inject", events })`.

---

## 18. Status, roadmap, and known gaps

**Shipped (and merged):** the full hero loop — automatic capture, history import,
heuristic extraction, hybrid recall, one-click injection — across Claude, ChatGPT,
and Gemini; the offline/vendored embedding model; a memory-first onboarding funnel;
and optional E2E-encrypted sync. The pre-release task list (T1–T11 in
[RELEASE_PLAN.md](RELEASE_PLAN.md)) is complete.

**Known gaps / next steps:**
- **Injection selectors** need ongoing per-platform tuning — host sites change UI
  often; this is the main maintenance surface.
- **Extraction quality** is heuristic; an optional **BYOK LLM extraction** pass
  would lift it above regex (must stay opt-in to preserve the no-egress default).
- **Sync deployment** is a manual step: `wrangler deploy` the relay and swap the
  placeholder URL (×3). The relay's v1 has no per-user auth and no CAS — a future
  Durable Object migration addresses both.
- **Chrome Web Store:** not yet published (`STORE_LISTING.md` has placeholders).
- **Performance:** sql.js + single-threaded ONNX is fine into the thousands of
  messages; brute-force vector search and the near-dup guard are the first things
  to optimize for very large archives.

---

## 19. Glossary

- **Offscreen Document** — the long-lived hidden page that hosts the compute engine
  (SQLite, embeddings, search, memory, sync). The heart of Smriti.
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

---

*Smriti (स्मृति) is Sanskrit for "memory" / "that which is remembered."*
