// Run against `bun run start --port 3031` with a photo fixture:
// bun scripts/tier-smoke.mjs /path/to/photo.jpg [tier ...]
// Forces each tier via localStorage["nobg:quality"] before page load.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const fixture = process.argv[2];
if (!fixture) throw new Error("Pass a photo fixture path");
const tiers = process.argv.slice(3);
const target = tiers.length ? tiers : ["basic", "light", "balanced", "best"];
const origin = process.env.NOBG_TEST_URL ?? "http://localhost:3031";

const browser = await chromium.launch();
const results = [];
try {
  for (const tier of target) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript((t) => {
      localStorage.setItem("nobg:quality", t);
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
    }, tier);
    const errors = [];
    const models = new Set();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.url().includes(".onnx")) models.add(request.url());
    });
    page.on("console", (message) => {
      if (message.type() === "error") console.error(`[${tier}]`, message.text().slice(0, 400));
    });
    const startedAt = Date.now();
    await page.goto(origin);
    await page.setInputFiles('input[type="file"]', fixture);
    await page.waitForFunction(() => document.querySelector("a[download]") ||
      document.body.innerText.includes("Couldn't process"), null, { timeout: 600_000 });
    const failure = await page.locator("[title]").evaluateAll((nodes) =>
      nodes.filter((node) => node.textContent.includes("Couldn't process")).map((node) => node.title));
    assert.deepEqual(failure, [], `Processing failed on tier ${tier}: ${failure}`);
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
      const readyText = document.body.innerText.match(/Ready[^\n]*/)?.[0];
      return { width: canvas.width, height: canvas.height, transparent, foreground,
        type: blob.type, devices: window.testDevices, readyText };
    });
    result.ms = Date.now() - startedAt;
    result.tier = tier;
    result.model = [...models].map((url) => url.split("/").pop());
    assert.equal(result.type, "image/png");
    assert.ok(result.transparent > 0 && result.foreground > 0,
      `tier ${tier}: mask preserves a subject and removes a background`);
    assert.deepEqual(errors, []);
    assert.ok(result.devices.length > 0, "worker reported its execution device");
    results.push(result);
    console.log(`PASS ${tier}`, JSON.stringify(result));
    await context.close();
  }
} finally {
  await browser.close();
}
