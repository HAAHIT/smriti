// Composer injection — the hero interaction.
//
// Writes recalled memory into the AI tool's message box so the user's next
// prompt carries the context. The hard part: every tool uses a different,
// React-controlled editor:
//   • Claude.ai   → ProseMirror contenteditable
//   • ChatGPT     → ProseMirror contenteditable (#prompt-textarea)
//   • Gemini      → Quill contenteditable (.ql-editor)
// and some older surfaces still use a plain <textarea>.
//
// Strategy: prefer document.execCommand("insertText") on a focused
// contenteditable — it routes through the editor's own beforeinput/input
// handling, so React/ProseMirror/Quill stay in sync. Fall back to the native
// value setter + InputEvent for <textarea>. We insert at the START so the
// context lands ahead of whatever the user has already typed.

export type InjectPlatform = "claude" | "chatgpt" | "gemini" | "unknown";

// Format recalled memories into a clean context block to prepend to a prompt.
// Kept dependency-free so content scripts can call it directly.
export function formatMemoryBlock(memories: Array<{ text: string }>): string {
  if (memories.length === 0) return "";
  if (memories.length === 1) {
    return `For context, here's something from my past chats: ${memories[0]!.text.replace(/\.?$/, ".")}`;
  }
  const lines = memories.map((m) => `- ${m.text.replace(/\.?$/, ".")}`);
  return `Context about me, from my past conversations:\n${lines.join("\n")}`;
}

interface Selectors {
  composer: string[];
}

const SELECTORS: Record<Exclude<InjectPlatform, "unknown">, Selectors> = {
  claude: {
    composer: [
      'div[contenteditable="true"].ProseMirror',
      'fieldset div[contenteditable="true"]',
      '[data-testid="chat-input"] div[contenteditable="true"]',
      'div[contenteditable="true"]',
    ],
  },
  chatgpt: {
    composer: [
      '#prompt-textarea',
      'div[contenteditable="true"]#prompt-textarea',
      'form div[contenteditable="true"]',
      'textarea[data-id]',
      'textarea',
    ],
  },
  gemini: {
    composer: [
      'rich-textarea .ql-editor[contenteditable="true"]',
      '.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea',
    ],
  },
};

export function detectInjectPlatform(): InjectPlatform {
  const h = location.hostname;
  if (h.endsWith("claude.ai")) return "claude";
  if (h.endsWith("chatgpt.com") || h.endsWith("chat.openai.com")) return "chatgpt";
  if (h.endsWith("gemini.google.com")) return "gemini";
  return "unknown";
}

function isVisible(el: Element): boolean {
  const r = (el as HTMLElement).getBoundingClientRect();
  if (r.width < 40 || r.height < 8) return false;
  const style = getComputedStyle(el as HTMLElement);
  return style.visibility !== "hidden" && style.display !== "none";
}

export function findComposer(): HTMLElement | null {
  const platform = detectInjectPlatform();
  const lists = platform === "unknown"
    ? Object.values(SELECTORS).flatMap((s) => s.composer)
    : SELECTORS[platform].composer;

  for (const sel of lists) {
    const matches = Array.from(document.querySelectorAll<HTMLElement>(sel)).filter(isVisible);
    if (matches.length > 0) {
      // Prefer the editor nearest the bottom of the viewport — that's the live
      // composer, not a hidden/template one.
      matches.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
      return matches[0]!;
    }
  }

  // Last resort: a focused editable element, or the largest visible one.
  const active = document.activeElement as HTMLElement | null;
  if (active && isEditable(active) && isVisible(active)) return active;
  const editables = Array.from(
    document.querySelectorAll<HTMLElement>('textarea, div[contenteditable="true"]'),
  ).filter(isVisible);
  editables.sort((a, b) => area(b) - area(a));
  return editables[0] ?? null;
}

function area(el: Element): number {
  const r = el.getBoundingClientRect();
  return r.width * r.height;
}

function isEditable(el: HTMLElement): boolean {
  return el.tagName === "TEXTAREA" || el.isContentEditable;
}

// Insert `text` at the start of the composer. Returns true on success.
export function injectText(text: string): boolean {
  const el = findComposer();
  if (!el) return false;
  el.scrollIntoView({ block: "center", behavior: "smooth" });

  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    return injectIntoTextarea(el as HTMLTextAreaElement, text);
  }
  if (el.isContentEditable) {
    return injectIntoContentEditable(el, text);
  }
  return false;
}

function injectIntoTextarea(el: HTMLTextAreaElement, text: string): boolean {
  el.focus();
  const existing = el.value;
  const next = existing ? text + "\n\n" + existing : text;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (setter) setter.call(el, next);
  else el.value = next;
  // Put the caret at the end of the injected block so the user can keep typing.
  const caret = text.length + (existing ? 2 : 0);
  try { el.setSelectionRange(caret, caret); } catch { /* noop */ }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function injectIntoContentEditable(el: HTMLElement, text: string): boolean {
  el.focus();

  // Move the caret to the very start of the editor so context goes first.
  try {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(true); // collapse to start
    sel?.removeAllRanges();
    sel?.addRange(range);
  } catch { /* fall through to execCommand at current caret */ }

  const block = text.endsWith("\n") ? text : text + "\n\n";

  // Preferred path: execCommand routes through the editor's input pipeline.
  let ok = false;
  try {
    ok = document.execCommand("insertText", false, block);
  } catch { ok = false; }

  if (!ok) {
    // Fallback: dispatch a beforeinput/input pair with the text, which modern
    // ProseMirror/Quill builds also honor.
    ok = dispatchInsertInput(el, block);
  }

  if (!ok) {
    // Hard fallback: prepend a text node and fire input. Least faithful but
    // guarantees the text lands somewhere visible.
    el.insertBefore(document.createTextNode(block), el.firstChild);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: block, inputType: "insertText" }));
    ok = true;
  }
  return ok;
}

function dispatchInsertInput(el: HTMLElement, text: string): boolean {
  try {
    const before = new InputEvent("beforeinput", {
      bubbles: true, cancelable: true, inputType: "insertText", data: text,
    });
    const accepted = el.dispatchEvent(before);
    if (!accepted) return false;
    el.dispatchEvent(new InputEvent("input", {
      bubbles: true, inputType: "insertText", data: text,
    }));
    return true;
  } catch {
    return false;
  }
}
