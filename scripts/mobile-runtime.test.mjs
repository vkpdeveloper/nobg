// Run with: bun scripts/mobile-runtime.test.mjs
import assert from "node:assert/strict";
import { mock } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

// The pool tests simulate workers/window, not the browser analytics SDK.
mock.module("../src/lib/analytics.ts", () => ({ track() {} }));

const created = [];
class FakeWorker {
  messages = [];
  terminated = false;
  constructor() { created.push(this); }
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  emit(data) { this.onmessage({ data }); }
}
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
};
const listeners = {};
globalThis.Worker = FakeWorker;
globalThis.window = {
  isSecureContext: true,
  addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
};
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
  userAgent: "Android Mobile", hardwareConcurrency: 8, deviceMemory: 8,
} });
const { removerPool } = await import("../src/lib/remover-pool.ts");
const events = [];
removerPool.onJob((event) => events.push(event));
const file = new Blob(["test"]);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

removerPool.enqueue("load-failure", file);
await settle();
created[0].emit({ type: "error", message: "Download failed" });
assert.equal(removerPool.getStatus().state, "error");
assert.ok(created[0].terminated);
assert.deepEqual(events.pop(), { id: "load-failure", state: "error", message: "Download failed" });

removerPool.enqueue("active", file);
removerPool.enqueue("queued", file);
await settle();
assert.equal(created.length, 2, "retry starts a fresh worker");
created[1].emit({ type: "ready", device: "webgpu" });
assert.equal(created.length, 2, "mobile uses only one worker even with eight cores");
assert.equal(events.at(-1).id, "active");
created[1].onerror();
assert.ok(created[1].terminated);
assert.deepEqual(events.slice(-2).map(({ id, state }) => ({ id, state })), [
  { id: "active", state: "error" }, { id: "queued", state: "error" },
]);

removerPool.enqueue("bad-file", file);
removerPool.enqueue("good-file", file);
await settle();
created[2].emit({ type: "ready", device: "wasm" });
created[2].emit({ type: "error", id: "bad-file", message: "Invalid image" });
assert.equal(events.at(-1).id, "good-file", "per-image error does not block the next image");
assert.equal(events.at(-1).state, "processing");
created[2].emit({ type: "result", id: "good-file", blob: file, width: 1, height: 1 });
assert.equal(events.at(-1).state, "done");

removerPool.enqueue("gpu-retry", file);
removerPool.enqueue("after-retry", file);
created[2].emit({ type: "fallback" });
assert.ok(created[2].terminated, "failed runtime is terminated before CPU initialization");
assert.equal(created.length, 4);
assert.deepEqual(created[3].messages[0], { type: "load", tier: "light", device: "wasm" });
created[2].emit({ type: "error", id: "gpu-retry", message: "stale error" });
assert.notEqual(events.at(-1).state, "error", "messages from terminated workers are ignored");
created[3].emit({ type: "ready", device: "wasm" });
assert.deepEqual(created[3].messages.at(-1), { type: "process", id: "gpu-retry", file });
created[3].emit({ type: "result", id: "gpu-retry", blob: file, width: 1, height: 1 });
assert.equal(created[3].messages.at(-1).id, "after-retry", "queued jobs survive recovery");
created[3].emit({ type: "result", id: "after-retry", blob: file, width: 1, height: 1 });
created[3].emit({ type: "fallback" });
assert.equal(created.length, 4, "CPU failures cannot cause a restart loop");
assert.equal(removerPool.getStatus().state, "error");
window.isSecureContext = false;
removerPool.enqueue("insecure", file);
assert.match(events.at(-1).message, /HTTPS/);
console.log("PASS worker failures, fresh CPU recovery, job replay, stale messages, bounded retries, mobile concurrency, and HTTPS errors");

window.isSecureContext = true;
navigator.userAgent = "Macintosh Chrome";
navigator.gpu = { requestAdapter: async () => ({}) };
created.length = 0;
const { removerPool: desktopPool } = await import("../src/lib/remover-pool.ts?desktop-recovery");
const completed = [];
desktopPool.onJob((event) => { if (event.state === "done") completed.push(event.id); });
await desktopPool.warmup();
created[0].emit({ type: "ready", device: "webgpu" });
for (const id of ["one", "two", "three", "four"]) desktopPool.enqueue(id, file);
assert.equal(created.length, 3);
created[1].emit({ type: "ready", device: "webgpu" });
created[2].emit({ type: "ready", device: "webgpu" });
created[1].emit({ type: "fallback" });
assert.ok(created.slice(0, 3).every((worker) => worker.terminated));
assert.deepEqual(created[3].messages[0], { type: "load", tier: "best", device: "wasm" });
created[0].emit({ type: "result", id: "one", blob: file, width: 1, height: 1 });
assert.deepEqual(completed, [], "late GPU results cannot complete a replayed job");
created[3].emit({ type: "ready", device: "wasm" });
for (const id of ["one", "two", "three", "four"]) {
  assert.equal(created[3].messages.at(-1).id, id);
  created[3].emit({ type: "result", id, blob: file, width: 1, height: 1 });
}
assert.deepEqual(completed, ["one", "two", "three", "four"]);
assert.equal(created.length, 4, "recovery stays on one CPU worker");
console.log("PASS three active desktop GPU jobs and queued work recover once on a single CPU worker");

// Live OOM downgrade: an OOM error on the light tier drops to basic, replays
// the interrupted job, and persists the cap for the next page load.
navigator.userAgent = "Android Mobile";
delete navigator.gpu;
store.clear();
created.length = 0;
const { removerPool: oomPool } = await import("../src/lib/remover-pool.ts?oom");
const oomEvents = [];
oomPool.onJob((event) => oomEvents.push(event));
await oomPool.warmup();
assert.deepEqual(created[0].messages[0], { type: "load", tier: "light" },
  "an Android phone without WebGPU auto-selects the light tier");
created[0].emit({ type: "ready", device: "wasm" });
oomPool.enqueue("oom-job", file);
assert.equal(created[0].messages.at(-1).type, "process");
assert.ok(store.get("nobg:inflight"), "a job in flight leaves a marker");
created[0].emit({ type: "error", id: "oom-job", message: "Out of memory" });
assert.ok(created[0].terminated, "the OOM worker is terminated");
assert.equal(store.get("nobg:tier-cap"), "basic", "the lower tier is persisted");
assert.equal(created.length, 2);
assert.deepEqual(created[1].messages[0], { type: "load", tier: "basic" });
assert.match(oomPool.getStatus().notice ?? "", /ran out of memory/);
created[1].emit({ type: "ready", device: "wasm" });
assert.deepEqual(created[1].messages.at(-1), { type: "process", id: "oom-job", file },
  "the interrupted job is replayed");
created[1].emit({ type: "error", id: "oom-job", message: "Out of memory" });
assert.equal(oomEvents.at(-1).state, "error", "a repeated OOM on the lowest tier fails the job");
assert.equal(created.length, 2, "basic cannot downgrade further");
console.log("PASS live OOM downgrade, persisted cap, job replay, and retry bound");

// A fresh inflight marker at warmup means the page died mid-inference.
store.clear();
store.set("nobg:inflight", JSON.stringify({ tier: "light", at: Date.now() }));
created.length = 0;
const { removerPool: crashPool } = await import("../src/lib/remover-pool.ts?inflight");
await crashPool.warmup();
assert.equal(store.get("nobg:tier-cap"), "basic");
assert.equal(store.has("nobg:inflight"), false, "the marker is cleared after reading");
assert.match(crashPool.getStatus().notice ?? "", /ran out of memory/);
assert.deepEqual(created[0].messages[0], { type: "load", tier: "basic" });

store.clear();
store.set("nobg:inflight", JSON.stringify({ tier: "light", at: Date.now() - 11 * 60 * 1000 }));
created.length = 0;
const { removerPool: stalePool } = await import("../src/lib/remover-pool.ts?stale");
await stalePool.warmup();
assert.equal(store.has("nobg:tier-cap"), false, "a stale marker does not cap the tier");
assert.equal(store.has("nobg:inflight"), false);
assert.deepEqual(created[0].messages[0], { type: "load", tier: "light" });
console.log("PASS crash-marker cap, notice, clearing, and stale-marker ignore");

// A normal tab close fires pagehide, which clears the marker so the next
// load does not downgrade. An OOM kill never reaches the listener.
store.set("nobg:inflight", JSON.stringify({ tier: "light", at: Date.now() }));
assert.ok((listeners.pagehide ?? []).length > 0, "a pagehide listener is registered");
for (const handler of listeners.pagehide) handler();
assert.equal(store.has("nobg:inflight"), false, "pagehide clears the inflight marker");

// Restarting a pool after a failure must not register the listener twice.
const { removerPool: oncePool } = await import("../src/lib/remover-pool.ts?once");
await oncePool.warmup();
const pagehideCount = listeners.pagehide.length;
created.at(-1).emit({ type: "error", message: "load failed" });
oncePool.enqueue("after-failure", file);
await settle();
assert.equal(listeners.pagehide.length, pagehideCount, "pagehide listener is registered once per pool");
console.log("PASS pagehide clears the marker and is registered once");

const dir = await mkdtemp(join(tmpdir(), "nobg-mobile-test-"));
execFileSync("bun", ["build", "src/lib/processing-image.ts", "--target=browser", `--outdir=${dir}`]);
const moduleSource = await readFile(join(dir, "processing-image.js"));
const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": req.url === "/module.js" ? "text/javascript" : "text/html" });
  res.end(req.url === "/module.js" ? moduleSource : "<!doctype html><title>Mobile image tests</title>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const sizes = await page.evaluate(async () => {
    const { boundedImageCanvas, MOBILE_MAX_EDGE } = await import("/module.js");
    const results = [];
    for (const [width, height] of [[4000, 3000], [3000, 4000], [600, 400], [1, 4000]]) {
      const original = new OffscreenCanvas(width, height);
      const ctx = original.getContext("2d");
      ctx.fillStyle = "red";
      ctx.fillRect(0, 0, width / 2, height);
      const resized = await boundedImageCanvas(await original.convertToBlob(), MOBILE_MAX_EDGE);
      const output = resized.getContext("2d");
      results.push({ width: resized.width, height: resized.height,
        alpha: output.getImageData(resized.width - 1, 0, 1, 1).data[3] });
    }
    let rejected = false;
    try { await boundedImageCanvas(new Blob(["not an image"]), MOBILE_MAX_EDGE); } catch { rejected = true; }
    return { results, rejected };
  });
  assert.deepEqual(sizes.results.map(({ width, height }) => [width, height]), [[1536, 1152], [1152, 1536], [600, 400], [1, 1536]]);
  assert.equal(sizes.results[0].alpha, 0, "resizing preserves transparency");
  assert.ok(sizes.rejected, "invalid images produce an error");
  console.log("PASS browser photo resizing, aspect ratio, no upscaling, transparency, and invalid images");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
