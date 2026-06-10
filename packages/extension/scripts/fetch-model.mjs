// Vendors the embedding model + ONNX wasm into public/ so the built extension
// makes zero network requests at runtime. Idempotent — skips existing files.
import { mkdir, writeFile, copyFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const HF = "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main";
const MODEL_DIR = join(extRoot, "public", "models", "Xenova", "all-MiniLM-L6-v2");
const ORT_DIR = join(extRoot, "public", "ort");
const FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"];

for (const f of FILES) {
  const dest = join(MODEL_DIR, f);
  await mkdir(dirname(dest), { recursive: true });
  try { if ((await stat(dest)).size > 0) { console.log("skip", f); continue; } } catch {}
  console.log("fetch", `${HF}/${f}`);
  const res = await fetch(`${HF}/${f}`);
  if (!res.ok) throw new Error(`${HF}/${f}: HTTP ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
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
