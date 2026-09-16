// Run against a production server: NOBG_TEST_URL=http://localhost:3027 \
// bun scripts/desktop-recovery-smoke.mjs /path/to/photo.jpg
// Exercises real BEN2 FP16 inference and cache reuse after a simulated worker
// fallback request. Hardware-specific shader failures still need a device test.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { DESKTOP_ASSET_PATH } from "../src/lib/model-config.ts";

const fixture = process.argv[2];
if (!fixture) throw new Error("Pass a photo fixture path");
const imageCount = process.argv.includes("--single") ? 1 : 2;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.recovery = { created: 0, terminated: 0, loads: [], devices: [], injected: false };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.index = window.recovery.created++;
        this.addEventListener("message", ({ data }) => {
          if (data.type === "ready") window.recovery.devices.push(data.device);
        });
      }
      postMessage(message, ...args) {
        if (message.type === "load") window.recovery.loads.push(message.device ?? "auto");
        if (this.index === 0 && message.type === "process") {
          window.recovery.injected = true;
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { type: "fallback" } })));
          return;
        }
        return super.postMessage(message, ...args);
      }
      terminate() { window.recovery.terminated++; return super.terminate(); }
    };
  });
  let modelRequests = 0;
  const modelUrls = new Set();
  const isCompressedModelPart = (url) => new URL(url).pathname.startsWith(`${DESKTOP_ASSET_PATH}/part-`) &&
    new URL(url).pathname.endsWith(".gz");
  const errors = [];
  page.on("request", (request) => {
    if ((request.url().includes(".onnx") || isCompressedModelPart(request.url())) && !request.redirectedFrom()) {
      modelRequests++;
      modelUrls.add(request.url());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.env.NOBG_TEST_URL ?? "http://localhost:3027");
  await page.waitForFunction(() => document.body.innerText.includes("Ready"), null, { timeout: 300_000 });
  const downloaded = modelRequests;
  assert.ok(downloaded > 0);
  console.log(`Model ready after ${downloaded} model-part requests; injecting worker fallback`);
  await page.setInputFiles('input[type="file"]', Array(imageCount).fill(fixture));
  await page.waitForFunction((count) => document.querySelectorAll("a[download]").length === count ||
    document.body.innerText.includes("Couldn't process"), imageCount, { timeout: 600_000 });
  assert.equal(await page.locator("a[download]").count(), imageCount, await page.locator("body").innerText());
  const result = await page.evaluate(async () => {
    const blob = await (await fetch(document.querySelector("a[download]").href)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let transparent = 0;
    let foreground = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 20) transparent++;
      if (data[i] > 200) foreground++;
    }
    bitmap.close();
    return { ...window.recovery, width: canvas.width, height: canvas.height, transparent, foreground };
  });
  assert.ok(result.injected);
  assert.equal(result.created, 2);
  assert.equal(result.terminated, 1);
  assert.deepEqual(result.loads, ["auto", "wasm"]);
  assert.equal(result.devices.at(-1), "wasm");
  assert.ok(result.transparent > 0 && result.foreground > 0);
  assert.equal(modelRequests, downloaded, "CPU recovery must use the saved model without network requests");
  assert.ok([...modelUrls].every((url) => isCompressedModelPart(url) ||
    (url.includes("BEN2-ONNX") && url.includes("model_fp16.onnx"))));
  assert.deepEqual(errors, []);
  console.log("PASS real BEN2 FP16 inference, fresh CPU worker, and zero model re-downloads", { images: imageCount, ...result });
} finally {
  await browser.close();
}
