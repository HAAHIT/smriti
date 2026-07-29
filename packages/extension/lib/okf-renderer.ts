/** Mirrors ConversationMeta from @smriti/shared/protocol */
export interface OkfConversationMeta {
  id: string;
  platform: string;
  platform_conv_id: string;
  title: string | null;
  url: string | null;
  started_at: string;       // ISO 8601
  last_message_at: string;  // ISO 8601
}

/** Mirrors ConversationMessageRow from @smriti/shared/protocol */
export interface OkfMessage {
  id: string;
  role: string;             // "user" | "assistant" | "system" | "tool"
  content_text: string;
  created_at: string;       // ISO 8601
  position: number;
}

/** Subset of MemoryItem relevant for cross-linking */
export interface OkfRelatedMemory {
  id: string;
  kind: string;             // MemoryKind
  text: string;
}

export interface OkfDocument {
  /** The complete markdown string (frontmatter + body), ready to write. */
  markdown: string;
  /** The suggested filename (no path), e.g. "2026-07-01_building-chrome-ext.md" */
  filename: string;
  /** The suggested vault-relative path, e.g. "threads/claude/" */
  directory: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all',
  'can', 'had', 'her', 'was', 'one', 'our', 'out', 'has',
  'have', 'this', 'that', 'with', 'from', 'they', 'been',
  'would', 'could', 'should', 'what', 'when', 'where', 'which',
  'their', 'there', 'about', 'will', 'make', 'just', 'also',
  'some', 'than', 'them', 'very', 'after', 'before', 'into',
  'like', 'how', 'then', 'its', 'only', 'come', 'made',
  'want', 'use', 'using', 'used', 'need', 'please', 'help',
  'think', 'know', 'does', 'don', 'didn',
]);

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function yamlQuote(text: string): string {
  // Titles containing :, #, [, ], {, }, ", or leading * MUST be wrapped in double quotes
  // with internal " escaped as \".
  const needsQuotes = /[:#\[\]{}"]|^\*/.test(text);
  if (!needsQuotes) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

// ─── Core Renderer Functions ────────────────────────────────────────────────

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')  // strip non-alphanumeric
    .replace(/\s+/g, '-')           // spaces → hyphens
    .replace(/-+/g, '-')            // collapse multiple hyphens
    .replace(/^-|-$/g, '')          // trim leading/trailing hyphens
    .slice(0, 60);                  // cap length
}

export function generateFilename(meta: OkfConversationMeta): string {
  const date = meta.started_at.slice(0, 10); // "2026-07-01"
  const title = meta.title ?? 'untitled';
  let slug = slugify(title);
  if (!slug) slug = 'untitled';
  return `${date}_${slug}.md`;
}

export function extractTags(messages: OkfMessage[]): string[] {
  const wordCounts = new Map<string, number>();

  for (const msg of messages) {
    if (msg.role !== 'user') continue;

    // Split into words, removing punctuation
    const words = msg.content_text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/);

    for (const word of words) {
      if (word.length >= 3 && !STOP_WORDS.has(word)) {
        wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
      }
    }
  }

  // Sort by frequency
  const sorted = Array.from(wordCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(entry => entry[0]);

  return sorted;
}

export function renderFrontmatter(
  meta: OkfConversationMeta,
  messages: OkfMessage[],
  tags: string[],
  model?: string | null,
): string {
  const yaml = [
    '---',
    'type: thread',
    `title: ${yamlQuote(meta.title ?? 'Untitled conversation')}`,
    `platform: ${meta.platform}`,
  ];

  if (tags.length > 0) {
    yaml.push('tags:');
    // Ensure uniqueness, including platform tag which will be added manually in renderOkf
    const uniqueTags = Array.from(new Set([...tags, meta.platform]));
    uniqueTags.forEach(t => yaml.push(`  - ${t}`));
  } else {
    yaml.push('tags:');
    yaml.push(`  - ${meta.platform}`);
  }

  yaml.push(`created: "${meta.started_at}"`);
  yaml.push(`updated: "${meta.last_message_at}"`);

  if (meta.url) yaml.push(`source_url: "${meta.url}"`);
  yaml.push(`message_count: ${messages.length}`);
  if (model) yaml.push(`model: "${model}"`);

  yaml.push('---');
  return yaml.join('\n');
}

export function renderBody(messages: OkfMessage[]): string {
  if (messages.length === 0) {
    return '*No messages captured.*';
  }

  const parts: string[] = [];
  let lastRole: string | null = null;

  for (const msg of messages) {
    const role = capitalize(msg.role);
    if (msg.role !== lastRole) {
      parts.push(`## ${role}`);
      lastRole = msg.role;
    }

    // For tool messages, we wrap the content in a code block if it isn't already
    if (msg.role === 'tool' && !msg.content_text.startsWith('```')) {
      parts.push(`\`\`\`json\n${msg.content_text.trim()}\n\`\`\``);
    } else {
      parts.push(msg.content_text.trim());
    }

    parts.push(''); // blank line separator
  }

  // Remove the last blank line to avoid trailing whitespace
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }

  return parts.join('\n');
}

export function renderMemoriesFooter(memories: OkfRelatedMemory[]): string {
  if (!memories || memories.length === 0) return '';

  const parts = [
    '---',
    '',
    '## Related Memories',
    ''
  ];

  for (const mem of memories) {
    parts.push(`- ${mem.text} (*${mem.kind}*)`);
  }

  return parts.join('\n');
}

export function renderOkf(
  meta: OkfConversationMeta,
  messages: OkfMessage[],
  memories?: OkfRelatedMemory[],
  model?: string | null,
): OkfDocument {
  const extractedTags = extractTags(messages);
  const frontmatter = renderFrontmatter(meta, messages, extractedTags, model);
  const body = renderBody(messages);

  let markdown = `${frontmatter}\n\n${body}`;

  if (memories && memories.length > 0) {
    const footer = renderMemoriesFooter(memories);
    markdown += `\n\n${footer}`;
  }

  // Ensure the markdown ends with a single newline
  markdown = markdown.trim() + '\n';

  return {
    markdown,
    filename: generateFilename(meta),
    directory: `threads/${meta.platform}/`,
  };
}
