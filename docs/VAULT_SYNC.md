# Vault export — OKF markdown to Google Drive

> **Status: implemented, not yet runnable.** The code landed in commit `5863955`
> (2026-07-07) but has never been exercised end to end. Nine issues are catalogued
> in [§5](#5-known-defects): two are hard blockers on it running at all
> ([V1](#v1-blocker--csp-blocks-every-google-api-call) CSP,
> [V2](#v2-blocker--the-oauth-client-id-is-a-placeholder) OAuth client ID), three
> are engine defects that cause silent wrong behaviour once it does run
> ([V3](#v3--manual-sync-now-silently-does-nothing-while-the-loop-is-running),
> [V4](#v4--vault-sync-stops-permanently-after-the-offscreen-document-restarts),
> [V6](#v6--resyncall-duplicates-every-file-on-drive)), and the rest are a failing
> test, a robustness gap, a stale comment, and the typecheck error. This document
> is the complete picture: what it does, how it is built, what is broken, and
> exactly what to do to bring it up.

Companion to [PRODUCT_BRIEF.md §12](../PRODUCT_BRIEF.md#12-vault-export--okf-markdown-to-google-drive).

---

## 1. What it is, and how it differs from sync

Smriti has two very different "it leaves the device" features. Do not conflate
them.

| | **Sync** ([§11](../PRODUCT_BRIEF.md#11-optional-end-to-end-encrypted-sync)) | **Vault export** (this doc) |
|---|---|---|
| What moves | **Memories** only | **Conversations** (full transcripts) |
| Format on the wire | AES-256-GCM ciphertext | Plaintext markdown |
| Destination | Smriti's zero-knowledge relay | **The user's own** Google Drive |
| Can the destination read it? | No | Yes (it's the user's own account) |
| Purpose | Multi-device consistency | Portability / readability / "I own my archive" |
| Direction | Bidirectional (pull → merge → push) | **One-way, push only** |

The pitch for vault export is *escape velocity*: your archive becomes ordinary
markdown files in your own Drive, readable in Obsidian, greppable, and still
yours after you uninstall Smriti. It is the strongest possible answer to "what
happens to my data if this project dies."

Because it uploads **readable** content, it is the one feature that genuinely
weakens the "nothing readable ever leaves your device" claim. It must stay
opt-in, off by default, and clearly labelled — and the privacy copy needs
updating before release (see [§7](#7-before-this-ships)).

---

## 2. Module map

| Module | Purity | Role |
|---|---|---|
| [`lib/okf-renderer.ts`](../packages/extension/lib/okf-renderer.ts) | **pure** | conversation + messages + memories → `{ markdown, filename, directory }` |
| [`lib/drive-client.ts`](../packages/extension/lib/drive-client.ts) | I/O | OAuth token, folder find-or-create + path cache, upload/update, retry + quota guard |
| [`lib/vault-sync.ts`](../packages/extension/lib/vault-sync.ts) | I/O | the engine: select pending → render → upload → record state; periodic loop |
| `005_vault.sql` in [`lib/migrations.ts`](../packages/extension/lib/migrations.ts) | — | `vault_sync_state`, `vault_config` |
| `VaultSection` / `VaultStatusCard` in [`options/main.tsx`](../packages/extension/entrypoints/options/main.tsx) | — | Settings UI |
| [`scripts/test-okf-renderer.ts`](../packages/extension/scripts/test-okf-renderer.ts) | — | 9 assertions over the pure renderer (`npm run test:okf`) |

Only `okf-renderer.ts` is pure and testable headlessly — keep it that way. Any new
formatting logic belongs there, not in `vault-sync.ts`.

---

## 3. The OKF output format

**OKF** = "Obsidian Knowledge Format": YAML frontmatter + a markdown transcript,
one file per conversation, laid out for an Obsidian vault.

**Path:** `smriti-vault/threads/<platform>/<YYYY-MM-DD>_<slug>.md`
— e.g. `smriti-vault/threads/claude/2026-07-01_building-a-chrome-extension.md`

**Shape:**

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
How do I keep an offscreen document alive?

## Assistant
…

---

## Related Memories

- I'm building a Chrome extension called Smriti (*project*)
```

Rules the renderer implements:

- **Filename** = `started_at` date + `slugify(title)`, slug capped at 60 chars,
  falling back to `untitled` when the title is null or slugs to nothing.
- **Tags** = the 5 most frequent tokens (≥3 chars, not in `STOP_WORDS`) across the
  **user's** messages, plus the platform name, de-duplicated.
- **Role headings** are emitted only when the role *changes*, so a run of
  consecutive assistant messages sits under one `## Assistant`.
- **`tool` messages** are wrapped in a ```json fence unless already fenced.
- **YAML safety**: a title containing `:` `#` `[` `]` `{` `}` `"` or a leading `*`
  is double-quoted with internal `"` escaped. Timestamps and URLs are always
  quoted. (See [defect V5](#v5--okf-null-title-test-fails) — the "no special
  characters" branch currently emits an unquoted title, which the test disagrees
  with.)
- **`model`** is taken from the first message in the conversation with a non-null
  `model` column, and omitted if there is none.
- **Related Memories** footer is emitted only when memories exist; it lists up to
  10 memories whose `source_conversation_id` is this conversation.
- Output always ends with exactly one trailing newline.

---

## 4. The engine

### Enable / disable

`enableVault()` → `chrome.identity.getAuthToken({ interactive: true })` → create
the `smriti-vault` root folder → persist the path cache → set
`vault_config.enabled = 1` → kick a first sync and start the loop.

`disableVault()` stops the loop, revokes the token (both from Chrome's cache and
via Google's revoke endpoint), clears the path cache, and sets `enabled = 0`.
**Files already on Drive are left alone** — the UI says so explicitly.

### Change detection

A round selects conversations that are:

1. not in `vault_sync_state` at all (never exported), **or**
2. `conversations.last_message_at > vault_sync_state.last_synced_at` (grew since
   last export), **or**
3. `vault_sync_state.status = 'error'` (retry).

ordered by `last_message_at DESC`, `LIMIT 10` per round.

### Scheduling

| Trigger | Interval |
|---|---|
| Offscreen boot | `startVaultSyncLoop()` → first tick after 30 s (no-op if disabled) |
| Round did work or errored | next tick in **5 min** (`SYNC_INTERVAL_MS`) |
| Round found nothing | next tick in **30 min** (`IDLE_INTERVAL_MS`) |
| No valid token | next tick in 30 min, round skipped |

### Per-conversation upload

`syncOneConversation()`: read messages → read related memories (best-effort, a
failure here is swallowed) → detect model → `renderOkf()` →
`ensureFolder("threads/<platform>/")` → `updateFile(drive_file_id)` if we have one,
else `uploadFile()` → upsert `vault_sync_state` with `status = 'synced'`.
A `404` on update (file deleted on Drive) falls back to a fresh upload.

### Drive API discipline

- **Path cache** — folder IDs are cached in `chrome.storage.local` under
  `smriti:drive_path_cache`, with a **24-hour TTL** so a folder deleted on Drive
  self-heals within a day. Loaded at the start of a round, persisted at the end.
- **Quota guard** — `MAX_CALLS_PER_ROUND = 50`; exceeding it throws a
  non-retryable `DriveApiError(429)`, which `syncRound` treats as "stop this round
  early, try again next tick".
- **`fetchWithRetry`** — up to 3 retries. `401` → drop the cached token, attempt
  one silent refresh, replay the request. `429` → sleep `Retry-After` seconds.
  `5xx` → exponential backoff. `403` containing `rateLimitExceeded` /
  `userRateLimitExceeded` → non-retryable. `404` → non-retryable (callers handle).
- **Uploads** — new files use a `multipart/related` upload (metadata + body);
  updates use `uploadType=media` with `PATCH`, which replaces content only.

### RPCs

| RPC | Effect |
|---|---|
| `vault_status` | `{ enabled, connected, lastSyncAt, totalSynced, pendingCount, errorCount }` |
| `vault_enable` | interactive OAuth + create root folder + start loop |
| `vault_disable` | stop loop, revoke token, clear cache, disable |
| `vault_sync_now` | run one round immediately |
| `vault_sync_conversation` | export a single conversation by id |
| `vault_resync_all` | `DELETE FROM vault_sync_state`, then one round |

---

## 5. Known defects

All of the following were verified by reading the code on `main` at `5863955`,
and where noted, reproduced by running it. None have been observed against a live
Google account, because the feature cannot currently authenticate ([V1](#v1-blocker--csp-blocks-every-google-api-call)).

### V1 (blocker) — CSP blocks every Google API call

[`wxt.config.ts`](../packages/extension/wxt.config.ts) grants
`https://www.googleapis.com/*` in `host_permissions`, but the
`content_security_policy.extension_pages` directive is:

```text
connect-src 'self' https://smriti-sync-relay.YOUR-SUBDOMAIN.workers.dev
```

The offscreen document **is an extension page**, so `connect-src` governs its
`fetch()` calls. A host permission grants cross-origin *permission*; it does not
relax CSP. Every Drive request from `drive-client.ts` will be refused by the
browser before it leaves.

**Fix:** add the Google origins to `connect-src`:

```ts
connect-src 'self' https://www.googleapis.com https://accounts.google.com
            https://smriti-sync-relay.YOUR-SUBDOMAIN.workers.dev
```

(`accounts.google.com` is needed by `revokeAuthToken()`, which calls the revoke
endpoint directly.)

### V2 (blocker) — the OAuth client ID is a placeholder

```ts
oauth2: {
  client_id: "YOUR_CLIENT_ID.apps.googleusercontent.com",
  scopes: ["https://www.googleapis.com/auth/drive.file"],
}
```

`chrome.identity.getAuthToken()` fails outright with this value. See
[§6](#6-setup-getting-a-real-oauth-client-id) for the procedure.

### V3 — manual "Sync now" silently does nothing while the loop is running

In `syncRound()`:

```ts
for (const conv of pending) {
  if (!_running && _syncTimer !== null) {
    // Loop was disabled
    break;
  }
```

`_running` is set to `true` **only inside `tick()`**. Every other caller —
`vault_sync_now`, `vault_resync_all`, and the one-second kick inside
`enableVault()` — reaches `syncRound()` with `_running === false`. And whenever
the vault is enabled, `_syncTimer` is non-null (the loop is scheduled). So the
guard fires on the **first** iteration and the round exits having exported
nothing, while still reporting `{ synced: 0, errors: 0 }` and stamping
`last_sync_at`. The user sees a successful-looking no-op.

The intent was clearly "abort if the loop was cancelled mid-round". That should be
an explicit cancellation flag, not an inference from `_running`/`_syncTimer`:

```ts
let _cancelled = false;                    // set by stopVaultSyncLoop()
...
for (const conv of pending) {
  if (_cancelled) break;
```

### V4 — vault sync stops permanently after the offscreen document restarts

`hasValidToken()` reads module-level `_cachedToken`, which lives only in offscreen
memory. When the extension reloads (or the browser restarts), the offscreen
document is recreated and that variable is `null`. Then:

- `getVaultStatus()` reports `connected: false`, so Settings shows disconnected
  even though the user's Google grant is intact.
- `tick()` sees `!hasValidToken()`, logs `no valid token, skipping sync`, and
  reschedules — **without ever attempting a silent refresh**. It will do this
  forever until the user clicks "Enable Vault Export" again.

Chrome caches the OAuth grant, so `getAuthToken({ interactive: false })` would
almost always succeed here. `tick()` should attempt that refresh before giving up,
and `getVaultStatus()` should reflect "we hold a grant" rather than "we hold a
token in RAM".

### V5 — OKF null-title test fails

`npm run test:okf` fails on the null-title case:

```text
expected: title: "Untitled conversation"
actual:   title: Untitled conversation
```

`yamlQuote()` only quotes strings containing `: # [ ] { } "` or a leading `*`.
`Untitled conversation` has none, so it is emitted bare. Bare is valid YAML, so
**the renderer is not wrong** — but the test asserts otherwise, so one of them
must move. Quoting *all* titles unconditionally is the safer choice (it removes a
whole class of YAML edge cases and matches how `created`/`updated`/`source_url`
are already handled).

Note the assertion failure that node prints points at the wrong source line —
`tsx`'s source mapping offsets it. The failing assertion is the `doc2` null-title
one, not the `## Assistant` one it appears to name.

### V6 — `resyncAll()` duplicates every file on Drive

`resyncAll()` does `DELETE FROM vault_sync_state` and then runs a round. With no
`drive_file_id` on record, `syncOneConversation()` takes the `uploadFile()` branch
and creates a **new** Drive file, even though a file of that name already exists
in the folder. Drive permits duplicate names, so the user ends up with two copies
of every conversation, and a third after the next resync.

`drive-client.ts` already exports `findFile(parentFolderId, filename)` — and
nothing calls it. The fix is to use it: before uploading a new file, look for an
existing one by name in the target folder and `updateFile()` it instead.

### V7 — filename collisions are unhandled

`generateFilename()` is `<date>_<slug>`. Two conversations started on the same day
with the same (or same-slugging) title produce identical filenames. Combined with
V6 this silently interleaves two conversations' exports. Appending a short hash of
`platform_conv_id` would make filenames unique while staying human-readable.

### V8 (nit) — misleading escaping comment

`findOrCreateFolder()` says:

```ts
// Double single quotes to escape single quotes in name (Google Drive API escaping)
const escapedName = name.replace(/'/g, "\\'");
```

The **code** is right — Drive's query syntax escapes with a backslash — but the
comment describes SQL-style doubling. Fix the comment, not the code.

### V9 — the typecheck error

Not vault-specific in spirit but it lives here and it breaks `tsc` for the whole
package:

```text
lib/vault-sync.ts(256,33): error TS2352: Conversion of type '{ id: string; platform: string;
platform_conv_id: string; … }' to type 'ConversationMeta' may be a mistake …
Property 'message_count' is missing
```

`ConversationMeta` (in `@smriti/shared`) has `message_count` but **no**
`platform_conv_id`; a raw `conversations` row is the opposite. `syncOneConversation`
already works around this with `(conv as any).platform_conv_id`. The clean fix is a
local row interface for what the queries actually select, and to stop routing these
rows through `ConversationMeta` at all:

```ts
interface VaultConvRow {
  id: string; platform: string; platform_conv_id: string;
  title: string | null; url: string | null;
  started_at: string; last_message_at: string;
}
```

then type `pending`, `syncConversation`'s `dbGet`, and `syncOneConversation`'s
parameter as `VaultConvRow` and delete the `as ConversationMeta` cast and the
`as any` workaround together.

---

## 6. Setup: getting a real OAuth client ID

`chrome.identity.getAuthToken()` requires the extension to have a **stable
extension ID**, because the OAuth client is registered against it. An unpacked
extension's ID is derived from a key, so pin it first.

1. **Pin the extension ID.** Build once, then take the `key` from the generated
   manifest (or generate a keypair and add its public key as `manifest.key` in
   `wxt.config.ts`). Note the resulting 32-character extension ID.
2. **Create a Google Cloud project** at <https://console.cloud.google.com>.
3. **Enable the Google Drive API** for that project.
4. **Configure the OAuth consent screen.** External, with the scope
   `https://www.googleapis.com/auth/drive.file`. While the app is in *Testing*,
   add each tester's Google account explicitly — untested accounts are rejected.
5. **Create credentials → OAuth client ID → Chrome App / Chrome Extension**, and
   supply the extension ID from step 1.
6. **Put the client ID in `wxt.config.ts`**, replacing
   `YOUR_CLIENT_ID.apps.googleusercontent.com`.
7. **Apply the CSP fix from [V1](#v1-blocker--csp-blocks-every-google-api-call)** in
   the same file.
8. Rebuild, reload unpacked, then Settings → **Vault — Export to Google Drive** →
   *Enable Vault Export*.

**Keep the scope at `drive.file`.** It limits Smriti to files it created itself.
The broader `drive` scope would expose the user's entire Drive, requires Google's
restricted-scope security assessment, and would be indefensible against the
product's own privacy claims.

### Verifying it works

Watch the offscreen console (`chrome://extensions` → Smriti → *Inspect views:
offscreen.html*) for `[smriti:vault]` lines:

```text
[smriti:vault] sync loop started
[smriti:vault] round: synced=10 errors=0 apiCalls=13 ms=4211
```

Then check Drive for `smriti-vault/threads/claude/…`. Note that with
[V3](#v3--manual-sync-now-silently-does-nothing-while-the-loop-is-running)
unfixed, only the loop's own 30-second tick will actually export anything — the
"Sync now" button and the post-enable kick will both report success and do
nothing.

---

## 7. Before this ships

- [ ] Fix [V1](#v1-blocker--csp-blocks-every-google-api-call) (CSP) and
      [V2](#v2-blocker--the-oauth-client-id-is-a-placeholder) (client ID) — without
      both, nothing runs.
- [ ] Fix [V9](#v9--the-typecheck-error) so `tsc --noEmit` is clean again.
- [ ] Fix [V3](#v3--manual-sync-now-silently-does-nothing-while-the-loop-is-running)
      and [V4](#v4--vault-sync-stops-permanently-after-the-offscreen-document-restarts)
      — both are silent failures, the worst kind for a background sync.
- [ ] Resolve [V5](#v5--okf-null-title-test-fails) so `npm run test:okf` passes.
- [ ] Fix [V6](#v6--resyncall-duplicates-every-file-on-drive) / add
      [V7](#v7--filename-collisions-are-unhandled) before anyone runs a resync
      against a real Drive.
- [ ] **Update the privacy story.** `PRIVACY_POLICY.md`, `STORE_LISTING.md`,
      `docs/privacy.html`, and `docs/index.html` all currently state that nothing
      leaves the device. That is no longer unconditionally true once vault export
      is enabled. The Chrome Web Store data-use disclosure must reflect it too —
      shipping the current copy alongside this feature would be a false statement
      to reviewers and users.
- [ ] Add a bounded end-to-end test or a documented manual QA script; today the
      only automated coverage is the pure renderer.
