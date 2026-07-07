import {
  renderOkf,
  slugify,
  extractTags,
  OkfConversationMeta,
  OkfMessage
} from '../lib/okf-renderer.js';
import * as assert from 'assert';

console.log('Running OKF Renderer tests...');

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

try {
  // 1. Basic round-trip
  const doc = renderOkf(baseMeta, baseMessages);
  assert.ok(doc.markdown.startsWith('---\n'));
  assert.ok(doc.markdown.includes('type: thread'));
  assert.ok(doc.markdown.includes('## User\nHello'));
  assert.ok(doc.markdown.includes('## Assistant\nHi there!'));
  assert.strictEqual(doc.filename, '2026-07-01_test-chat.md');
  assert.strictEqual(doc.directory, 'threads/claude/');

  // 2. Null title
  const doc2 = renderOkf({ ...baseMeta, title: null }, baseMessages);
  assert.ok(doc2.markdown.includes('title: "Untitled conversation"'));
  assert.ok(doc2.filename.includes('untitled'));

  // 3. YAML-unsafe title
  const doc3 = renderOkf({ ...baseMeta, title: 'Why: "this" breaks [YAML]' }, baseMessages);
  assert.ok(doc3.markdown.includes('title: "Why: \\"this\\" breaks [YAML]"'));

  // 4. Empty messages
  const doc4 = renderOkf(baseMeta, []);
  assert.ok(doc4.markdown.includes('message_count: 0'));
  assert.ok(doc4.markdown.includes('*No messages captured.*'));

  // 5. Consecutive same-role messages are merged
  const doc5 = renderOkf(baseMeta, [
    { id: 'm1', role: 'assistant', content_text: 'Part 1', created_at: '2026-07-01T10:00:00Z', position: 1 },
    { id: 'm2', role: 'assistant', content_text: 'Part 2', created_at: '2026-07-01T10:00:01Z', position: 2 },
  ]);
  const count = (doc5.markdown.match(/## Assistant/g) ?? []).length;
  assert.strictEqual(count, 1);
  assert.ok(doc5.markdown.includes('Part 1\n\nPart 2'));

  // 6. Memories footer
  const doc6 = renderOkf(baseMeta, baseMessages, [
    { id: 'mem1', kind: 'identity', text: "I'm a TypeScript dev" },
  ]);
  assert.ok(doc6.markdown.includes('## Related Memories'));
  assert.ok(doc6.markdown.includes("- I'm a TypeScript dev (*identity*)"));

  // 7. Tag extraction
  const tags = extractTags([
    { id: 'm1', role: 'user', content_text: 'How do I use TypeScript with React and build components?', created_at: '', position: 1 },
  ]);
  assert.ok(tags.includes('typescript'));
  assert.ok(tags.includes('react'));
  assert.ok(tags.includes('build'));
  assert.ok(tags.includes('components'));

  // 8. Slugify edge cases
  assert.strictEqual(slugify('Hello World!'), 'hello-world');
  assert.strictEqual(slugify('  --weird--chars!!  '), 'weird--chars');
  assert.ok(slugify('A'.repeat(100)).length <= 60);

  // 9. Tool messages handling
  const doc9 = renderOkf(baseMeta, [
    { id: 't1', role: 'tool', content_text: '{"result": "success"}', created_at: '2026-07-01T10:00:00Z', position: 1 },
  ]);
  assert.ok(doc9.markdown.includes('## Tool\n```json\n{"result": "success"}\n```'));

  console.log('✅ All OKF Renderer tests passed!');
} catch (error) {
  console.error('❌ OKF Renderer tests failed:');
  console.error(error);
  process.exit(1);
}
