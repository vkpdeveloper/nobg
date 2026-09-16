import { pipeline, RawImage, env } from "@huggingface/transformers";
import { createModelFetch, MODEL_ID, MOBILE_MODEL_ID, ModelDownloadError } from "../lib/model-download";
import { isMobileDevice } from "../lib/device";
import { mobileImageCanvas } from "../lib/processing-image";

env.allowLocalModels = false;
env.useBrowserCache = true;
env.fetch = createModelFetch((progress) => self.postMessage({ type: "progress", ...progress }));

type Remover = ((input: RawImage) => Promise<RawImage | RawImage[]>) & { dispose(): Promise<void> };

const mobile = isMobileDevice();
// Keep CPU execution within a phone's memory budget, including on pages without
// cross-origin isolation (where shared-memory threading is unavailable).
if (mobile && env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 1;

let remover: Remover | null = null;
let removerDevice: "webgpu" | "wasm" | null = null;
let loading: Promise<Remover> | null = null;

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
    const devices: ("webgpu" | "wasm")[] = (await hasWebGPU())
      ? ["webgpu", "wasm"]
      : ["wasm"];
    let lastErr: unknown = null;
    for (const device of devices) {
      try {
        const r = await createPipeline(device);
        remover = r;
        removerDevice = device;
        self.postMessage({ type: "ready", device });
        return r;
      } catch (e) {
        // Changing inference device cannot fix a failed download/storage write.
        if (e instanceof ModelDownloadError) throw e;
        lastErr = e;
      }
    }
    throw lastErr;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

async function process(id: string, file: Blob) {
  const r = await load();
  const image = mobile
    ? RawImage.fromCanvas(await mobileImageCanvas(file))
    : await RawImage.fromBlob(file);
  let output: RawImage | RawImage[];
  try {
    output = await r(image);
  } catch (e) {
    if (removerDevice !== "webgpu") throw e;
    remover = null;
    removerDevice = null;
    await r.dispose().catch(() => {});
    const fallback = await createPipeline("wasm");
    remover = fallback;
    removerDevice = "wasm";
    self.postMessage({ type: "ready", device: "wasm" });
    output = await fallback(image);
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
      await load();
    } else if (msg.type === "process") {
      await process(msg.id, msg.file);
    }
  } catch (err) {
    self.postMessage({
      type: "error",
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
