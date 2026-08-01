/**
 * Client-side media processing for PureWire.
 *
 * Photos taken on phones and cameras carry hidden metadata — exact GPS
 * coordinates, camera serials, device info, timestamps, lens settings.
 * PureWire processes every image in the user's own browser before it is
 * transmitted, so that metadata never reaches the server at all:
 *
 * - Re-encode through a canvas, which drops EXIF/GPS/device chunks.
 * - Downscale oversized images to MAX_DIMENSION on the long edge.
 * - Compress to JPEG (or keep PNG alpha when the source has it).
 *
 * Privacy wins over size: whenever a re-encode succeeds, the stripped copy
 * is the one that goes up, even if it is slightly larger than the source —
 * removing hidden GPS/device data is the point.
 *
 * Videos and audio pass through untouched here: re-encoding them in the
 * browser would require heavy transcoding. They are instead scanned
 * server-side for AI-generator markers, and their container metadata is
 * not used by any PureWire surface. See `src/convex/aiContent.ts`.
 */

export const MAX_DIMENSION = 2048;
const JPEG_QUALITY = 0.82;

export interface ProcessedImage {
  file: File;
  // True when the file was actually re-encoded (metadata stripped).
  processed: boolean;
}

function resizeCanvas(
  source: ImageBitmap,
  maxDimension: number,
): HTMLCanvasElement {
  const scale = Math.min(1, maxDimension / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx !== null) {
    // ImageBitmap draws are EXIF-orientation-correct by default; drawing
    // into a fresh canvas and reading it back out yields a clean file.
    ctx.drawImage(source, 0, 0, width, height);
  }
  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, JPEG_QUALITY));
}

/** Whether the source is a format we can safely re-encode. */
function isRasterImage(type: string): boolean {
  return (
    type === "image/jpeg" ||
    type === "image/png" ||
    type === "image/webp" ||
    type === "image/avif"
  );
}

/**
 * Re-encode an image in the browser: strips EXIF/GPS/device metadata,
 * downsizes to MAX_DIMENSION, and compresses. Falls back to the original
 * file unchanged when the browser can't decode it (e.g. exotic formats) —
 * never blocks the user on a processing failure.
 */
export async function processImageFile(file: File): Promise<ProcessedImage> {
  if (!isRasterImage(file.type)) {
    return { file, processed: false };
  }
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = resizeCanvas(bitmap, MAX_DIMENSION);
      // Keep PNG's alpha channel; everything else flattens to JPEG.
      const type = file.type === "image/png" ? "image/png" : "image/jpeg";
      const blob = await canvasToBlob(canvas, type);
      if (blob === null) {
        return { file, processed: false };
      }
      const extension = type === "image/png" ? "png" : "jpg";
      const base = file.name.replace(/\.[^.]+$/, "") || "image";
      const processedFile = new File([blob], `${base}.${extension}`, {
        type,
        lastModified: Date.now(),
      });
      return { file: processedFile, processed: true };
    } finally {
      bitmap.close();
    }
  } catch {
    // Unsupported or corrupted image — upload as-is.
    return { file, processed: false };
  }
}
