/**
 * Client-side perceptual hashing for PureWire's Verified Original layer.
 *
 * A difference hash (dHash) turns a frame into a 64-bit signature that is
 * robust to recompression, resizing, and mild color shifts — the ways real
 * copies of the same media actually differ. Each media item yields a small
 * set of variant hashes so evasive copies still match the original:
 *
 * - original      — the frame as-is
 * - mirrored      — horizontal flip, so a mirror-flipped copy still matches
 * - center-crop   — the middle ~70% scaled back up, so a light crop still
 *                   matches
 * - video frames  — a few frames sampled across the duration, so a video
 *                   re-encoded at a different speed still shares frames
 *
 * The browser is the only sensible place to run this: canvas gives pixel
 * access for free and video decoding needs the platform. The resulting hex
 * signatures travel with the post and are compared server-side by Hamming
 * distance (see `posts.ts`). This module must stay DOM-free of any Convex
 * imports so the browser can use it directly.
 */

/** A difference hash is 64 bits, serialized as 16 hex characters. */
const HEX_BITS = 16;

/** dHash grid: 9x8 pixels → 8×8 = 64 comparisons. */
const COLS = 9;
const ROWS = 8;

/** Bits of a sampled frame used for light-crop robustness. */
const CENTER_CROP = 0.3;

/**
 * Hamming distance between two hex dHash signatures. Two media items are
 * considered the same frame when this distance is small (≤ SIMILARITY_BITS).
 */
export function hashDistance(a: string, b: string): number {
  const x = BigInt(`0x${a}`);
  const y = BigInt(`0x${b}`);
  let diff = x ^ y;
  let distance = 0;
  while (diff > 0n) {
    distance += Number(diff & 1n);
    diff >>= 1n;
  }
  return distance;
}

/** Maximum Hamming distance for two frames to count as a match. */
export const SIMILARITY_BITS = 10;

/** True when any hash from one set is within SIMILARITY_BITS of the other. */
export function hashesMatch(a: string[], b: string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (hashDistance(x, y) <= SIMILARITY_BITS) return true;
    }
  }
  return false;
}

/** True when any hash in `candidate` matches any hash in any of `stored`. */
export function mediaHashesMatch(
  candidate: string[],
  stored: string[][],
): boolean {
  for (const item of stored) {
    if (hashesMatch(candidate, item)) return true;
  }
  return false;
}

/** Draw a source into the 9x8 dHash grid and return its 64-bit signature. */
function dHashOfCanvas(
  source: CanvasImageSource,
  flipX = false,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = COLS;
  canvas.height = ROWS;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return "";
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, COLS, ROWS);
  ctx.save();
  if (flipX) {
    ctx.translate(COLS, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(source, 0, 0, COLS, ROWS);
  ctx.restore();
  const data = ctx.getImageData(0, 0, COLS, ROWS).data;
  const gray: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    gray.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }
  let hash = 0n;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS - 1; c++) {
      const left = gray[r * COLS + c];
      const right = gray[r * COLS + c + 1];
      hash = (hash << 1n) | (left < right ? 1n : 0n);
    }
  }
  return hash.toString(16).padStart(HEX_BITS, "0");
}

/** Draw the centered (1 - crop) region of a source at its own resolution. */
function cropCanvasFrom(
  source: CanvasImageSource,
  width: number,
  height: number,
  crop: number,
): HTMLCanvasElement | null {
  const cw = Math.max(1, Math.round(width * (1 - crop)));
  const ch = Math.max(1, Math.round(height * (1 - crop)));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  const sx = (width - cw) / 2;
  const sy = (height - ch) / 2;
  ctx.drawImage(source, sx, sy, cw, ch, 0, 0, cw, ch);
  return canvas;
}

/**
 * Perceptual hashes for an image: original, mirrored, center-crop, and the
 * mirrored crop. Returns [] on any decoding failure — hashing must never
 * block an upload.
 */
export async function computeImageHashes(file: Blob): Promise<string[]> {
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const { width, height } = bitmap;
      const hashes: string[] = [];
      const push = (flipX: boolean) => {
        const h = dHashOfCanvas(bitmap, flipX);
        if (h.length === HEX_BITS) hashes.push(h);
      };
      push(false);
      push(true);
      const crop = cropCanvasFrom(bitmap, width, height, CENTER_CROP);
      if (crop !== null) {
        for (const flipX of [false, true]) {
          const h = dHashOfCanvas(crop, flipX);
          if (h.length === HEX_BITS) hashes.push(h);
        }
      }
      return hashes;
    } finally {
      bitmap.close();
    }
  } catch {
    return [];
  }
}

/** Sample a few frames of a video and hash each (original + mirrored). */
export function computeVideoHashes(file: Blob): Promise<string[]> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    const hashes: string[] = [];
    let finished = false;
    // Watchdog: a video that loads metadata but stalls on seek (or fires
    // neither error nor loadedmetadata) must never hang the upload — resolve
    // with whatever frames were collected, best-effort.
    const watchdog = setTimeout(() => {
      video.removeAttribute("src");
      video.load();
      finish();
    }, 10_000);
    const finish = () => {
      if (!finished) {
        finished = true;
        clearTimeout(watchdog);
        URL.revokeObjectURL(url);
        resolve(hashes);
      }
    };
    video.onerror = () => finish();
    video.onloadedmetadata = () => {
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) {
        finish();
        return;
      }
      // Sample near the start, middle, and end: a speed-shifted re-encode
      // still shares some of these frames with the original.
      const times = [0.1, 0.5, 0.9].map((f) => duration * f);
      let index = 0;
      const seekNext = () => {
        if (index >= times.length) {
          finish();
          return;
        }
        video.currentTime = times[index];
      };
      video.onseeked = () => {
        try {
          const frame = document.createElement("canvas");
          frame.width = video.videoWidth;
          frame.height = video.videoHeight;
          const ctx = frame.getContext("2d");
          if (ctx !== null && frame.width > 0 && frame.height > 0) {
            ctx.drawImage(video, 0, 0, frame.width, frame.height);
            for (const flipX of [false, true]) {
              const h = dHashOfCanvas(frame, flipX);
              if (h.length === HEX_BITS) hashes.push(h);
            }
          }
        } catch {
          // Skip a frame we can't decode — never block on it.
        }
        index++;
        seekNext();
      };
      seekNext();
    };
    video.load();
  });
}
