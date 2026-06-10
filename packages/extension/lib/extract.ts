// Memory extraction — pure functions, no DB or model dependencies.
//
// Split out from memory.ts so it can be unit-tested headlessly: extraction
// quality is the make-or-break for the "your AI remembers you" experience, so
// it needs to be exercised against realistic messages without booting SQLite.

import type { MemoryKind } from "@smriti/shared";

export const MAX_MEMORY_LEN = 320;
export const MIN_MEMORY_LEN = 12;
export const NEAR_DUP_JACCARD = 0.82;

export interface Candidate {
  kind: MemoryKind;
  text: string;
  salience: number;
}

interface Rule {
  kind: MemoryKind;
  salience: number;
  re: RegExp;
}

// Requests aimed at the AI ("write me a function", "explain X") are not durable
// facts about the user — skip them.
const REQUEST_RE =
  /^\s*(please\s+)?(write|generate|create|make|build|explain|show|give|tell|help|fix|debug|implement|refactor|translate|summari[sz]e|list|draw|design|code|can you|could you|would you|how (do|can|should) i|what('?s| is)|why (do|does|is)|when (do|does|is)|where (do|does|is)|who (is|are))\b/i;

const RULES: Rule[] = [
  // identity — who the user is
  { kind: "identity", salience: 0.92, re: /\bi['’]?m\s+(a|an|the)\s+[a-z]/i },
  { kind: "identity", salience: 0.92, re: /\bmy\s+name\s+is\b/i },
  { kind: "identity", salience: 0.88, re: /\bi\s+work\s+(\w+\s+)?(at|as|in|for|with)\b/i },
  { kind: "identity", salience: 0.85, re: /\bi['’]?m\s+based\s+in\b|\bi\s+live\s+in\b/i },
  { kind: "identity", salience: 0.82, re: /\bi\s+have\s+\d+\+?\s+years?\b/i },

  // decision — choices locked in
  { kind: "decision", salience: 0.88, re: /\b(i|we)\s+(decided|chose|settled on|went with|picked|will use|are using|am going with|have chosen)\b/i },
  { kind: "decision", salience: 0.82, re: /\b(we|i)['’]?re\s+going\s+with\b/i },
  { kind: "decision", salience: 0.80, re: /\blet['’]?s\s+(go with|use|stick with)\b/i },

  // project — what they're working on
  { kind: "project", salience: 0.85, re: /\bi['’]?m\s+(building|making|working on|developing|creating)\b/i },
  { kind: "project", salience: 0.85, re: /\bwe['’]?re\s+(building|making|working on|developing)\b/i },
  { kind: "project", salience: 0.82, re: /\bmy\s+(project|app|startup|company|product|side\s*project|codebase|repo)\b/i },
  { kind: "project", salience: 0.80, re: /\b(the\s+(app|project|product|tool|repo)\s+is\s+called)\b/i },
  { kind: "project", salience: 0.78, re: /\bour\s+(stack|tech\s*stack|backend|frontend|database|infra|architecture)\b/i },

  // preference — how they like things (incl. style directives to the AI)
  { kind: "preference", salience: 0.80, re: /\bi\s+(prefer|like|love|hate|dislike|avoid|always|usually|never|tend to)\b/i },
  { kind: "preference", salience: 0.80, re: /\b(always|never|don['’]?t)\s+(use|write|include|add|put|format)\b/i },
  { kind: "preference", salience: 0.75, re: /\b(use|prefer)\s+[\w.+-]+\s+(over|instead of|rather than)\b/i },
  { kind: "preference", salience: 0.72, re: /\bmy\s+(coding\s+)?(style|convention|preference)\b/i },

  // fact — broader durable statements (lower salience, stricter length later)
  { kind: "fact", salience: 0.58, re: /\b(i|we)\s+(need|want|use|run|own|manage|maintain|have)\b/i },
];

// Pull candidate memories out of a single message's text.
export function extractCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const raw of splitClauses(text)) {
    const clause = raw.trim();
    if (clause.length < MIN_MEMORY_LEN || clause.length > MAX_MEMORY_LEN) continue;
    if (REQUEST_RE.test(clause)) continue;
    if (looksLikeCode(clause)) continue;
    if (!/[a-z]/i.test(clause)) continue;
    // Must contain a first-person/possessive anchor OR a style directive.
    // "let's"/"lets" counts — it implies "we" (a shared decision).
    const firstPerson = /\b(i|i['’]?m|i['’]?ve|i['’]?ll|i['’]?d|my|mine|we|we['’]?re|our|us|me|let['’]?s|lets)\b/i.test(clause);
    const directive = /\b(always|never|don['’]?t)\s+(use|write|include|add|put|format)\b/i.test(clause);
    if (!firstPerson && !directive) continue;

    for (const rule of RULES) {
      if (!rule.re.test(clause)) continue;
      const cleaned = cleanMemoryText(clause);
      const norm = normalize(cleaned);
      if (norm.length < MIN_MEMORY_LEN || seen.has(norm)) break;
      // "fact" rule is broad — require a bit more length to avoid noise.
      if (rule.kind === "fact" && cleaned.length < 24) break;
      seen.add(norm);
      out.push({ kind: rule.kind, text: cleaned, salience: rule.salience });
      break; // first rule wins for this clause
    }
  }
  // Keep the strongest few per message so one long message can't flood memory.
  return out.sort((a, b) => b.salience - a.salience).slice(0, 4);
}

export function splitClauses(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, " ") // drop fenced code
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z“"'(])|\s*[;•]\s*|\s+-\s+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function looksLikeCode(s: string): boolean {
  if (/[{}<>]=?|=>|\b(function|const|let|var|import|export|class)\b\s/.test(s)) {
    const symbols = (s.match(/[{}();=<>[\]]/g) ?? []).length;
    if (symbols >= 3) return true;
  }
  return s.startsWith("```") || s.startsWith("    ");
}

export function cleanMemoryText(s: string): string {
  let t = s.replace(/\s+/g, " ").trim();
  t = t.replace(/^(so|well|okay|ok|btw|also|basically|honestly|actually|fyi|note that|just)\b[\s,:-]+/i, "");
  t = t.replace(/[\s,]+(and|but|so|because|which|that)$/i, "");
  if (t) t = t[0]!.toUpperCase() + t.slice(1);
  t = t.replace(/[\s,;:]+$/, "");
  if (t.length > MAX_MEMORY_LEN) t = t.slice(0, MAX_MEMORY_LEN - 1).trim() + "…";
  return t;
}

export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

export function tokenSet(norm: string): Set<string> {
  return new Set(norm.split(" ").filter((w) => w.length > 2));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
