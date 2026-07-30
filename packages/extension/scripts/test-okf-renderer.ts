// Headless unit tests for the OKF markdown renderer.
// Run: npm run test:okf
//
// Covers renderOkf and the pure helpers it composes: slugify, generateFilename,
// extractTags, renderFrontmatter, renderBody, renderMemoriesFooter. All are pure
// string transforms with no DOM or DB dependency, so they run fine under tsx.
//
// Uses the same check()/pass-fail-counter harness as the other suites rather
// than one big try/catch, so every assertion runs and a failure names itself
// instead of aborting the rest of the file.

import {
  renderOkf,
  renderBody,
  renderFrontmatter,
  renderMemoriesFooter,
  generateFilename,
  slugify,
  extractTags,
  OkfConversationMeta,
  OkfMessage,
} from "../lib/okf-renderer.js";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  cond ? pass++ : fail++;
}

function eq<T>(a: T, b: T): boolean {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) console.log(`    expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  return ok;
}

function has(haystack: string, needle: string): boolean {
  const ok = haystack.includes(needle);
  if (!ok) console.log(`    expected to contain ${JSON.stringify(needle)}`);
  return ok;
}

const baseMeta: OkfConversationMeta = {
  id: "1",
  platform: "claude",
  platform_conv_id: "abc",
  title: "Test Chat",
  url: "https://claude.ai/chat/abc",
  started_at: "2026-07-01T10:00:00Z",
  last_message_at: "2026-07-01T11:00:00Z",
};

const baseMessages: OkfMessage[] = [
  { id: "m1", role: "user", content_text: "Hello", created_at: "2026-07-01T10:00:00Z", position: 1 },
  { id: "m2", role: "assistant", content_text: "Hi there!", created_at: "2026-07-01T10:00:01Z", position: 2 },
];

// ─── renderOkf — basic round-trip ─────────────────────────────────────────────

console.log("\n=== renderOkf: basic round-trip ===\n");

const doc = renderOkf(baseMeta, baseMessages);

check("markdown opens with a frontmatter fence", doc.markdown.startsWith("---\n"));
check("frontmatter declares type: thread", has(doc.markdown, "type: thread"));
check("title is quoted", has(doc.markdown, 'title: "Test Chat"'));
check("platform recorded", has(doc.markdown, "platform: claude"));
check("user turn rendered", has(doc.markdown, "## User\nHello"));
check("assistant turn rendered", has(doc.markdown, "## Assistant\nHi there!"));
check("source_url recorded", has(doc.markdown, 'source_url: "https://claude.ai/chat/abc"'));
check("message_count recorded", has(doc.markdown, "message_count: 2"));
check("created/updated recorded", has(doc.markdown, 'created: "2026-07-01T10:00:00Z"'));
check("filename is <date>_<slug>.md", eq(doc.filename, "2026-07-01_test-chat.md"));
check("directory is threads/<platform>/", eq(doc.directory, "threads/claude/"));
check("markdown ends with exactly one newline", /[^\n]\n$/.test(doc.markdown));

// ─── Titles ───────────────────────────────────────────────────────────────────

console.log("\n=== titles ===\n");

const docNull = renderOkf({ ...baseMeta, title: null }, baseMessages);
check("null title → quoted placeholder", has(docNull.markdown, 'title: "Untitled conversation"'));
check("null title → 'untitled' in filename", has(docNull.filename, "untitled"));

const docYaml = renderOkf({ ...baseMeta, title: 'Why: "this" breaks [YAML]' }, baseMessages);
check(
  "YAML-unsafe title quoted with escaped inner quotes",
  has(docYaml.markdown, 'title: "Why: \\"this\\" breaks [YAML]"'),
);

const docSlash = renderOkf({ ...baseMeta, title: 'path C:\\temp "x"' }, baseMessages);
check(
  "backslash escaped as \\\\ (it is the escape char in double-quoted YAML)",
  has(docSlash.markdown, 'title: "path C:\\\\temp \\"x\\""'),
);

const docBareType = renderOkf({ ...baseMeta, title: "yes" }, baseMessages);
check(
  "title that looks like a YAML boolean stays a quoted string",
  has(docBareType.markdown, 'title: "yes"'),
);

check(
  "empty title → 'untitled' filename slug",
  has(renderOkf({ ...baseMeta, title: "" }, baseMessages).filename, "untitled"),
);

// ─── renderBody ───────────────────────────────────────────────────────────────

console.log("\n=== renderBody ===\n");

const docEmpty = renderOkf(baseMeta, []);
check("no messages → message_count: 0", has(docEmpty.markdown, "message_count: 0"));
check("no messages → placeholder body", has(docEmpty.markdown, "*No messages captured.*"));

const docMerged = renderOkf(baseMeta, [
  { id: "m1", role: "assistant", content_text: "Part 1", created_at: "2026-07-01T10:00:00Z", position: 1 },
  { id: "m2", role: "assistant", content_text: "Part 2", created_at: "2026-07-01T10:00:01Z", position: 2 },
]);
check(
  "consecutive same-role messages share one heading",
  eq((docMerged.markdown.match(/## Assistant/g) ?? []).length, 1),
);
check("merged turns separated by a blank line", has(docMerged.markdown, "Part 1\n\nPart 2"));

const bodyAlternating = renderBody([
  { id: "a", role: "user", content_text: "one", created_at: "", position: 1 },
  { id: "b", role: "assistant", content_text: "two", created_at: "", position: 2 },
  { id: "c", role: "user", content_text: "three", created_at: "", position: 3 },
]);
check("a role change re-emits the heading", eq((bodyAlternating.match(/## User/g) ?? []).length, 2));
check("body has no trailing blank line", !bodyAlternating.endsWith("\n"));

const docTool = renderOkf(baseMeta, [
  { id: "t1", role: "tool", content_text: '{"result": "success"}', created_at: "2026-07-01T10:00:00Z", position: 1 },
]);
check(
  "tool output wrapped in a json fence",
  has(docTool.markdown, '## Tool\n```json\n{"result": "success"}\n```'),
);

const bodyToolFenced = renderBody([
  { id: "t1", role: "tool", content_text: "```\nalready fenced\n```", created_at: "", position: 1 },
]);
check("already-fenced tool output is not double-wrapped", !bodyToolFenced.includes("```json"));

// ─── renderMemoriesFooter ─────────────────────────────────────────────────────

console.log("\n=== renderMemoriesFooter ===\n");

const docMem = renderOkf(baseMeta, baseMessages, [
  { id: "mem1", kind: "identity", text: "I'm a TypeScript dev" },
]);
check("memories footer heading present", has(docMem.markdown, "## Related Memories"));
check("memory rendered with its kind", has(docMem.markdown, "- I'm a TypeScript dev (*identity*)"));

check("empty memories array → no footer", eq(renderMemoriesFooter([]), ""));
check(
  "no memories → renderOkf omits the heading",
  !renderOkf(baseMeta, baseMessages, []).markdown.includes("## Related Memories"),
);

// ─── renderFrontmatter ────────────────────────────────────────────────────────

console.log("\n=== renderFrontmatter ===\n");

const fmPlain = renderFrontmatter(baseMeta, baseMessages, [], null);
check("null url → no source_url key", !renderFrontmatter({ ...baseMeta, url: null }, baseMessages, [], null).includes("source_url"));
check("model recorded when known", has(renderFrontmatter(baseMeta, baseMessages, [], "claude-opus-4"), 'model: "claude-opus-4"'));
check("model omitted when absent", !fmPlain.includes("model:"));
check("no extracted tags → platform is still tagged", has(fmPlain, "tags:\n  - claude"));
check(
  "platform tag not duplicated when it was also extracted",
  eq((renderFrontmatter(baseMeta, baseMessages, ["claude", "rust"], null).match(/^ {2}- claude$/gm) ?? []).length, 1),
);
check("frontmatter closes with a fence", fmPlain.trimEnd().endsWith("---"));

// ─── extractTags ──────────────────────────────────────────────────────────────

console.log("\n=== extractTags ===\n");

const tags = extractTags([
  {
    id: "m1",
    role: "user",
    content_text: "How do I use TypeScript with React and build components?",
    created_at: "",
    position: 1,
  },
]);
check("extracts 'typescript'", tags.includes("typescript"));
check("extracts 'react'", tags.includes("react"));
check("extracts 'build'", tags.includes("build"));
check("extracts 'components'", tags.includes("components"));
check("drops stop words ('with')", !tags.includes("with"));
check("caps at 5 tags", tags.length <= 5);

check(
  "assistant messages do not contribute tags",
  eq(
    extractTags([
      { id: "a", role: "assistant", content_text: "kubernetes kubernetes kubernetes", created_at: "", position: 1 },
    ]),
    [],
  ),
);

check(
  "more frequent term ranks first",
  eq(
    extractTags([
      { id: "a", role: "user", content_text: "postgres postgres postgres sqlite", created_at: "", position: 1 },
    ])[0],
    "postgres",
  ),
);

check("no messages → no tags", eq(extractTags([]), []));

// ─── slugify / generateFilename ───────────────────────────────────────────────

console.log("\n=== slugify / generateFilename ===\n");

check("lowercases and hyphenates", eq(slugify("Hello World!"), "hello-world"));
// Runs of hyphens collapse to one and leading/trailing hyphens are trimmed, so
// surrounding whitespace and doubled dashes both normalize away.
check("collapses hyphen runs and trims the edges", eq(slugify("  --weird--chars!!  "), "weird-chars"));
check("interior hyphen run collapses to one", eq(slugify("a---b"), "a-b"));
check("caps slug length at 60", slugify("A".repeat(100)).length <= 60);
check("all-punctuation title → empty slug", eq(slugify("!!!"), ""));

check(
  "unslugifiable title falls back to 'untitled'",
  eq(generateFilename({ ...baseMeta, title: "!!!" }), "2026-07-01_untitled.md"),
);
check(
  "filename date comes from started_at",
  eq(generateFilename({ ...baseMeta, started_at: "2025-12-25T00:00:00Z" }), "2025-12-25_test-chat.md"),
);

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nAssertions: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
