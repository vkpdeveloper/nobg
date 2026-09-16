// Exercise the real editor/worker/export flow. Only BEN2 is replaced with a
// deterministic transparent fixture to avoid a model download and inference.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    let removerURL;
    window.__cleanupMetrics = [];
    window.Worker = class extends EventTarget {
      constructor(url, options) {
        super();
        // The app warms its background remover first; production URLs are hashed.
        removerURL ??= String(url);
        if (String(url) !== removerURL) {
          const real = new NativeWorker(url, options);
          const pending = [];
          const post = real.postMessage.bind(real);
          real.postMessage = (message) => {
            if (!["begin", "export"].includes(message.type))
              pending.push({ type: message.type, start: performance.now() });
            post(message);
          };
          real.addEventListener("message", (event) => {
            if (event.data.type === "frame") {
              const request = pending.shift();
              window.__cleanupMetrics.push({
                operation: event.data.operation,
                workerMs: event.data.elapsed,
                roundTripMs: request ? performance.now() - request.start : null,
              });
            }
          });
          return real;
        }
      }
      postMessage(message) {
        if (message.type === "load")
          setTimeout(
            () => this.onmessage?.({ data: { type: "ready", device: "wasm" } }),
            10,
          );
        if (message.type === "process")
          createImageBitmap(message.file).then((bitmap) => {
            this.onmessage?.({
              data: {
                type: "result",
                id: message.id,
                blob: message.file,
                width: bitmap.width,
                height: bitmap.height,
              },
            });
            bitmap.close();
          });
      }
      terminate() {}
    };
  });
  await page.goto(process.env.CLEANUP_URL ?? "http://localhost:3011");
  const data = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 400;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#a67550";
    ctx.fillRect(40, 40, 280, 320);
    ctx.fillStyle = "rgba(220,180,30,0.2)";
    ctx.fillRect(444, 144, 62, 92);
    ctx.fillStyle = "#e4b929";
    ctx.fillRect(450, 150, 50, 80);
    return canvas.toDataURL().split(",")[1];
  });
  await page.locator("input[type=file]").setInputFiles({
    name: "cleanup-fixture.png",
    mimeType: "image/png",
    buffer: Buffer.from(data, "base64"),
  });
  await page.getByRole("button", { name: "Clean up", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const idle = () =>
    page.waitForFunction(() => {
      const status =
        document.querySelector("dialog [role=status]")?.textContent ?? "";
      return (
        status && !status.includes("Preparing") && !status.includes("Updating")
      );
    });
  await idle();
  const canvas = page.getByLabel("Image cleanup canvas");
  const alpha = (x, y) =>
    canvas.evaluate(
      (node, p) =>
        node
          .getContext("2d")
          .getImageData(
            Math.floor((p.x * node.width) / 600),
            Math.floor((p.y * node.height) / 400),
            1,
            1,
          ).data[3],
      { x, y },
    );
  const position = async (x, y) => {
    const r = await canvas.boundingBox();
    return { x: r.x + (x * r.width) / 600, y: r.y + (y * r.height) / 400 };
  };
  const stroke = async (points) => {
    const start = await position(...points[0]);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (const p of points.slice(1)) {
      const end = await position(...p);
      await page.mouse.move(end.x, end.y, { steps: 5 });
    }
    await page.mouse.up();
    await idle();
  };
  await stroke([
    [430, 130],
    [520, 130],
    [520, 250],
    [430, 250],
    [430, 130],
  ]);
  await page
    .getByRole("button", { name: "Remove selected", exact: true })
    .click();
  await idle();
  assert.equal(await alpha(475, 190), 0);
  assert.equal(await alpha(445, 145), 0);
  assert.equal(await alpha(100, 100), 255);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await idle();
  assert.equal(await alpha(475, 190), 255);
  await page.keyboard.press("Control+Shift+z");
  await idle();
  assert.equal(await alpha(475, 190), 0);
  await page
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await dialog.waitFor({ state: "detached" });
  const href = await page
    .getByRole("link", { name: "Download", exact: true })
    .getAttribute("href");
  const exported = await page.evaluate(async (url) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = c.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    return {
      width: c.width,
      height: c.height,
      alpha: ctx.getImageData(475, 190, 1, 1).data[3],
    };
  }, href);
  assert.deepEqual(exported, { width: 600, height: 400, alpha: 0 });
  await page.getByRole("button", { name: "Clean up", exact: true }).click();
  await idle();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await stroke([
    [460, 190],
    [490, 190],
  ]);
  assert.equal(await alpha(475, 190), 255);
  const color = await canvas.evaluate((node) => [
    ...node.getContext("2d").getImageData(475, 190, 1, 1).data,
  ]);
  assert.deepEqual(color, [228, 185, 41, 255]);
  await page.getByRole("button", { name: "Erase", exact: true }).click();
  await stroke([
    [100, 100],
    [220, 100],
  ]);
  assert.equal(await alpha(160, 100), 0);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await stroke([
    [100, 160],
    [220, 160],
  ]);
  assert.equal(await alpha(160, 160), 0);
  await page.getByRole("button", { name: "Close editor", exact: true }).click();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await page.getByRole("button", { name: "Smart Remove", exact: true }).click();
  await page.getByRole("button", { name: "Fit image", exact: true }).click();
  await stroke([
    [40, 40],
    [80, 40],
    [80, 80],
    [40, 80],
    [40, 40],
  ]);
  assert.equal(
    await page
      .getByRole("button", { name: "Remove selected", exact: true })
      .count(),
    0,
  );
  assert.match(await dialog.getByRole("status").innerText(), /extends outside/);
  await page.screenshot({ path: "/tmp/nobg-cleanup-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/nobg-cleanup-mobile.png" });
  const dimensions = await dialog.evaluate((node) => ({
    width: node.getBoundingClientRect().width,
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  }));
  assert.ok(
    dimensions.width <= 390 && dimensions.scrollWidth <= dimensions.clientWidth,
  );
  await page.getByRole("button", { name: "Erase", exact: true }).click();
  const cdp = await page.context().newCDPSession(page);
  const touch = async (type, x = 0, y = 0) => {
    const point = await position(x, y);
    await cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints:
        type === "touchEnd" || type === "touchCancel"
          ? []
          : [{ x: point.x, y: point.y, id: 1 }],
    });
  };
  await touch("touchStart", 100, 290);
  await touch("touchMove", 220, 290);
  await touch("touchEnd");
  await idle();
  assert.equal(await alpha(160, 290), 0);
  await touch("touchStart", 100, 330);
  await touch("touchMove", 220, 330);
  await page.waitForFunction(() => {
    const node = document.querySelector("dialog canvas");
    return (
      node
        .getContext("2d")
        .getImageData(
          Math.floor((160 * node.width) / 600),
          Math.floor((330 * node.height) / 400),
          1,
          1,
        ).data[3] === 0
    );
  });
  await touch("touchCancel");
  await idle();
  assert.equal(await alpha(160, 330), 255);
  await cdp.detach();
  await page.getByRole("button", { name: "Close editor", exact: true }).click();
  await page
    .getByRole("button", { name: "Discard edits", exact: true })
    .click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(
    await page
      .getByRole("link", { name: "Download", exact: true })
      .getAttribute("href"),
    href,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS browser: selection, fringe, undo/redo, export, reopen/restore RGB, brushes, zoom mapping, attachment rejection, discard, mobile layout, touch drawing and cancellation; no page errors.",
  );
  console.log(
    JSON.stringify(await page.evaluate(() => window.__cleanupMetrics), null, 2),
  );
} finally {
  await browser.close();
}
