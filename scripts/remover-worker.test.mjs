// Run with: bun scripts/remover-worker.test.mjs
import assert from "node:assert/strict";
import { mock } from "bun:test";

const messages = [];
const calls = [];
let failGpuLoad = false;
let failDownload = false;
let moduleIndex = 0;
globalThis.self = { postMessage: (message) => messages.push(message) };
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
  userAgent: "Android Mobile", gpu: { requestAdapter: async () => ({}) },
} });
const { ModelDownloadError, MOBILE_MODEL_ID } = await import("../src/lib/model-download.ts");
mock.module("../src/lib/processing-image.ts", () => ({ mobileImageCanvas: async () => ({ width: 1536, height: 1024 }) }));
mock.module("@huggingface/transformers", () => ({
  env: { backends: { onnx: { wasm: {} } } },
  RawImage: { fromCanvas: (canvas) => canvas },
  pipeline: async (_task, model, options) => {
    calls.push(`load:${options.device}`);
    assert.equal(model, MOBILE_MODEL_ID);
    assert.equal(options.dtype, "q8");
    if (failDownload) throw new ModelDownloadError("Download interrupted");
    if (options.device === "webgpu" && failGpuLoad) throw new Error("GPU initialization failed");
    const remover = async (image) => {
      calls.push(`run:${options.device}`);
      if (options.device === "webgpu") throw new Error("GPU inference failed");
      return { ...image, toBlob: async () => new Blob(["PNG"], { type: "image/png" }) };
    };
    remover.dispose = async () => { calls.push(`dispose:${options.device}`); };
    return remover;
  },
}));
const freshWorker = async () => {
  messages.length = 0;
  calls.length = 0;
  await import(`../src/workers/remover.worker.ts?test=${moduleIndex++}`);
};
const send = (data) => self.onmessage({ data });

await freshWorker();
await send({ type: "load" });
await send({ type: "process", id: "photo", file: new Blob() });
assert.deepEqual(calls, ["load:webgpu", "run:webgpu", "dispose:webgpu", "load:wasm", "run:wasm"]);
assert.equal(messages.at(-1).type, "result");
assert.equal(messages.at(-1).width, 1536);
await send({ type: "process", id: "next-photo", file: new Blob() });
assert.equal(calls.at(-1), "run:wasm", "later photos reuse the CPU fallback");
assert.equal(calls.filter((call) => call.startsWith("load:")).length, 2);

failGpuLoad = true;
await freshWorker();
await send({ type: "load" });
assert.deepEqual(calls, ["load:webgpu", "load:wasm"]);
assert.equal(messages.at(-1).device, "wasm");

failDownload = true;
await freshWorker();
await send({ type: "load" });
assert.deepEqual(calls, ["load:webgpu"], "a download failure must not start another model download");
assert.equal(messages.at(-1).type, "error");
assert.match(messages.at(-1).message, /Download interrupted/);
console.log("PASS GPU inference disposal and CPU retry, fallback reuse, initialization fallback, and download error handling");
