export const MOBILE_MAX_EDGE = 1536;

/** Bound the canvas before reading pixels into JS memory; never upscale. */
export async function boundedImageCanvas(file: Blob, maxEdge: number): Promise<OffscreenCanvas> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    );
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser could not prepare the image.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    bitmap.close();
  }
}
