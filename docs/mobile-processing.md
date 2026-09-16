# Mobile image processing

Android/mobile browsers and touch-enabled iPads use the quantized
[ISNet model](https://huggingface.co/xrds/isnet-general-onnx-int8), pinned to
`71eff2372ec9c8edbc6ca637ded591423d23b65a`. Its ONNX file is 44,229,662 bytes.
It handles general subjects, rather than only portraits. Results can differ
from the desktop BEN2 model, especially around fine edges.

Mobile processing uses one worker and a single WASM thread. It tries WebGPU,
then retries with WASM if GPU initialization or inference fails. A failed GPU
pipeline is disposed before loading the CPU fallback. Download/storage errors
are reported without trying to download the same model through another device.

Before copying decoded pixels into JavaScript, large photos are drawn into a
canvas with a maximum longest edge of 1536 pixels. Aspect ratio and transparency
are preserved; smaller images are not enlarged. The original upload remains
available for comparison, while the downloaded PNG uses the bounded dimensions.
The browser still needs enough memory to decode the original photo.

Both models use the existing resumable download cache. Mobile workers never
download BEN2. Worker startup failures and crashes fail affected jobs visibly,
and selecting another image can start a fresh worker. Per-image failures allow
the remaining queue to continue. Error details appear below the filename so
touch users can read them without hovering.

## Verification

```sh
bun scripts/mobile-runtime.test.mjs
bun scripts/remover-worker.test.mjs
bun scripts/model-download.test.mjs
bun run lint
bun run build
bun run start --port 3016
# In another terminal, supply a real photo containing foreground/background:
bun scripts/mobile-smoke.mjs /path/to/photo.jpg
```

The smoke test downloads the actual model and performs inference in Chromium
with a mobile user agent and viewport. It reports the execution device, checks
PNG transparency and foreground pixels, verifies the size limit, and checks for
horizontal overflow. This does not reproduce an Android GPU driver, Chrome tab
memory limits, or performance on a OnePlus Nord 6; those require a physical-phone
test over HTTPS. Keep the tab foregrounded during that test.
