import { MaskEditor } from "../lib/cleanup/mask";
import type { EditorRequest, EditorResponse } from "../lib/cleanup/protocol";

let editor: MaskEditor;
let canvas: OffscreenCanvas;
let context: OffscreenCanvasRenderingContext2D;
let preview: OffscreenCanvas;
let overlay: OffscreenCanvas;
let image: ImageData;
let selection = { components: 0, pixels: 0, ambiguous: false };

async function decode(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = surface.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return {
    surface,
    ctx,
    image: ctx.getImageData(0, 0, surface.width, surface.height),
  };
}

function clear() {
  selection = { components: 0, pixels: 0, ambiguous: false };
  editor.clearSelection();
  overlay.width = 1;
  overlay.height = 1;
}

function frame(operation: EditorRequest["type"], start: number) {
  const dirty = editor.dirty;
  if (dirty) {
    context.putImageData(
      image,
      0,
      0,
      dirty.x,
      dirty.y,
      dirty.width,
      dirty.height,
    );
    editor.dirty = null;
  }
  const ctx = preview.getContext("2d")!;
  ctx.clearRect(0, 0, preview.width, preview.height);
  ctx.drawImage(canvas, 0, 0, preview.width, preview.height);
  const bounds = editor.selectionBounds;
  if (selection.components && bounds) {
    const sx = preview.width / editor.width,
      sy = preview.height / editor.height;
    ctx.drawImage(
      overlay,
      bounds.x * sx,
      bounds.y * sy,
      bounds.width * sx,
      bounds.height * sy,
    );
  }
  const bitmap = preview.transferToImageBitmap();
  const response: EditorResponse = {
    type: "frame",
    bitmap,
    width: editor.width,
    height: editor.height,
    ...editor.state,
    selection,
    elapsed: performance.now() - start,
    operation,
  };
  self.postMessage(response, { transfer: [bitmap] });
}

async function handle(msg: EditorRequest) {
  const start = performance.now();
  switch (msg.type) {
    case "init": {
      const current = await decode(msg.blob);
      canvas = current.surface;
      context = current.ctx;
      image = current.image;
      let original: Uint8Array | undefined;
      if (msg.base !== msg.blob) {
        const base = await decode(msg.base);
        if (
          base.surface.width !== canvas.width ||
          base.surface.height !== canvas.height
        )
          throw new Error("Mask dimensions do not match");
        original = new Uint8Array(canvas.width * canvas.height);
        for (let p = 0; p < original.length; p++) {
          original[p] = base.image.data[p * 4 + 3];
          // PNG decoders discard RGB under zero alpha. Retain the base colors for restore.
          image.data[p * 4] = base.image.data[p * 4];
          image.data[p * 4 + 1] = base.image.data[p * 4 + 1];
          image.data[p * 4 + 2] = base.image.data[p * 4 + 2];
        }
      }
      editor = new MaskEditor(
        canvas.width,
        canvas.height,
        image.data,
        original,
      );
      // Full-resolution mask/export, display-sized transfers. Zoom requests more detail.
      const scale = Math.min(1, 1600 / Math.max(canvas.width, canvas.height));
      preview = new OffscreenCanvas(
        Math.max(1, Math.round(canvas.width * scale)),
        Math.max(1, Math.round(canvas.height * scale)),
      );
      overlay = new OffscreenCanvas(1, 1);
      editor.index();
      break;
    }
    case "resize":
      preview.width = Math.max(1, Math.min(editor.width, msg.width));
      preview.height = Math.max(1, Math.min(editor.height, msg.height));
      break;
    case "select": {
      clear();
      selection = editor.select(msg.points);
      const bounds = editor.selectionBounds;
      if (bounds) {
        overlay.width = bounds.width;
        overlay.height = bounds.height;
        const mask = new ImageData(bounds.width, bounds.height);
        for (let y = 0; y < bounds.height; y++)
          for (let x = 0; x < bounds.width; x++) {
            if (
              !editor.isSelected((bounds.y + y) * editor.width + bounds.x + x)
            )
              continue;
            const p = (y * bounds.width + x) * 4;
            mask.data[p] = 244;
            mask.data[p + 1] = 63;
            mask.data[p + 2] = 94;
            mask.data[p + 3] = 175;
          }
        overlay.getContext("2d")!.putImageData(mask, 0, 0);
      }
      break;
    }
    case "begin":
      clear();
      editor.begin();
      return;
    case "brush":
      for (let i = 0; i < msg.points.length; i++)
        editor.brush(
          msg.points[Math.max(0, i - 1)],
          msg.points[i],
          msg.radius,
          msg.restore,
          msg.hardness,
        );
      break;
    case "commit":
      editor.commit();
      break;
    case "cancel":
      editor.cancel();
      clear();
      break;
    case "remove":
      editor.removeSelection();
      clear();
      break;
    case "clear":
      clear();
      break;
    case "undo":
      editor.undo();
      clear();
      break;
    case "redo":
      editor.redo();
      clear();
      break;
    case "export": {
      if (editor.dirty) context.putImageData(image, 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      self.postMessage({ type: "export", blob } satisfies EditorResponse);
      return;
    }
  }
  frame(msg.type, start);
}

// Init/export are asynchronous; serialize commands so strokes cannot overtake them.
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<EditorRequest>) => {
  queue = queue
    .then(() => handle(event.data))
    .catch((error: unknown) => {
      self.postMessage({
        type: "error",
        message:
          error instanceof Error ? error.message : "Could not edit this image",
      } satisfies EditorResponse);
    });
};
