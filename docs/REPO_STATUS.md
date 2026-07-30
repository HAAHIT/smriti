# Repo status — verified snapshot

**As of:** 2026-07-30 · **Branch:** `chore/phase-0-unblock` · **Base:** `d5fbce0` ·
working tree clean.

This is a point-in-time health report produced by actually running the checks on a
fresh clone, not a summary of intent. For how the system is *designed*, see
[PRODUCT_BRIEF.md](../PRODUCT_BRIEF.md). For the release checklist, see
[RELEASE_PLAN.md](../RELEASE_PLAN.md).

---

## 1. Headline

**`main` is green, and CI now keeps it that way.** Blockers B1–B4 from the previous
snapshot are fixed; B5 (vault) and B6 (sync relay) are unresolved but no longer
reachable from the UI — both are frozen behind `lib/features.ts`, so a
half-working feature can't ship by accident.

| Check | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | ✅ clean |
| `npm run test:extract` | ✅ 12/12 |
| `npm run test:sync` | ✅ 21/21 |
| `npm run test:sidebar-helpers` | ✅ 46/46 |
| `npm run test:sidebar-renderers` | ✅ 79/79 |
| `npm run test:okf` | ✅ 52/52 |
| `npm run build` | ✅ 64.51 MB → `.output/chrome-mv3` |
| CI (`.github/workflows/ci.yml`) | ✅ typecheck + all five suites on every PR |

Two of those numbers moved for reasons worth knowing:

- **`test:okf` went from 6 effective assertions to 52.** The suite was one
  `try`/`catch` that aborted on the first failure, so everything after the
  null-title assertion had never run. Rewritten onto the same `check()` harness
  the other suites use. Behind the known failure was a real one: the
  never-executed `slugify('  --weird--chars!!  ')` case expected `weird--chars`,
  but `slugify` collapses hyphen runs by design, so `weird-chars` is correct — the
  assertion was wrong, not the renderer.
- **`test:sidebar-helpers` gained 4 assertions** (42→46) because the four stale
  ones were fixed rather than deleted: two had literal markdown backticks in the
  expected colour, two expected `"Invalid Date"` where `formatDate()` correctly
  returns `""`.

### Also fixed here, not in the previous snapshot's list

The sidebar injected a `<link>` to **fonts.googleapis.com into every host page**,
and the options page did the same — an outbound request to Google on every
claude.ai / chatgpt.com / gemini.google.com visit and every settings open, from a
product whose privacy policy says nothing leaves the device. Both now load
`@font-face` rules from `public/fonts/`, vendored at build time by
`scripts/fetch-fonts.mjs` (latin + latin-ext, ~400 KB). The built output contains
no reference to any Google font host.

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
| 2026-07-29 | PR #7 | `PRODUCT_BRIEF.md`, this status doc, `docs/VAULT_SYNC.md` |
| 2026-07-30 | Phase 0 | **Unblock + freeze**: B1–B4 fixed, CI added, sync/vault frozen behind `lib/features.ts`, webfonts vendored |

Stale remote branches still present: `release/t1-t10`, `feature/e2e-sync`,
`fix/onboarding-first-run`, `5-refactor-…` (all merged — safe to delete) and
`docs/product-brief` (PR #4, superseded by the updated brief now on `main`).

---

## 3. Blockers

### B1–B4 — resolved in Phase 0

| Was | Resolution |
|---|---|
| **B1** `TS2352` at `lib/vault-sync.ts:256` | Local `ConversationRow` interface declares the shape actually selected; `syncOneConversation` takes it, and the mirror-image `(conv as any).platform_conv_id` at `:360` is gone. `ConversationMeta` is the UI's shape and was never the right type for a raw row. |
| **B2** `tsx` undeclared | `"tsx": "^4.19.2"` in `packages/extension` devDependencies. All five scripts now run from a clean `npm ci`. |
| **B3** `test:okf` fails | `yamlQuote()` now quotes unconditionally — which also keeps a bare title that looks like another YAML type (`yes`, `null`, `2026-07-01`) parsing back as a string — and escapes `\` before `"`. Suite rewritten off its fail-fast `try`/`catch`; see §1 for the second bug that exposed. |
| **B4** 4 stale sidebar-helper assertions | Fixed to match the implementation (`#888` without backticks, `""` for unparseable dates), with the stale explanatory comment corrected. |

Nothing enforced these before: there was no `.github/workflows` directory, and the
two checks configured on PRs (`pre-commit.ci`, CodeRabbit) do neither a typecheck
nor a test run — which is exactly how B1 reached `main`. `ci.yml` now does both.

### B5 — vault export cannot run at all · **frozen**

Nine issues are catalogued in [VAULT_SYNC.md §5](VAULT_SYNC.md#5-known-defects).
Two are hard blockers on it running at all — a placeholder OAuth client ID, and a
CSP that blocks every `googleapis.com` request. Three more are engine defects that
produce silent wrong behaviour once it does run. The rest are a failing test, a
robustness gap, and a stale comment. (B1 was on that list and is now fixed.)

**Frozen rather than fixed:** `FEATURES.VAULT = false` in `lib/features.ts` hides
the Settings section. The engine, `005_vault.sql`, and the OKF suite all stay —
`startVaultSyncLoop()` already returns immediately while `vault_config.enabled` is
0 (the default), so nothing is left ticking behind the flag.

### B6 — sync relay is still undeployed · **frozen**

`https://smriti-sync-relay.YOUR-SUBDOMAIN.workers.dev` remains a placeholder in
three places (`lib/sync.ts`, and twice in `wxt.config.ts` — `host_permissions` and
the `connect-src` CSP). `syncNow()` throws a clear, deliberate error until it is
replaced. Procedure: [`packages/sync-relay/README.md`](../packages/sync-relay/README.md).

**Frozen rather than fixed:** `FEATURES.SYNC = false`. Unfreeze in the same commit
that deploys the relay and replaces the three placeholders.

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
- ~~Root `package.json` self-referential dependency (`"smriti": "file:"`)~~ —
  removed.
- **`packages/helper` and `packages/mcp-server` are outside the workspaces array.**
  Documented as legacy, which is consistent — but it was also the root cause of B2,
  since `tsx` lived only in them. `tsx` is now declared where it is used.
- ~~`packages/extension/stats.html` (240 KB) committed build artifact~~ —
  untracked and gitignored.
- ~~`CLAUDE.md`'s stale `STORE_LISTING.md` placeholder note~~ — already removed in
  `da92c6e`; `STORE_LISTING.md` has no placeholders.
- **Privacy copy.** `PRIVACY_POLICY.md`, `STORE_LISTING.md`, `docs/privacy.html`
  and `docs/index.html` all assert that nothing leaves the device. That is now
  accurate for a default build — vault is frozen, and the webfonts both surfaces
  used to fetch from Google are vendored. It stops being accurate the moment vault
  is unfrozen; revise the copy in that change, not before. See
  [VAULT_SYNC.md §7](VAULT_SYNC.md#7-before-this-ships).
- **`drive-client.ts` exports `findFile()` which nothing calls** — dead code today,
  but it is exactly the function needed to fix the resync-duplication defect.
- **`protocol.ts`'s `NMRequest`/`NMResponse` unions are historical**, left over from
  the native-messaging helper. The live RPC contract is the `switch` in
  `offscreen-main.ts`. The shape interfaces in that file *are* current.

---

## 5. What's next

Phase 0 is done. The next work is the per-app memory layers / cross-app search
refactor, whose first milestone is WhatsApp captured and searchable:

1. **Phase 1 — the Source layer.** Open the `Platform` closed union into a
   registry-backed source id, build the connector SDK (`fetchInterceptor` +
   `domObserver` strategies), refactor all three existing connectors onto it, and
   land migration 006 (`spaces`, `people`, `person_identities`, dense `position`
   rewrite). Also fixes the two ingest landmines that must not meet WhatsApp data:
   `content_hash` dropping legitimately repeated messages, and `position` being
   `Date.now()` rather than a turn index.
2. **Phase 2 — the index unit.** Episodes as the retrieval unit, episode-level
   int8 vectors out of SQLite, pre-filtered search, multilingual model.
3. **Phase 3 — WhatsApp connector** (first milestone).

**Manual QA** — the remaining unticked boxes in `RELEASE_PLAN.md` all require a
loaded extension and cannot be closed from source review. Add to that list: the
sidebar and options page should render with correct typography and make **no**
request to any Google font host (check a fresh-profile network trace).

---

## 6. How this was verified

```bash
npm ci                                  # from repo root — clean, exit 0
cd packages/extension
npx tsc --noEmit -p tsconfig.json       # → 0 errors
npm run test:extract                    # → 12 passed, 0 failed
npm run test:sync                       # → 21 passed, 0 failed
npm run test:sidebar-helpers            # → 46 passed, 0 failed
npm run test:sidebar-renderers          # → 79 passed, 0 failed
npm run test:okf                        # → 52 passed, 0 failed
npm run build                           # → .output/chrome-mv3, 64.51 MB
```

Every script ran through the declared `tsx`, not `npx --yes`. `npm run build` was
run this time (it also exercises the new `fetch-fonts.mjs` prebuild step); the
built manifest was checked for `web_accessible_resources`, and
`grep -rl 'fonts.googleapis\|fonts.gstatic' .output/chrome-mv3/` returns nothing.

Note `wxt build` uses Vite, which transpiles without typechecking, so a green
build proves less than `tsc --noEmit` does — CI runs both.

The vault defects in [VAULT_SYNC.md](VAULT_SYNC.md) were established by code
reading, not by running against a live Google account — that is impossible until
B5's blockers are cleared.
