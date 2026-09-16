// Run with: bun scripts/model-download.test.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const dir = await mkdtemp(join(tmpdir(), "nobg-download-test-"));
execFileSync("bun", ["build", "src/lib/model-download.ts", "--target=browser", `--outdir=${dir}`]);
const moduleSource = await readFile(join(dir, "model-download.js"));
const fixture = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const requests = [];
let active = 0;
let peak = 0;
let failureStart = -1;
const server = createServer((req, res) => {
  if (req.url === "/module.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    res.end(moduleSource);
    return;
  }
  if (req.url === "/worker.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    res.end(`import { downloadModelFile } from '/module.js';
      self.onmessage = async ({data}) => {
        try {
          const response = await downloadModelFile(data, { chunkSize: 32, onProgress() {} });
          self.postMessage(Array.from(new Uint8Array(await response.arrayBuffer())));
        } catch (error) { self.postMessage({error: error.message}); }
      };`);
    return;
  }
  if (!req.url.startsWith("/model/")) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><title>Model download tests</title>");
    return;
  }
  const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
  const start = match ? Number(match[1]) : 0;
  const end = match ? Number(match[2]) : fixture.length - 1;
  requests.push({ path: req.url, start, end });
  peak = Math.max(peak, ++active);
  setTimeout(() => {
    active--;
    if (start === failureStart) {
      res.writeHead(503);
      res.end();
    } else if (req.url.includes("full")) {
      res.writeHead(200, { "Content-Length": fixture.length });
      res.end(fixture);
    } else {
      const bytes = fixture.subarray(start, end + 1);
      res.writeHead(206, {
        "Content-Range": `bytes ${req.url.includes("bad-range") ? 1 : start}-${end}/${fixture.length}`,
        "Content-Length": bytes.length,
      });
      res.end(bytes);
    }
  }, 30);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(origin);
const file = (name) => ({ url: `${origin}/model/${name}`, cacheKey: `${origin}/saved/${name}`, size: fixture.length });
const download = (target, descriptor) => target.evaluate(async (descriptor) => {
  const { downloadModelFile } = await import("/module.js");
  const response = await downloadModelFile(descriptor, { chunkSize: 32, onProgress() {} });
  return Array.from(new Uint8Array(await response.arrayBuffer()));
}, descriptor);
let passed = 0;
const pass = (name) => console.log(`PASS ${++passed}: ${name}`);

try {
  const otherTab = await context.newPage();
  await otherTab.goto(origin);
  const shared = file("shared");
  const results = await Promise.all([
    download(page, shared), download(otherTab, shared),
    page.evaluate((descriptor) => new Promise((resolve) => {
      const worker = new Worker("/worker.js", { type: "module" });
      worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
      worker.postMessage(descriptor);
    }), shared),
  ]);
  for (const result of results) assert.deepEqual(result, [...fixture]);
  assert.equal(requests.length, 8, "every range downloaded exactly once across tabs and a worker");
  assert.ok(peak >= 2 && peak <= 4, `expected parallelism up to four, got ${peak}`);
  pass("tabs and workers share one correct download with bounded parallelism");

  await page.reload();
  await page.evaluate(() => { window.fetch = () => Promise.reject(new Error("No network allowed")); });
  assert.deepEqual(await download(page, shared), [...fixture]);
  assert.equal(requests.length, 8);
  pass("reload reuses the saved model with all fetch calls blocked");
  await page.reload();

  const legacy = file("legacy");
  await page.evaluate(async ({ descriptor, bytes }) => {
    const cache = await caches.open("transformers-cache");
    await cache.put(descriptor.cacheKey, new Response(new Uint8Array(bytes)));
  }, { descriptor: legacy, bytes: [...fixture] });
  assert.deepEqual(await download(page, legacy), [...fixture]);
  assert.equal(requests.length, 8);
  pass("existing Transformers.js cache is reused without migration downloads");

  failureStart = 64;
  const interrupted = file("interrupted");
  await assert.rejects(download(page, interrupted), /invalid part/);
  const savedParts = await page.evaluate(async () => {
    const cache = await caches.open("nobg-model-parts-v1");
    return (await cache.keys()).filter((request) => request.url.includes("interrupted")).map((request) => Number(new URL(request.url).searchParams.get("nobg-part")));
  });
  assert.ok(savedParts.length > 0);
  const beforeResume = requests.length;
  failureStart = -1;
  await page.reload();
  assert.deepEqual(await download(page, interrupted), [...fixture]);
  for (const request of requests.slice(beforeResume)) assert.ok(!savedParts.includes(request.start / 32));
  pass("interrupted downloads resume without fetching completed parts again");

  const beforeFull = requests.length;
  assert.deepEqual(await download(page, file("full")), [...fixture]);
  assert.equal(requests.length, beforeFull + 1);
  pass("a server ignoring Range sends the full model only once");

  const invalid = file("bad-range");
  await assert.rejects(download(page, invalid), /invalid part/);
  assert.equal(await page.evaluate(async (key) => !!(await (await caches.open("transformers-cache")).match(key)), invalid.cacheKey), false);
  pass("invalid ranges cannot become a saved model");

  const beforeStorageFailure = requests.length;
  const storageError = await page.evaluate(async (descriptor) => {
    const { downloadModelFile } = await import("/module.js");
    const original = Cache.prototype.put;
    Cache.prototype.put = async () => { throw new DOMException("Full", "QuotaExceededError"); };
    try {
      await downloadModelFile(descriptor, { chunkSize: 32, onProgress() {} });
    } catch (error) { return error.message; }
    finally { Cache.prototype.put = original; }
  }, file("no-storage"));
  assert.match(storageError, /Not enough browser storage/);
  assert.equal(requests.length, beforeStorageFailure);
  pass("storage failures are surfaced before downloading");

  const saveFailure = file("save-failure");
  const finalError = await page.evaluate(async (descriptor) => {
    const { downloadModelFile } = await import("/module.js");
    const original = Cache.prototype.put;
    Cache.prototype.put = function (request, response) {
      if (request === descriptor.cacheKey) return Promise.reject(new DOMException("Full", "QuotaExceededError"));
      return original.call(this, request, response);
    };
    try { await downloadModelFile(descriptor, { chunkSize: 32, onProgress() {} }); }
    catch (error) { return error.message; }
    finally { Cache.prototype.put = original; }
  }, saveFailure);
  assert.match(finalError, /Not enough browser storage/);
  const beforeSaveRetry = requests.length;
  assert.deepEqual(await download(page, saveFailure), [...fixture]);
  assert.equal(requests.length, beforeSaveRetry);
  pass("a failed final save keeps every part; retry requires no network");
  console.log(`${passed} browser download tests passed`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
