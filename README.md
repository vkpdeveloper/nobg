# nobg

Remove the background from any photo. Free, private, unlimited.

**[Try it →](https://github.com/vkpdeveloper/nobg)**

## Why this exists

Every background remover on the internet works the same way: you upload your photo to someone's server, wait, and hope they delete it afterwards. Most of them cap you at a handful of free images a month, slap a watermark on the result, or ask you to sign up before you can download anything.

That felt backwards for such a simple task. Removing a background is something your own computer is perfectly capable of doing. So nobg does exactly that — the whole thing runs inside your browser, on your device. Nothing is uploaded. There are no accounts, no limits, no watermarks, and no "pro" tier hiding the good stuff.

It's free and open source because a tool this basic should just be available to everyone.

## What it does

- **Drop, done.** Drag images in, click to browse, or just paste from your clipboard. The background disappears on its own.
- **Stays on your device.** Your photos never leave your computer. Turn off Wi-Fi after the page loads and it still works.
- **Handles batches.** Drop as many images as you like at once. nobg works through them as fast as your device can handle.
- **Grab the result instantly.** Copy the cutout straight to your clipboard or download it as a transparent PNG. One click for a single image, one click for the whole batch.
- **Hold to compare.** Press and hold any result to peek at the original.
- **Clean up leftovers.** If a stray bit of background survives, open the built-in editor: circle it and remove it, or use the erase and restore brushes. Undo as much as you like.
- **Light and dark.** Follows your system theme, or pick your own.
- **Satisfying little sounds.** A soft tick for each finished image and a chime when the batch is done. Mute it if you prefer quiet.
- **Fast after the first visit.** The first time you open nobg it prepares itself in the background. After that, it's ready in seconds.

## Later

Things we'd like to add, roughly in order:

- Choose a solid colour or a custom image as the new background
- Crop and resize before downloading
- Export as WEBP and JPG, not just PNG
- Install it as an app on your desktop or phone
- Drag results straight out of the page into other apps
- More languages

Have an idea? [Open an issue.](https://github.com/vkpdeveloper/nobg/issues)

## Running it yourself

```sh
bun install
bun run dev
```

Then open http://localhost:3000. Copy `.env.example` to `.env.local` if you want to set a public URL or analytics.

Model downloads use the external R2 CDN by default, with Hugging Face
fallback and persistent browser caching. nobg picks one of four quality tiers
(Best, Balanced, Light, Basic) from device signals — mobile/desktop, iOS,
WebGPU and GPU vendor, cores, memory, and WASM SIMD — and a header selector
can override it. If the tab dies mid-inference or a worker runs out of
memory, the tier is automatically lowered for this and future visits.
See [model hosting and benchmarks](docs/model-download.md)
for configuration, same-device download comparisons, and the Mac WebGPU fix.

## License

MIT
