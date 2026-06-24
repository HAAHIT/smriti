// Headless unit tests for sidebar helper functions.
// Run: npx tsx scripts/test-sidebar-helpers.ts
//
// Covers the pure utility functions extracted in the PR:
//   detectCurrentChat, providerBadge, memoryKindMeta, formatDate, escapeHtml
// All of these are pure (no DOM, no browser globals) and run fine under tsx.

import {
  detectCurrentChat,
  providerBadge,
  memoryKindMeta,
  formatDate,
  escapeHtml,
} from "../lib/sidebar-helpers.js";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  cond ? pass++ : fail++;
}

function eq<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── detectCurrentChat ────────────────────────────────────────────────────────

console.log("\n=== detectCurrentChat ===\n");

// Claude.ai — valid UUID-like path
check(
  "claude.ai /chat/<uuid> → platform=claude",
  eq(detectCurrentChat("https://claude.ai/chat/a1b2c3d4-e5f6-7890-abcd-ef1234567890"), {
    platform: "claude",
    platformConvId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  })
);

// Claude.ai — minimal 8-char hex ID
check(
  "claude.ai /chat/ with 8-char hex id",
  eq(detectCurrentChat("https://claude.ai/chat/abcdef01"), {
    platform: "claude",
    platformConvId: "abcdef01",
  })
);

// Claude.ai — no chat segment
check(
  "claude.ai root path → null",
  detectCurrentChat("https://claude.ai/") === null
);

// Claude.ai — /new path (no UUID)
check(
  "claude.ai /new path → null",
  detectCurrentChat("https://claude.ai/new") === null
);

// Claude.ai — ID too short (< 8 chars)
check(
  "claude.ai /chat/<7-char-id> → null (too short)",
  detectCurrentChat("https://claude.ai/chat/abc1234") === null
);

// Claude.ai on a subdomain still matches (endsWith check)
check(
  "subdomain.claude.ai /chat/<uuid> → platform=claude",
  detectCurrentChat("https://app.claude.ai/chat/deadbeef-dead-beef-dead-beefdeadbeef") !== null &&
  detectCurrentChat("https://app.claude.ai/chat/deadbeef-dead-beef-dead-beefdeadbeef")?.platform === "claude"
);

// ChatGPT — standard /c/<uuid>
check(
  "chatgpt.com /c/<id> → platform=chatgpt",
  eq(detectCurrentChat("https://chatgpt.com/c/abcdef01-2345-6789-abcd-ef0123456789"), {
    platform: "chatgpt",
    platformConvId: "abcdef01-2345-6789-abcd-ef0123456789",
  })
);

// ChatGPT — custom GPT pattern /g/g-xxx/c/<uuid>
check(
  "chatgpt.com /g/g-xxx/c/<id> (custom GPT) → platform=chatgpt",
  detectCurrentChat("https://chatgpt.com/g/g-XyZ123/c/abcdef01-2345-6789-abcd-ef0123456789")?.platform === "chatgpt"
);

// ChatGPT — root with no /c/ path
check(
  "chatgpt.com root → null",
  detectCurrentChat("https://chatgpt.com/") === null
);

// ChatGPT — /c/ with short ID (< 8 chars)
check(
  "chatgpt.com /c/<7-char> → null (too short)",
  detectCurrentChat("https://chatgpt.com/c/abc1234") === null
);

// Gemini — valid /app/<id>
check(
  "gemini.google.com /app/<id> → platform=gemini",
  eq(detectCurrentChat("https://gemini.google.com/app/abcdef01234567890"), {
    platform: "gemini",
    platformConvId: "abcdef01234567890",
  })
);

// Gemini — root path
check(
  "gemini.google.com root → null",
  detectCurrentChat("https://gemini.google.com/") === null
);

// Gemini — /app/ with short ID
check(
  "gemini.google.com /app/<7-char> → null (too short)",
  detectCurrentChat("https://gemini.google.com/app/abc1234") === null
);

// Unknown domain
check(
  "unknown domain → null",
  detectCurrentChat("https://example.com/chat/abcdef01234567890") === null
);

// Malformed / empty URL
check(
  "malformed URL → null",
  detectCurrentChat("not-a-url") === null
);

// Empty string URL
check(
  "empty string URL → null",
  detectCurrentChat("") === null
);

// ─── providerBadge ────────────────────────────────────────────────────────────

console.log("\n=== providerBadge ===\n");

check(
  "claude → {label: 'Claude', color: '#c96442'}",
  eq(providerBadge("claude"), { label: "Claude", color: "#c96442" })
);

check(
  "chatgpt → {label: 'ChatGPT', color: '#1f7a64'}",
  eq(providerBadge("chatgpt"), { label: "ChatGPT", color: "#1f7a64" })
);

check(
  "gemini → {label: 'Gemini', color: '#3b6cb5'}",
  eq(providerBadge("gemini"), { label: "Gemini", color: "#3b6cb5" })
);

check(
  "claude_code → {label: 'Code', color: '#6d5fa6'}",
  eq(providerBadge("claude_code"), { label: "Code", color: "#6d5fa6" })
);

check(
  "unknown provider → normalized label, fallback color `#888`",
  eq(providerBadge("some-new-ai"), { label: "Other", color: "`#888`" })
);

check(
  "empty string → normalized label, fallback color",
  eq(providerBadge(""), { label: "Other", color: "`#888`" })
);

// ─── memoryKindMeta ───────────────────────────────────────────────────────────

console.log("\n=== memoryKindMeta ===\n");

check(
  "identity → {label: 'identity', color: '#8b3a2f'}",
  eq(memoryKindMeta("identity"), { label: "identity", color: "#8b3a2f" })
);

check(
  "preference → {label: 'preference', color: '#1f7a64'}",
  eq(memoryKindMeta("preference"), { label: "preference", color: "#1f7a64" })
);

check(
  "project → {label: 'project', color: '#3b6cb5'}",
  eq(memoryKindMeta("project"), { label: "project", color: "#3b6cb5" })
);

check(
  "decision → {label: 'decision', color: '#9a6b1f'}",
  eq(memoryKindMeta("decision"), { label: "decision", color: "#9a6b1f" })
);

// "fact" is the default case
check(
  "explicit 'fact' → {label: 'fact', color: '#6d5fa6'}",
  eq(memoryKindMeta("fact"), { label: "fact", color: "#6d5fa6" })
);

check(
  "unknown kind → falls back to 'fact' / '#6d5fa6'",
  eq(memoryKindMeta("mystery"), { label: "fact", color: "#6d5fa6" })
);

check(
  "empty kind → falls back to 'fact'",
  eq(memoryKindMeta(""), { label: "fact", color: "#6d5fa6" })
);

// ─── formatDate ───────────────────────────────────────────────────────────────

console.log("\n=== formatDate ===\n");

check(
  "valid ISO string → non-empty formatted date",
  formatDate("2026-01-15T12:00:00Z").length > 0
);

check(
  "valid ISO string contains Jan for month 1",
  formatDate("2026-01-15T12:00:00Z").includes("Jan") ||
  formatDate("2026-01-15T12:00:00Z").includes("1")   // locale may differ
);

// new Date("not-a-date") creates an Invalid Date without throwing; toLocaleDateString
// returns "Invalid Date" in V8/Node rather than throwing, so the catch block is not hit.
check(
  "invalid date string → non-empty 'Invalid Date' string (no exception thrown)",
  formatDate("not-a-date").length > 0
);

check(
  "empty string input → non-empty string (Invalid Date, no throw)",
  formatDate("").length > 0
);

// Cross-check: two different months produce different output
check(
  "different months → different formatted strings",
  formatDate("2026-01-15T00:00:00Z") !== formatDate("2026-06-15T00:00:00Z")
);

// Same day different years → same short format (month + day only)
check(
  "same month+day across years → same short format",
  formatDate("2024-03-10T00:00:00Z") === formatDate("2025-03-10T00:00:00Z")
);

// ─── escapeHtml ───────────────────────────────────────────────────────────────

console.log("\n=== escapeHtml ===\n");

check(
  "& → &amp;",
  escapeHtml("&") === "&amp;"
);

check(
  "< → &lt;",
  escapeHtml("<") === "&lt;"
);

check(
  "> → &gt;",
  escapeHtml(">") === "&gt;"
);

check(
  '" → &quot;',
  escapeHtml('"') === "&quot;"
);

check(
  "' → &#39;",
  escapeHtml("'") === "&#39;"
);

check(
  "safe string passes through unchanged",
  escapeHtml("hello world 123") === "hello world 123"
);

check(
  "empty string → empty string",
  escapeHtml("") === ""
);

check(
  "combined XSS payload escaped correctly",
  escapeHtml('<script>alert("xss")\'</script>') ===
    "&lt;script&gt;alert(&quot;xss&quot;)&#39;&lt;/script&gt;"
);

check(
  "multiple & chars all escaped",
  escapeHtml("a & b & c") === "a &amp; b &amp; c"
);

check(
  "HTML attribute injection attempt escaped",
  escapeHtml('"><img src=x onerror=alert(1)>') ===
    "&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"
);

// Boundary: string with no special chars at all
check(
  "string with only digits and letters unchanged",
  escapeHtml("abcXYZ0123456789") === "abcXYZ0123456789"
);

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\nAssertions: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);