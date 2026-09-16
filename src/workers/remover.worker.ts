import { pipeline, RawImage, env } from "@huggingface/transformers";

env.allowLocalModels = false;
env.useBrowserCache = true;

const MODEL_ID = "onnx-community/BEN2-ONNX";

type Remover = (input: RawImage) => Promise<RawImage | RawImage[]>;

let remover: Remover | null = null;
let removerDevice: "webgpu" | "wasm" | null = null;
let loading: Promise<Remover> | null = null;

const files = new Map<string, { loaded: number; total: number }>();

function postProgress() {
  let loaded = 0;
  let total = 0;
  for (const f of files.values()) {
    loaded += f.loaded;
    total += f.total;
  }
  self.postMessage({ type: "progress", loaded, total });
}

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
  return (await pipeline("background-removal", MODEL_ID, {
    device,
    dtype: "fp16",
    progress_callback: (info: FileProgressInfo) => {
      if (
        (info.status === "progress" || info.status === "done") &&
        info.file
      ) {
        files.set(info.file, {
          loaded: info.loaded ?? info.total ?? 0,
          total: info.total ?? 0,
        });
        postProgress();
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
  const image = await RawImage.fromBlob(file);
  let output: RawImage | RawImage[];
  try {
    output = await r(image);
  } catch (e) {
    if (removerDevice !== "webgpu") throw e;
    remover = null;
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
