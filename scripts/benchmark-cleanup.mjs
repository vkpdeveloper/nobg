// Runs the actual mask engine in a Chromium Web Worker. Requires installed Playwright Chromium.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, cpus, totalmem } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { chromium } from "playwright";
const directory = mkdtempSync(join(tmpdir(), "nobg-bench-"));
const server = createServer((req, res) => {
  res.setHeader(
    "Content-Type",
    req.url.endsWith(".js") ? "text/javascript" : "text/html",
  );
  res.end(
    req.url.endsWith(".js")
      ? readFileSync(
          join(directory, req.url === "/editor.js" ? "editor.js" : "worker.js"),
        )
      : "<!doctype html><title>Cleanup benchmark</title>",
  );
});
let browser;
try {
  execFileSync("bun", [
    "build",
    "scripts/cleanup-benchmark.worker.ts",
    "--target=browser",
    `--outfile=${join(directory, "worker.js")}`,
  ]);
  execFileSync("bun", [
    "build",
    "src/workers/cleanup.worker.ts",
    "--target=browser",
    `--outfile=${join(directory, "editor.js")}`,
  ]);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const results = [];
  for (const [width, height] of [
    [1024, 1024],
    [1920, 1080],
    [4000, 3000],
  ]) {
    const result = await page.evaluate(
      ({ width, height }) =>
        new Promise((resolve, reject) => {
          const worker = new Worker("/worker.js");
          worker.onmessage = (event) => {
            worker.terminate();
            resolve(event.data);
          };
          worker.onerror = (event) => reject(new Error(event.message));
          worker.postMessage({ width, height, iterations: 7 });
        }),
      { width, height },
    );
    const summary = Object.fromEntries(
      Object.entries(result.records).map(([name, values]) => {
        const sorted = [...values].sort((a, b) => a - b);
        return [
          name,
          {
            medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
            p95Ms: +sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(2),
          },
        ];
      }),
    );
    results.push({ ...result, summary });
    console.log(
      JSON.stringify({
        width,
        height,
        summary,
        retainedMaskMiB: +(result.retainedMaskBytes / 1048576).toFixed(1),
      }),
    );
  }
  const integration = [];
  for (const [width, height] of [
    [1920, 1080],
    [4000, 3000],
  ]) {
    const result = await page.evaluate(
      async ({ width, height }) => {
        const source = new OffscreenCanvas(width, height),
          ctx = source.getContext("2d");
        ctx.fillStyle = "#a67550";
        ctx.fillRect(width * 0.08, height * 0.1, width * 0.55, height * 0.8);
        const x = Math.floor(width * 0.78),
          y = Math.floor(height * 0.45),
          w = Math.floor(width * 0.06),
          h = Math.floor(height * 0.08);
        ctx.fillStyle = "#e4b929";
        ctx.fillRect(x, y, w, h);
        const blob = await source.convertToBlob({ type: "image/png" });
        const worker = new Worker("/editor.js");
        const target = document.createElement("canvas");
        document.body.append(target);
        const samples = [];
        const request = (message) =>
          new Promise((resolve, reject) => {
            const start = performance.now();
            worker.onerror = (event) => reject(new Error(event.message));
            worker.onmessage = async (event) => {
              const data = event.data;
              if (data.type === "error") {
                reject(new Error(data.message));
                return;
              }
              if (data.type === "frame") {
                target.width = data.bitmap.width;
                target.height = data.bitmap.height;
                target.getContext("2d").drawImage(data.bitmap, 0, 0);
                data.bitmap.close();
              }
              const roundTripMs = performance.now() - start;
              await new Promise(requestAnimationFrame);
              samples.push({
                operation: message.type,
                workerMs: data.elapsed,
                roundTripMs,
                nextFrameMs: performance.now() - start,
              });
              resolve();
            };
            worker.postMessage(message);
          });
        await request({ type: "init", blob, base: blob });
        await request({
          type: "resize",
          width: Math.round(width * Math.min(1, 1200 / width)),
          height: Math.round(height * Math.min(1, 1200 / width)),
        });
        const points = [
          { x: x - 10, y: y - 10 },
          { x: x + w + 10, y: y - 10 },
          { x: x + w + 10, y: y + h + 10 },
          { x: x - 10, y: y + h + 10 },
        ];
        for (let i = 0; i < 7; i++) {
          await request({ type: "select", points });
          await request({ type: "clear" });
        }
        await request({ type: "select", points });
        await request({ type: "remove" });
        await request({ type: "undo" });
        await request({ type: "select", points });
        worker.postMessage({ type: "begin" });
        for (let i = 0; i < 12; i++)
          await request({
            type: "brush",
            points: [
              { x: width / 3 + i * 5, y: height / 2 },
              { x: width / 3 + i * 5 + 5, y: height / 2 },
            ],
            radius: 20,
            restore: false,
            hardness: 0.8,
          });
        await request({ type: "commit" });
        await request({ type: "export" });
        worker.terminate();
        target.remove();
        return { width, height, previewWidth: 1200, samples };
      },
      { width, height },
    );
    integration.push(result);
    const summarize = (samples) => {
      const values = samples.map((s) => s.roundTripMs).sort((a, b) => a - b);
      return {
        medianMs: +values[Math.floor(values.length / 2)].toFixed(2),
        p95Ms: +values[Math.ceil(values.length * 0.95) - 1].toFixed(2),
      };
    };
    console.log(
      JSON.stringify({
        integration: {
          width,
          height,
          initMs: +result.samples[0].roundTripMs.toFixed(2),
          cachedSelection: summarize(
            result.samples.filter((s) => s.operation === "select").slice(0, 7),
          ),
          brushFrame: summarize(
            result.samples.filter((s) => s.operation === "brush"),
          ),
          exportMs: +result.samples.at(-1).roundTripMs.toFixed(2),
        },
      }),
    );
  }
  const report = {
    date: new Date().toISOString(),
    cpu: cpus()[0].model,
    logicalCores: cpus().length,
    memoryGiB: +(totalmem() / 1073741824).toFixed(1),
    browser: browser.version(),
    method:
      "Chromium headless Web Worker; synthetic alpha masks; 1 warmup + 7 measured iterations per size; brush = 20 segments, 40px diameter; excludes decode, rendering and PNG export; p95 is maximum with 7 samples; retained mask bytes excludes canvas, temporary queue and browser overhead.",
    results,
    integration,
  };
  if (process.argv[2])
    writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + "\n");
} finally {
  await browser?.close();
  server.close();
  rmSync(directory, { recursive: true, force: true });
}
