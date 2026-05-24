# Smriti Privacy Policy

_Last updated: 2026-05-24_

Smriti is built local-first. This policy describes what data Smriti handles
and where it lives. Short version: **your conversations never leave your
browser**.

---

## What Smriti collects

Smriti's purpose is to archive the AI conversations you have on:

- claude.ai
- chatgpt.com
- gemini.google.com

For each conversation, Smriti stores:

- The text content of every message you send and every message the AI
  sends back
- Conversation metadata: title, platform, URL, timestamps, message ordering
- A locally-computed embedding vector for each message (used only for
  semantic search — never transmitted anywhere)

## Where your data is stored

All data is kept in a **SQLite database inside your browser's Origin Private
File System (OPFS)**. OPFS is a sandboxed storage area that Chrome provides
to browser extensions and web apps — it is:

- Accessible only to this extension (origin-partitioned by Chrome)
- Invisible to websites you visit
- Stored on your local machine (typically inside your Chrome profile
  directory)
- Never readable by Smriti's developers or any third party

There is no local helper program, no companion app, and no external database.
Everything lives inside Chrome.

## What Smriti does NOT collect

- No analytics or telemetry of any kind
- No crash reports sent anywhere
- No account information — Smriti has no accounts
- No browser history, bookmarks, cookies, passwords, or activity outside
  the three AI hosts listed above
- No content from any other website
- No data from open tabs other than the ones you've explicitly visited on
  those three hosts

## Network requests Smriti makes

Smriti makes exactly two types of outbound network requests:

1. **One-time model download** — on first use, Smriti downloads the
   all-MiniLM-L6-v2 ONNX embedding model (~25 MB) from Hugging Face's CDN.
   This happens once and is cached permanently in the browser. The request
   contains no user data.

2. **Backfill fetch** — when you click "Import history", Smriti uses your
   existing browser session cookies to fetch your past conversations directly
   from claude.ai or chatgpt.com (the same requests your browser would make
   if you scrolled through your history). These requests go to Anthropic's
   and OpenAI's servers respectively. Smriti never sees your password or
   authentication tokens — it uses the session your browser already has.

No conversation content, no message text, and no embeddings are ever
transmitted to any server.

## Permissions and what they're used for

- **`storage`** — saves UI preferences (theme, capture pause toggles,
  sidebar collapsed state) in chrome.storage.local. No conversation data
  is stored here.

- **`offscreen`** — creates a persistent offscreen document (a hidden
  browser page) that owns the SQLite database and the local embedding
  pipeline. This is the compute engine of the extension — all data stays
  inside this document, inside Chrome.

- **`scripting`** — used to inject the sidebar content script into AI chat
  tabs when capture is toggled on or off for a specific host.

- **Host permissions** for `claude.ai`, `chatgpt.com`,
  `gemini.google.com` — to run capture scripts and the sidebar on
  exactly those three AI surfaces. The extension does not run on any other
  site.

## Your controls

From the Settings page (click the Smriti toolbar icon → Settings tab) you
can:

- **Pause capture** for any individual host — Smriti stops collecting new
  messages on that site until you re-enable it
- **Wipe the local archive** — permanently deletes every captured message
  and conversation from your OPFS database

To fully remove all Smriti data:
1. Click "Wipe archive" in Settings, then
2. Uninstall the extension from `chrome://extensions/`

Uninstalling the extension causes Chrome to delete its OPFS storage
automatically.

## Open source

Smriti is open source. You can audit exactly what the extension does at:
https://github.com/<your-handle>/smriti

## Contact

For privacy questions or to report a concern:
- Open an issue: https://github.com/<your-handle>/smriti/issues
- Email: `<your-email>`

## Changes to this policy

If we make material changes, we'll bump the "Last updated" date at the top
and note the change in the GitHub releases for the corresponding version.
