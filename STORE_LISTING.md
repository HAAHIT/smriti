# Smriti — Chrome Web Store listing

All copy ready to paste into the CWS developer dashboard. Keep this file
updated whenever marketing text changes.

---

## Item name (max 45 chars)

`Smriti — Memory for your AI conversations`

## Short description (max 132 chars)

> Local-first memory for your AI conversations across Claude, ChatGPT and
> Gemini. Search, outline, recall. Nothing leaves your browser.

(Char count: 128 ✓)

## Detailed description (max 16,000 chars)

```
Your AI finally remembers you.

Smriti captures your conversations across Claude, ChatGPT, and Gemini,
distills durable facts about you — who you are, how you like to work, what
you're building — and injects that context into any prompt in one click.
Entirely on your device.

─────────────────────────────────────────
THE PROBLEM
─────────────────────────────────────────

You use AI tools every day. Over months you've had hundreds of conversations
— many long, many half-remembered. The pain is familiar:

  • "I solved this exact thing three weeks ago, where was it?"
  • "I had a great conversation about X but can't find the specific exchange."
  • "I just explained my whole stack and how I like to work — again — to a
    brand-new chat that remembers none of it."

Each AI tool has its own search, but it's keyword-only, scoped to one
platform, and dumps you at the top of a fifty-message thread. Your thinking
is fragmented across three silos, and none of them know about the others.

Smriti fixes this.

─────────────────────────────────────────
WHAT SMRITI DOES
─────────────────────────────────────────

MEMORY, INJECTED IN ONE CLICK
As you type a new message, Smriti recalls relevant facts about you — your
stack, your preferences, your in-flight projects — distilled automatically
from past conversations. A "Smriti remembers" card appears with one click to
drop that context straight into the composer, on Claude, ChatGPT, or Gemini.

AUTOMATIC CAPTURE
Captures every message you send and receive on claude.ai, chatgpt.com, and
gemini.google.com — automatically, in the background, with no setup per chat.

ONE-TIME HISTORY IMPORT
Import your entire Claude.ai or ChatGPT history using your existing browser
session — no API keys, no third-party accounts. Your whole backlog is
searchable within minutes.

HYBRID SEARCH
FTS5 keyword index + locally-computed semantic embeddings (all-MiniLM-L6-v2
via transformers.js) fused with Reciprocal Rank Fusion. Vague queries like
"the chat where we discussed embedding choices" find the right thread even
if the word "embedding" never appears in it.

CONVERSATION OUTLINES
Every long conversation gets an auto-generated outline. Topic chapters are
inferred from embedding similarity drops between consecutive messages — no
extra LLM call needed. A 50-message thread becomes 6 clickable chapters;
jump to any section instantly.

DEEP-LINK VIEWER
Open any search result and the viewer auto-scrolls to the exact matched
message and pulses it yellow so your eye locks on immediately.

IN-PAGE SIDEBAR
A sidebar lives inside claude.ai, chatgpt.com, and gemini.google.com. When
you start typing a new message, Smriti surfaces past conversations on the
same topic — across all three AI tools — so you never ask the same question
twice.

─────────────────────────────────────────
WHY IT'S DIFFERENT
─────────────────────────────────────────

Other AI chat search tools exist, but:

  • They're per-platform. Smriti spans all three major AI tools.
  • They're keyword-only. Smriti is hybrid: keyword + semantic recall.
  • They can't pinpoint a moment inside a long chat. Smriti's outline lets
    you jump straight to the section that holds the answer.
  • They run in someone else's cloud. Smriti runs entirely inside your
    browser — no external server, no account, no data leaving your machine.

─────────────────────────────────────────
PRIVACY
─────────────────────────────────────────

Smriti is local-first in the strict sense:

  • Your conversations never leave your browser.
  • No accounts, no telemetry, no analytics.
  • The SQLite archive lives in your browser's origin-private file system
    (OPFS) — accessible only to this extension, invisible to websites.
  • Embedding generation runs locally via transformers.js — no model API
    calls.
  • You can pause capture per host, or wipe the entire archive in one click
    from the Settings page.

─────────────────────────────────────────
HOW IT WORKS
─────────────────────────────────────────

Smriti is a single browser extension — no companion app to install, no
native helper, no account to create.

  1. A content script intercepts the API responses your AI tools are already
     receiving (read-only, never blocks or modifies the response stream).

  2. Messages are routed to a persistent offscreen document that owns a
     sql.js SQLite database stored in the browser's Origin Private File
     System (OPFS).

  3. Embeddings are computed locally inside the same offscreen document
     using transformers.js and the all-MiniLM-L6-v2 ONNX model, which ships
     bundled inside the extension package (~25 MB, never downloaded).

  4. Search queries hit the local FTS5 index and embedding index, fused
     via RRF, all inside your browser.

Everything runs inside Chrome. Smriti makes zero network requests of its
own — the only traffic is your browser's own session talking to claude.ai
or chatgpt.com when you explicitly import history.

─────────────────────────────────────────
WHAT IT DOESN'T DO
─────────────────────────────────────────

  • Doesn't send your data anywhere. Doesn't download anything at runtime —
    the embedding model ships bundled with the extension.
  • Doesn't require an account.
  • Doesn't auto-update or call home.
  • Doesn't index web pages or other browser activity — only the three AI
    surfaces listed in host_permissions.
  • Doesn't require installing any companion app or helper.

─────────────────────────────────────────
OPEN SOURCE
─────────────────────────────────────────

Source code: https://github.com/HAAHIT/smriti
Privacy policy: https://HAAHIT.github.io/smriti/privacy
Issues & feedback: https://github.com/HAAHIT/smriti/issues

─────────────────────────────────────────
REQUIREMENTS
─────────────────────────────────────────

  • Chrome 116+ (or Brave, Edge — any modern Chromium)
  • ~65 MB install size (includes the bundled embedding model — nothing
    downloaded separately)
  • ~1 MB per 1,000 messages archived

That's it. Install and open any AI chat — Smriti starts capturing.
```

---

## Category

`Productivity` (primary), `Developer Tools` (secondary, if allowed)

## Language

English (US)

## Visibility

Public

---

## Single purpose statement

> Smriti's single purpose is to locally capture the user's own AI
> conversations (from Claude.ai, ChatGPT, and Gemini), let the user search
> them, and re-use distilled facts about themselves in new prompts. All
> storage and processing happens on-device; the extension has no server.

---

## Permissions justification

For the CWS submission form, paste these into the matching boxes.

### `storage`
Used to persist user preferences (theme, per-host capture pause toggles,
sidebar collapsed state, onboarding completion flag) and to cache backfill
progress state between background service worker restarts. No conversation
data is stored in chrome.storage — that lives in the OPFS SQLite database.

### `offscreen`
Smriti runs a persistent offscreen document that owns the sql.js SQLite
database (stored in OPFS) and the transformers.js embedding pipeline. The
embedding model ships bundled with the extension, so the offscreen document
is the local compute engine of the extension — all ingestion, indexing, and
search happen here, inside Chrome, with no external network calls.

### `scripting`
Used to programmatically inject the sidebar content script into AI chat tabs
after the user grants or revokes capture for a specific host.

### Host permissions: `claude.ai`, `chatgpt.com`, `gemini.google.com`
Smriti runs content scripts on exactly the three AI chat hosts whose
conversations it captures. These scripts:
1. Intercept API responses (via a read-only MAIN-world fetch hook) to
   extract message content for local archiving. The host page's response
   is never blocked or modified.
2. Inject the right-edge sidebar UI for proactive "past you discussed this"
   recall.

The extension does not run on any other site. No broad host permissions.

### `wasm-unsafe-eval` (Content Security Policy)
Required by two bundled WASM binaries: sql.js (SQLite compiled to WASM) and
onnxruntime-web (ONNX Runtime for local embedding inference). Both run
entirely within the extension's offscreen document. No remote code is
fetched or evaluated — this flag is a WASM-specific compile requirement, not
a general eval permission.

---

## Review notes (single purpose & permissions)

Quick-reference summary for CWS reviewer follow-ups and the Privacy
practices tab's permission / remote-code / data-use fields.

- **Single purpose:** Smriti locally captures the user's own AI
  conversations on three sites, lets the user search them, and re-use
  distilled facts in new prompts. All storage and processing is on-device;
  the extension has no server.
- **`storage`** — persists capture pause toggles and onboarding flags.
- **`offscreen`** — hosts the SQLite (WASM) database and the local embedding
  model; MV3 service workers cannot run long-lived WASM workloads.
- **`scripting` + host permissions** (`claude.ai`, `chatgpt.com`,
  `gemini.google.com`) — content scripts that (a) read the user's own
  conversation streams on these three sites only, and (b) render the
  sidebar; text is written into the prompt box only on the user's explicit
  click.
- **Remote code:** none — all JS/WASM is bundled, including the local
  embedding model.
- **Data use disclosures (CWS form):** collects no data; nothing is
  transmitted or sold; all data stays on the user's device.

---

## Screenshots needed

CWS requires at least 1 screenshot at 1280×800 or 640×400. Recommend 5:

1. **Search results page** (1280×800)
   - Hybrid search results with FTS/Semantic/RRF tags, conversation cards
   - Caption: "Hybrid keyword + semantic search across all your AI tools"

2. **Conversation viewer with outline spine** (1280×800)
   - Long chat open, right-rail chapter spine visible, one message pulsing
   - Caption: "Jump to any moment in a long conversation — outline included"

3. **In-page sidebar on claude.ai** (1280×800)
   - Real claude.ai page with Smriti sidebar showing "Past you discussed this"
   - Caption: "Related past conversations — right inside your AI tool"

4. **Settings / privacy page** (1280×800)
   - Capture toggles with live green dots, wipe button, archive size counter
   - Caption: "100% local. Pause or wipe at any time."

5. **Home / recents view** (1280×800)
   - Recent conversations list across platforms with timestamps
   - Caption: "Your AI conversations, archived and searchable forever"

### Promo tile (440×280) — required

Wordmark "Smriti" in serif on parchment/oxblood background with tagline:
"Every AI conversation, remembered."

### Marquee (1400×560) — optional

Hero shot of the spine outline visualization + search panel side by side.

---

## Data usage declaration (CWS form)

Select: **"The extension handles user data"**

Under "personally identifiable information":
> This extension captures the text content of the user's own AI
> conversations on claude.ai, chatgpt.com, and gemini.google.com. All data
> is stored exclusively in the browser's Origin Private File System (OPFS),
> which is sandboxed to this extension and inaccessible to any website or
> remote server. No data is transmitted off the user's device.

---

## Privacy policy URL

Host the contents of `PRIVACY_POLICY.md` at a public URL, e.g.:
`https://HAAHIT.github.io/smriti/privacy`

---

## Submission checklist

- [ ] Pay the one-time $5 CWS developer registration fee
- [ ] Create GitHub repo and push source code
- [ ] Deploy privacy policy to public URL
- [ ] Run `npx wxt zip` to produce the submission zip (no source maps)
- [ ] Upload zip via CWS dashboard
- [ ] Set item name, short description, detailed description (above)
- [ ] Upload 1–5 screenshots at 1280×800
- [ ] Upload promo tile 440×280
- [ ] Fill single-purpose statement (above)
- [ ] Fill permissions justification for each permission (above)
- [ ] Fill data usage declaration (above)
- [ ] Submit privacy policy URL
- [ ] Submit for review (expect 1–7 business days)
