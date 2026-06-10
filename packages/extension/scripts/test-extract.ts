// Headless sanity check for memory extraction quality.
// Run: npx tsx scripts/test-extract.ts
//
// Extraction quality makes or breaks the "your AI remembers you" demo, so we
// exercise the pure extractor against realistic user messages and eyeball the
// memories it produces — plus a few hard assertions for must-have / must-skip.

import { extractCandidates } from "../lib/extract.js";

// Realistic user messages (the kind people actually type into Claude/ChatGPT).
const SAMPLES: string[] = [
  "I'm a senior backend engineer at a fintech startup. I work mostly in Rust and Go.",
  "Can you write me a function that parses ISO timestamps?",
  "I'm building a CLI tool called Virohan that indexes local git repos. We're using SQLite for storage.",
  "We decided to go with SP-GiST indexes for the geo lookups instead of GiST because the data is non-overlapping.",
  "I prefer TypeScript over JavaScript, and I always use 2-space indentation. Never add semicolons.",
  "My name is Priya and I live in Bangalore. I have 8 years of experience in distributed systems.",
  "how do I center a div?",
  "Our stack is Next.js on the frontend, FastAPI on the backend, and Postgres. The project is called Lumen.",
  "I hate verbose explanations — just give me the code. Always use async/await over promises.",
  "Let's use Tailwind for this. I'm working on the onboarding flow right now.",
  "explain how transformers work",
  "I need the report done by Friday. We're going with the blue color scheme for the brand.",
  "thanks, that worked!",
  "function add(a,b){ return a+b; } // can you optimize this",
];

// Must-have: at least one memory whose text contains the substring.
const MUST_HAVE = ["Rust", "Virohan", "SP-GiST", "TypeScript", "Priya", "Tailwind", "blue color scheme"];
// Must-not-capture: these substrings should never appear in any extracted
// memory — ephemeral/time-anchored noise (see EPHEMERAL_RE in extract.ts).
const MUST_NOT_CAPTURE = ["Friday"];
// Must-skip: these messages should yield ZERO memories.
const MUST_SKIP = [
  "Can you write me a function that parses ISO timestamps?",
  "how do I center a div?",
  "explain how transformers work",
  "thanks, that worked!",
];

let totalMemories = 0;
const allTexts: string[] = [];

console.log("\n=== Extraction results ===\n");
for (const s of SAMPLES) {
  const cands = extractCandidates(s);
  totalMemories += cands.length;
  for (const c of cands) allTexts.push(c.text);
  console.log(`MSG: ${s}`);
  if (cands.length === 0) {
    console.log("   (no memories)\n");
  } else {
    for (const c of cands) {
      console.log(`   • [${c.kind}] (${c.salience}) ${c.text}`);
    }
    console.log("");
  }
}

console.log("=== Assertions ===\n");
let pass = 0;
let fail = 0;

for (const needle of MUST_HAVE) {
  const ok = allTexts.some((t) => t.includes(needle));
  console.log(`${ok ? "✓" : "✗"} must capture "${needle}"`);
  ok ? pass++ : fail++;
}
for (const needle of MUST_NOT_CAPTURE) {
  const ok = !allTexts.some((t) => t.includes(needle));
  console.log(`${ok ? "✓" : "✗"} must NOT capture "${needle}"`);
  ok ? pass++ : fail++;
}
for (const msg of MUST_SKIP) {
  const ok = extractCandidates(msg).length === 0;
  console.log(`${ok ? "✓" : "✗"} must skip "${msg.slice(0, 40)}…"`);
  ok ? pass++ : fail++;
}

console.log(`\nTotal memories extracted: ${totalMemories} from ${SAMPLES.length} messages`);
console.log(`Assertions: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
