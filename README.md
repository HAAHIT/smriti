# Recall

Local-first archive, search, and reference layer for AI conversations across Claude, ChatGPT, Gemini, and Claude Code.

See [recall-PRD.md](../Sadhguru%20Door/recall-PRD.md) for the full product spec.

## Layout

```
packages/
  shared/       Shared TypeScript types + Native Messaging protocol contract
  extension/    Browser extension (Chrome + Firefox via WXT)
  helper/       Node service: SQLite, capture intake, search, NM host
  mcp-server/   MCP server exposing the archive to Claude Desktop / Code
```

## Quick start (dev)

```powershell
npm install
npm run dev:helper          # starts helper in dev mode
npm run dev:extension       # starts WXT extension dev server
npm run install-nm          # registers Native Messaging manifest for Chrome/Edge/Firefox
```

## Status

Week 1 — foundations. See `recall-PRD.md` section 11 for the build plan.
