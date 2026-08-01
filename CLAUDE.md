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
  now: what compiles, what tests pass, what's blocked. Phase 0 made the tree
  green and put CI in front of it.
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
- `lib/connectors/registry.ts` — **the source registry.** One `SourceDef` per
  place Smriti captures from, and the single source of truth for every origin
  list: content-script `matches`, the sidebar's `matches`, `host_permissions`,
  and the capture-pause host mapping are all derived from it. Adding a source
  means adding an entry here. Pure data + pure functions — it is imported by
  content scripts *and* by `wxt.config.ts` at build time, so keep it free of
  browser globals.
- `lib/connectors/fetch-interceptor.ts` / `dom-observer.ts` — the two capture
  strategies. A connector supplies only what is site-specific (which requests to
  watch, how to parse a payload, or which selectors mark a turn); all the
  mechanism lives in the strategy.
- `entrypoints/*-main.content.ts` — the per-source connector definitions.
  MAIN-world for fetch interceptors (read-only; they tee the response so the
  page is untouched).
- `entrypoints/bridge.content.ts` — ISOLATED-world relay. MAIN-world scripts
  can't reach `chrome.*`, so they `postMessage` and this forwards. One bridge
  for all sources; its `matches` is the union of registry origins.
- `entrypoints/background.ts` — service worker; routes messages, owns the
  offscreen doc lifecycle + capture toggles.
- `lib/ingest.ts` — turns capture events into rows. Owns the two things a
  connector cannot: the dense per-conversation `position`, and the dedup hash
  (`lib/ingest-identity.ts`, kept DB-free so it is testable).
- `lib/offscreen-main.ts` — the compute engine. Owns SQLite (sql.js over OPFS),
  embeddings, search, memory. All RPCs dispatch here.
- `lib/db.ts` — sql.js + OPFS persistence (debounced flush). Synchronous query
  helpers `dbAll/dbGet/dbRun`.
- `lib/search.ts` — hybrid RRF search. The FTS5 lane matches **messages** (an
  exact token lives in exactly one). The vector lane matches **episodes**, then
  resolves each hit down to the best message inside it.
- `lib/segment.ts` — **pure** episode segmentation: time gaps and a size cap
  always, cosine-drop refinement when enough messages carry a vector. Shared by
  `outline.ts` and `episodes.ts`. `npm run test:segment`.
- `lib/episodes.ts` — builds/embeds/queries the `episodes` table.
- `lib/vectors.ts` — the int8 episode-vector store, held **outside SQLite** in
  its own OPFS file. `lib/db.ts` persists by serialising the whole database on
  every flush, so vectors kept inside it would be rewritten wholesale every few
  seconds. Needs `initVectors()` at boot and `flushVectors()` alongside
  `flushToOpfs()` — both wired in `lib/offscreen-main.ts`. `npm run test:vectors`.
- `lib/fts-query.ts` — **pure** FTS5 MATCH builder, shared by search and memory
  recall. It must agree with the tokenizer in migration 007 or queries silently
  return nothing. `npm run test:fts-query`.
- `lib/outline.ts` — conversation chaptering (no LLM), now a thin layer over
  `segment.ts`.
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
  sweeps, embeds memories, segments conversations into episodes and embeds
  their gists. The episode stages are gated on `isVectorsReady()`.
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
  (currently `001_init` … `007_episodes`). Never edit a shipped migration.
  `npm run test:migrations` runs the real SQL against real SQLite — add coverage
  there for anything that rewrites existing rows.
- Adding a capture source: add a `SourceDef` to `lib/connectors/registry.ts` and
  one connector file using `installFetchInterceptor` or `installDomObserver`.
  Do **not** hardcode an origin anywhere else. The synthetic fourth connector in
  `scripts/test-connectors.ts` is the worked example.

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
npm run test:connectors          # source registry + connector SDK + msg identity
npm run test:segment             # episode boundary rules (pure)
npm run test:fts-query           # FTS5 MATCH builder (pure)
npm run test:vectors             # int8 vector store: search, removal, file format
npm run test:migrations          # real migration SQL against real SQLite
npm run build            # → .output/chrome-mv3  (load unpacked in chrome://extensions)
npm run dev              # live dev
```

All `test:*` scripts run from a fresh clone (`tsx` is a declared devDependency
of `packages/extension`). `.github/workflows/ci.yml` runs the typecheck and every
suite on every PR and on pushes to `main` — it deliberately does **not**
run `npm run build`, because `prebuild` triggers the ~25 MB model fetch and
`wxt build` uses Vite, which transpiles without typechecking.

## Known gaps / next steps

**`RELEASE_PLAN.md` is the executable pre-release PRD (tasks T1–T11 with
anchors, snippets, and acceptance criteria) — work from it, in order.**
`docs/REPO_STATUS.md` has the current, verified state and a suggested work order.

**Green as of Phase 2** — the typecheck is clean, all ten suites pass, and CI
blocks merges. The build-health items that used to sit here are fixed.

**Frozen (built, not shipped):**
- **Sync and Vault UI are hidden** behind the `FEATURES` flag at the top of
  `entrypoints/options/main.tsx`. Their engine code (`lib/sync.ts`,
  `lib/vault-sync.ts`, `lib/drive-client.ts`) and migrations 004/005 are intact
  and untouched — flip a flag to resume. They are hidden because neither can be
  turned on from the UI: sync needs the relay deployed and its placeholder URL
  swapped in, and vault export can't authenticate at all (placeholder OAuth
  client ID + a CSP that blocks `googleapis.com`, plus three engine defects —
  see `docs/VAULT_SYNC.md`).

**Standing gaps:**
- Injection selectors need live tuning per platform (sites change often).
- BYOK LLM extraction (optional) would lift memory quality above heuristics.
- Optional E2E-encrypted sync (the fundability piece) is built (memories only):
  `lib/sync-crypto.ts` (HKDF + AES-256-GCM), `lib/sync.ts` (whole-state merge),
  `lib/sync-merge.ts` (pure decider, `npm run test:sync`), Settings → Sync UI
  (currently hidden — see *Frozen* above), and `packages/sync-relay`. Remaining
  manual step: `wrangler deploy` the relay, then swap the
  `smriti-sync-relay.YOUR-SUBDOMAIN.workers.dev` placeholder in `lib/sync.ts` +
  `wxt.config.ts` (×2). See `packages/sync-relay/README.md`.
- Privacy copy (`PRIVACY_POLICY.md`, `STORE_LISTING.md`, `docs/privacy.html`,
  `docs/index.html`) predates vault export and still claims nothing leaves the
  device. Must be corrected before store submission. (The *code* now matches
  that claim again: Phase 0 vendored the webfonts, so no surface requests
  `fonts.googleapis.com` any more — see `packages/extension/public/fonts/`.)
- Not yet shipped to Chrome Web Store.

## Conventions

- Match existing style: section-comment headers (`// ─── X ───`), serif/sans/mono
  CSS vars, oxblood accent (`--accent`). No new deps unless necessary.
- Commit messages end with the Co-Authored-By trailer.
