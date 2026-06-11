# Smriti — Pre-release execution plan (PRD)

This document is a self-contained work order for getting Smriti from
"demo-ready" to "stranger-ready" (Chrome Web Store v0.1.0). It is written to be
executed task-by-task by an AI coding agent with no prior context.

**Before starting any task:** read `CLAUDE.md` (repo root). It explains the
product, the architecture, and the conventions. The two rules that prevent the
most damage:

1. **Content scripts** (`entrypoints/sidebar.content.ts`, `lib/inject.ts`,
   `lib/extract.ts`) must stay DOM-only / dependency-light. Never import
   `lib/memory.ts`, `lib/db.ts`, or `lib/embeddings.ts` from them — those pull
   sql.js/transformers and belong only to the offscreen document.
2. **New offscreen RPCs** = add a `case` in `lib/offscreen-main.ts`
   `handleMessage()`; UI calls them with `sendToHelper({ type, ... })` and reads
   fields off the loose result.

**Line numbers in this doc are anchors, not gospel** — they drift as you edit.
Always locate the quoted code with search, not by line number.

## How to work

- Do tasks **in order within each priority band**: T1 → T2 → … P0 must all be
  done before release; P1 should be; P2 is post-launch-acceptable.
- One commit per task, message ends with the `Co-Authored-By: Claude` trailer
  (see `git log` for the exact format used).
- **Verification loop after every task** (run from `packages/extension/`):

```bash
npx tsc --noEmit -p tsconfig.json   # must exit 0
npm run test:extract                # all assertions must pass
npm run build                       # wxt build must exit 0
```

- Manual QA = load `.output/chrome-mv3` unpacked at `chrome://extensions`
  (Developer mode → Load unpacked). The offscreen document's console is
  reachable via `chrome://extensions` → Smriti → "Inspect views: offscreen.html".

**Explicitly out of scope — do NOT build any of these:** encrypted sync,
accounts, BYOK/LLM extraction, new platforms, package renames, redesigns.

---

# P0 — release blockers

## T1. Request persistent storage (prevent OPFS eviction) — XS

**Why:** The DB lives in OPFS (`lib/db.ts`, file `smriti.db`). Without
`navigator.storage.persist()`, Chrome may evict it under disk pressure —
catastrophic for a product whose promise is "remembers you".

**Files:** `packages/extension/lib/db.ts`

**Read first:** `lib/db.ts` `initDb()` (~line 26).

**Implementation:** at the top of `initDb()`, before loading the file:

```ts
// Ask the browser never to evict this origin's storage (OPFS) under disk
// pressure. Best-effort: extension origins are usually granted silently.
try {
  const persisted = await navigator.storage.persist();
  console.log("[smriti:db] storage.persist:", persisted ? "granted" : "denied");
} catch (e) {
  console.warn("[smriti:db] storage.persist unavailable", e);
}
```

**Acceptance:**
- [ ] Offscreen console logs `storage.persist: granted` on boot.
- [ ] Verification loop green.

## T2. Memory-first onboarding funnel (kill the cold start) — L

**Why:** A fresh install has zero memories, so the hero feature shows nothing
and the user uninstalls. The cure already exists in code — history backfill +
`build_memory_now` — it just isn't the front door. Target: install → imported
history → "Smriti learned N things about you" → first inject, in under 10
minutes.

**Files:** `packages/extension/entrypoints/options/main.tsx`,
`packages/extension/entrypoints/background.ts`

**Read first:**
- `options/main.tsx` — the existing onboarding: `ONBOARDED_KEY` (~1679),
  `Onboarding` component + `OnboardingStep1/2/3` (~1688–1860), and the
  `needOnboarding` gate in `App` (~2474–2490). Routing: `parseHash` (~69)
  already supports `#/welcome`.
- `options/main.tsx` — `BackfillSection` (~842–950): the existing pattern for
  starting a backfill (`browser.runtime.sendMessage({ kind: "start_backfill",
  platform })`) and receiving progress (listen for `kind === "backfill_progress"`
  messages; restore state via `kind: "get_backfill_progress"`). Reuse this
  pattern — do not invent a new protocol.
- `lib/offscreen-main.ts` — the `build_memory_now` case (returns
  `{ created, processed, stats }`) and `memory_stats`.
- `lib/backfill.ts` line 53: backfill supports **claude and chatgpt only**;
  Gemini is capture-only. Copy must reflect that.

**Implementation:**

1. **Open the funnel on install.** In `background.ts`, inside the
   `defineBackground(() => { ... })` callback, add:

```ts
chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === "install") {
    void chrome.tabs.create({ url: chrome.runtime.getURL("/options.html#/welcome") });
  }
});
```

2. **Rework the three onboarding steps** (keep the existing
   `Onboarding`/step-component structure, shell, and `onDone` wiring; replace
   the *content*):

   - **Step 1 — "Your AI is about to remember you."** Replace search-era copy.
     Three short value lines (capture happens automatically on claude.ai /
     chatgpt.com / gemini.google.com; Smriti distills durable facts about you;
     you inject them into any prompt in one click) + one privacy line
     ("Everything stays in your browser. Nothing is uploaded — there's no
     server."). CTA: "Next".
   - **Step 2 — "Import your history."** Two provider cards: Claude and
     ChatGPT, each with an Import button that fires
     `{ kind: "start_backfill", platform }` and then shows live progress
     (fetched / total, latest titles) using the `backfill_progress` listener
     pattern from `BackfillSection`. A note under them: "Gemini is captured
     live as you chat — no import needed." Buttons: "Continue" (enabled
     always) and "Skip for now". Import keeps running in the background if
     they continue — say so in the UI.
   - **Step 3 — "Build your memory."** One button: "Build my memory" → call
     `sendToHelper({ type: "build_memory_now" })`, show a spinner, then render
     the result: "✦ Smriti learned **{stats.total}** things about you" with
     the per-kind breakdown (identity/preference/project/decision/fact counts
     from `stats.byKind`). Below it, the finish row: buttons "Open claude.ai"
     and "Open chatgpt.com" (`target="_blank"` links) + "See my memory"
     (calls `onDone()` then navigates to `#/memory`). All three finish paths
     must set the onboarded flag (the existing `onDone` → `finishOnboarding`
     does this).
     - Edge case: if `stats.total === 0` (user skipped import and has no
       history), show "No history yet — Smriti learns as you chat" and the
       same finish row. Never show a bare zero as the payoff.

3. Do **not** remove or break `BackfillSection` in the left rail — it remains
   the post-onboarding home for imports.

**Acceptance:**
- [ ] Fresh install (remove + re-load unpacked) auto-opens `options.html#/welcome`.
- [ ] Step 2 starts a real Claude or ChatGPT backfill and shows live progress
      (requires being logged into that site in the same profile).
- [ ] Step 3 runs `build_memory_now` and shows a non-zero count after an import,
      and the zero-state copy when there's no history.
- [ ] Completing onboarding lands in the app; reloading does not re-show it.
- [ ] No step ever dead-ends: every step has a skip/continue path.
- [ ] Verification loop green.

## T3. Clipboard fallback — injection must never dead-end — S

**Why:** Injection depends on per-site DOM selectors that break whenever the
host sites ship UI changes. Today, when `injectText()` fails, the user gets
"Click your message box once, then retry" — a dead end on the hero action.
Degrade to clipboard instead: the action then *always* produces something.

**Files:** `packages/extension/entrypoints/sidebar.content.ts`

**Read first:** `injectMemories()` (~568–580) and `flashToast()` (~583). Note
the shadow-DOM container: the panel renders into a local root (the `ui`
element) — append any temp node there, not to `document.body`.

**Implementation:**

1. Add a helper near `injectMemories`:

```ts
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* clipboard API can be blocked — fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    ui.appendChild(ta);          // `ui` = the panel's root container element
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}
```

2. In `injectMemories()`, replace the failure branch:

```ts
} else {
  const copied = await copyToClipboard(block);
  if (copied) {
    void sendToHelper({ type: "touch_memories", ids: hits.map((h) => h.id) }).catch(() => {});
    flashToast("Copied — paste into your message box (Ctrl+V)");
  } else {
    flashToast("Click your message box once, then retry.");
  }
}
```

**Acceptance:**
- [ ] Manual QA: temporarily make `findComposer()` return `null` (or test on a
      page where the composer is hidden), click "Inject all" → toast says
      "Copied…", and Ctrl+V pastes the formatted memory block. Revert any
      temporary change.
- [ ] Normal injection path unchanged on claude.ai.
- [ ] Verification loop green.

## T4. Ephemeral-fact suppression + "recently learned" review — M

**Why:** The extractor currently stores deadline-class noise as durable memory
— our own test corpus shows `"I need the report done by Friday"` saved as a
`fact`. Injecting a months-stale deadline into a prompt is worse than
injecting nothing. Two parts: stop the worst class at extraction time, and
give users a cheap review surface for what auto-extraction learned.

### Part A — extractor (`packages/extension/lib/extract.ts`)

**Read first:** all of `extract.ts` (130 lines, pure functions) — especially
`RULES` and the rule-matching loop in `extractCandidates()`.

1. Add near the other top-level regexes:

```ts
// Time-anchored statements decay fast — they're tasks, not facts about the
// user. Hard-skip the broad "fact" kind; soften salience for the rest.
const EPHEMERAL_RE =
  /\b(today|tonight|tomorrow|yesterday|this (morning|afternoon|evening|week|weekend|month|sprint|quarter)|next (week|month|sprint)|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday|eod|eow|end of (the )?(day|week|month))|right now|at the moment|asap)\b/i;
```

(Deliberately NOT bare `currently` — "I currently work at X" is durable.)

2. In `extractCandidates()`, inside the rule loop after a rule matches and
   before the candidate is pushed:
   - if `EPHEMERAL_RE.test(clause)` and `rule.kind === "fact"` → `break`
     (skip this clause entirely);
   - else if `EPHEMERAL_RE.test(clause)` → push with
     `salience: Math.max(0.3, rule.salience - 0.15)` instead of `rule.salience`.

### Part B — test harness (`packages/extension/scripts/test-extract.ts`)

The harness currently **asserts the bug**: `MUST_HAVE` includes `"Friday"`
(line ~29). With Part A that assertion must flip or the suite fails:

1. In `MUST_HAVE`, replace `"Friday"` with `"blue color scheme"` (the decision
   in the same sample message must still be captured).
2. Add a new check:

```ts
const MUST_NOT_CAPTURE = ["Friday"];
// after extraction: assert no extracted memory text contains these substrings
```

   Wire it into the pass/fail counts in the same style as the existing
   assertions.

### Part C — "Recently learned" review strip (options Memory view)

**Files:** `packages/extension/lib/memory.ts`,
`packages/extension/lib/offscreen-main.ts`,
`packages/extension/entrypoints/options/main.tsx`

1. `memory.ts` — extend `listMemories` opts with `sort?: "default" | "recent"`;
   when `"recent"`, `ORDER BY created_at DESC` (keep the `pinned DESC` first
   term off for this mode — newest strictly first).
2. `offscreen-main.ts` — pass `m.sort` through in the `list_memories` case.
3. `options/main.tsx` `MemoryView` (~2218) — above the existing list, render a
   collapsible **"Recently learned"** strip: the newest ~15 memories where
   `source === "auto"`, fetched with `{ type: "list_memories", sort: "recent",
   limit: 30 }` and filtered client-side. Each row: kind badge, text, and two
   one-tap actions — **pin** (`pin_memory`) and **delete** (`delete_memory`) —
   reusing the styling/RPC patterns already in `MemoryCard`. A "dismiss"
   control hides the strip for the session (component state is fine). Match
   the existing serif/sans/mono + `--accent` styling; no new dependencies.

**Acceptance:**
- [ ] `npm run test:extract` passes with the new assertions ("Friday" never
      captured; "blue color scheme" captured).
- [ ] "Let's use Tailwind" (decision) and identity/preference samples still
      extract — no regression in the existing MUST_HAVE list.
- [ ] Memory view shows the strip after "Build my memory"; pin/delete work
      from it.
- [ ] Verification loop green.

## T5. Export must include memories; add import — M

**Why:** The landing page and listing say "you own your data", but the JSON
export (Settings → Export) contains conversations only — the memory layer is
not exportable, and nothing is importable. Make the claim true.

**Files:** `packages/extension/entrypoints/options/main.tsx`, optionally
`packages/extension/lib/offscreen-main.ts`

**Read first:** `SettingsView` → `onExport` (~1978–2000) to see how the
archive blob is currently assembled; the `list_memories` / `add_memory` /
`pin_memory` cases in `offscreen-main.ts`.

**Implementation:**

1. **Export:** in `onExport`, also fetch
   `sendToHelper({ type: "list_memories", limit: 1000 })` and write:

```ts
const payload = {
  version: 2,
  exported_at: new Date().toISOString(),
  conversations: archive,
  memories,            // MemoryItem[] straight from the RPC
};
```

2. **Import (memories — required):** in the Export section, add an
   "Import from JSON" button wired to a hidden `<input type="file"
   accept="application/json">`. On file select: parse; if `memories` is an
   array, loop sequentially calling
   `sendToHelper({ type: "add_memory", text: m.text, kind: m.kind, platform:
   m.source_platform, conversation_id: m.source_conversation_id, message_id:
   m.source_message_id })`. If `m.pinned`, follow with `pin_memory` using the
   id returned by `add_memory`. Count created vs deduped (`add_memory` returns
   the existing row when deduped — treat "returned id ≠ newly created" simply
   as success; an exact created/skipped split is nice-to-have). Show a summary
   line: "Imported N memories." Reject files with neither `memories` nor
   `conversations` arrays with a friendly error.
   - Fidelity tweak: the `add_memory` RPC case currently hardcodes source
     `"manual"`. Extend the case to accept an optional `source` field
     (`(m.source as "auto" | "manual" | undefined) ?? "manual"`) and pass the
     imported memory's original `source` through.
3. **Import (conversations — stretch, only if everything else is done):**
   convert each exported conversation back into `CaptureEvent`s
   (`conversation_seen` + `message_appended`, shapes visible in
   `lib/backfill.ts` `convToEvents`) and send batched
   `{ kind: "to_offscreen", type: "ingest", events }`. Requires the export to
   carry `platform_conv_id`/`url` per conversation — extend the export payload
   accordingly if you take this on. Skip silently if a conversation lacks the
   needed fields.

**Acceptance:**
- [ ] Export file contains `version: 2` and a non-empty `memories` array (after
      building memory).
- [ ] Settings → Danger zone wipe, then Import of that file restores the
      memories (Memory view repopulates; pinned restored).
- [ ] Malformed/irrelevant JSON shows an error message, no crash.
- [ ] Verification loop green.

---

# P1 — should land before the listing

## T6. Vendor the embedding model — zero network calls — M

**Why:** `lib/embeddings.ts` sets `env.allowLocalModels = false`, so the model
(~25 MB) is fetched from HuggingFace's CDN at first run — the privacy pitch
("nothing leaves your device") carries an asterisk, and on networks where HF
is blocked, embeddings silently never initialize. Bundling the model files
into the package removes Smriti's only runtime network dependency.

**Files:** new `packages/extension/scripts/fetch-model.mjs`,
`packages/extension/lib/embeddings.ts`,
`packages/extension/package.json`, `.gitignore`, `README.md`, `CLAUDE.md`

**Implementation:**

1. Create `packages/extension/scripts/fetch-model.mjs`:

```js
// Vendors the embedding model + ONNX wasm into public/ so the built extension
// makes zero network requests at runtime. Idempotent — skips existing files.
import { mkdir, writeFile, copyFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const HF = "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main";
const MODEL_DIR = join(extRoot, "public", "models", "Xenova", "all-MiniLM-L6-v2");
const ORT_DIR = join(extRoot, "public", "ort");
const FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"];

for (const f of FILES) {
  const dest = join(MODEL_DIR, f);
  await mkdir(dirname(dest), { recursive: true });
  try { if ((await stat(dest)).size > 0) { console.log("skip", f); continue; } } catch {}
  console.log("fetch", `${HF}/${f}`);
  const res = await fetch(`${HF}/${f}`);
  if (!res.ok) throw new Error(`${HF}/${f}: HTTP ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

// The ONNX runtime .wasm files ship inside @xenova/transformers (hoisted to
// the workspace root — resolve, don't hardcode the path).
const require = createRequire(import.meta.url);
const ortSrc = join(dirname(require.resolve("@xenova/transformers/package.json")), "dist");
await mkdir(ORT_DIR, { recursive: true });
for (const f of await readdir(ortSrc)) {
  if (f.endsWith(".wasm")) { await copyFile(join(ortSrc, f), join(ORT_DIR, f)); console.log("copied", f); }
}
console.log("model vendored ✓");
```

2. `packages/extension/package.json` scripts: add
   `"fetch:model": "node scripts/fetch-model.mjs"`, plus
   `"prebuild": "node scripts/fetch-model.mjs"` and
   `"predev": "node scripts/fetch-model.mjs"` so builds self-heal.
3. `lib/embeddings.ts` — replace the env-config block (lines ~17–24) with:

```ts
// Fully local model — vendored into the package by `npm run fetch:model`.
// Zero network calls at runtime.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = chrome.runtime.getURL("/models/");
env.useBrowserCache = false; // files are extension-local; caching adds nothing
// Single-threaded inference (no SharedArrayBuffer in offscreen context).
// @ts-ignore — property exists at runtime
if (env.backends?.onnx?.wasm) {
  // @ts-ignore
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("/ort/");
  // @ts-ignore
  env.backends.onnx.wasm.numThreads = 1;
}
```

   Also update the file-header comment (it currently documents the CDN
   download behavior).
4. Root `.gitignore`: add `packages/extension/public/models/` and
   `packages/extension/public/ort/` (~25 MB of binaries do not belong in git).
5. Docs: README quick-start and `CLAUDE.md` build section gain
   `npm run fetch:model` (or note that build runs it automatically).
6. If path-joining misbehaves (transformers v2 concatenates
   `localModelPath + modelId + "/" + file`), test with and without the
   trailing slash on `localModelPath` — verify at runtime, don't guess.

**Acceptance:**
- [ ] Fresh profile, vendored build: open the offscreen console's Network tab —
      **zero** requests to `huggingface.co` or any CDN; model loads
      (`[smriti:embed] model ready` log) and `embed_status` reports the model.
- [ ] Search returns `vec`/`hybrid` matches (embeddings actually work).
- [ ] `npm run build` from a clean checkout self-fetches and succeeds.
- [ ] Landing page / privacy copy updated: `docs/index.html`, `docs/privacy.html`,
      and `PRIVACY_POLICY.md` currently describe a one-time model download —
      change to "zero network requests" only AFTER verifying the above.

## T7. Ship Chrome-only, deliberately — XS

**Why:** The engine lives in an Offscreen Document — an API Firefox does not
have. The Firefox config in `wxt.config.ts` implies support that would install
and silently do nothing.

**Files:** `packages/extension/wxt.config.ts`, `README.md`

**Implementation:**
1. In `wxt.config.ts`, delete the `...(browser === "firefox" ? { browser_specific_settings: ... } : {})`
   block (and the now-unused `({ browser })` destructure if nothing else uses it).
2. Check `packages/extension/package.json` for any `firefox` build scripts;
   remove them if present.
3. README: add one line under requirements — "Chrome/Chromium only for now:
   Smriti's engine runs in an Offscreen Document, which Firefox doesn't support."

**Acceptance:**
- [ ] `npm run build` (chrome-mv3) still green; no `firefox` references left in
      extension config/scripts.

## T8. Chrome Web Store review pack — S (copywriting)

**Why:** MAIN-world fetch interception on three major AI sites is exactly what
CWS reviewers scrutinize. Clear single-purpose + per-permission justifications
are the difference between a 2-day and a 3-week review. Also, the current
listing copy leads with archive/search — it must lead with memory.

**Files:** `STORE_LISTING.md`

**Implementation:**
1. Rework the detailed description's opening to memory-first. Lead block:
   "Your AI finally remembers you. Smriti captures your conversations across
   Claude, ChatGPT, and Gemini, distills durable facts about you — who you
   are, how you like to work, what you're building — and injects that context
   into any prompt in one click. Entirely on your device." Keep
   capture/import/search/outline content as supporting features below.
2. Add a new section `## Review notes (single purpose & permissions)`:
   - **Single purpose:** "Smriti locally captures the user's own AI
     conversations on three sites, lets the user search them, and re-use
     distilled facts in new prompts. All storage and processing is on-device;
     the extension has no server."
   - **`storage`** — persists capture pause toggles and onboarding flags.
   - **`offscreen`** — hosts the SQLite (WASM) database and the local embedding
     model; MV3 service workers cannot run long-lived WASM workloads.
   - **`scripting` + host permissions (claude.ai, chatgpt.com,
     gemini.google.com)** — content scripts that (a) read the user's own
     conversation streams on these three sites only, and (b) render the
     sidebar; text is written into the prompt box only on the user's explicit
     click.
   - **Remote code:** none — all JS/WASM is bundled; the embedding model is
     packaged with the extension (after T6).
   - **Data use disclosures (for the CWS form):** collects no data; nothing is
     transmitted or sold; all data stays on the user's device.
3. Resolve remaining placeholders in the file (developer name, support email,
   homepage = the GitHub Pages URL). If a value is genuinely unknown (e.g.,
   which email to use), leave the placeholder and flag it in your summary —
   do not invent one.

**Acceptance:**
- [ ] `STORE_LISTING.md` has the review-notes section and memory-first
      description; remaining placeholders (if any) are explicitly listed at
      the top of the file.

---

# P2 — fine to follow the launch

## T9. "Report a broken site" link — XS

**Why:** No telemetry (by design) means users are the only sensor for selector
breakage on the three host sites. Make reporting one click.

**Files:** `packages/extension/entrypoints/sidebar.content.ts`,
`packages/extension/entrypoints/options/main.tsx`

**Implementation:** in the sidebar footer (`.rc-footer`, built ~line 431) and
in options Settings, add a small "Report an issue ↗" link:

```ts
const v = chrome.runtime.getManifest().version;
const issueUrl =
  `https://github.com/HAAHIT/smriti/issues/new?title=${encodeURIComponent(`[${platform}] `)}` +
  `&body=${encodeURIComponent(`Platform: ${platform}\nExtension: v${v}\nWhat broke:\n`)}`;
```

Open with `target="_blank"` / `rel="noopener"`. Match existing footer styling.

**Acceptance:** link opens a prefilled GitHub issue form from both surfaces.

## T10. Composer watching respects the capture pause — S

**Why:** Pausing capture for a site should pause *all* observation there. The
sidebar currently watches composer keystrokes regardless of the pause toggle
(all local, but the toggle should mean what it says).

**Files:** `packages/extension/entrypoints/background.ts`,
`packages/extension/entrypoints/sidebar.content.ts`

**Implementation:**
1. `background.ts` message router — add alongside `capture_toggle`:

```ts
if (kind === "get_capture_paused") {
  sendResponse({ ok: true, paused: [...pausedHosts] });
  return true;
}
```

2. `sidebar.content.ts` — module state `let capturePaused = false`. On boot
   and then every 60 s, send `{ kind: "get_capture_paused" }` and set
   `capturePaused = paused.includes(location.hostname)` (hostnames are stored
   as `claude.ai` / `chatgpt.com` / `gemini.google.com` — see
   `platformToHost` in background.ts; normalize `location.hostname`
   accordingly, e.g. strip a leading `www.`). In `onComposerInput()` and
   `attachComposer()`, return early when `capturePaused`.

**Acceptance:** with capture paused for the current site (Settings → Capture),
typing in the composer triggers no recall card; re-enabling restores it within
a minute (or on reload).

## T11. Performance sanity pass on large archives — S

**Why:** sql.js + single-threaded ONNX is fine until someone imports 10k
messages. Measure before users do.

**Implementation:**
1. Add lightweight timing logs (console.debug, no flag needed):
   - `lib/search.ts` `search()` — total ms; warn if > 300 ms.
   - `lib/memory.ts` `recallMemories()` — total ms; warn if > 200 ms.
   - `lib/index-worker.ts` tick log — append elapsed ms.
2. Manual QA on a real large import (run a full ChatGPT/Claude backfill on an
   account with 1k+ conversations):
   - [ ] Typing in the host composer stays smooth with the sidebar open.
   - [ ] Recall card appears < ~500 ms after the debounce.
   - [ ] Options search results < ~1 s.
   - [ ] Offscreen document memory (Chrome Task Manager) stays under ~500 MB.
   - [ ] OPFS flush (watch for `flush failed` logs) — none.
3. Record numbers in the PR/commit description. If targets are missed, file
   follow-ups — do not optimize speculatively in this task.

---

# Release gate — final checklist before CWS submission

- [ ] T1–T5 (all P0) merged; T6–T8 strongly recommended before submitting.
- [ ] `npx tsc --noEmit`, `npm run test:extract`, `npm run build` all green.
- [ ] Fresh-profile end-to-end: install → onboarding auto-opens → import
      history → build memory → open claude.ai → type a prompt → recall card →
      inject works → sent message contains the context block.
- [ ] Export contains memories; wipe + import restores them.
- [ ] DevTools network on offscreen doc: zero external requests (post-T6).
- [ ] Bump version to `0.1.0` in `packages/extension/package.json` (wxt
      manifest version follows it) and tag the release commit.
- [ ] CWS dashboard: listing copy + review notes from `STORE_LISTING.md`,
      existing screenshots in repo, privacy disclosures = "no data collected".
