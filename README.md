# Smriti — the memory layer for AI

**Your AI finally remembers you.** Smriti gives Claude, ChatGPT, and Gemini one
shared memory. It captures your conversations, distills the durable facts about
you — your stack, your decisions, your preferences — and lets you inject that
context into your next prompt in **one click**. Everything runs locally; nothing
leaves your browser.

> Stop re-explaining yourself to every AI.

## How it works

1. **Capture** — a read-only content script archives your chats across every AI
   tool. No copy-paste, no API keys.
2. **Distill** — durable, first-person facts are extracted locally (no LLM call)
   and classified as identity / preference / project / decision / fact.
3. **Recall** — as you type your next prompt, hybrid keyword + semantic search
   surfaces the memories that matter — across all three tools.
4. **Inject** — one click drops the context straight into the composer.

All of it is local-first: SQLite (WASM) + embeddings run inside the extension's
offscreen document, persisted to the browser's Origin Private File System. No
account, no server, no telemetry.

## Layout

```
packages/
  shared/       Shared TypeScript types + protocol contract
  extension/    The product — browser extension (Chrome + Firefox via WXT)
  helper/       Legacy Node service (superseded by the offscreen doc)
  mcp-server/   Legacy MCP server
```

The memory layer lives in `packages/extension/lib/`:
`extract.ts` (pure extractor) · `memory.ts` (store + recall) · `inject.ts`
(composer injection) · `index-worker.ts` (background extraction + embeddings).

## Quick start (dev)

```bash
npm install
cd packages/extension
npm run test:extract   # extraction-quality assertions
npm run build          # → .output/chrome-mv3 (load unpacked at chrome://extensions)
npm run dev            # live dev server
```

Then open Claude/ChatGPT/Gemini, click the Smriti toolbar icon → **✦ Memory** →
*Build my memory*, and start typing a prompt to see recall + one-click inject.

## Status

Hero feature shipped: automatic memory extraction, hybrid recall, and one-click
injection across Claude, ChatGPT, and Gemini. Landing page in `docs/`.

See [CLAUDE.md](CLAUDE.md) for architecture, conventions, and the roadmap.
```
