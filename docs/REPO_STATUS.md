# Repo status — verified snapshot

**As of:** 2026-07-31 · **Branch:** `phase-0/unblock-and-freeze` ·
**Base:** `da92c6e`.

> **Updated for Phase 0.** Blockers **B1–B4 are resolved** and CI now enforces
> them. The original findings are kept below rather than deleted, each annotated
> with how it was fixed, so the history of *why* each change was made stays
> readable. B5 and B6 are unchanged — but both features are now hidden behind the
> `FEATURES` flag in `entrypoints/options/main.tsx`, so neither can ship
> half-working.

This is a point-in-time health report produced by actually running the checks on a
fresh clone, not a summary of intent. For how the system is *designed*, see
[PRODUCT_BRIEF.md](../PRODUCT_BRIEF.md). For the release checklist, see
[RELEASE_PLAN.md](../RELEASE_PLAN.md).

---

## 1. Headline

The product is feature-complete for its stated v0.1 scope — capture, import,
extraction, hybrid recall, one-click injection, E2E sync, and now vault export are
all implemented and merged. **The tree is now green**, every suite runs from a
fresh clone, and `.github/workflows/ci.yml` runs the whole loop on every PR and
on pushes to `main`.

| Check | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | ✅ clean |
| `npm run test:extract` | ✅ 12/12 |
| `npm run test:sync` | ✅ 21/21 |
| `npm run test:sidebar-renderers` | ✅ 79/79 |
| `npm run test:sidebar-helpers` | ✅ 46/46 |
| `npm run test:okf` | ✅ 26/26 |
| `npm run build` | ✅ succeeds → `.output/chrome-mv3`, 64.5 MB (model + ORT wasm dominate) |

Verified after a clean `npm ci` at the repo root, which is the exact path CI
takes.

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

### B1 — `main` does not typecheck ✅ RESOLVED (Phase 0)

**Fixed:** `lib/vault-sync.ts` now declares a local `ConversationRow` interface
matching the actual `SELECT`, `syncOneConversation()` takes it, and the
`(conv as any).platform_conv_id` on the old line 360 is gone. `syncConversation()`
was fetching into `ConversationMeta` too and now uses the row type as well.

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

### B2 — the test suite cannot run from a fresh clone ✅ RESOLVED (Phase 0)

**Fixed:** `"tsx": "^4.19.2"` is now a devDependency of `packages/extension`, and
`.github/workflows/ci.yml` runs the typecheck plus all five suites on every PR
and push to `main`. The gap this section describes at the end — that nothing ran
these automatically — is closed.

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

### B3 — `test:okf` fails ✅ RESOLVED (Phase 0)

**Fixed, and it was worse than it looked.** The whole suite was a single
`try { … } catch { process.exit(1) }`, so it aborted at the first failure and
**every assertion after the null-title case had never once run**. The wrapper is
replaced with the same `check(label, cond)` pass/fail harness the other four
suites use. With all assertions actually executing, a second latent failure
surfaced behind the first: `slugify('  --weird--chars!!  ')` returns
`weird-chars`, not `weird--chars` as asserted (the implementation collapses
repeated hyphens, so the test was wrong). `yamlQuote()` now quotes every title,
and escapes backslashes before quotes — previously a title containing `\` would
have emitted a dangling escape. The suite is 26 assertions, all running.

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

### B4 — `test:sidebar-helpers` has 4 stale assertions ✅ RESOLVED (Phase 0)

**Fixed:** all four assertions corrected to match the implementation (`#888`
without the leaked backticks; `""` for unparseable dates), and the stale comment
explaining the old "Invalid Date" behaviour was rewritten. 46/46 pass.

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

### B5 — vault export cannot run at all ⏸ FROZEN (Phase 0)

Not fixed — deliberately parked. The Vault section of Settings is now hidden
behind `FEATURES.vault`, so a half-working feature cannot ship. The engine
(`lib/vault-sync.ts`, `lib/drive-client.ts`) and migration 005 are untouched, and
the nine catalogued defects below still stand for whoever unfreezes it.

Nine issues are catalogued in [VAULT_SYNC.md §5](VAULT_SYNC.md#5-known-defects).
Two are hard blockers on it running at all — a placeholder OAuth client ID, and a
CSP that blocks every `googleapis.com` request. Three more are engine defects that
produce silent wrong behaviour once it does run. The rest are a failing test, a
robustness gap, a stale comment, and B1.

### B6 — sync relay is still undeployed ⏸ FROZEN (Phase 0)

Not fixed — parked the same way. The Sync section is hidden behind
`FEATURES.sync`; `lib/sync.ts` and migration 004 are untouched.

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
- ~~**Root `package.json` has a self-referential dependency**:
  `"dependencies": { "smriti": "file:" }`.~~ ✅ **Removed (Phase 0)**, along with
  its `node_modules/smriti → repo root` symlink and its `package-lock.json`
  entry. Note the cause, so it doesn't come back: running `npm install --prefix
  <repo>` (rather than plain `npm install` from the root) makes npm treat the
  directory as a package to install and re-adds the self-dependency.
- **`packages/helper` and `packages/mcp-server` are outside the workspaces array.**
  They are documented as legacy, which is consistent — but it is also the root
  cause of B2, since `tsx` lives only in them.
- ~~**`packages/extension/stats.html` (240 KB)** is a committed rollup
  bundle-analysis artifact.~~ ✅ **Untracked and gitignored (Phase 0).**
- **`STORE_LISTING.md` has no remaining placeholders.** The `CLAUDE.md` line that
  claimed otherwise was already removed in `da92c6e`; this note is kept only so
  the correction isn't re-litigated.
- **Privacy copy predates vault export.** `PRIVACY_POLICY.md`, `STORE_LISTING.md`,
  `docs/privacy.html`, and `docs/index.html` all assert that nothing leaves the
  device. With vault export enabled, readable markdown does. This must be corrected
  before store submission — see [VAULT_SYNC.md §7](VAULT_SYNC.md#7-before-this-ships).
  (Vault is frozen as of Phase 0, so the claim is not *currently* false on that
  count.)
- ~~**The sidebar injected a Google Fonts `<link>` into every host page**~~ ✅
  **Fixed (Phase 0).** Both the sidebar and the options page loaded
  `fonts.googleapis.com`, an outbound request to Google on every visit to a
  supported site — directly contradicting the privacy claim above. The three
  families are now vendored in `packages/extension/public/fonts/` (396 KB, six
  variable `woff2` files, SIL OFL) and the `@font-face` rules are generated by
  `lib/fonts.ts`. Verified: no `fonts.googleapis.com` / `fonts.gstatic.com`
  reference survives anywhere in `.output/chrome-mv3`.
- **`drive-client.ts` exports `findFile()` which nothing calls** — dead code today,
  but it is exactly the function needed to fix the resync-duplication defect.
- **`protocol.ts`'s `NMRequest`/`NMResponse` unions are historical**, left over from
  the native-messaging helper. The live RPC contract is the `switch` in
  `offscreen-main.ts`. The shape interfaces in that file *are* current.

---

## 5. Suggested order of work

**Done in Phase 0:** B1, B2, B3, B4, CI, the sync/vault freeze (which is how B5
and B6 were resolved — deferred, not shipped), the font vendoring, and the
`stats.html` / self-dependency / `createHash` JSDoc housekeeping.

**Next:**

1. **Close PR #4 and delete the merged remote branches** — the one housekeeping
   item Phase 0 did not touch, because it is a GitHub-side action, not a code
   change.
2. **Phase 1 — the Source layer.** Registry + Connector SDK, the three existing
   connectors refactored onto it, migration 006 (`spaces` / `people` /
   `person_identities`), and the ingest fixes (dense `position`, real
   `accepted++`, `platform_msg_id` identity index). This is where the four
   load-bearing assumptions listed in the program doc start getting replaced.
3. **Manual QA** — the remaining unticked boxes in `RELEASE_PLAN.md` all require a
   loaded extension and cannot be closed from source review.

Unfreezing sync or vault is a deliberate decision, not a next step: both are
parked behind `FEATURES` until someone chooses to finish them.

---

## 6. How this was verified

Phase 0 re-ran the whole loop after a clean `npm ci` — the exact path CI takes,
which also proves the lockfile is in sync and that `wxt prepare` regenerates the
gitignored `.wxt/tsconfig.json` from scratch:

```bash
npm ci                           # from repo root — exit 0
cd packages/extension
npx tsc --noEmit -p tsconfig.json   # → clean
npm run test:extract                # → 12 passed, 0 failed
npm run test:sync                   # → 21 passed, 0 failed
npm run test:sidebar-helpers        # → 46 passed, 0 failed
npm run test:sidebar-renderers      # → 79 passed, 0 failed
npm run test:okf                    # → 26 passed, 0 failed
npm run build                       # → .output/chrome-mv3, exit 0
```

`npm run build` was run once here to verify the font vendoring end to end (that
`web_accessible_resources` is valid and the `woff2` files land in the output). It
is deliberately **not** in CI: `prebuild` triggers the ~25 MB model fetch, and
`wxt build` uses Vite, which transpiles without typechecking — so a green build
would not have caught B1 anyway.

The original (pre-Phase-0) verification run, for reference:

```bash
npx tsc --noEmit -p tsconfig.json          # → 1 error (B1)
npm run test:extract                       # → 'tsx' not recognized (B2)
npx --yes tsx scripts/test-sidebar-helpers.ts   # → 42 passed, 4 failed (B4)
npx --yes tsx scripts/test-okf-renderer.ts      # → failed (B3)
```

The vault defects in [VAULT_SYNC.md](VAULT_SYNC.md) were established by code
reading, not by running against a live Google account — that is impossible until
B5's blockers are cleared.
