import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";

const URL_ = "http://localhost:3000";
const TEST_IMAGES = [
  "/tmp/nobg-test-1.jpg",
  "/tmp/nobg-test-2.jpg",
  "/tmp/nobg-test-3.jpg",
];
const OUT_PNG = "/tmp/nobg-out.png";
const SHOTS = "/tmp/nobg-shots";
const READY_TIMEOUT = 10 * 60 * 1000;

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

let consoleErrors = 0;
let modelRequests = 0; // logical fetch chains for the model file
page.on("console", (m) => {
  if (m.type() === "error") {
    consoleErrors++;
    log("console.error:", m.text().slice(0, 300));
  }
});
page.on("pageerror", (e) => {
  consoleErrors++;
  log("pageerror:", String(e).slice(0, 300));
});
page.on("request", (req) => {
  if (req.url().includes("model_fp16.onnx") && !req.redirectedFrom()) {
    const range = req.headers()["range"];
    log("model fetch:", req.method(), range ? `Range:${range}` : "full");
    if (req.method() === "GET" && !range) modelRequests++;
  }
});
page.on("response", async (res) => {
  const req = res.request();
  if (req.url().includes("model_fp16.onnx") && !req.redirectedFrom()) {
    log(
      "model response:",
      res.status(),
      "bytes:",
      res.headers()["content-length"] ?? "?",
    );
  }
});

// --- empty state, light ---
await page.emulateMedia({ colorScheme: "light" });
await page.goto(URL_, { waitUntil: "domcontentloaded" });
await page.waitForSelector("text=Drop images here");
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOTS}/empty-light.png` });
log("shot: empty-light");

// --- empty state, dark ---
await page.emulateMedia({ colorScheme: "dark" });
await page.waitForTimeout(300);
await page.screenshot({ path: `${SHOTS}/empty-dark.png` });
await page.emulateMedia({ colorScheme: "light" });
await page.waitForTimeout(300);
log("shot: empty-dark");

// --- wait for Ready ---
const t0 = Date.now();
await page.waitForFunction(
  () => document.body.innerText.includes("Ready"),
  null,
  { timeout: READY_TIMEOUT },
);
log(`engine ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const cacheKeys = await page.evaluate(() => caches.keys());
log("cache keys:", JSON.stringify(cacheKeys));

const soundLabel = await page.evaluate(
  () =>
    document
      .querySelector('button[aria-label$="sounds"]')
      ?.getAttribute("aria-label"),
);
log("sound toggle aria-label:", soundLabel);

// --- upload 3 images at once ---
await page.setInputFiles('input[type="file"]', TEST_IMAGES);
const donePoll = setInterval(async () => {
  const n = await page
    .evaluate(() => document.querySelectorAll("a[download]").length)
    .catch(() => -1);
  log(`done cards: ${n}/3`);
}, 30000);
try {
  await page.waitForFunction(
    () => document.querySelectorAll("a[download]").length >= 3,
    null,
    { timeout: 15 * 60 * 1000 },
  );
} finally {
  clearInterval(donePoll);
}
await page.waitForTimeout(800);
await page.screenshot({ path: `${SHOTS}/results-light.png` });
log("shot: results-light (3 done)");

// --- extract first result blob ---
const b64 = await page.evaluate(async () => {
  const a = document.querySelector("a[download]");
  const res = await fetch(a.href);
  const buf = await res.arrayBuffer();
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
});
const png = Buffer.from(b64, "base64");
await writeFile(OUT_PNG, png);
log(`saved ${OUT_PNG} (${png.length} bytes)`);
log(`PNG color type: ${png[25]} (6 = RGBA)`);

const alpha = await page.evaluate(async (b64in) => {
  const blob = await (await fetch("data:image/png;base64," + b64in)).blob();
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(bmp, 0, 0);
  let transparent = 0;
  const step = Math.max(1, Math.floor((bmp.width * bmp.height) / 20000));
  const all = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  for (let i = 3; i < all.length; i += 4 * step) if (all[i] === 0) transparent++;
  return { transparent, sampled: Math.ceil(all.length / 4 / step) };
}, b64);
log(`fully transparent px: ${alpha.transparent}/${alpha.sampled}`);

// --- second load: cache hit + fast ready ---
const t1 = Date.now();
await page.goto(URL_, { waitUntil: "domcontentloaded" });
await page.waitForFunction(
  () => document.body.innerText.includes("Ready"),
  null,
  { timeout: 120000 },
);
log(`second load ready in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

// --- dev overlay issue check ---
const overlayIssues = await page.evaluate(() => {
  const portal = document.querySelector("nextjs-portal");
  if (!portal?.shadowRoot) return 0;
  const text = portal.shadowRoot.textContent || "";
  const m = text.match(/(\d+)\s+issue/i);
  return m ? Number(m[1]) : 0;
});

await browser.close();

log("--- assertions ---");
log(`model_fp16.onnx requests: ${modelRequests} (expect <= 1)`);
log(`console/page errors: ${consoleErrors} (expect 0)`);
log(`overlay issues: ${overlayIssues} (expect 0)`);
log(`sound label: ${soundLabel} (expect "Mute sounds")`);

if (modelRequests > 1) { console.error("FAIL: model fetched more than once"); process.exit(1); }
if (consoleErrors > 0) { console.error("FAIL: console errors"); process.exit(1); }
if (overlayIssues > 0) { console.error("FAIL: dev overlay issues"); process.exit(1); }
if (soundLabel !== "Mute sounds") { console.error("FAIL: sound default"); process.exit(1); }
log("E2E SMOKE PASSED");
