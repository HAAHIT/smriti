// Vendors the sidebar's webfonts into public/fonts/ so the built extension makes
// zero network requests at runtime.
//
// Why this exists: the sidebar used to inject a <link> to fonts.googleapis.com
// into every host page, which meant a request to Google on every claude.ai /
// chatgpt.com / gemini.google.com visit — from a product whose store listing and
// privacy policy both assert that nothing leaves the device.
//
// Unlike fetch-model.mjs, this does NOT pin per-file SHA256 hashes. Google serves
// fonts from opaque, version-stamped URLs (/s/inter/v20/UcC73Fwr….woff2) and
// revs them independently of anything we control, so a hash pin would fail the
// build on an upstream font revision rather than on a real problem. The model is
// a fixed artifact we deliberately pin; fonts are presentational and degrade
// gracefully — lib/sidebar-styles.ts declares a full system-font fallback chain,
// so a missing file costs typography, never legibility.
//
// Only the latin and latin-ext subsets are vendored. Google's css2 response
// splits each family across ~7 unicode-range subsets (cyrillic, greek,
// vietnamese, …); shipping all of them would be ~4x the bytes for glyphs this UI
// chrome never renders. Text in other scripts falls through to the system font.

import { mkdir, writeFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const FONT_DIR = join(extRoot, "public", "fonts");
const CSS_FILE = join(FONT_DIR, "fonts.css");

const FETCH_TIMEOUT_MS = 30_000;
const FETCH_RETRIES = 3;

// Keep the families in sync with the --serif / --sans / --mono vars, which are
// declared identically in lib/sidebar-styles.ts and entrypoints/options/index.html.
//
// Weights are requested as variable-axis *ranges* (400..700) rather than the
// discrete list each surface happens to use. All three families are variable
// fonts, so a range costs the same bytes as a single weight — one file per subset
// backs every weight — and it means one vendored set serves both the sidebar
// (which uses 400-600) and the options page (which also uses 700) without either
// surface silently falling back to a system font at a weight we forgot to ask for.
const CSS_URL =
  "https://fonts.googleapis.com/css2" +
  "?family=Inter:wght@400..700" +
  "&family=Source+Serif+4:opsz,wght@8..60,400..700" +
  "&family=JetBrains+Mono:wght@400..500" +
  "&display=swap";

// css2 content-negotiates on User-Agent: without a modern browser UA it serves
// ttf instead of woff2.
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36";

// The two subsets we keep, identified by a codepoint range unique to each.
const KEEP_SUBSETS = [
  "U+0000-00FF", // latin
  "U+0100-02BA", // latin-ext
];

async function fetchWithRetry(url, headers = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      if (attempt < FETCH_RETRIES) await new Promise((r) => setTimeout(r, 1000 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`failed to fetch ${url}: ${lastErr?.message ?? lastErr}`);
}

/** Split a css2 response into its individual @font-face blocks. */
function parseFontFaces(css) {
  const blocks = [];
  const re = /@font-face\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const body = m[1];
    const url = body.match(/url\((https:\/\/[^)]+\.woff2)\)/)?.[1];
    const unicodeRange = body.match(/unicode-range:\s*([^;]+);/)?.[1]?.trim();
    const family = body.match(/font-family:\s*'([^']+)'/)?.[1];
    if (!url || !unicodeRange || !family) continue;
    blocks.push({ body, url, unicodeRange, family });
  }
  return blocks;
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function main() {
  await mkdir(FONT_DIR, { recursive: true });

  console.log("[fonts] fetching stylesheet");
  const css = (await fetchWithRetry(CSS_URL, { "User-Agent": UA })).toString("utf8");

  const all = parseFontFaces(css);
  if (all.length === 0) throw new Error("parsed 0 @font-face blocks — did the css2 format change?");

  const kept = all.filter((b) => KEEP_SUBSETS.some((r) => b.unicodeRange.includes(r)));
  if (kept.length === 0) {
    throw new Error(`no latin/latin-ext subsets among ${all.length} @font-face blocks`);
  }

  // The families here are variable fonts, so one file backs every weight of a
  // given subset — dedupe by URL so we download each file once.
  const byUrl = new Map();
  for (const b of kept) {
    if (!byUrl.has(b.url)) byUrl.set(b.url, b);
  }

  const localName = new Map(); // remote url → local filename
  let downloaded = 0;
  for (const [url, block] of byUrl) {
    // Name by family + a hash of the upstream URL: stable across runs, and it
    // changes when Google revs the file so a stale copy can't linger.
    const name = `${slug(block.family)}-${createHash("sha256").update(url).digest("hex").slice(0, 8)}.woff2`;
    localName.set(url, name);
    const dest = join(FONT_DIR, name);
    if (await stat(dest).then((s) => s.size > 0).catch(() => false)) continue;
    const buf = await fetchWithRetry(url, { "User-Agent": UA });
    await writeFile(dest, buf);
    downloaded++;
    console.log(`[fonts] ${name} (${(buf.length / 1024).toFixed(1)} KB)`);
  }

  // Emit local CSS: Google's own @font-face blocks with url() rewritten to the
  // vendored file. Relative URLs resolve against the stylesheet, and both live
  // in public/fonts/, so a bare filename is correct.
  const out = [
    "/* Generated by scripts/fetch-fonts.mjs — do not edit, do not commit. */",
    "/* Vendored from Google Fonts (latin + latin-ext subsets) so the extension",
    "   makes no runtime network requests. Licensed under the SIL Open Font",
    "   License 1.1: Inter, Source Serif 4, JetBrains Mono. */",
    "",
  ];
  for (const b of kept) {
    const body = b.body.replace(
      /url\(https:\/\/[^)]+\.woff2\)/,
      `url(${localName.get(b.url)})`,
    );
    out.push(`@font-face {${body}}`);
  }
  await writeFile(CSS_FILE, out.join("\n") + "\n");

  // Drop any vendored file the current stylesheet no longer references, so an
  // upstream rev doesn't leave dead weight in the packaged extension.
  const wanted = new Set([...localName.values(), "fonts.css"]);
  for (const f of await readdir(FONT_DIR)) {
    if (!wanted.has(f)) {
      await rm(join(FONT_DIR, f));
      console.log(`[fonts] removed stale ${f}`);
    }
  }

  console.log(
    `[fonts] ready — ${byUrl.size} file(s), ${kept.length} @font-face rule(s)` +
    `${downloaded === 0 ? " (all cached)" : ""}`,
  );
}

main().catch((e) => {
  console.error("[fonts] FAILED:", e.message);
  process.exit(1);
});
