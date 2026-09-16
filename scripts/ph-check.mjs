import { chromium } from "playwright";
import { gunzipSync } from "node:zlib";

const URL_ = process.env.NOBG_URL ?? "http://localhost:3020";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true,
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.12 Safari/537.36",
});

// posthog-js drops events when navigator.webdriver is true (bot filter) —
// override it so the headless run exercises the real capture path.
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => false });
  Object.defineProperty(navigator, "userAgentData", {
    get: () => ({
      brands: [
        { brand: "Chromium", version: "153" },
        { brand: "Google Chrome", version: "153" },
        { brand: "Not/A)Brand", version: "24" },
      ],
      mobile: false,
      platform: "Linux",
    }),
  });
});

const page = await ctx.newPage();
const events = [];
page.on("request", (req) => {
  const u = req.url();
  if (!u.includes("posthog.com") || u.includes("/array/") || u.includes("/static/"))
    return;
  const buf = req.postDataBuffer();
  if (!buf) return;
  let text;
  try {
    text = gunzipSync(buf).toString();
  } catch {
    text = buf.toString("latin1");
  }
  for (const m of text.matchAll(/"event"\s*:\s*"([^"]+)"/g)) events.push(m[1]);
});

await ctx.route("**github.com**", (r) => r.abort());

await page.goto(URL_, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);
console.log("after load:", events.join(", ") || "(none)");

await page.click('a[aria-label="GitHub"]');
await page.waitForTimeout(6000);
console.log("after github click:", events.join(", ") || "(none)");

await browser.close();
console.log("HAS_PAGEVIEW:", events.includes("$pageview"));
console.log("HAS_GITHUB_CLICKED:", events.includes("github_clicked"));
if (!events.includes("$pageview") || !events.includes("github_clicked"))
  process.exit(1);
