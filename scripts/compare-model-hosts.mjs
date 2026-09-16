// Bundle for a browser with Bun. Run compareModelHosts() on an allowed HTTPS
// app origin; this transfers ~1.18 GB for the default six runs. See docs/model-download.md.
import { downloadModelFile, MODEL_CACHE } from "../src/lib/model-download.ts";
import { DESKTOP_MODEL, DESKTOP_ASSET_PATH, DEFAULT_MODEL_CDN_URL, MODEL_CHUNK_SIZE } from "../src/lib/model-config.ts";

export async function compareModelHosts(onEvent = () => {}) {
  const url = `https://huggingface.co/${DESKTOP_MODEL.id}/resolve/${DESKTOP_MODEL.revision}/${DESKTOP_MODEL.filename}`;
  const baseUrl = DEFAULT_MODEL_CDN_URL + DESKTOP_ASSET_PATH;
  const partCache = await caches.open("nobg-model-parts-v1");
  const partKeys = Array.from({ length: Math.ceil(DESKTOP_MODEL.size / MODEL_CHUNK_SIZE) },
    (_, index) => `${url}?nobg-part=${index}&size=${MODEL_CHUNK_SIZE}`);
  // Do not remove a user's interrupted download to make a benchmark look cold.
  for (const key of partKeys) {
    if (await partCache.match(key)) throw new Error("An unfinished model download exists; finish it before benchmarking.");
  }
  const cache = await caches.open(MODEL_CACHE);
  const runId = crypto.randomUUID();
  const results = [];
  const order = ["huggingface", "r2", "r2", "huggingface", "huggingface", "r2"];
  for (const [index, host] of order.entries()) {
    const cacheKey = `${location.origin}/__nobg_host_benchmark__/${runId}/${index}`;
    let firstHeadersMs = 0;
    let savingMs = 0;
    let payloadBytes = 0;
    const requests = [];
    const start = performance.now();
    onEvent({ type: "start", run: index + 1, host });
    try {
      const response = await downloadModelFile({ url, cacheKey, size: DESKTOP_MODEL.size,
        ...(host === "r2" ? { compressed: { baseUrl, sha256: DESKTOP_MODEL.sha256 } } : {}),
      }, {
        concurrency: 4,
        onProgress(progress) {
          if (progress.phase === "saving") savingMs = performance.now() - start;
          onEvent({ type: "progress", run: index + 1, host, ...progress });
        },
        async fetch(input, init) {
          requests.push(String(input));
          // Bypass the browser HTTP cache for BOTH hosts, retaining normal CDN
          // URLs (no cache-busting queries). Application caches start empty.
          const response = await fetch(input, { ...init, cache: "no-store" });
          firstHeadersMs ||= performance.now() - start;
          if (!response.body) return response;
          const body = response.body.pipeThrough(new TransformStream({
            transform(chunk, controller) { payloadBytes += chunk.byteLength; controller.enqueue(chunk); },
          }));
          return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        },
      });
      const savedMs = performance.now() - start;
      const bytes = await response.arrayBuffer();
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        byte => byte.toString(16).padStart(2, "0")).join("");
      if (bytes.byteLength !== DESKTOP_MODEL.size || sha256 !== DESKTOP_MODEL.sha256) throw new Error("Checksum mismatch");
      const originRequests = requests.filter(request => request.startsWith("https://huggingface.co/")).length;
      const cdnRequests = requests.filter(request => request.startsWith(baseUrl)).length;
      if (host === "r2" && (originRequests || cdnRequests !== 28)) throw new Error("R2 comparison used origin fallback or skipped CDN parts");
      if (host === "huggingface" && originRequests !== 27) throw new Error("Hugging Face comparison skipped model parts");
      const result = { run: index + 1, host, seconds: +(savedMs / 1000).toFixed(3),
        firstHeadersSeconds: +(firstHeadersMs / 1000).toFixed(3), finalSaveSeconds: +((savedMs - savingMs) / 1000).toFixed(3),
        payloadBytes, bytes: bytes.byteLength, sha256, originRequests, cdnRequests };
      results.push(result);
      onEvent({ type: "result", ...result });
    } finally {
      await cache.delete(cacheKey);
      // These keys were absent before the test; remove only test-created parts
      // on error. Completed downloads already remove their own parts.
      await Promise.all(partKeys.map(key => partCache.delete(key)));
    }
  }
  return { timestamp: new Date().toISOString(), userAgent: navigator.userAgent,
    origin: location.origin, concurrency: 4, browserHttpCache: "no-store",
    order, results, notes: "Same browser and network; no concurrent transfers. CDN cache warmth and other network traffic are uncontrolled. Times include decompression and durable cache save, exclude inference and final checksum verification." };
}

// The standalone IIFE bundle can be pasted into an allowed app's DevTools.
if (typeof window !== "undefined") window.compareModelHosts = compareModelHosts;
