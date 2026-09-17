# Device-adaptive processing

The model is picked from device signals, not just a mobile/desktop split.
Four quality tiers exist (see `src/lib/model-config.ts`):

| Tier | Model | Input | Longest edge | Download |
| --- | --- | --- | --- | --- |
| Best | BEN2 FP16, 219,121,675 bytes | 1024x1024 | unbounded | ~220 MB |
| Balanced | ISNet INT8, 44,229,662 bytes | 1024x1024 | 1536 | ~44 MB |
| Light | ISNet INT8 (same file) | 512x512 | 1024 | ~44 MB |
| Basic | U-2-Netp FP32, 4,574,861 bytes | 320x320 | 1024 | ~4.6 MB |

`pickTier` in `src/lib/device.ts` maps signals to a tier: no WASM SIMD is
always basic; iOS is always light; other mobile is basic at <=2 GB RAM,
balanced with WebGPU and >=8 GB, otherwise light; desktop WebGPU is best unless
memory is low or the GPU vendor is Intel (integrated GPUs get balanced);
CPU-only desktops get balanced at >=8 cores/8 GB, light at >=4 cores/4 GB,
else basic. The light tier reuses the ISNet download and only shrinks the
processor's resize target — ISNet's ONNX inputs are dynamic.

U-2-Netp uses a fixed 320x320 input and an unknown `u2net` model_type, so the
model fetch serves synthetic `config.json` and `preprocessor_config.json`
inline (an `isnet` model type plus a padding-free `ViTFeatureExtractor`
config). See `MODEL_CONFIG_OVERRIDES` in `src/lib/model-config.ts`.

A native `<select>` in the header overrides the auto pick (`nobg:quality` in
localStorage). If a worker dies mid-inference or reports an out-of-memory
error, the pool drops one tier (`nobg:tier-cap`), replays the interrupted
jobs on a fresh worker, and shows a notice. The cap persists so the next
visit avoids the crash. A `nobg:inflight` marker written before dispatch
catches full page crashes: if it is still fresh at the next warmup, the tier
is capped as well. Each job gets at most one OOM retry.

Processing uses one worker and a single WASM thread on mobile. It tries
WebGPU, then retries with WASM in a fresh worker if GPU initialization or
inference fails. The pool terminates the GPU workers before starting the CPU
worker and replays unfinished images. This resets Transformers.js's rejected
runtime promise chains and releases the GPU resources. The CPU worker reads
the same model and precision from the shared cache. Download/storage errors
are reported without trying to download the same model through another device.

Before copying decoded pixels into JavaScript, large photos are drawn into a
canvas bounded to the tier's longest edge. Aspect ratio and transparency are
preserved; smaller images are not enlarged. The original upload remains
available for comparison, while the downloaded PNG uses the bounded
dimensions. The browser still needs enough memory to decode the original
photo.

All models use the existing resumable download cache and the R2 CDN bundles.
Worker startup failures and crashes fail affected jobs visibly, and selecting
another image can start a fresh worker. Per-image failures allow the
remaining queue to continue. Error details appear below the filename so
touch users can read them without hovering.

## Verification

```sh
bun run test
bun run lint
bun run build
bun run start --port 3016
# In another terminal, supply a real photo containing foreground/background:
bun scripts/mobile-smoke.mjs /path/to/photo.jpg
# Exercise every tier (or a subset) with real model downloads:
bun scripts/tier-smoke.mjs /path/to/photo.jpg [basic|light|balanced|best ...]
# A specific tier can also be forced via localStorage["nobg:quality"].
```

The smoke test downloads the actual model and performs inference in Chromium
with a mobile user agent and viewport. It reports the execution device, checks
PNG transparency and foreground pixels, verifies the size limit, and checks for
horizontal overflow. This does not reproduce an Android GPU driver, Chrome tab
memory limits, or performance on a OnePlus Nord 6; those require a physical-phone
test over HTTPS. Keep the tab foregrounded during that test.
