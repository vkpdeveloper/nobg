import { MaskEditor } from "../src/lib/cleanup/mask";

self.onmessage = (
  event: MessageEvent<{ width: number; height: number; iterations: number }>,
) => {
  const { width, height, iterations } = event.data;
  const records: Record<string, number[]> = {
    construct: [],
    index: [],
    select: [],
    remove: [],
    undo: [],
    brush: [],
    reindex: [],
  };
  let memory = 0;
  for (let run = -1; run < iterations; run++) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    const rect = (
      x0: number,
      y0: number,
      w: number,
      h: number,
      alpha: number,
    ) => {
      for (let y = y0; y < y0 + h; y++)
        for (let x = x0; x < x0 + w; x++)
          pixels[(y * width + x) * 4 + 3] = alpha;
    };
    rect(
      Math.floor(width * 0.08),
      Math.floor(height * 0.1),
      Math.floor(width * 0.55),
      Math.floor(height * 0.8),
      255,
    );
    const x = Math.floor(width * 0.78),
      y = Math.floor(height * 0.45),
      w = Math.floor(width * 0.06),
      h = Math.floor(height * 0.08);
    rect(x - 2, y - 2, w + 4, h + 4, 40);
    rect(x, y, w, h, 255);
    const constructStart = performance.now();
    const editor = new MaskEditor(width, height, pixels);
    if (run >= 0) records.construct.push(performance.now() - constructStart);
    const time = (name: string, action: () => void) => {
      const start = performance.now();
      action();
      if (run >= 0) records[name].push(performance.now() - start);
    };
    time("index", () => editor.index());
    time("select", () =>
      editor.select([
        { x: x - 10, y: y - 10 },
        { x: x + w + 10, y: y - 10 },
        { x: x + w + 10, y: y + h + 10 },
        { x: x - 10, y: y + h + 10 },
      ]),
    );
    time("remove", () => editor.removeSelection());
    time("undo", () => editor.undo());
    time("brush", () => {
      editor.begin();
      for (let i = 0; i < 20; i++)
        editor.brush(
          { x: width / 3 + i * 5, y: height / 2 },
          { x: width / 3 + i * 5 + 5, y: height / 2 },
          20,
          false,
          0.8,
        );
      editor.commit();
    });
    time("reindex", () => editor.index());
    memory = editor.memoryBytes;
  }
  self.postMessage({ width, height, records, retainedMaskBytes: memory });
};
