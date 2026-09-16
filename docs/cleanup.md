# Image cleanup

Choose **Clean up** on a finished image. Circle a leftover region with Smart Remove, inspect the rose highlight, and choose **Remove selected**. Erase and Restore offer adjustable size/hardness; Pan and zoom allow fine work. Undo/redo also support Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z. Apply updates the card, copy, individual download, and batch download. Closing an edited session asks whether to discard it.

Restore returns pixels to the original BEN2 cutout, including when reopening an applied edit. It does not reconstruct background pixels BEN2 removed. Undo history lasts for the open editor session.

## Selection and editing

- A separate worker decodes the existing PNG. BEN2 is not rerun, and cleanup makes no network requests or model downloads.
- Four-connected core pixels (alpha >= 128) are labeled with a sequential two-pass union-find algorithm. All core boundaries grow together through nonzero soft alpha, assigning translucent fringes to the nearest core in four-neighbor pixel distance. Separate all-translucent regions are labeled afterward. This separates many faint bridges without changing the source alpha.
- The lasso uses even-odd scanline filling. A component is proposed only when at least 85% of its pixels are enclosed. Cached component bounds avoid scanning the whole image for a small selection. All proposed pixels, including any outside the lasso, are highlighted before confirmation. Multiple fragments can be selected together.
- These are spatial heuristics, not object recognition. A solid connection to a larger subject is usually rejected when the lasso encloses only the leftover. Similar/overlapping objects, shared shadows, very faint regions, and borderline coverage remain ambiguous; refine the lasso or use the brush. No automatic graph-cut or extra segmentation model is included.
- Changes touch alpha only. RGB and the original cutout alpha are retained separately so erased colors survive restore. Segmented brush strokes evaluate distance to line segments, preventing gaps between pointer events. Soft brush coverage is absolute, avoiding opacity changes caused solely by event frequency.
- History saves before/after alpha in changed 64x64 tiles. Older entries are evicted over a 32 MiB target; the most recent edit is always kept, even if a single very large edit exceeds that target. New edits clear redo. Cancelled pointer gestures roll back their pending tiles.
- Editing and export keep full resolution. Preview transfers match display resolution and increase with zoom. Brush messages are coalesced with at most one brush update in flight. PNG encoding happens on Apply, not on each stroke.
- Edits invalidate the component index. The next Smart Remove rebuilds it in the worker. Only the active editor allocates these buffers; closing terminates its worker.
- Requires modern browser support for Worker, OffscreenCanvas, createImageBitmap, and native dialog. A worker/decode error leaves the current saved image intact and offers closing the editor.

## Reproduce validation

```sh
bun scripts/cleanup.test.ts
bun run dev --port 3011
# In another terminal; Chromium must be installed for Playwright:
node scripts/test-cleanup-browser.mjs
node scripts/benchmark-cleanup.mjs /tmp/cleanup-benchmark.json
bun run lint
bunx tsc --noEmit
bun run build
# Optional production browser check after starting `bun run start --port 3012`:
CLEANUP_URL=http://localhost:3012 node scripts/test-cleanup-browser.mjs
```

The nine engine tests cover alpha/RGB preservation, soft fringes, accidental subject overlap, multi-region selection, attached and faintly connected objects, translucent objects, concave/empty lassos, brush continuity, exact undo/redo, cancelled strokes, topology changes, and randomized comparison with an independent flood fill. The random test includes 60 masks and single-pixel-wide images.

The browser test replaces only the background remover with a deterministic transparent PNG fixture. The actual editor, worker, selection, canvas rendering, export, and result update paths run unchanged. It covers exported dimensions/alpha, reopening and restoring RGB, zoom coordinates, keyboard undo/redo, discard, mobile layout, touch strokes, and pointer cancellation. Both development and production builds passed, with no page errors. It does not measure BEN2 or validate the unavailable cat/key photo.

## Benchmark: 17 September 2026, local time

Machine: AMD Ryzen 5 3500U, 8 logical CPUs, 29.3 GiB reported RAM; Linux; headless Chromium 153.0.8010.12. Raw samples and metadata: [benchmarks/cleanup.json](benchmarks/cleanup.json).

The engine benchmark uses synthetic rectangular subjects and a small separate object with a translucent fringe. Each size has one warmup and seven measured iterations. Values below are medians, milliseconds. The brush operation is a complete 20-segment stroke with a 40-pixel diameter. Decode, rendering, worker startup, and PNG export are excluded from this table.

| Image | Copy base alpha | Build index | Cached selection | Remove | Undo | Brush stroke | Rebuild after edits |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1024x1024 | 2.4 | 20.3 | 0.6 | 0.6 | <0.1 | 3.1 | 21.8 |
| 1920x1080 | 4.6 | 36.5 | 0.4 | 0.9 | 0.1 | 4.4 | 37.3 |
| 4000x3000 | 27.5 | 288.1 | 1.9 | 4.9 | 0.2 | 3.4 | 286.5 |

The integration benchmark bundles the real cleanup worker, generates its PNG before timing, and measures from posting each command through drawing the returned bitmap on the main-thread canvas. It uses a 1200-pixel-wide preview after initialization. Cached selection has seven samples; brush updates have twelve. Initial open, selection after undo, and export are single samples. This timing excludes React event dispatch and the wait for actual screen presentation; the raw data separately records time to the next animation frame. Export measures receipt of the encoded blob.

| Image | First open | Cached selection median / p95 | Brush update median / p95 | Selection after undo | PNG export |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1920x1080 | 163.8 | 9.0 / 13.7 | 9.7 / 16.8 | 55.9 | 19.5 |
| 4000x3000 | 491.8 | 16.0 / 22.8 | 9.5 / 13.3 | 307.3 | 61.7 |

Retained engine buffers plus history were about 9.0, 17.8, and 103.0 MiB respectively. Those figures exclude canvas surfaces, decoded PNGs, the temporary indexing queue (about 46 MiB at 12 MP), and browser overhead; they are not total process-memory measurements. With only seven samples, the reported p95 is the slowest sample. This shared workstation was not thermally or CPU-load controlled. Large lassos, highly fragmented masks, real fur/shadows, other browsers, and simultaneous inference can change the timings. These measurements support responsiveness for the tested cases, not a universal speed claim.
