import assert from "node:assert/strict";
import { MaskEditor } from "../src/lib/cleanup/mask";

function fixture(w = 120, h = 100) {
  const pixels = new Uint8ClampedArray(w * h * 4);
  const rect = (
    x0: number,
    y0: number,
    width: number,
    height: number,
    alpha = 255,
  ) => {
    for (let y = y0; y < y0 + height; y++)
      for (let x = x0; x < x0 + width; x++)
        pixels.set([120, 80, 40, alpha], (y * w + x) * 4);
  };
  return {
    pixels,
    rect,
    make: () => new MaskEditor(w, h, pixels),
    alpha: (x: number, y: number) => pixels[(y * w + x) * 4 + 3],
  };
}
const box = (x: number, y: number, w: number, h: number) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];
let count = 0;
function test(name: string, run: () => void) {
  run();
  count++;
  console.log(`PASS ${name}`);
}

test("separate object and translucent fringe removed; subject alpha and RGB unchanged", () => {
  const f = fixture();
  f.rect(5, 5, 40, 80);
  f.rect(75, 35, 22, 22, 40);
  f.rect(77, 37, 18, 18);
  const before = f.pixels.slice(),
    editor = f.make();
  assert.equal(editor.select(box(70, 30, 32, 32)).components, 1);
  editor.removeSelection();
  assert.equal(f.alpha(75, 35), 0);
  assert.equal(f.alpha(85, 45), 0);
  for (let p = 0; p < 120 * 100; p++) {
    for (let c = 0; c < 3; c++)
      assert.equal(f.pixels[p * 4 + c], before[p * 4 + c]);
    if (p % 120 < 50) assert.equal(f.pixels[p * 4 + 3], before[p * 4 + 3]);
  }
  editor.undo();
  assert.deepEqual(f.pixels, before);
  editor.redo();
  assert.equal(f.alpha(85, 45), 0);
});
test("small subject overlap does not select subject; isolated fragments select together", () => {
  const f = fixture();
  f.rect(5, 5, 50, 80);
  f.rect(70, 35, 10, 10);
  f.rect(85, 35, 5, 5);
  const e = f.make(),
    result = e.select(box(50, 30, 45, 25));
  assert.equal(result.components, 2);
  assert.equal(result.ambiguous, true);
  e.removeSelection();
  assert.equal(f.alpha(54, 35), 255);
  assert.equal(f.alpha(72, 37), 0);
});
test("solid connection rejected rather than removing subject", () => {
  const f = fixture();
  f.rect(5, 5, 40, 80);
  f.rect(75, 35, 20, 20);
  f.rect(45, 40, 30, 3);
  const e = f.make();
  assert.deepEqual(e.select(box(70, 30, 30, 30)), {
    components: 0,
    pixels: 0,
    ambiguous: true,
  });
});
test("faint bridge does not merge opaque cores", () => {
  const f = fixture();
  f.rect(5, 5, 40, 80);
  f.rect(75, 35, 20, 20);
  f.rect(45, 40, 30, 1, 10);
  const e = f.make();
  assert.equal(e.select(box(68, 30, 32, 30)).components, 1);
  e.removeSelection();
  assert.equal(f.alpha(40, 40), 255);
  assert.equal(f.alpha(80, 40), 0);
});
test("entirely translucent object, concave polygon, empty selection", () => {
  const f = fixture();
  f.rect(75, 35, 10, 10, 30);
  const e = f.make();
  assert.equal(e.select(box(70, 30, 30, 30)).components, 1);
  assert.equal(e.select([]).components, 0);
  assert.equal(
    e.select([
      { x: 70, y: 30 },
      { x: 100, y: 30 },
      { x: 100, y: 60 },
      { x: 90, y: 60 },
      { x: 90, y: 48 },
      { x: 70, y: 48 },
    ]).components,
    1,
  );
});
test("fast brush segments have no gaps; restore and history are exact", () => {
  const f = fixture();
  f.rect(0, 0, 120, 100, 160);
  const original = f.pixels.slice(),
    e = f.make();
  e.begin();
  e.brush({ x: 5, y: 50 }, { x: 115, y: 50 }, 5, false, 1);
  e.commit();
  for (let x = 5; x < 115; x++) assert.equal(f.alpha(x, 50), 0);
  e.begin();
  e.brush({ x: 5, y: 50 }, { x: 115, y: 50 }, 6, true, 1);
  e.commit();
  assert.deepEqual(f.pixels, original);
  e.undo();
  assert.equal(f.alpha(60, 50), 0);
  e.undo();
  assert.deepEqual(f.pixels, original);
  e.redo();
  assert.equal(f.alpha(60, 50), 0);
  e.begin();
  e.brush({ x: 5, y: 50 }, { x: 115, y: 50 }, 6, true, 1);
  e.commit();
  assert.equal(e.state.canRedo, false);
});
test("brush changes connectivity, cancelled stroke rolls back, and transparent pixels stay transparent", () => {
  const f = fixture();
  f.rect(20, 20, 80, 30);
  const e = f.make();
  e.index();
  e.begin();
  e.brush({ x: 60, y: 15 }, { x: 60, y: 55 }, 4, false, 1);
  e.cancel();
  assert.equal(f.alpha(60, 30), 255);
  e.begin();
  e.brush({ x: 60, y: 15 }, { x: 60, y: 55 }, 4, false, 1);
  e.commit();
  assert.equal(e.select(box(15, 15, 43, 40)).components, 1);
  e.begin();
  e.brush({ x: 0, y: 0 }, { x: 10, y: 10 }, 5, true, 1);
  e.commit();
  assert.equal(f.alpha(5, 5), 0);
});
test("soft brush overlap does not compound opacity and boundary strokes are safe", () => {
  const f = fixture();
  f.rect(0, 0, 120, 100);
  const e = f.make();
  e.begin();
  e.brush({ x: 0, y: 0 }, { x: 0, y: 0 }, 10, false, 0);
  const first = f.pixels.slice();
  e.brush({ x: 0, y: 0 }, { x: 0, y: 0 }, 10, false, 0);
  assert.deepEqual(f.pixels, first);
  e.commit();
});
test("two-pass core labels match independent flood fill on random masks", () => {
  let seed = 123456;
  for (let trial = 0; trial < 60; trial++) {
    const width = trial % 3 === 0 ? 1 : 23,
      height = 19;
    const f = fixture(width, height);
    for (let p = 0; p < width * height; p++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      f.pixels[p * 4 + 3] = seed / 4294967296 < 0.55 ? 255 : 0;
    }
    const seen = new Set<number>();
    let components = 0;
    for (let p = 0; p < width * height; p++) {
      if (!f.pixels[p * 4 + 3] || seen.has(p)) continue;
      components++;
      const queue = [p];
      seen.add(p);
      for (let i = 0; i < queue.length; i++) {
        const q = queue[i],
          x = q % width;
        const neighbors = [
          x > 0 ? q - 1 : -1,
          x + 1 < width ? q + 1 : -1,
          q - width,
          q + width,
        ];
        for (const next of neighbors)
          if (
            next >= 0 &&
            next < width * height &&
            !seen.has(next) &&
            f.pixels[next * 4 + 3]
          ) {
            seen.add(next);
            queue.push(next);
          }
      }
    }
    const e = f.make();
    assert.equal(e.select(box(0, 0, width, height)).components, components);
    const before = f.pixels.slice();
    e.removeSelection();
    for (let p = 0; p < width * height; p++)
      assert.equal(f.pixels[p * 4 + 3], 0);
    e.undo();
    assert.deepEqual(f.pixels, before);
  }
});
console.log(`${count} cleanup correctness tests passed`);
