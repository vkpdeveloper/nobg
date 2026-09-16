// Keep the existing cache keys so people who already have the model keep it.
export const MODEL_ID = "onnx-community/BEN2-ONNX";
export const MOBILE_MODEL_ID = "xrds/isnet-general-onnx-int8";
// New downloads use immutable URLs, including all of their byte ranges.
const REVISION = "c552aa82688edce09f0ac9d2e31ad53d9d629010";
const MODEL_DOWNLOADS = [
  { id: MODEL_ID, revision: REVISION, filename: "onnx/model_fp16.onnx", size: 219_121_675 },
  { id: MOBILE_MODEL_ID, revision: "71eff2372ec9c8edbc6ca637ded591423d23b65a", filename: "onnx/model_quantized.onnx", size: 44_229_662 },
];
export const MODEL_CACHE = "transformers-cache";
const PART_CACHE = "nobg-model-parts-v1";
const CHUNK_SIZE = 8 * 1024 * 1024;

export type ModelPhase = "loading" | "waiting" | "downloading" | "saving";
export type ModelProgress = { phase: ModelPhase; loaded: number; total: number };

export interface ModelFile {
  url: string;
  cacheKey: string;
  size?: number;
}

interface DownloadOptions {
  onProgress: (progress: ModelProgress) => void;
  fetch?: typeof fetch;
  chunkSize?: number;
  concurrency?: number;
}

export class ModelDownloadError extends Error {}

/** The lock covers the cache check, transfer, and durable write across tabs/workers. */
export async function downloadModelFile(
  file: ModelFile,
  options: DownloadOptions,
): Promise<Response> {
  if (!globalThis.caches || !navigator.locks) {
    throw new ModelDownloadError("This browser cannot save and share the model. Try a browser with storage enabled.");
  }
  const networkFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const report = (phase: ModelPhase, loaded = 0, total = file.size ?? 0) =>
    options.onProgress({ phase, loaded, total });

  report("waiting");
  try {
    return await navigator.locks.request(`nobg-model:${file.cacheKey}`, async () => {
      const cache = await caches.open(MODEL_CACHE);
      const saved = await cache.match(file.cacheKey);
      if (saved) {
        report("loading");
        return saved;
      }

      // Fail before transferring hundreds of MB if browser storage is unavailable.
      const probe = `${file.cacheKey}?nobg-storage-probe`;
      await cache.put(probe, new Response("ok"));
      await cache.delete(probe);

      if (!file.size) {
        const response = await networkFetch(file.url);
        if (!response.ok) return response;
        await cache.put(file.cacheKey, response);
        return (await cache.match(file.cacheKey))!;
      }

      const total = file.size;
      const chunkSize = options.chunkSize ?? CHUNK_SIZE;
      const count = Math.ceil(total / chunkSize);
      const parts = await caches.open(PART_CACHE);
      const key = (index: number) => `${file.url}?nobg-part=${index}&size=${chunkSize}`;
      const sizes = new Array<number>(count).fill(0);
      const progress = () => report("downloading", sizes.reduce((a, b) => a + b, 0));
      const pending: number[] = [];
      for (let index = 0; index < count; index++) {
        const part = await parts.match(key(index));
        const size = Math.min(chunkSize, total - index * chunkSize);
        if (part && Number(part.headers.get("content-length")) === size) {
          sizes[index] = size;
        } else {
          pending.push(index);
        }
      }
      progress();

      const downloadPart = async (index: number): Promise<Response | undefined> => {
        const start = index * chunkSize;
        const end = Math.min(start + chunkSize, total) - 1;
        const response = await networkFetch(file.url, {
          headers: { Range: `bytes=${start}-${end}` },
          // Chromium can serialize same-URL ranges behind its HTTP cache lock.
          // We persist the responses ourselves, so bypass that separate cache.
          cache: "no-store",
          signal: AbortSignal.timeout(120_000),
        });
        // Probe the first missing range before starting concurrent requests. If a
        // host ignores Range, consume that one full response instead of duplicating it.
        if (response.status === 200) return response;
        if (response.status !== 206 || response.headers.get("content-range") !== `bytes ${start}-${end}/${total}`) {
          await response.body?.cancel();
          throw new ModelDownloadError("The model download returned an invalid part. Reload to resume.");
        }
        const bytes = await readBytes(response, end - start + 1, (loaded) => {
          sizes[index] = loaded;
          progress();
        });
        await parts.put(key(index), new Response(bytes, {
          headers: { "content-length": String(bytes.byteLength) },
        }));
      };

      const first = pending.shift();
      const fullResponse = first === undefined ? undefined : await downloadPart(first);
      if (fullResponse) {
        const bytes = await readBytes(fullResponse, total, (loaded) => report("downloading", loaded));
        report("saving", total);
        await cache.put(file.cacheKey, new Response(bytes, {
          headers: { "content-length": String(total) },
        }));
      } else {
        let failed = false;
        const lanes = Array.from({ length: Math.min(options.concurrency ?? 4, pending.length) }, async () => {
          while (!failed && pending.length) {
            const index = pending.shift()!;
            try {
              const unexpectedFull = await downloadPart(index);
              if (unexpectedFull) {
                await unexpectedFull.body?.cancel();
                throw new ModelDownloadError("The server stopped supporting partial downloads. Reload to resume.");
              }
            } catch (error) {
              failed = true;
              throw error;
            }
          }
        });
        // Do not release the lock while any lane is still writing completed parts.
        const results = await Promise.allSettled(lanes);
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;

        report("saving", total);
        // Stream saved parts into the complete cache entry without holding a second
        // full model buffer in memory. Only a completed response becomes visible.
        let index = 0;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (index === count) {
              controller.close();
              return;
            }
            const part = await parts.match(key(index++));
            if (!part) throw new ModelDownloadError("A saved model part is missing. Reload to resume.");
            controller.enqueue(new Uint8Array(await part.arrayBuffer()));
          },
        });
        await cache.put(file.cacheKey, new Response(body, {
          headers: { "content-length": String(total) },
        }));
      }

      const result = await cache.match(file.cacheKey);
      if (!result) throw new ModelDownloadError("The browser could not save the model. Check available storage.");
      // Cleanup is best-effort; never turn a successful durable save into a retry.
      await Promise.allSettled(Array.from({ length: count }, (_, index) => parts.delete(key(index))));
      report("loading", total);
      return result;
    });
  } catch (error) {
    if (error instanceof ModelDownloadError) throw error;
    if (error instanceof DOMException && error.name === "QuotaExceededError") {
      throw new ModelDownloadError("Not enough browser storage to save the model. Free some space and reload to resume.");
    }
    throw new ModelDownloadError("Could not download or save the model. Check your connection and browser storage, then reload to resume.");
  }
}

async function readBytes(response: Response, size: number, onProgress: (loaded: number) => void) {
  if (!response.body) throw new ModelDownloadError("The model download was empty. Reload to resume.");
  const bytes = new Uint8Array(size);
  const reader = response.body.getReader();
  let loaded = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (loaded + value.byteLength > size) throw new ModelDownloadError("The model download had an unexpected size.");
      bytes.set(value, loaded);
      loaded += value.byteLength;
      onProgress(loaded);
    }
    if (loaded !== size) throw new ModelDownloadError("The model download was interrupted. Reload to resume.");
    return bytes;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createModelFetch(onProgress: DownloadOptions["onProgress"]) {
  const networkFetch = globalThis.fetch.bind(globalThis);
  return (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const model = MODEL_DOWNLOADS.find(({ id }) => url.startsWith(`https://huggingface.co/${id}/resolve/main/`));
    if (!model || (init?.method && init.method !== "GET")) {
      return networkFetch(input, init);
    }
    const filename = url.slice(`https://huggingface.co/${model.id}/resolve/main/`.length);
    return downloadModelFile({
      cacheKey: url,
      url: url.replace("/resolve/main/", `/resolve/${model.revision}/`),
      size: filename === model.filename ? model.size : undefined,
    }, { onProgress: (progress) => {
      if (filename === model.filename) onProgress(progress);
    }, fetch: networkFetch });
  };
}
