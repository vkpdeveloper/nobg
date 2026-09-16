# Model downloads and GPU recovery

Desktop continues to use BEN2 FP16, pinned to
`c552aa82688edce09f0ac9d2e31ad53d9d629010`, with an ONNX file of
219,121,675 bytes. Mobile continues to use the existing 44,229,662-byte ISNet INT8
model. Neither weights nor precision change for download optimization or recovery.

The downloader starts parallel transfers after the first range's response
headers confirm range support. Previously it waited for the entire first 8 MiB
body and cache write. The first body now occupies one of the four download lanes.
Servers that ignore ranges still send only one full response. Cache keys, chunk
boundaries, cross-worker locks, and resumable parts are preserved.

## External R2 hosting

The default CDN is `https://nobg-models.ordinity.com`, backed by the dedicated
`nobg-models` R2 bucket. Override `NEXT_PUBLIC_MODEL_CDN_URL` with a separate HTTPS
origin serving the prepared assets, then rebuild the app. Set it to an empty
string to download directly from Hugging Face. Same-origin URLs are rejected so this option cannot route
model traffic through the Vercel app. The CDN is used only for desktop BEN2;
mobile keeps its existing pinned download.

Prepare the bundle separately from the application build:

```sh
bun scripts/prepare-model-assets.mjs
# Or reuse a previously downloaded, checksum-verified source:
bun scripts/prepare-model-assets.mjs --source=/path/to/model_fp16.onnx
```

Upload the contents of `.model-assets/`, preserving object paths, to an R2
bucket. This directory is excluded from Git and Vercel uploads. The 27 gzip
parts total 174,211,266 bytes, 20.5% less than the original model. Preparation
verifies the original and reconstructed SHA-256 against the publisher's file.
The model weights, precision, and graph are unchanged by compression.

Hosting requirements:

- Attach an R2 custom domain and enable Cloudflare caching for `/models/*`.
  The `r2.dev` development endpoint does not provide the production edge cache.
- Allow browser GET/HEAD requests via R2 CORS. The configured origins are
  `https://nobg-nu.vercel.app`, `https://nobg.ordinity.com`, and
  `http://localhost:3000`. Additional preview origins need an explicit CORS entry.
- Serve `.gz` objects as `Content-Type: application/gzip` with **no
  `Content-Encoding` header**. The downloader decompresses them explicitly.
- Use `Cache-Control: public, max-age=31536000, immutable, no-transform` for
  versioned objects; serve the manifest as `application/json`.
- Upload all parts and `NOTICE.txt` before `manifest.json`. Keep the
  SHA/version path immutable. Include the bundled BEN2 MIT notice.
- Verify a cross-origin browser download and its reconstructed checksum before
  configuring the app's build environment.

Four compressed requests run concurrently. Each decoded part is size-checked
and SHA-256-checked before being saved under the existing resumable cache keys.
Unavailable or invalid CDN data falls back to the pinned Hugging Face source.
Completed browser caches skip the CDN entirely, and saved partial downloads
can combine origin and CDN transfers. Storage errors do not trigger redownloads.

R2 has no internet egress fees, but storage and request usage can incur charges
above the account's free allowances. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
and [R2 caching](https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/).

The real compressed bundle passed a local Chromium transfer/decode/cache test
in 4.367 seconds (28 requests, including the manifest), reconstructing the exact
219,121,675-byte source. This is a local validation, **not an internet CDN speed
measurement**. At 100 Mbps the compressed payload alone requires at least 13.9
seconds, before storage, initialization, and network overhead.

The deployed R2 bundle was also verified from the Mac browser on 2026-09-17:
38.685 seconds for a fresh transfer and durable cache save, 28 CDN requests,
zero Hugging Face requests, and the exact publisher SHA-256 after decompression.
A subsequent full browser-cache read took 0.129 seconds with networking blocked
by the test fetch function. These timings exclude inference. Cloudflare response
headers confirmed `CF-Cache-Status: HIT`, the intended CORS origins, and no
`Content-Encoding` on gzip objects. This is one live observation, not a guaranteed
speed or a controlled comparison against the development-machine measurements.

The initial upload credential was restricted to objects in `nobg-models` and
revoked after the verified upload. The application needs only the public CDN
URL; no R2 keys belong in the browser bundle or Vercel environment.

For future uploads, a separate `nobg-models upload` token is scoped to object
read/write access in this bucket. Its values are stored locally in the ignored
`.env.r2.local` file: `R2_API_TOKEN`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, and `R2_ENDPOINT`. This file is explicitly
excluded from Vercel uploads. The token has no access to other buckets or DNS.

At 1,000 new desktop downloads per month, the bundle transfers approximately
174 GB and uses 28,000 object reads before CDN caching, while storing only
174 MB. With the account's shared free allowances still available, that adds
$0 in R2 charges. This estimate excludes unrelated account usage and retries.

```sh
bun scripts/benchmark-model-download.mjs --desktop --assets-dir=.model-assets
```

## Measurements

### Same-Mac comparison, 2026-09-17

Three fresh downloads per host in the Mac's Chromium 152 preview, on the same
connection, produced the following transfer-plus-save times:

| Delivery | Run 1 | Run 2 | Run 3 | Median |
| --- | ---: | ---: | ---: | ---: |
| Hugging Face, original FP16 file | 47.590 s | 58.124 s | 53.432 s | 53.432 s |
| R2 CDN, losslessly compressed FP16 parts | 37.181 s | 42.861 s | 36.858 s | 37.181 s |

R2's median time was **30.4% lower** (16.251 seconds saved), and every R2 run
was faster than every Hugging Face run in this sample. This supports using R2
for this Mac/connection; it does not establish a global speed guarantee. The
gain includes the 20.5% payload reduction from lossless compression.

All six runs reconstructed 219,121,675 bytes with the exact publisher SHA-256.
Every HF run fetched all 27 ranges; every R2 run fetched the manifest plus all
27 gzip parts, with no origin fallback. R2 payloads including the manifest were
174,215,526 bytes versus 219,121,675 bytes from HF. Both bypassed the browser's
HTTP cache and started with empty benchmark caches.

[Raw measurements and browser metadata](benchmarks/model-hosts-mac-2026-09-17.json)
are committed alongside the reproducible harness below.

For a same-device host comparison, bundle the standalone browser harness:

```sh
bun build scripts/compare-model-hosts.mjs --target=browser --format=iife --outfile=/tmp/compare-model-hosts.js
```

Paste the bundle into DevTools on `https://nobg.ordinity.com` or
`https://nobg-nu.vercel.app`, then run `await window.compareModelHosts(console.log)`.
It transfers approximately 1.18 GB: three full downloads from each host in
HF/R2/R2/HF/HF/R2 order. Both use four lanes, empty benchmark model caches, and
`cache: "no-store"` for every fetch. Existing complete user caches are preserved;
an unfinished user download blocks the benchmark instead of being erased.
Each result checks the original model's full SHA-256. Timing includes transfer,
decompression where applicable, and durable cache storage, excluding inference
and final checksum verification. CDN warmth and unrelated network traffic are
uncontrolled; this measures the two deployed delivery strategies, not hosting
providers in isolation with identical wire encodings.

To compare R2 download concurrency with three rotated repetitions per setting
(approximately 1.57 GB transferred), use the same bundle and run:

```js
await window.compareModelHosts(console.log,
  [4, 6, 8, 6, 8, 4, 8, 4, 6].map(concurrency => ({ host: "r2", concurrency })),
);
```

These are concurrent network requests inside one downloader. Adding image
inference workers does not add download lanes: workers share a download lock
and browser cache.

`bun scripts/benchmark-model-download.mjs --baseline=HEAD` compares the working
tree with a Git revision in fresh Chromium contexts. Add `--remote` to download
real pinned files, and `--desktop` for BEN2. Remote mode downloads the file four
times and checks each result against the publisher's LFS SHA-256. It measures
transfer plus durable cache storage, excluding model initialization and inference.

Single sequential runs on the development machine, 2026-09-17, comparing with
`c5b5f6d`:

| Transfer | Previous, 4 lanes | Headers first, 4 lanes | 6 lanes | 8 lanes |
| --- | ---: | ---: | ---: | ---: |
| Local per-request limit, 44 MB | 5.29 s | 4.66 s | 2.57 s | 2.55 s |
| Hugging Face, mobile 44 MB | 17.18 s | 10.26 s | 10.35 s | 10.83 s |
| Hugging Face, desktop 219 MB | 53.77 s | 66.74 s | 59.41 s | 67.40 s |

These are individual observations, not statistically controlled speedup claims.
The local fixture limits each request independently, so it illustrates available
parallelism, not a shared last-mile bandwidth limit. The live desktop results do
not demonstrate a speedup; raising concurrency was therefore not adopted.
At 100 Mbps, 219 MB needs at least 17.5 seconds of transfer even before request,
storage, and initialization overhead. A saved model requires no model transfer.

Desktop SHA-256, matching the publisher's pinned file:
`dfdc25f421f32a0d1268e0f2ff2153d340e8f1d52d3dd16f5dc33c1ce85cedf1`.

## Desktop GPU compatibility and recovery

The default advanced graph optimizations in ONNX Runtime
`1.31.0-dev.20260914-8d85527a0` generate an invalid BEN2 LayerNorm shader:
`cannot assign 'vec4<f16>' to 'vec4<f32>'`. This was reproduced on the Mac
preview's Apple Metal GPU with a 256 × 256 synthetic image, ruling out large
photo dimensions as a necessary trigger. The adapter advertises `shader-f16`.

Desktop WebGPU now uses `graphOptimizationLevel: "basic"`, preserving the
graph's casts and avoiding the invalid fusion. The model file, requested FP16
precision, and output resolution are unchanged. Mobile and WASM keep their
existing optimization settings. Selectively disabling named fusion optimizers
did not resolve the error in this runtime; both `basic` and `disabled` worked,
so basic optimizations are retained.

On the same Mac preview, the supplied 1488 × 1984 photo completed on WebGPU in
5.246 seconds after initialization (7.756 seconds including cached model
initialization). The result retained the original dimensions, with 2,663,079
nearly transparent pixels and 279,401 opaque foreground pixels. The full CPU
recovery test also processed that photo without a model re-download. These are
individual validation timings, not cross-browser performance guarantees.

In the installed Transformers.js 4.3.0, `webInitChain` and `webInferenceChain`
chain operations with `.then(...)` without recovering rejected promises. A
WebGPU shader failure therefore also poisons later CPU attempts within that
worker. Recreating only the pipeline does not reset the runtime.

On GPU initialization or inference failure, the worker asks the pool to recover.
The pool terminates the GPU workers, requeues all unfinished jobs, and starts
one fresh worker explicitly using WASM. Its runtime reads the same saved model.
Late messages from terminated workers are ignored, and CPU failures cannot
trigger an automatic restart loop. Download/storage errors remain errors rather
than triggering GPU recovery.

Checks:

```sh
bun scripts/model-download.test.mjs
bun scripts/remover-worker.test.mjs
bun scripts/mobile-runtime.test.mjs
bun run lint
bun run build
bun run start --port 3027
# Separately, with a foreground/background photo:
bun scripts/desktop-recovery-smoke.mjs /path/to/photo.jpg
```

The desktop smoke test requests fallback at the worker protocol boundary, then
checks real BEN2 FP16 CPU inference, queued images, and absence of model downloads
during recovery. It does not reproduce a particular Mac GPU shader failure.
