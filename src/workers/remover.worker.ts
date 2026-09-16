import { pipeline, RawImage, env } from "@huggingface/transformers";
import { createModelFetch, MODEL_ID, MOBILE_MODEL_ID, ModelDownloadError } from "../lib/model-download";
import { isMobileDevice } from "../lib/device";
import { mobileImageCanvas } from "../lib/processing-image";
import { DEFAULT_MODEL_CDN_URL } from "../lib/model-config";

env.allowLocalModels = false;
env.useBrowserCache = true;
env.fetch = createModelFetch(
  (progress) => self.postMessage({ type: "progress", ...progress }),
  process.env.NEXT_PUBLIC_MODEL_CDN_URL ?? DEFAULT_MODEL_CDN_URL,
);

type Remover = ((input: RawImage) => Promise<RawImage | RawImage[]>) & { dispose(): Promise<void> };

const mobile = isMobileDevice();
// Keep CPU execution within a phone's memory budget, including on pages without
// cross-origin isolation (where shared-memory threading is unavailable).
if (mobile && env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 1;

let remover: Remover | null = null;
let removerDevice: "webgpu" | "wasm" | null = null;
let loading: Promise<Remover> | null = null;
let forceWasm = false;

// Transformers.js retains rejected initialization/inference promises in its
// worker-global chains. Recovery must use a new worker, even for CPU execution.
class CpuWorkerRequired extends Error {}

async function hasWebGPU(): Promise<boolean> {
  const nav = navigator as Navigator & {
    gpu?: { requestAdapter(): Promise<unknown> };
  };
  return !!nav.gpu && !!(await nav.gpu.requestAdapter().catch(() => null));
}

interface FileProgressInfo {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
}

async function createPipeline(device: "webgpu" | "wasm"): Promise<Remover> {
  const lightweight = mobile;
  return (await pipeline("background-removal", lightweight ? MOBILE_MODEL_ID : MODEL_ID, {
    device,
    dtype: lightweight ? "q8" : "fp16",
    // ORT's advanced fusion generates an invalid mixed-f16/f32 LayerNorm shader
    // for BEN2. Basic optimization preserves the original graph's casts while
    // keeping the exact FP16 weights and WebGPU execution.
    session_options: device === "webgpu" && !lightweight ? {
      graphOptimizationLevel: "basic",
    } : undefined,
    progress_callback: (info: FileProgressInfo) => {
      if (
        (info.status === "progress" || info.status === "done") &&
        info.file?.endsWith(".onnx")
      ) {
        self.postMessage({
          type: "progress",
          phase: "loading",
          loaded: info.status === "done" ? 1 : info.loaded ?? 0,
          total: info.status === "done" ? 1 : info.total ?? 0,
        });
      }
    },
  })) as unknown as Remover;
}

async function load(): Promise<Remover> {
  if (remover) return remover;
  if (loading) return loading;
  loading = (async () => {
    const device = !forceWasm && await hasWebGPU() ? "webgpu" : "wasm";
    try {
      const r = await createPipeline(device);
      remover = r;
      removerDevice = device;
      self.postMessage({ type: "ready", device });
      return r;
    } catch (e) {
      // Changing inference device cannot fix a failed download/storage write.
      if (e instanceof ModelDownloadError || device === "wasm") throw e;
      throw new CpuWorkerRequired();
    }
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

async function processImage(id: string, file: Blob) {
  const r = await load();
  const image = mobile
    ? RawImage.fromCanvas(await mobileImageCanvas(file))
    : await RawImage.fromBlob(file);
  let output: RawImage | RawImage[];
  try {
    output = await r(image);
  } catch (e) {
    if (removerDevice !== "webgpu") throw e;
    // The pool terminates this worker (releasing GPU resources) and replays the
    // original image in a clean CPU worker using exactly the same cached model.
    throw new CpuWorkerRequired();
  }
  const result = Array.isArray(output) ? output[0] : output;
  const blob = await result.toBlob("image/png");
  self.postMessage({
    type: "result",
    id,
    blob,
    width: result.width,
    height: result.height,
  });
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === "load") {
      forceWasm = msg.device === "wasm";
      await load();
    } else if (msg.type === "process") {
      await processImage(msg.id, msg.file);
    }
  } catch (err) {
    if (err instanceof CpuWorkerRequired) {
      self.postMessage({ type: "fallback" });
      return;
    }
    self.postMessage({
      type: "error",
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
