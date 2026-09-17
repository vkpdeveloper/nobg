// Prepare external CDN bundles, never assets in public/ or a Vercel build.
// bun scripts/prepare-model-assets.mjs [--model=ben2|isnet|u2netp] [--source=/path/model.onnx] [--out-dir=.model-assets]
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolve, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { MODELS, assetPath, MODEL_CHUNK_SIZE } from "../src/lib/model-config.ts";

const LICENSES = {
  ben2: {
    file: "BEN2-MIT.txt",
    header: (m) =>
      `BEN2 FP16, ${m.id}, revision ${m.revision}\n` +
      `https://huggingface.co/${m.id}\nhttps://github.com/PramaLLC/BEN2\n\n`,
  },
  isnet: {
    file: "ISNET-MIT.txt",
    header: (m) =>
      `ISNet INT8, ${m.id}, revision ${m.revision}\n` +
      `https://huggingface.co/${m.id}\nhttps://github.com/xuebinqin/DIS\n\n`,
  },
  u2netp: {
    file: "U2NETP-APACHE-2.0.txt",
    header: (m) =>
      `U-2-Netp FP32, ${m.id}, revision ${m.revision}\n` +
      `https://huggingface.co/${m.id}\nhttps://github.com/xuebinqin/U-2-Net\n\n`,
  },
};

const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const outputRoot = resolve(option("out-dir") ?? ".model-assets");
const only = option("model");
const source = option("source");
const cacheDir = resolve(".next/cache/nobg-models");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

const selected = Object.values(MODELS).filter((m) => !only || m.key === only);
if (only && selected.length === 0) throw new Error(`Unknown --model=${only}`);
if (source && selected.length !== 1) throw new Error("--source requires --model");

for (const spec of selected) {
  const output = join(outputRoot, assetPath(spec).slice(1));
  const cached = join(cacheDir, `${spec.sha256}.onnx`);
  let model;
  try { model = await readFile(source ?? cached); }
  catch (error) {
    if (source || error.code !== "ENOENT") throw error;
    await mkdir(cacheDir, { recursive: true });
    const temporary = `${cached}.download`;
    try {
      const url = `https://huggingface.co/${spec.id}/resolve/${spec.revision}/${spec.filename}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
      if (!response.ok || !response.body) throw new Error(`Model download failed: ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
      model = await readFile(temporary);
      if (model.length !== spec.size || hash(model) !== spec.sha256) throw new Error("Model checksum mismatch");
      await rename(temporary, cached);
    } finally { await rm(temporary, { force: true }); }
  }
  if (model.length !== spec.size || hash(model) !== spec.sha256) {
    throw new Error(`Source is not the pinned ${spec.id} file; no assets were generated`);
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
  if (reconstructed.digest("hex") !== spec.sha256) throw new Error("Reconstructed model checksum mismatch");
  const license = LICENSES[spec.key];
  await writeFile(join(output, "NOTICE.txt"),
    license.header(spec) +
    await readFile(new URL(`../docs/licenses/${license.file}`, import.meta.url), "utf8"));
  // Publish the manifest last so an interrupted preparation is never complete.
  await writeFile(join(output, "manifest.json"), JSON.stringify({ version: 1,
    sha256: spec.sha256, size: spec.size, chunkSize: MODEL_CHUNK_SIZE, parts,
  }, null, 2) + "\n");
  const compressedBytes = parts.reduce((total, part) => total + part.compressedSize, 0);
  console.log(JSON.stringify({ model: spec.key, output, parts: parts.length, originalBytes: model.length, compressedBytes,
    reductionPercent: +((1 - compressedBytes / model.length) * 100).toFixed(2), sha256: spec.sha256 }, null, 2));
}
