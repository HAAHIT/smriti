// Headless unit tests for the OKF markdown renderer.
// Run: npx tsx scripts/test-okf-renderer.ts
//
// Covers renderOkf and its pure helpers (slugify, extractTags). All are pure
// (no DOM, no DB, no browser globals) and run fine under tsx.

import {
  renderOkf,
  slugify,
  extractTags,
  OkfConversationMeta,
  OkfMessage
} from '../lib/okf-renderer.js';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  cond ? pass++ : fail++;
}

const baseMeta: OkfConversationMeta = {
  id: '1',
  platform: 'claude',
  platform_conv_id: 'abc',
  title: 'Test Chat',
  url: 'https://claude.ai/chat/abc',
  started_at: '2026-07-01T10:00:00Z',
  last_message_at: '2026-07-01T11:00:00Z'
};

const baseMessages: OkfMessage[] = [
  { id: 'm1', role: 'user', content_text: 'Hello', created_at: '2026-07-01T10:00:00Z', position: 1 },
  { id: 'm2', role: 'assistant', content_text: 'Hi there!', created_at: '2026-07-01T10:00:01Z', position: 2 },
];

// ─── 1. Basic round-trip ─────────────────────────────────────────────────────

console.log("\n=== basic round-trip ===\n");

const doc = renderOkf(baseMeta, baseMessages);

check("markdown starts with frontmatter fence", doc.markdown.startsWith('---\n'));
check("frontmatter declares type: thread", doc.markdown.includes('type: thread'));
check("user turn rendered under ## User", doc.markdown.includes('## User\nHello'));
check("assistant turn rendered under ## Assistant", doc.markdown.includes('## Assistant\nHi there!'));
check("filename is <date>_<slug>.md", doc.filename === '2026-07-01_test-chat.md');
check("directory is threads/<platform>/", doc.directory === 'threads/claude/');

// ─── 2. Null title ───────────────────────────────────────────────────────────

console.log("\n=== null title ===\n");

const doc2 = renderOkf({ ...baseMeta, title: null }, baseMessages);

check('null title → title: "Untitled conversation"', doc2.markdown.includes('title: "Untitled conversation"'));
check("null title → filename contains 'untitled'", doc2.filename.includes('untitled'));

// ─── 3. YAML-unsafe title ────────────────────────────────────────────────────

console.log("\n=== YAML-unsafe title ===\n");

const doc3 = renderOkf({ ...baseMeta, title: 'Why: "this" breaks [YAML]' }, baseMessages);

check(
  "colons/quotes/brackets in title are quoted and escaped",
  doc3.markdown.includes('title: "Why: \\"this\\" breaks [YAML]"')
);

// Plain titles are quoted too — the frontmatter is uniform, not "quoted only
// when strictly required".
check(
  "plain title is quoted as well",
  renderOkf(baseMeta, baseMessages).markdown.includes('title: "Test Chat"')
);

// Backslash must be escaped before the quote, or "C:\" would emit a dangling
// escape and break the YAML.
check(
  "backslashes in title are escaped",
  renderOkf({ ...baseMeta, title: 'path C:\\Users "home"' }, baseMessages)
    .markdown.includes('title: "path C:\\\\Users \\"home\\""')
);

check(
  "newlines in title do not break the frontmatter",
  renderOkf({ ...baseMeta, title: 'line one\nline two' }, baseMessages)
    .markdown.includes('title: "line one\\nline two"')
);

// ─── 4. Empty messages ───────────────────────────────────────────────────────

console.log("\n=== empty messages ===\n");

const doc4 = renderOkf(baseMeta, []);

check("no messages → message_count: 0", doc4.markdown.includes('message_count: 0'));
check("no messages → placeholder body", doc4.markdown.includes('*No messages captured.*'));

// ─── 5. Consecutive same-role messages are merged ────────────────────────────

console.log("\n=== consecutive same-role merge ===\n");

const doc5 = renderOkf(baseMeta, [
  { id: 'm1', role: 'assistant', content_text: 'Part 1', created_at: '2026-07-01T10:00:00Z', position: 1 },
  { id: 'm2', role: 'assistant', content_text: 'Part 2', created_at: '2026-07-01T10:00:01Z', position: 2 },
]);

check(
  "two assistant turns → one ## Assistant header",
  (doc5.markdown.match(/## Assistant/g) ?? []).length === 1
);
check("both turns present, blank-line separated", doc5.markdown.includes('Part 1\n\nPart 2'));

// ─── 6. Memories footer ──────────────────────────────────────────────────────

console.log("\n=== memories footer ===\n");

const doc6 = renderOkf(baseMeta, baseMessages, [
  { id: 'mem1', kind: 'identity', text: "I'm a TypeScript dev" },
]);

check("footer heading present", doc6.markdown.includes('## Related Memories'));
check("memory rendered with its kind", doc6.markdown.includes("- I'm a TypeScript dev (*identity*)"));

// ─── 7. Tag extraction ───────────────────────────────────────────────────────

console.log("\n=== tag extraction ===\n");

const tags = extractTags([
  { id: 'm1', role: 'user', content_text: 'How do I use TypeScript with React and build components?', created_at: '', position: 1 },
]);

check("extracts 'typescript'", tags.includes('typescript'));
check("extracts 'react'", tags.includes('react'));
check("extracts 'build'", tags.includes('build'));
check("extracts 'components'", tags.includes('components'));

// ─── 8. Slugify edge cases ───────────────────────────────────────────────────

console.log("\n=== slugify ===\n");

check("'Hello World!' → 'hello-world'", slugify('Hello World!') === 'hello-world');
check("'  --weird--chars!!  ' → 'weird-chars'", slugify('  --weird--chars!!  ') === 'weird-chars');
check("long title capped at 60 chars", slugify('A'.repeat(100)).length <= 60);

// ─── 9. Tool messages handling ───────────────────────────────────────────────

console.log("\n=== tool messages ===\n");

const doc9 = renderOkf(baseMeta, [
  { id: 't1', role: 'tool', content_text: '{"result": "success"}', created_at: '2026-07-01T10:00:00Z', position: 1 },
]);

check(
  "tool output wrapped in a json fence",
  doc9.markdown.includes('## Tool\n```json\n{"result": "success"}\n```')
);

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\nAssertions: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
