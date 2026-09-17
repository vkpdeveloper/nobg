import { MODELS, MODEL_CONFIG_OVERRIDES, assetPath, MODEL_CHUNK_SIZE, type CompressedModelManifest } from "./model-config";

// Keep the existing cache keys so people who already have the model keep it.
export const MODEL_ID = MODELS.ben2.id;
export const MOBILE_MODEL_ID = MODELS.isnet.id;
// New downloads use immutable URLs, including all of their byte ranges.
const MODEL_DOWNLOADS = Object.values(MODELS);
export const MODEL_CACHE = "transformers-cache";
const PART_CACHE = "nobg-model-parts-v1";

export type ModelPhase = "loading" | "waiting" | "downloading" | "saving";
export type ModelProgress = { phase: ModelPhase; loaded: number; total: number };

export interface ModelFile {
  url: string;
  cacheKey: string;
  size?: number;
  compressed?: { baseUrl: string; sha256: string };
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
      const chunkSize = options.chunkSize ?? MODEL_CHUNK_SIZE;
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

      let manifest: CompressedModelManifest | undefined;
      if (pending.length && file.compressed && typeof DecompressionStream !== "undefined") {
        try {
          const response = await networkFetch(`${file.compressed.baseUrl}/manifest.json`, {
            signal: AbortSignal.timeout(5000),
          });
          if (response.ok) {
            const candidate = await response.json();
            if (isCompressedManifest(candidate, file, chunkSize)) manifest = candidate;
          } else await response.body?.cancel();
        } catch { /* Development/older deployments can still use Hugging Face. */ }
      }

      const requestPart = async (index: number): Promise<Response> => {
        const start = index * chunkSize;
        const end = Math.min(start + chunkSize, total) - 1;
        const response = await networkFetch(file.url, {
          headers: { Range: `bytes=${start}-${end}` },
          // Chromium can serialize same-URL ranges behind its HTTP cache lock.
          // We persist the responses ourselves, so bypass that separate cache.
          cache: "no-store",
          signal: AbortSignal.timeout(120_000),
        });
        // Only wait for headers to confirm range support, not the first 8 MB body.
        // If a host ignores Range, consume its full response just once.
        if (response.status === 200) return response;
        if (response.status !== 206 || response.headers.get("content-range") !== `bytes ${start}-${end}/${total}`) {
          await response.body?.cancel();
          throw new ModelDownloadError("The model download returned an invalid part. Reload to resume.");
        }
        return response;
      };

      const partProgress = (index: number) => (loaded: number) => {
        sizes[index] = loaded;
        progress();
      };
      const savePart = async (index: number, bytes: Uint8Array<ArrayBuffer>) => {
        await parts.put(key(index), new Response(bytes, {
          headers: { "content-length": String(bytes.byteLength) },
        }));
      };

      // Static gzip files need no range probe. Start all lanes immediately.
      const first = manifest ? undefined : pending.shift();
      const firstResponse = first === undefined ? undefined : await requestPart(first);
      if (firstResponse?.status === 200) {
        const bytes = await readBytes(firstResponse, total, (loaded) => report("downloading", loaded));
        report("saving", total);
        await cache.put(file.cacheKey, new Response(bytes, {
          headers: { "content-length": String(total) },
        }));
      } else {
        let failed = false;
        // The probed response occupies one lane, including while its body is read.
        // Reuse it instead of fetching the first range a second time.
        if (first !== undefined) pending.unshift(first);
        const lanes = Array.from({ length: Math.min(options.concurrency ?? 4, pending.length) }, async () => {
          while (!failed && pending.length) {
            const index = pending.shift()!;
            try {
              let bytes: Uint8Array<ArrayBuffer> | undefined;
              if (manifest) {
                try {
                  bytes = await readCompressedPart(file.compressed!.baseUrl, index, manifest, networkFetch, partProgress(index));
                } catch {
                  // Only retry transfer/decoding failures at the origin. A cache
                  // write failure below must remain a storage error.
                  manifest = undefined;
                  sizes[index] = 0;
                  progress();
                }
              }
              if (!bytes) {
                const response = index === first ? firstResponse! : await requestPart(index);
                if (response.status === 200) {
                  await response.body?.cancel();
                  throw new ModelDownloadError("The server stopped supporting partial downloads. Reload to resume.");
                }
                bytes = await readBytes(response, Math.min(chunkSize, total - index * chunkSize), partProgress(index));
              }
              await savePart(index, bytes);
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

function isCompressedManifest(value: unknown, file: ModelFile, chunkSize: number): value is CompressedModelManifest {
  if (!value || typeof value !== "object") return false;
  const m = value as CompressedModelManifest;
  return m.version === 1 && m.sha256 === file.compressed?.sha256 && m.size === file.size &&
    m.chunkSize === chunkSize && Array.isArray(m.parts) && m.parts.length === Math.ceil(m.size / chunkSize) &&
    m.parts.every((part, index) => part && part.size === Math.min(chunkSize, m.size - index * chunkSize) &&
      Number.isSafeInteger(part.compressedSize) && part.compressedSize > 0 && part.compressedSize <= chunkSize + 65536 &&
      typeof part.sha256 === "string" && /^[a-f0-9]{64}$/.test(part.sha256));
}

async function readCompressedPart(
  baseUrl: string, index: number, manifest: CompressedModelManifest,
  networkFetch: typeof fetch, onProgress: (loaded: number) => void,
) {
  const part = manifest.parts[index];
  const response = await networkFetch(`${baseUrl}/part-${index}.gz`, {
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new Error("Compressed part unavailable");
  }
  let received = 0;
  const counted = response.body.pipeThrough(new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > part.compressedSize) throw new Error("Oversized compressed part");
      controller.enqueue(chunk);
    },
    flush() { if (received !== part.compressedSize) throw new Error("Truncated compressed part"); },
  }));
  const bytes = await readBytes(new Response(counted.pipeThrough(new DecompressionStream("gzip"))), part.size, onProgress);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== part.sha256) throw new Error("Compressed part checksum mismatch");
  return bytes;
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

export function createModelFetch(onProgress: DownloadOptions["onProgress"], cdn?: string) {
  const networkFetch = globalThis.fetch.bind(globalThis);
  // Opt in to a separately hosted model CDN. Never route model traffic through
  // the application's origin or add large model assets to the Vercel build.
  let cdnBase: string | undefined;
  if (cdn) {
    try {
      const trimmed = cdn.replace(/\/$/, "");
      const probe = new URL(`${trimmed}${assetPath(MODELS.ben2)}`);
      if (probe.protocol === "https:" && probe.origin !== globalThis.location.origin) cdnBase = trimmed;
    } catch { /* Invalid optional CDN settings fall back to the pinned origin. */ }
  }
  return (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const model = MODEL_DOWNLOADS.find(({ id }) => url.startsWith(`https://huggingface.co/${id}/resolve/main/`));
    if (!model || (init?.method && init.method !== "GET")) {
      return networkFetch(input, init);
    }
    const filename = url.slice(`https://huggingface.co/${model.id}/resolve/main/`.length);
    const overrides = MODEL_CONFIG_OVERRIDES[model.key as keyof typeof MODELS];
    if (overrides && filename in overrides) {
      return Promise.resolve(new Response(JSON.stringify(overrides[filename]), {
        headers: { "content-type": "application/json" },
      }));
    }
    return downloadModelFile({
      cacheKey: url,
      url: url.replace("/resolve/main/", `/resolve/${model.revision}/`),
      size: filename === model.filename ? model.size : undefined,
      ...(cdnBase && filename === model.filename ? {
        compressed: { baseUrl: `${cdnBase}${assetPath(model)}`, sha256: model.sha256 },
      } : {}),
    }, { onProgress: (progress) => {
      if (filename === model.filename) onProgress(progress);
    }, fetch: networkFetch });
  };
}
