/** Full-resolution alpha editing. No image resampling or inference is involved. */
export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };
type Tile = {
  x: number;
  y: number;
  width: number;
  height: number;
  before: Uint8Array;
  after?: Uint8Array;
};
type Edit = Tile[];
const TILE = 64;
const HISTORY_BYTES = 32 * 1024 * 1024;
const CORE_ALPHA = 128;
const MIN_COVERAGE = 0.85;

export class MaskEditor {
  readonly original: Uint8Array;
  readonly pixels: Uint8ClampedArray;
  private labels?: Int32Array;
  private sizes = new Uint32Array(0);
  private bounds = new Int32Array(0);
  private selected = new Set<number>();
  private history: Edit[] = [];
  private future: Edit[] = [];
  private pending = new Map<number, Tile>();
  private historyBytes = 0;
  dirty: Rect | null = null;
  selectionBounds: Rect | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
    pixels: Uint8ClampedArray,
    original?: Uint8Array,
  ) {
    if (width <= 0 || height <= 0 || pixels.length !== width * height * 4)
      throw new Error("Invalid image dimensions");
    this.pixels = pixels;
    this.original = original ?? new Uint8Array(width * height);
    if (!original) {
      for (let p = 0; p < this.original.length; p++)
        this.original[p] = pixels[p * 4 + 3];
    }
    if (this.original.length !== width * height)
      throw new Error("Invalid original mask");
  }

  get state() {
    return {
      canUndo: this.history.length > 0,
      canRedo: this.future.length > 0,
    };
  }
  get memoryBytes() {
    return (
      this.pixels.byteLength +
      this.original.byteLength +
      (this.labels?.byteLength ?? 0) +
      this.sizes.byteLength +
      this.bounds.byteLength +
      this.historyBytes
    );
  }

  /** Label opaque cores, then grow all cores together through soft alpha. This
   * assigns faint bridges to their nearest core instead of merging subjects. */
  index() {
    if (this.labels) return;
    const n = this.width * this.height;
    const labels = new Int32Array(n);
    const queue = new Int32Array(n + 1);
    const data = this.pixels;
    let count = 0;
    let head = 0,
      tail = 0;
    // Reuse these functions for the whole pass; no per-pixel closures or arrays.
    const enqueue = (q: number, id: number, threshold: number) => {
      if (!labels[q] && data[q * 4 + 3] >= threshold) {
        labels[q] = id;
        queue[tail++] = q;
      }
    };
    const neighbors = (p: number, id: number, threshold: number) => {
      const x = p % this.width;
      if (x > 0) enqueue(p - 1, id, threshold);
      if (x + 1 < this.width) enqueue(p + 1, id, threshold);
      if (p >= this.width) enqueue(p - this.width, id, threshold);
      if (p + this.width < n) enqueue(p + this.width, id, threshold);
    };
    // Sequential two-pass labeling keeps large opaque interiors cache-friendly.
    // The queue doubles as union-find storage until all core labels are resolved.
    const root = (id: number): number => {
      while (queue[id] !== id) {
        queue[id] = queue[queue[id]];
        id = queue[id];
      }
      return id;
    };
    for (let y = 0, p = 0; y < this.height; y++)
      for (let x = 0; x < this.width; x++, p++) {
        if (data[p * 4 + 3] < CORE_ALPHA) continue;
        const left = x > 0 ? labels[p - 1] : 0;
        const above = y > 0 ? labels[p - this.width] : 0;
        if (!left && !above) {
          count++;
          queue[count] = count;
          labels[p] = count;
        } else if (!left || !above || left === above) labels[p] = left || above;
        else {
          const a = root(left),
            b = root(above);
          const id = Math.min(a, b);
          queue[Math.max(a, b)] = id;
          labels[p] = id;
        }
      }
    for (let id = 1; id <= count; id++) queue[id] = root(id);
    for (let p = 0; p < n; p++) if (labels[p]) labels[p] = queue[labels[p]];
    head = 0;
    tail = 0;
    for (let p = 0; p < n; p++) {
      if (!labels[p]) continue;
      const x = p % this.width;
      if (
        (x > 0 && !labels[p - 1] && data[(p - 1) * 4 + 3]) ||
        (x + 1 < this.width && !labels[p + 1] && data[(p + 1) * 4 + 3]) ||
        (p >= this.width &&
          !labels[p - this.width] &&
          data[(p - this.width) * 4 + 3]) ||
        (p + this.width < n &&
          !labels[p + this.width] &&
          data[(p + this.width) * 4 + 3])
      )
        queue[tail++] = p;
    }
    while (head < tail) {
      const p = queue[head++];
      neighbors(p, labels[p], 1);
    }
    // Entirely translucent, isolated regions still need to be selectable.
    for (let p = 0; p < n; p++) {
      if (labels[p] || !data[p * 4 + 3]) continue;
      count++;
      head = 0;
      tail = 1;
      queue[0] = p;
      labels[p] = count;
      while (head < tail) neighbors(queue[head++], count, 1);
    }
    this.sizes = new Uint32Array(count + 1);
    this.bounds = new Int32Array((count + 1) * 4);
    for (let id = 1; id <= count; id++) {
      this.bounds[id * 4] = this.width;
      this.bounds[id * 4 + 1] = this.height;
    }
    for (let y = 0, p = 0; y < this.height; y++)
      for (let x = 0; x < this.width; x++, p++) {
        const id = labels[p];
        if (!id) continue;
        this.sizes[id]++;
        const b = id * 4;
        if (x < this.bounds[b]) this.bounds[b] = x;
        if (y < this.bounds[b + 1]) this.bounds[b + 1] = y;
        if (x > this.bounds[b + 2]) this.bounds[b + 2] = x;
        if (y > this.bounds[b + 3]) this.bounds[b + 3] = y;
      }
    this.labels = labels;
  }

  select(polygon: Point[]) {
    this.clearSelection();
    if (polygon.length < 3)
      return { components: 0, pixels: 0, ambiguous: false };
    this.index();
    const labels = this.labels!;
    const hits = new Map<number, number>();
    let minY = this.height,
      maxY = 0;
    for (const p of polygon) {
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    // Scanline polygon rasterization: work scales with the enclosed area.
    for (
      let y = Math.max(0, Math.floor(minY));
      y < Math.min(this.height, Math.ceil(maxY));
      y++
    ) {
      const intersections: number[] = [];
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i],
          b = polygon[j],
          py = y + 0.5;
        if (a.y > py !== b.y > py)
          intersections.push(a.x + ((py - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
      intersections.sort((a, b) => a - b);
      for (let k = 0; k + 1 < intersections.length; k += 2) {
        const end = Math.min(this.width, Math.ceil(intersections[k + 1] - 0.5));
        for (
          let x = Math.max(0, Math.ceil(intersections[k] - 0.5));
          x < end;
          x++
        ) {
          const id = labels[y * this.width + x];
          if (id) hits.set(id, (hits.get(id) ?? 0) + 1);
        }
      }
    }
    let pixels = 0,
      ambiguous = false;
    for (const [id, hit] of hits) {
      if (hit / this.sizes[id] >= MIN_COVERAGE) {
        this.selected.add(id);
        pixels += this.sizes[id];
      } else ambiguous = true;
    }
    let x0 = this.width,
      y0 = this.height,
      x1 = -1,
      y1 = -1;
    for (const id of this.selected) {
      const b = id * 4;
      x0 = Math.min(x0, this.bounds[b]);
      y0 = Math.min(y0, this.bounds[b + 1]);
      x1 = Math.max(x1, this.bounds[b + 2]);
      y1 = Math.max(y1, this.bounds[b + 3]);
    }
    this.selectionBounds =
      x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
    return { components: this.selected.size, pixels, ambiguous };
  }

  isSelected(p: number) {
    return !!this.labels && this.selected.has(this.labels[p]);
  }
  clearSelection() {
    this.selected.clear();
    this.selectionBounds = null;
  }
  begin() {
    this.pending.clear();
    this.dirty = null;
  }

  private setAlpha(p: number, value: number) {
    const offset = p * 4 + 3;
    if (this.pixels[offset] === value) return;
    const x = p % this.width,
      y = Math.floor(p / this.width);
    const tx = Math.floor(x / TILE) * TILE,
      ty = Math.floor(y / TILE) * TILE;
    const key = ty * this.width + tx;
    if (!this.pending.has(key)) {
      const tile = {
        x: tx,
        y: ty,
        width: Math.min(TILE, this.width - tx),
        height: Math.min(TILE, this.height - ty),
        before: new Uint8Array(0),
      };
      tile.before = this.readTile(tile);
      this.pending.set(key, tile);
    }
    this.pixels[offset] = value;
    if (!this.dirty) this.dirty = { x, y, width: 1, height: 1 };
    else {
      const x1 = Math.max(this.dirty.x + this.dirty.width, x + 1),
        y1 = Math.max(this.dirty.y + this.dirty.height, y + 1);
      this.dirty.x = Math.min(this.dirty.x, x);
      this.dirty.y = Math.min(this.dirty.y, y);
      this.dirty.width = x1 - this.dirty.x;
      this.dirty.height = y1 - this.dirty.y;
    }
  }

  private readTile(tile: Rect) {
    const values = new Uint8Array(tile.width * tile.height);
    for (let y = 0; y < tile.height; y++)
      for (let x = 0; x < tile.width; x++)
        values[y * tile.width + x] =
          this.pixels[((tile.y + y) * this.width + tile.x + x) * 4 + 3];
    return values;
  }

  removeSelection() {
    if (!this.selectionBounds) return;
    this.begin();
    const r = this.selectionBounds;
    for (let y = r.y; y < r.y + r.height; y++)
      for (let x = r.x; x < r.x + r.width; x++) {
        const p = y * this.width + x;
        if (this.isSelected(p)) this.setAlpha(p, 0);
      }
    this.commit();
  }

  /** Evaluate distance to a segment, avoiding gaps even in fast pointer strokes. */
  brush(
    from: Point,
    to: Point,
    radius: number,
    restore: boolean,
    hardness: number,
  ) {
    radius = Math.max(0.5, radius);
    const x0 = Math.max(0, Math.floor(Math.min(from.x, to.x) - radius)),
      x1 = Math.min(this.width, Math.ceil(Math.max(from.x, to.x) + radius));
    const y0 = Math.max(0, Math.floor(Math.min(from.y, to.y) - radius)),
      y1 = Math.min(this.height, Math.ceil(Math.max(from.y, to.y) + radius));
    const dx = to.x - from.x,
      dy = to.y - from.y,
      length2 = dx * dx + dy * dy;
    const inner = radius * Math.min(1, Math.max(0, hardness));
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const t = length2
          ? Math.max(
              0,
              Math.min(
                1,
                ((x + 0.5 - from.x) * dx + (y + 0.5 - from.y) * dy) / length2,
              ),
            )
          : 0;
        const distance = Math.hypot(
          x + 0.5 - from.x - t * dx,
          y + 0.5 - from.y - t * dy,
        );
        if (distance >= radius) continue;
        const strength =
          distance <= inner ? 1 : (radius - distance) / (radius - inner);
        const p = y * this.width + x,
          current = this.pixels[p * 4 + 3];
        // Absolute coverage avoids opacity accumulating at pointer-event boundaries.
        const value = restore
          ? Math.max(current, Math.round(this.original[p] * strength))
          : Math.min(current, Math.round(this.original[p] * (1 - strength)));
        this.setAlpha(p, value);
      }
  }

  commit() {
    if (!this.pending.size) return;
    const edit = [...this.pending.values()];
    for (const tile of edit) tile.after = this.readTile(tile);
    for (const redo of this.future) this.historyBytes -= this.bytes(redo);
    this.future = [];
    this.history.push(edit);
    this.historyBytes += this.bytes(edit);
    while (this.historyBytes > HISTORY_BYTES && this.history.length > 1)
      this.historyBytes -= this.bytes(this.history.shift()!);
    this.pending.clear();
    this.labels = undefined;
    this.clearSelection();
  }
  private bytes(edit: Edit) {
    return edit.reduce(
      (sum, t) => sum + t.before.byteLength + (t.after?.byteLength ?? 0),
      0,
    );
  }
  private replay(edit: Edit, after: boolean) {
    for (const tile of edit) {
      const values = after ? tile.after! : tile.before;
      for (let y = 0; y < tile.height; y++)
        for (let x = 0; x < tile.width; x++)
          this.pixels[((tile.y + y) * this.width + tile.x + x) * 4 + 3] =
            values[y * tile.width + x];
    }
    this.dirty = { x: 0, y: 0, width: this.width, height: this.height };
    this.labels = undefined;
    this.clearSelection();
  }
  cancel() {
    this.replay([...this.pending.values()], false);
    this.pending.clear();
  }
  undo() {
    const edit = this.history.pop();
    if (edit) {
      this.replay(edit, false);
      this.future.push(edit);
    }
  }
  redo() {
    const edit = this.future.pop();
    if (edit) {
      this.replay(edit, true);
      this.history.push(edit);
    }
  }
}
