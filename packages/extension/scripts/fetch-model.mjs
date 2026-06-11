// Vendors the embedding model + ONNX wasm into public/ so the built extension
// makes zero network requests at runtime. Idempotent — skips files whose
// SHA256 already matches the pinned hash below.
import { mkdir, writeFile, rename, readFile, copyFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const HF = "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main";
const MODEL_DIR = join(extRoot, "public", "models", "Xenova", "all-MiniLM-L6-v2");
const ORT_DIR = join(extRoot, "public", "ort");
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_RETRIES = 3;

// Pinned SHA256 of each vendored model file. A mismatch — corrupted/partial
// download, or upstream `main` changing the file's content — fails the build
// loudly instead of silently shipping a different model.
const FILES = {
  "config.json": "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7",
  "tokenizer.json": "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
  "tokenizer_config.json": "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
  "onnx/model_quantized.onnx": "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
};

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function fetchWithRetry(url) {
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      if (attempt < FETCH_RETRIES) await new Promise((r) => setTimeout(r, 1000 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${url}: ${lastErr}`);
}

for (const [f, expectedHash] of Object.entries(FILES)) {
  const dest = join(MODEL_DIR, f);
  await mkdir(dirname(dest), { recursive: true });
  try {
    if (sha256(await readFile(dest)) === expectedHash) { console.log("skip", f); continue; }
    console.warn(`${f}: hash mismatch, re-fetching`);
  } catch {}

  console.log("fetch", `${HF}/${f}`);
  const data = await fetchWithRetry(`${HF}/${f}`);
  const actualHash = sha256(data);
  if (actualHash !== expectedHash) {
    throw new Error(`${f}: SHA256 mismatch — expected ${expectedHash}, got ${actualHash}`);
  }
  // Write to a temp path and rename so a crash mid-download never leaves a
  // corrupt file at `dest` that a future run's hash check would reject anyway,
  // but this avoids the half-written window entirely.
  const tmp = `${dest}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, dest);
}

// The ONNX runtime .wasm files ship inside @xenova/transformers (hoisted to
// the workspace root — resolve, don't hardcode the path).
const require = createRequire(import.meta.url);
const ortSrc = join(dirname(require.resolve("@xenova/transformers/package.json")), "dist");
await mkdir(ORT_DIR, { recursive: true });
for (const f of await readdir(ortSrc)) {
  if (f.endsWith(".wasm")) { await copyFile(join(ortSrc, f), join(ORT_DIR, f)); console.log("copied", f); }
}
console.log("model vendored ✓");
