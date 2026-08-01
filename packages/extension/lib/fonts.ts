// Vendored webfonts — @font-face rules over files shipped inside the extension.
//
// These used to be a <link> to fonts.googleapis.com injected into every host
// page. That made an outbound request to Google on every claude.ai /
// chatgpt.com / gemini.google.com visit, which contradicts the product's core
// claim that nothing leaves the device. The font files now live in
// public/fonts/ (see its README for provenance and licensing) and are
// referenced by extension URL, so there is no network egress at all.
//
// Two callers, two URL schemes — hence the `resolve` parameter:
//   - the sidebar content script injects this into the *host page's* head and
//     must use absolute chrome-extension:// URLs from browser.runtime.getURL
//   - the options page is itself an extension page and can use root-relative
//     paths
//
// Note the rules must go in the host document's head, NOT the sidebar's shadow
// root: Chrome does not apply @font-face declared inside a shadow tree.
//
// All three families are variable fonts, so one file per subset covers every
// weight the UI uses. If a file fails to load for any reason, the var(--sans) /
// var(--serif) / var(--mono) fallback chains in lib/sidebar-styles.ts take over
// and the UI degrades to system fonts rather than to unstyled text.

/** Unicode ranges as published by Google Fonts; identical across our families. */
const LATIN =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, " +
  "U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, " +
  "U+2212, U+2215, U+FEFF, U+FFFD";

const LATIN_EXT =
  "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, " +
  "U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, " +
  "U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF";

/**
 * The vendored filenames, as a literal union rather than `string`. This is what
 * lets the sidebar's `` `/fonts/${file}` `` expression typecheck against WXT's
 * generated `PublicPath` union with no cast — so renaming or dropping a file
 * here is a compile error at the call site instead of a 404 at runtime.
 */
export type FontFile =
  | "inter-latin.woff2"
  | "inter-latin-ext.woff2"
  | "source-serif-4-latin.woff2"
  | "source-serif-4-latin-ext.woff2"
  | "jetbrains-mono-latin.woff2"
  | "jetbrains-mono-latin-ext.woff2";

interface VendoredFace {
  family: string;
  /** Filename under public/fonts/. */
  file: FontFile;
  /** Variable-font weight range, e.g. "400 700". */
  weight: string;
  unicodeRange: string;
}

const FACES: VendoredFace[] = [
  { family: "Inter",           file: "inter-latin.woff2",                weight: "400 700", unicodeRange: LATIN },
  { family: "Inter",           file: "inter-latin-ext.woff2",            weight: "400 700", unicodeRange: LATIN_EXT },
  { family: "Source Serif 4",  file: "source-serif-4-latin.woff2",       weight: "400 700", unicodeRange: LATIN },
  { family: "Source Serif 4",  file: "source-serif-4-latin-ext.woff2",   weight: "400 700", unicodeRange: LATIN_EXT },
  { family: "JetBrains Mono",  file: "jetbrains-mono-latin.woff2",       weight: "400 500", unicodeRange: LATIN },
  { family: "JetBrains Mono",  file: "jetbrains-mono-latin-ext.woff2",   weight: "400 500", unicodeRange: LATIN_EXT },
];

/**
 * Build the @font-face block.
 *
 * @param resolve maps a filename under public/fonts/ to a loadable URL.
 */
export function fontFaceCss(resolve: (file: FontFile) => string): string {
  return FACES.map(f => `@font-face {
  font-family: '${f.family}';
  font-style: normal;
  font-weight: ${f.weight};
  font-display: swap;
  src: url('${resolve(f.file)}') format('woff2');
  unicode-range: ${f.unicodeRange};
}`).join("\n");
}

/** DOM id used for the injected <style>, so injection stays idempotent. */
export const FONT_STYLE_ID = "smriti-fonts";

/**
 * Inject the @font-face rules into a document's head exactly once.
 * Safe to call repeatedly.
 */
export function injectFontFaces(doc: Document, resolve: (file: FontFile) => string): void {
  if (doc.getElementById(FONT_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = FONT_STYLE_ID;
  style.textContent = fontFaceCss(resolve);
  doc.head.appendChild(style);
}
