# Repo status — verified snapshot

**As of:** 2026-07-29 · **Branch:** `main` · **HEAD:** `5863955` ·
**Sync with `origin/main`:** up to date (0 ahead / 0 behind), working tree clean.

This is a point-in-time health report produced by actually running the checks on a
fresh clone, not a summary of intent. For how the system is *designed*, see
[PRODUCT_BRIEF.md](../PRODUCT_BRIEF.md). For the release checklist, see
[RELEASE_PLAN.md](../RELEASE_PLAN.md).

---

## 1. Headline

The product is feature-complete for its stated v0.1 scope — capture, import,
extraction, hybrid recall, one-click injection, E2E sync, and now vault export are
all implemented and merged. **But `main` is not currently green.** The most recent
commit introduced a type error, and the test suite cannot be run at all from a
fresh clone because its runner is not a declared dependency.

| Check | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | ❌ **1 error** (`lib/vault-sync.ts:256`) |
| `npm run test:extract` | ⚠️ runner missing — passes 12/12 via `npx tsx` |
| `npm run test:sync` | ⚠️ runner missing — passes 21/21 via `npx tsx` |
| `npm run test:sidebar-renderers` | ⚠️ runner missing — passes 79/79 via `npx tsx` |
| `npm run test:sidebar-helpers` | ❌ **4 failures** (42 passed) |
| `npm run test:okf` | ❌ **fails** on the null-title assertion |
| `npm run build` | not run in this session (requires the ~25 MB model fetch) |

---

## 2. Timeline — how we got here

| Date | Ref | What landed |
|---|---|---|
| 2026-06-11 | PR #1 | Pre-release tasks T1–T10: persistent storage, memory-first onboarding, clipboard fallback, ephemeral-fact suppression, memory export/import, vendored offline model, Chrome-only, store-listing pack |
| 2026-06-13 | PR #2 | Optional E2E-encrypted memory sync + the zero-knowledge Cloudflare relay |
| 2026-06-15 | `1da7f65` | Onboarding first-run loop made legible (real progress, no silent hangs) |
| 2026-06-22 | `b085a36` | Offscreen readiness recovers after a service-worker restart |
| 2026-06-22 | **PR #4 (open)** | `PRODUCT_BRIEF.md` — 800-line product & engineering brief. **Still unmerged.** |
| 2026-06-24 | PR #6 | Sidebar monolith (1,532 lines) split into `sidebar-{types,styles,helpers,renderers}.ts` + two new test suites |
| 2026-07-07 | `5863955` | **Vault export**: OKF renderer, Google Drive client, vault sync engine, migration `005_vault.sql`, Settings UI |

Stale remote branches still present: `release/t1-t10`, `feature/e2e-sync`,
`fix/onboarding-first-run`, `5-refactor-…` (all merged — safe to delete) and
`docs/product-brief` (PR #4, superseded by the updated brief now on `main`).

---

## 3. Blockers, in priority order

### B1 — `main` does not typecheck

```text
lib/vault-sync.ts(256,33): error TS2352: Conversion of type
'{ id: string; platform: string; platform_conv_id: string; title: string | null;
   url: string | null; started_at: string; last_message_at: string; }'
to type 'ConversationMeta' may be a mistake because neither type sufficiently
overlaps with the other. … Property 'message_count' is missing
```

`ConversationMeta` carries `message_count` but not `platform_conv_id`; a raw
`conversations` row is the reverse. The code already papers over the other half of
the mismatch with `(conv as any).platform_conv_id` on line 360. Fix both together
with a local row interface — see
[VAULT_SYNC.md V9](VAULT_SYNC.md#v9--the-typecheck-error).

`RELEASE_PLAN.md` requires a clean `tsc` after every task, so this is a regression
against the project's own standard.

### B2 — the test suite cannot run from a fresh clone

All five `test:*` scripts in `packages/extension/package.json` invoke `tsx`:

```json
"test:extract": "tsx scripts/test-extract.ts",
```

`tsx` is declared **only** in `packages/helper/package.json` and
`packages/mcp-server/package.json` — and neither is listed in the root
`workspaces` array, so neither is ever installed. On a clean
`npm install`, every test script fails with:

```text
'tsx' is not recognized as an internal or external command
```

**Fix:** add `"tsx": "^4.19.2"` to `devDependencies` in
`packages/extension/package.json` (or the root). Workaround until then:
`npx --yes tsx scripts/<name>.ts`.

Nothing runs these suites automatically: there is no `.github/workflows`
directory, and the two checks configured on pull requests (`pre-commit.ci` and
CodeRabbit) do neither a typecheck nor a test run. So B1, B3, and B4 could reach
`main` without anything objecting.

### B3 — `test:okf` fails

```text
expected: title: "Untitled conversation"
actual:   title: Untitled conversation
```

`yamlQuote()` only quotes titles containing `: # [ ] { } "` or a leading `*`.
Bare is valid YAML, so the renderer is defensible and the test is the stricter
party — but they disagree, so the suite is red. Quoting all titles is the cleaner
resolution. Detail: [VAULT_SYNC.md V5](VAULT_SYNC.md#v5--okf-null-title-test-fails).

> Note: node's assertion output names the wrong line (`## Assistant`) because
> `tsx` source-mapping offsets it. The actual failure is the null-title case.

### B4 — `test:sidebar-helpers` has 4 stale assertions

These are **test bugs, not product bugs** — the implementation is fine in all four
cases.

| Failing assertion | Cause |
|---|---|
| `unknown provider → fallback color` | test expects ``color: "`#888`"`` — literal backticks leaked out of a markdown snippet into the expected value. Implementation correctly returns `#888`. |
| `empty string → fallback color` | same backtick typo |
| `invalid date string → non-empty string` | test expects `"Invalid Date"`; `formatDate()` was changed to `return ""` on `NaN` — which is the better UI behaviour |
| `empty string input → non-empty string` | same |

Fix the assertions to match the implementation: expect `#888` without backticks,
and expect `""` for unparseable dates.

### B5 — vault export cannot run at all

Nine issues are catalogued in [VAULT_SYNC.md §5](VAULT_SYNC.md#5-known-defects).
Two are hard blockers on it running at all — a placeholder OAuth client ID, and a
CSP that blocks every `googleapis.com` request. Three more are engine defects that
produce silent wrong behaviour once it does run. The rest are a failing test, a
robustness gap, a stale comment, and B1.

### B6 — sync relay is still undeployed

`https://smriti-sync-relay.YOUR-SUBDOMAIN.workers.dev` remains a placeholder in
three places (`lib/sync.ts`, and twice in `wxt.config.ts` — `host_permissions` and
the `connect-src` CSP). `syncNow()` throws a clear, deliberate error until it is
replaced. Procedure: [`packages/sync-relay/README.md`](../packages/sync-relay/README.md).

---

## 4. Smaller findings

- **PR #4 is still open** and has been superseded: its `PRODUCT_BRIEF.md` is now on
  `main`, updated for the vault work it predates. Close the PR (or hard-reset the
  branch onto `main`) rather than merging it, or you will get a conflict.
- **The `pre-commit.ci` GitHub App is installed but had no config.** Every PR
  raised after it was enabled failed with `.pre-commit-config.yaml is not a file`
  — the file existed on no branch, including `main`. (PRs #4 and #6 predate the
  app and only ran CodeRabbit, which is why this surfaced now.) A minimal config
  now exists at the repo root: whitespace/EOF hygiene plus non-mutating integrity
  checks, with generated artifacts excluded. It found trailing whitespace in the
  four files added by the vault commit and missing final newlines in the six
  added by the sidebar refactor. **No JS/TS linter or formatter is wired into it**
  — the repo has no eslint/prettier config, and the real gate remains the
  `tsc --noEmit` + `test:*` loop, which needs a full install and doesn't belong in
  a hook.
- **Root `package.json` has a self-referential dependency**:
  `"dependencies": { "smriti": "file:" }`. Almost certainly accidental; harmless
  today, but it makes the root package depend on itself and is worth removing.
- **`packages/helper` and `packages/mcp-server` are outside the workspaces array.**
  They are documented as legacy, which is consistent — but it is also the root
  cause of B2, since `tsx` lives only in them.
- **`packages/extension/stats.html` (240 KB)** is a committed rollup bundle-analysis
  artifact. Build output; probably should be gitignored.
- **`STORE_LISTING.md` has no remaining placeholders**, contrary to the note in
  `CLAUDE.md`'s "known gaps" section — that line is stale.
- **Privacy copy predates vault export.** `PRIVACY_POLICY.md`, `STORE_LISTING.md`,
  `docs/privacy.html`, and `docs/index.html` all assert that nothing leaves the
  device. With vault export enabled, readable markdown does. This must be corrected
  before store submission — see [VAULT_SYNC.md §7](VAULT_SYNC.md#7-before-this-ships).
- **`drive-client.ts` exports `findFile()` which nothing calls** — dead code today,
  but it is exactly the function needed to fix the resync-duplication defect.
- **`protocol.ts`'s `NMRequest`/`NMResponse` unions are historical**, left over from
  the native-messaging helper. The live RPC contract is the `switch` in
  `offscreen-main.ts`. The shape interfaces in that file *are* current.

---

## 5. Suggested order of work

1. **B1** — fix the type error. One file, unblocks the standard verification loop.
2. **B2** — declare `tsx`. One line, makes every other test result trustworthy.
3. **B3 + B4** — get all five suites green. Small, mechanical.
4. **Housekeeping** — close PR #4, delete merged branches, drop the `smriti: "file:"`
   self-dependency, gitignore `stats.html`, fix the stale `CLAUDE.md` gap note.
5. **B5** — decide whether vault export is in scope for v0.1. If yes, work through
   [VAULT_SYNC.md §7](VAULT_SYNC.md#7-before-this-ships) *including* the privacy-copy
   revision. If no, gate the Settings section behind a flag so a half-working
   feature isn't shipped.
6. **B6** — deploy the relay and replace the three placeholders, or explicitly
   defer sync past v0.1.
7. **Manual QA** — the remaining unticked boxes in `RELEASE_PLAN.md` all require a
   loaded extension and cannot be closed from source review.

---

## 6. How this was verified

```bash
git fetch --all --prune          # confirmed 0 ahead / 0 behind origin/main
npm install                      # from repo root — clean, exit 0
cd packages/extension
npx tsc --noEmit -p tsconfig.json          # → 1 error (B1)
npm run test:extract                       # → 'tsx' not recognized (B2)
npx --yes tsx scripts/test-extract.ts           # → 12 passed, 0 failed
npx --yes tsx scripts/test-sync.ts              # → 21 passed, 0 failed
npx --yes tsx scripts/test-sidebar-renderers.ts # → 79 passed, 0 failed
npx --yes tsx scripts/test-sidebar-helpers.ts   # → 42 passed, 4 failed (B4)
npx --yes tsx scripts/test-okf-renderer.ts      # → failed (B3)
```

`npm run build` was **not** run in this session — it triggers the one-time ~25 MB
embedding-model fetch. Note that `wxt build` uses Vite, which transpiles without
typechecking, so a green build would **not** clear B1.

The vault defects in [VAULT_SYNC.md](VAULT_SYNC.md) were established by code
reading, not by running against a live Google account — that is impossible until
B5's blockers are cleared.
