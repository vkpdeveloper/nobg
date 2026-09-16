// Run against `bun run start --port 3016` with a photo fixture:
// bun scripts/mobile-smoke.mjs /path/to/photo.jpg
import assert from "node:assert/strict";
import { chromium } from "playwright";

const fixture = process.argv[2];
if (!fixture) throw new Error("Pass a photo fixture path");
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 412, height: 915 },
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (Linux; Android 16; OnePlus Nord 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36",
});
const page = await context.newPage();
await page.addInitScript(() => {
  window.testDevices = [];
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", ({ data }) => {
        if (data.type === "ready") window.testDevices.push(data.device);
      });
    }
  };
});
const errors = [];
const models = new Set();
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  if (request.url().includes(".onnx")) models.add(request.url());
});
page.on("console", (message) => {
  if (message.type() === "error") console.error(message.text().slice(0, 400));
});
try {
  await page.goto(process.env.NOBG_TEST_URL ?? "http://localhost:3016");
  await page.setInputFiles('input[type="file"]', fixture);
  await page.waitForFunction(() => document.querySelector("a[download]") ||
    document.body.innerText.includes("Couldn't process"), null, { timeout: 300_000 });
  const failure = await page.locator("[title]").evaluateAll((nodes) =>
    nodes.filter((node) => node.textContent.includes("Couldn't process")).map((node) => node.title));
  assert.deepEqual(failure, [], `Processing failed: ${failure}`);
  const result = await page.evaluate(async () => {
    const blob = await (await fetch(document.querySelector("a[download]").href)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let transparent = 0;
    let foreground = 0;
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] < 20) transparent++;
      if (data[index] > 200) foreground++;
    }
    bitmap.close();
    return { width: canvas.width, height: canvas.height, transparent, foreground, type: blob.type, devices: window.testDevices,
      overflow: document.documentElement.scrollWidth > window.innerWidth };
  });
  assert.equal(result.type, "image/png");
  assert.ok(Math.max(result.width, result.height) <= 1536);
  assert.ok(result.transparent > 0 && result.foreground > 0, "mask preserves a subject and removes a background");
  assert.equal(result.overflow, false);
  assert.ok([...models].some((url) => url.includes("isnet-general-onnx-int8")));
  assert.ok([...models].every((url) => !url.includes("BEN2")), "phone must not download the desktop model");
  assert.deepEqual(errors, []);
  assert.ok(result.devices.length > 0, "worker reported its execution device");
  console.log("PASS mobile Chromium image processing", result);
} finally {
  await browser.close();
}
