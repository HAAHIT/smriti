// Generate Smriti's toolbar/store icons.
//
// Library-aesthetic mark: an oxblood rounded square with three cream
// horizontal stripes (book spine / chapters). Renders cleanly at 16px and
// scales up to 128px. We avoid typography because it doesn't survive 16px.
//
// Run: node scripts/generate-icons.mjs
// Output: public/icons/icon-{16,32,48,128}.png

import { PNG } from "pngjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "..", "public", "icons");
mkdirSync(OUT_DIR, { recursive: true });

// Palette (matches the in-product theme).
const OXBLOOD  = [0x8b, 0x3a, 0x2f, 0xff];
const CREAM    = [0xf6, 0xf0, 0xe3, 0xff];
const SHADOW   = [0x6b, 0x2a, 0x20, 0xff]; // subtle inner shadow for depth
const TRANSPARENT = [0, 0, 0, 0];

const SIZES = [16, 32, 48, 128];

for (const size of SIZES) {
  const png = new PNG({ width: size, height: size });
  drawIcon(png, size);
  const buf = PNG.sync.write(png);
  const out = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(out, buf);
  console.log(`wrote ${out} (${buf.length} bytes)`);
}

function drawIcon(png, size) {
  const radius = Math.max(2, Math.round(size * 0.18));      // rounded corners
  const stripeY = [0.32, 0.50, 0.68];                       // chapter lines
  const stripeH = Math.max(1, Math.round(size * 0.06));     // stripe thickness
  const stripeInset = Math.round(size * 0.22);              // horiz padding for stripes

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      // Outside the rounded square → transparent.
      if (!insideRoundedSquare(x, y, size, radius)) {
        writePixel(png, idx, TRANSPARENT);
        continue;
      }
      // Base oxblood.
      let px = OXBLOOD;

      // Top-left bevel hint: 1-pixel cream highlight along the inner upper-left edge
      // to give the flat shape a touch of depth at larger sizes.
      if (size >= 48 && nearTopLeftEdge(x, y, size, radius)) {
        px = blend(OXBLOOD, CREAM, 0.18);
      }

      // Stripes (book chapters).
      for (const fy of stripeY) {
        const cy = Math.round(size * fy);
        if (y >= cy && y < cy + stripeH && x >= stripeInset && x < size - stripeInset) {
          px = CREAM;
        }
      }
      // A small accent on the bottom stripe so the icon has visual rhythm.
      if (size >= 32) {
        const cy = Math.round(size * stripeY[stripeY.length - 1]);
        const accentEnd = stripeInset + Math.round(size * 0.18);
        if (y >= cy && y < cy + stripeH && x >= stripeInset && x < accentEnd) {
          px = blend(CREAM, OXBLOOD, 0.15);
        }
      }

      // Subtle inner shadow along the very bottom edge.
      if (size >= 48 && y === size - radius - 1) {
        px = blend(px, SHADOW, 0.25);
      }

      writePixel(png, idx, px);
    }
  }
}

function insideRoundedSquare(x, y, size, r) {
  // Treat the corner quadrants as quarter-circles.
  if (x < r && y < r) return (r - x) ** 2 + (r - y) ** 2 < r * r;
  if (x >= size - r && y < r) return (x - (size - r - 1)) ** 2 + (r - y) ** 2 < r * r;
  if (x < r && y >= size - r) return (r - x) ** 2 + (y - (size - r - 1)) ** 2 < r * r;
  if (x >= size - r && y >= size - r) return (x - (size - r - 1)) ** 2 + (y - (size - r - 1)) ** 2 < r * r;
  return true;
}

function nearTopLeftEdge(x, y, size, r) {
  const edgeBand = Math.max(1, Math.round(size * 0.04));
  if (y < r) {
    // top-left quarter
    const dx = r - x;
    const dy = r - y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    return dist > r - edgeBand && dist < r;
  }
  if (x < r) {
    // left-bottom area: 1-pixel band along left edge
    return x < edgeBand;
  }
  return y < edgeBand;
}

function writePixel(png, idx, [r, g, b, a]) {
  png.data[idx]     = r;
  png.data[idx + 1] = g;
  png.data[idx + 2] = b;
  png.data[idx + 3] = a;
}

function blend(c1, c2, t) {
  return [
    Math.round(c1[0] * (1 - t) + c2[0] * t),
    Math.round(c1[1] * (1 - t) + c2[1] * t),
    Math.round(c1[2] * (1 - t) + c2[2] * t),
    Math.round(c1[3] * (1 - t) + c2[3] * t),
  ];
}
