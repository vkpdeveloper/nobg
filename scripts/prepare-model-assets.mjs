// Prepare an external CDN bundle, never assets in public/ or a Vercel build.
// bun scripts/prepare-model-assets.mjs [--source=/path/model_fp16.onnx] [--out-dir=.model-assets]
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolve, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { DESKTOP_MODEL, DESKTOP_ASSET_PATH, MODEL_CHUNK_SIZE } from "../src/lib/model-config.ts";

const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const outputRoot = resolve(option("out-dir") ?? ".model-assets");
const output = join(outputRoot, DESKTOP_ASSET_PATH.slice(1));
const source = option("source");
const cacheDir = resolve(".next/cache/nobg-models");
const cached = join(cacheDir, `${DESKTOP_MODEL.sha256}.onnx`);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let model;
try { model = await readFile(source ?? cached); }
catch (error) {
  if (source || error.code !== "ENOENT") throw error;
  await mkdir(cacheDir, { recursive: true });
  const temporary = `${cached}.download`;
  try {
    const url = `https://huggingface.co/${DESKTOP_MODEL.id}/resolve/${DESKTOP_MODEL.revision}/${DESKTOP_MODEL.filename}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok || !response.body) throw new Error(`Model download failed: ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    model = await readFile(temporary);
    if (model.length !== DESKTOP_MODEL.size || hash(model) !== DESKTOP_MODEL.sha256) throw new Error("Model checksum mismatch");
    await rename(temporary, cached);
  } finally { await rm(temporary, { force: true }); }
}
if (model.length !== DESKTOP_MODEL.size || hash(model) !== DESKTOP_MODEL.sha256) {
  throw new Error("Source is not the pinned BEN2 FP16 model; no assets were generated");
}

await mkdir(output, { recursive: true });
const parts = [];
const reconstructed = createHash("sha256");
for (let start = 0, index = 0; start < model.length; start += MODEL_CHUNK_SIZE, index++) {
  const bytes = model.subarray(start, start + MODEL_CHUNK_SIZE);
  const compressed = gzipSync(bytes, { level: 6 });
  // Verify the artifacts that will actually be served, not just the source.
  reconstructed.update(gunzipSync(compressed));
  await writeFile(join(output, `part-${index}.gz`), compressed);
  parts.push({ size: bytes.length, compressedSize: compressed.length, sha256: hash(bytes) });
}
if (reconstructed.digest("hex") !== DESKTOP_MODEL.sha256) throw new Error("Reconstructed model checksum mismatch");
await writeFile(join(output, "NOTICE.txt"),
  `BEN2 FP16, ${DESKTOP_MODEL.id}, revision ${DESKTOP_MODEL.revision}\n` +
  `https://huggingface.co/${DESKTOP_MODEL.id}\nhttps://github.com/PramaLLC/BEN2\n\n` +
  await readFile(new URL("../docs/licenses/BEN2-MIT.txt", import.meta.url), "utf8"));
// Publish the manifest last so an interrupted preparation is never complete.
await writeFile(join(output, "manifest.json"), JSON.stringify({ version: 1,
  sha256: DESKTOP_MODEL.sha256, size: DESKTOP_MODEL.size, chunkSize: MODEL_CHUNK_SIZE, parts,
}, null, 2) + "\n");
const compressedBytes = parts.reduce((total, part) => total + part.compressedSize, 0);
console.log(JSON.stringify({ output, parts: parts.length, originalBytes: model.length, compressedBytes,
  reductionPercent: +((1 - compressedBytes / model.length) * 100).toFixed(2), sha256: DESKTOP_MODEL.sha256 }, null, 2));
