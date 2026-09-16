// bun scripts/benchmark-model-download.mjs [--remote] [--desktop] [--baseline=HEAD] [--transfer] [--assets-dir=.model-assets]
// Remote mode downloads the pinned model four times (twice with --transfer).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { DESKTOP_ASSET_PATH } from "../src/lib/model-config.ts";

const remote = process.argv.includes("--remote");
const desktop = process.argv.includes("--desktop");
const transfer = process.argv.includes("--transfer");
const assetsDir = process.argv.find((arg) => arg.startsWith("--assets-dir="))?.slice(13);
if (assetsDir && !desktop) throw new Error("Prepared assets currently cover the desktop FP16 model; pass --desktop");
const baseline = process.argv.find((arg) => arg.startsWith("--baseline="))?.slice(11) ?? "HEAD";
const size = desktop ? 219_121_675 : 44_229_662;
// LFS SHA-256 values published for the pinned files by the Hugging Face API.
const expectedHash = desktop
  ? "dfdc25f421f32a0d1268e0f2ff2153d340e8f1d52d3dd16f5dc33c1ce85cedf1"
  : "3b21a6706dc8d6e4ba9f5b31ebc6940f6c785b58862e27bb25daa9dd4424b87f";
const dir = await mkdtemp(join(tmpdir(), "nobg-download-benchmark-"));
let server;
let browser;
try {
  await writeFile(join(dir, "baseline.ts"), execFileSync("git", ["show", `${baseline}:src/lib/model-download.ts`]));
  // Newer baselines share model constants; older revisions are self-contained.
  if ((await readFile(join(dir, "baseline.ts"), "utf8")).includes('"./model-config"')) {
    await writeFile(join(dir, "model-config.ts"), execFileSync("git", ["show", `${baseline}:src/lib/model-config.ts`]));
  }
  execFileSync("bun", ["build", join(dir, "baseline.ts"), "--target=browser", `--outdir=${dir}`]);
  execFileSync("bun", ["build", "src/lib/model-download.ts", "--target=browser", `--outdir=${dir}`]);
  const modules = {
    "/baseline.js": await readFile(join(dir, "baseline.js")),
    "/current.js": await readFile(join(dir, "model-download.js")),
  };
  // A per-request limit reproduces a slow origin. This is NOT a simulation of
  // a bandwidth-limited last mile; more connections cannot bypass that limit.
  const block = Buffer.alloc(64 * 1024, 37);
  server = createServer((req, res) => {
    if (assetsDir && /^\/assets\/(manifest\.json|part-\d+\.gz)$/.test(req.url)) {
      readFile(join(assetsDir, DESKTOP_ASSET_PATH.slice(1), req.url.slice(8))).then((bytes) => {
        res.writeHead(200, { "Content-Length": bytes.length,
          "Content-Type": req.url.endsWith(".gz") ? "application/gzip" : "application/json" });
        res.end(bytes);
      }).catch(() => { res.writeHead(404); res.end(); });
    } else if (modules[req.url]) {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end(modules[req.url]);
    } else if (req.url === "/model") {
      const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
      const start = Number(match?.[1] ?? 0);
      const end = Number(match?.[2] ?? size - 1);
      res.writeHead(match ? 206 : 200, {
        "Content-Length": end - start + 1,
        ...(match ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
      });
      res.flushHeaders();
      let remaining = end - start + 1;
      const timer = setInterval(() => {
        const bytes = block.subarray(0, Math.min(block.length, remaining));
        res.write(bytes);
        remaining -= bytes.length;
        if (remaining === 0) { clearInterval(timer); res.end(); }
      }, 16);
      res.on("close", () => clearInterval(timer));
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><title>Download benchmark</title>");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = remote ? desktop
    ? "https://huggingface.co/onnx-community/BEN2-ONNX/resolve/c552aa82688edce09f0ac9d2e31ad53d9d629010/onnx/model_fp16.onnx"
    : "https://huggingface.co/xrds/isnet-general-onnx-int8/resolve/71eff2372ec9c8edbc6ca637ded591423d23b65a/onnx/model_quantized.onnx"
    : `${origin}/model`;
  browser = await chromium.launch();
  let checksum;
  const variants = assetsDir ? [["compressed", 4]] : transfer ? [["direct", 1], ["current", 4]]
    : [["baseline", 4], ["current", 4], ["current", 6], ["current", 8]];
  for (const [module, concurrency] of variants) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(origin);
      const result = await page.evaluate(async ({ module, concurrency, url, size, expectedHash }) => {
        const { downloadModelFile } = await import(`/${["direct", "compressed"].includes(module) ? "current" : module}.js`);
        let requests = 0;
        let transferDone = 0;
        let firstHeaders = 0;
        const start = performance.now();
        const networkFetch = async (...args) => {
          requests++;
          const response = await fetch(...args);
          firstHeaders ||= performance.now() - start;
          return response;
        };
        const cacheKey = `${location.origin}/saved`;
        let response;
        if (module === "direct") {
          const cache = await caches.open("direct-benchmark");
          const remote = await networkFetch(url, { cache: "no-store" });
          if (remote.status !== 200) throw new Error(`Unexpected full response: ${remote.status}`);
          const body = remote.body.pipeThrough(new TransformStream({
            transform(chunk, controller) { controller.enqueue(chunk); },
            flush() { transferDone = performance.now() - start; },
          }));
          await cache.put(cacheKey, new Response(body, { headers: remote.headers }));
          response = await cache.match(cacheKey);
        } else response = await downloadModelFile({ url, size, cacheKey,
          ...(module === "compressed" ? { compressed: { baseUrl: `${location.origin}/assets`, sha256: expectedHash } } : {}),
        }, {
          concurrency,
          onProgress({ phase }) { if (phase === "saving") transferDone = performance.now() - start; },
          fetch: networkFetch,
        });
        const seconds = (performance.now() - start) / 1000;
        const bytes = await response.arrayBuffer();
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          (byte) => byte.toString(16).padStart(2, "0")).join("");
        return { seconds: +seconds.toFixed(3), firstHeadersSeconds: +(firstHeaders / 1000).toFixed(3),
          finalSaveSeconds: +(seconds - transferDone / 1000).toFixed(3),
          MBps: +(size / seconds / 1e6).toFixed(2), requests, bytes: bytes.byteLength, hash };
      }, { module, concurrency, url, size, expectedHash });
      assert.equal(result.bytes, size);
      checksum ??= result.hash;
      assert.equal(result.hash, checksum, "all configurations must return identical bytes");
      if (remote || assetsDir) assert.equal(result.hash, expectedHash, "download must match the publisher's original model");
      if (assetsDir) assert.equal(result.requests, 28, "only the manifest and 27 compressed assets should be requested");
      console.log(JSON.stringify({ source: assetsDir ? "local-compressed-assets" : remote ? "huggingface" : "local-per-request-limit", module, concurrency, ...result }));
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
