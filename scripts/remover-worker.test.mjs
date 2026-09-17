// Run with: bun scripts/remover-worker.test.mjs
import assert from "node:assert/strict";
import { mock } from "bun:test";

const messages = [];
const calls = [];
const processors = [];
let failGpuLoad = false;
let failDownload = false;
let moduleIndex = 0;
globalThis.self = { postMessage: (message) => messages.push(message) };
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
  userAgent: "Android Mobile", gpu: { requestAdapter: async () => ({}) },
} });
const { ModelDownloadError, MOBILE_MODEL_ID, MODEL_ID } = await import("../src/lib/model-download.ts");
const { MODELS } = await import("../src/lib/model-config.ts");
assert.equal(MODEL_ID, MODELS.ben2.id);
assert.equal(MOBILE_MODEL_ID, MODELS.isnet.id);
mock.module("../src/lib/processing-image.ts", () => ({
  boundedImageCanvas: async (_file, maxEdge) => ({ width: maxEdge, height: 1024 }),
}));
mock.module("@huggingface/transformers", () => ({
  env: { backends: { onnx: { wasm: {} } } },
  RawImage: { fromCanvas: (canvas) => canvas, fromBlob: async () => ({ width: 2048, height: 1536 }) },
  pipeline: async (_task, model, options) => {
    calls.push(`load:${options.device}:${model}`);
    const dtypes = { [MODELS.ben2.id]: "fp16", [MODELS.isnet.id]: "q8", [MODELS.u2netp.id]: "fp32" };
    assert.ok(model in dtypes, `unknown model ${model}`);
    assert.equal(options.dtype, dtypes[model]);
    assert.deepEqual(options.session_options,
      model === MODELS.ben2.id && options.device === "webgpu" ? { graphOptimizationLevel: "basic" } : undefined,
      "only BEN2 on WebGPU needs the fusion workaround");
    if (failDownload) throw new ModelDownloadError("Download interrupted");
    if (options.device === "webgpu" && failGpuLoad) throw new Error("GPU initialization failed");
    const remover = async (image) => {
      calls.push(`run:${options.device}`);
      if (options.device === "webgpu") throw new Error("GPU inference failed");
      return { ...image, toBlob: async () => new Blob(["PNG"], { type: "image/png" }) };
    };
    remover.processor = { image_processor: { size: { height: 1024, width: 1024 } } };
    processors.push(remover.processor);
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
await send({ type: "load", tier: "balanced" });
await send({ type: "process", id: "photo", file: new Blob() });
assert.deepEqual(calls, [`load:webgpu:${MODELS.isnet.id}`, "run:webgpu"]);
assert.equal(messages.at(-1).type, "fallback", "GPU errors must request a clean worker, never reuse the failed runtime");
await freshWorker();
await send({ type: "load", tier: "balanced", device: "wasm" });
await send({ type: "process", id: "photo", file: new Blob() });
assert.deepEqual(calls, [`load:wasm:${MODELS.isnet.id}`, "run:wasm"]);
assert.equal(messages.at(-1).type, "result");
assert.equal(messages.at(-1).width, 1536);
await send({ type: "process", id: "next-photo", file: new Blob() });
assert.equal(calls.at(-1), "run:wasm", "later photos reuse the CPU fallback");
assert.equal(calls.filter((call) => call.startsWith("load:")).length, 1);
assert.deepEqual(processors.at(-1).image_processor.size, { height: 1024, width: 1024 },
  "the balanced tier keeps the model's own input size");

await freshWorker();
await send({ type: "load", tier: "light", device: "wasm" });
assert.deepEqual(processors.at(-1).image_processor.size, { height: 512, width: 512 },
  "the light tier runs ISNet at a smaller input size");
await send({ type: "process", id: "light-photo", file: new Blob() });
assert.equal(messages.at(-1).type, "result");
assert.equal(messages.at(-1).width, 1024, "light bounds the longest edge to 1024");

await freshWorker();
await send({ type: "load", tier: "basic", device: "wasm" });
assert.ok(calls.includes(`load:wasm:${MODELS.u2netp.id}`), "basic loads the U-2-Netp model");
assert.deepEqual(processors.at(-1).image_processor.size, { height: 1024, width: 1024 },
  "the basic tier uses the model's own 320px config unchanged");

await freshWorker();
await send({ type: "load", tier: "best" });
await send({ type: "process", id: "desktop", file: new Blob() });
assert.deepEqual(calls, [`load:webgpu:${MODELS.ben2.id}`, "run:webgpu"]);
assert.equal(messages.at(-1).type, "fallback");
await freshWorker();
await send({ type: "load", tier: "best", device: "wasm" });
await send({ type: "process", id: "desktop", file: new Blob() });
assert.equal(messages.at(-1).type, "result");
assert.equal(messages.at(-1).width, 2048, "the best tier keeps the original resolution");

failGpuLoad = true;
await freshWorker();
await send({ type: "load", tier: "balanced" });
assert.deepEqual(calls, [`load:webgpu:${MODELS.isnet.id}`]);
assert.equal(messages.at(-1).type, "fallback");

failDownload = true;
await freshWorker();
await send({ type: "load", tier: "balanced" });
assert.deepEqual(calls, [`load:webgpu:${MODELS.isnet.id}`], "a download failure must not start another model download");
assert.equal(messages.at(-1).type, "error");
assert.match(messages.at(-1).message, /Download interrupted/);

console.log("PASS tiered model selection, light-tier resize, basic-tier fp32, fresh-worker GPU recovery, fallback reuse, and download errors");
