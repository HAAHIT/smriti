# Smriti — project guide

## What this is

**Smriti is a local-first memory layer for AI.** It captures your conversations
across Claude, ChatGPT, and Gemini, distills durable facts about you, and lets
you inject that context into any AI prompt in one click — so every tool
"remembers you" without you re-explaining yourself.

Positioning: **"Your AI remembers you."** (Not "search your old chats" — that's a
feature, memory is the product.) Goal: fundable startup / YC.

### Where to read more

- **[`PRODUCT_BRIEF.md`](PRODUCT_BRIEF.md)** — the full product & engineering
  brief. Read this first if you're new to the codebase.
- **[`docs/REPO_STATUS.md`](docs/REPO_STATUS.md)** — verified build health right
  now: what compiles, what tests pass, what's blocked. **`main` is currently
  red — read this before starting work.**
- **[`docs/VAULT_SYNC.md`](docs/VAULT_SYNC.md)** — the vault export subsystem
  (OKF markdown → Google Drive), its setup procedure, and its known defects.
- **[`RELEASE_PLAN.md`](RELEASE_PLAN.md)** — the executable pre-release PRD.

### Strategic decisions (locked)

- **Direction:** memory layer, not just search/archive.
- **Data model:** local-first by default + optional end-to-end-encrypted sync
  (built — memories only, zero-knowledge relay). The privacy wedge is the moat;
  sync is what makes it a company.
- **Hero feature (built):** the memory injection loop — recall relevant memory as
  you type and inject it into the composer.

## Architecture (local-first browser extension + optional relay)

WXT + React. Core memory features run entirely in-browser. Nothing leaves the
device unless the user opts into one of two features: **sync**, which uploads
only end-to-end-encrypted memory blobs to the zero-knowledge relay (opaque
ciphertext the relay can't read), or **vault export**, which writes conversation
transcripts as plaintext markdown to the user's own Google Drive. The embedding
model is vendored at build time, so there is no runtime model download.

```text
packages/
  shared/      Types + protocol (@smriti/shared).
  extension/   The product (WXT, Chrome MV3 — Chrome only; the engine needs
               Offscreen Documents, which Firefox lacks)
  helper/      LEGACY Node service — superseded by the offscreen doc. Ignore.
  mcp-server/  LEGACY MCP server. Ignore for now (could return as a B2B/dev surface).
  sync-relay/  Cloudflare Worker + KV — zero-knowledge encrypted-blob relay for
               optional memory sync. Stores opaque ciphertext only.
```

Extension internals:
- `entrypoints/*-main.content.ts` — MAIN-world fetch interceptors that capture
  messages (read-only) from each platform's API stream.
- `entrypoints/background.ts` — service worker; routes messages, owns the
  offscreen doc lifecycle + capture toggles.
- `lib/offscreen-main.ts` — the compute engine. Owns SQLite (sql.js over OPFS),
  embeddings, search, memory. All RPCs dispatch here.
- `lib/db.ts` — sql.js + OPFS persistence (debounced flush). Synchronous query
  helpers `dbAll/dbGet/dbRun`.
- `lib/search.ts` — hybrid FTS5 + vector RRF search over messages.
- `lib/outline.ts` — embedding-based conversation chaptering (no LLM).
- `entrypoints/sidebar.content.ts` — in-page panel (shadow DOM). The HERO surface.
  Rendering/state/styles/helpers live in `lib/sidebar-{types,styles,helpers,renderers}.ts`
  — the helpers and renderers are pure and have their own test suites.
- `entrypoints/options/main.tsx` — the desktop archive viewer + Memory view.
- `lib/vault-sync.ts` + `lib/okf-renderer.ts` + `lib/drive-client.ts` — optional
  vault export: conversations → OKF markdown → the user's Google Drive.
  **Not currently runnable** — see `docs/VAULT_SYNC.md`.

## The memory layer (this is the differentiator)

- `lib/extract.ts` — **pure** heuristic extractor (no DB/model). Pulls durable
  first-person facts from user messages, classified as
  identity/preference/project/decision/fact. Unit-tested: `npm run test:extract`.
- `lib/memory.ts` — storage (dedup via norm_text + Jaccard near-dup guard),
  incremental extraction sweep (rowid cursor in `memory_meta`), memory embeddings,
  hybrid recall (FTS+vector RRF + pinned/salience/recency boosts), CRUD.
- `lib/inject.ts` — **pure DOM** composer injection. Per-platform selectors +
  robust fallbacks; `execCommand("insertText")` path for ProseMirror/Quill,
  native-setter path for textareas. `formatMemoryBlock()` builds the context block.
- `lib/index-worker.ts` — background loop: embeds messages, runs extraction
  sweeps, embeds memories.
- Schema migration `003_memory.sql` in `lib/migrations.ts`
  (`memories`, `memory_embeddings`, `memories_fts`, `memory_meta`).

The loop: sidebar watches the host composer as you type → `recall_memories` RPC →
"Smriti remembers" card → click Inject → `injectText()` writes into the composer →
`touch_memories` records usage. Auto-extraction means memory builds itself;
"Build my memory" (`build_memory_now`) populates instantly from history for demos.

### Architecture rules

- Anything imported by a **content script** must be DOM-only / dependency-light
  (`extract.ts`, `inject.ts` are safe; never import `memory.ts`/`db.ts` there —
  they pull sql.js/transformers, which belong to the offscreen doc only).
- New offscreen RPCs: add a `case` in `lib/offscreen-main.ts`; UI calls them via
  `sendToHelper({ type, ... })` (loose `AnyResp`, read fields off the result).
- Reaching a **new external origin** needs the host added to *both*
  `host_permissions` **and** the `connect-src` CSP in `wxt.config.ts` — the
  offscreen doc is an extension page, so CSP governs its `fetch()`.
- Schema changes: append a new migration tuple to `SCHEMA` in `lib/migrations.ts`
  (currently `001_init` … `005_vault`). Never edit a shipped migration.

## Build / test / run

```bash
npm install
cd packages/extension
npm run fetch:model      # vendor embedding model + ONNX wasm (~25 MB, one-time;
                          # also runs automatically before build/dev)
npx tsc --noEmit -p tsconfig.json
npm run test:extract             # extraction quality assertions
npm run test:sync                # sync crypto + merge decider
npm run test:sidebar-helpers     # pure sidebar helpers
npm run test:sidebar-renderers   # pure sidebar renderers
npm run test:okf                 # OKF markdown renderer
npm run build            # → .output/chrome-mv3  (load unpacked in chrome://extensions)
npm run dev              # live dev
```

⚠️ On a fresh clone the `test:*` scripts fail with `'tsx' is not recognized` —
`tsx` isn't declared in any installed workspace. Until that's fixed, run them as
`npx --yes tsx scripts/<name>.ts`. See `docs/REPO_STATUS.md`.

## Known gaps / next steps

**`RELEASE_PLAN.md` is the executable pre-release PRD (tasks T1–T11 with
anchors, snippets, and acceptance criteria) — work from it, in order.**
`docs/REPO_STATUS.md` has the current, verified state and a suggested work order.

**Red right now — fix these first:**
- `main` does not typecheck: one TS2352 in `lib/vault-sync.ts` (`ConversationMeta`
  has `message_count` but not `platform_conv_id`; a raw row is the reverse).
- `tsx` is undeclared, so no `test:*` script runs from a fresh clone.
- `test:okf` and `test:sidebar-helpers` fail when run manually (the sidebar-helper
  failures are stale assertions, not product bugs).
- Vault export can't authenticate: placeholder OAuth client ID + a CSP that blocks
  `googleapis.com`, plus three engine defects. See `docs/VAULT_SYNC.md`.

**Standing gaps:**
- Injection selectors need live tuning per platform (sites change often).
- BYOK LLM extraction (optional) would lift memory quality above heuristics.
- Optional E2E-encrypted sync (the fundability piece) is built (memories only):
  `lib/sync-crypto.ts` (HKDF + AES-256-GCM), `lib/sync.ts` (whole-state merge),
  `lib/sync-merge.ts` (pure decider, `npm run test:sync`), Settings → Sync UI,
  and `packages/sync-relay`. Remaining manual step: `wrangler deploy` the relay,
  then swap the `smriti-sync-relay.YOUR-SUBDOMAIN.workers.dev` placeholder in
  `lib/sync.ts` + `wxt.config.ts` (×2). See `packages/sync-relay/README.md`.
- Privacy copy (`PRIVACY_POLICY.md`, `STORE_LISTING.md`, `docs/privacy.html`,
  `docs/index.html`) predates vault export and still claims nothing leaves the
  device. Must be corrected before store submission.
- Not yet shipped to Chrome Web Store.

## Conventions

- Match existing style: section-comment headers (`// ─── X ───`), serif/sans/mono
  CSS vars, oxblood accent (`--accent`). No new deps unless necessary.
- Commit messages end with the Co-Authored-By trailer.
