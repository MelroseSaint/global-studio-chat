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
 * - Compress to JPEG (or keep PNG alpha when the source has it), then step
 *   the quality down until the file fits IMAGE_BYTE_BUDGET — so a photo
 *   stays high quality but never wastes backend storage.
 *
 * Videos are re-encoded in the browser too (canvas + MediaRecorder): capped
 * resolution and bitrate, audio preserved, metadata dropped with the re-code.
 * Re-encoding runs at real-time playback speed, so only short clips are
 * re-encoded — anything longer or already small passes through untouched
 * rather than making the user wait. Every processing path is best-effort:
 * on any failure the original file is uploaded unchanged, never a blocked
 * upload.
 *
 * Privacy wins over size: whenever a re-encode succeeds, the stripped copy
 * is the one that goes up, even if it is slightly larger than the source —
 * removing hidden GPS/device data is the point.
 *
 * Audio passes through untouched here: it is small by nature and carries no
 * surface metadata PureWire uses. It is still scanned server-side for
 * AI-generator markers. See `src/convex/aiContent.ts`.
 *
 * Server-side safety net: the browser is not the last line of defense.
 * Videos that pass through the client unchanged (longer than the re-encode
 * budget, already small, or undecodable) are remuxed again on PureWire's
 * servers — GPS/device atoms like `©xyz`, `©mak`, and `©mod` are dropped
 * before the clip is ever served. See `src/lib/mp4-strip.ts` and
 * `src/convex/videoStrip.ts`.
 */

export const MAX_DIMENSION = 2048;
const JPEG_QUALITY = 0.82;
const MIN_JPEG_QUALITY = 0.45;
// Aim every photo under ~500 KB — sharp at feed size, tiny for storage.
export const IMAGE_BYTE_BUDGET = 512 * 1024;

// Video re-encode settings. Re-encoding is real-time, so it only kicks in
// for clips worth shrinking (bigger than the min size, shorter than the max
// duration, not already lean). Everything else passes through. The duration
// cap protects the user's time: a 3-minute clip takes ~3 minutes to process
// (the "Optimizing" line explains the wait) — longer clips upload as-is
// rather than making someone stare at a spinner.
export const VIDEO_MAX_DIMENSION = 1600;
const VIDEO_MIN_PROCESS_BYTES = 1.5 * 1024 * 1024;
const VIDEO_MAX_DURATION_SECONDS = 180;
// Clips at or under this resolution AND this size are already lean — no
// re-encode needed, so we don't spend real-time playback on them.
const VIDEO_LEAN_EDGE = 960;
const VIDEO_LEAN_BYTES = 4 * 1024 * 1024;
const VIDEO_MAX_BITRATE = 4_000_000;
const VIDEO_MIN_BITRATE = 700_000;
const VIDEO_FPS = 30;
// How long the browser may take just to open the file before we give up
// (metadata load stall — no onerror, no onloadedmetadata).
const VIDEO_OPEN_TIMEOUT_MS = 20_000;

export interface ProcessedImage {
  file: File;
  // True when the file was actually re-encoded (metadata stripped).
  processed: boolean;
}

export interface ProcessedVideo {
  file: File;
  // True when the file was actually re-encoded (metadata dropped, size cut).
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

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob | null> {
  return new Promise((resolve) =>
    canvas.toBlob(resolve, type, quality ?? JPEG_QUALITY),
  );
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
 * downsizes to MAX_DIMENSION, compresses, then steps quality down until the
 * result fits IMAGE_BYTE_BUDGET. Falls back to the original file unchanged
 * when the browser can't decode it (e.g. exotic formats) — never blocks the
 * user on a processing failure.
 */
export async function processImageFile(file: File): Promise<ProcessedImage> {
  if (!isRasterImage(file.type)) {
    return { file, processed: false };
  }
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = resizeCanvas(bitmap, MAX_DIMENSION);
      // Keep PNG's alpha channel; everything else flattens to JPEG. PNGs
      // skip the budget loop (toBlob ignores quality for PNG) — photos are
      // JPEG anyway; PNG is reserved for graphics with transparency.
      const type = file.type === "image/png" ? "image/png" : "image/jpeg";
      let blob: Blob | null;
      if (type === "image/png") {
        blob = await canvasToBlob(canvas, type);
      } else {
        blob = null;
        for (
          let quality = JPEG_QUALITY;
          quality >= MIN_JPEG_QUALITY;
          quality -= 0.1
        ) {
          blob = await canvasToBlob(canvas, type, quality);
          if (blob === null) break;
          if (blob.size <= IMAGE_BYTE_BUDGET) break;
        }
      }
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

/** A MediaRecorder mime type the browser actually supports, or "". */
function pickVideoMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    // H.264 + AAC (Safari and modern Chrome record to MP4).
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    // WebM fallbacks for browsers without MP4 recording.
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const candidate of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      // Some engines throw on exotic codec strings — keep probing.
    }
  }
  return "";
}

function videoExtension(mime: string): string {
  return mime.startsWith("video/mp4") ? "mp4" : "webm";
}

/** Bitrate that keeps the video sharp without wasting bytes at its size. */
function bitrateFor(outputHeight: number): number {
  const reference = 2_500_000; // ~1280x720 territory
  const ratio = Math.pow(outputHeight / 720, 2);
  const target = Math.round(reference * ratio);
  return Math.min(VIDEO_MAX_BITRATE, Math.max(VIDEO_MIN_BITRATE, target));
}

/**
 * Re-encode a video in the browser: play it once into a canvas capped at
 * VIDEO_MAX_DIMENSION and record that canvas + the original audio track with
 * MediaRecorder at a size-matched bitrate. This drops container metadata,
 * kills the multi-hundred-MB phone file, and keeps the audio — a short
 * clip that would store at 60–200 MB stores at a few MB.
 *
 * Real-time playback means a 90-second clip takes ~90 seconds to process, so
 * only clips worth shrinking are attempted; anything longer, smaller, or
 * already lean passes through unchanged. Every failure path falls back to
 * the original file — re-encoding never blocks an upload.
 */
export async function processVideoFile(file: File): Promise<ProcessedVideo> {
  const fail = { file, processed: false };
  if (!file.type.startsWith("video/")) return fail;
  if (file.size < VIDEO_MIN_PROCESS_BYTES) return fail;
  const mime = pickVideoMime();
  if (mime === "") return fail;

  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.playsInline = true;
  video.src = url;

  return new Promise<ProcessedVideo>((resolve) => {
    let settled = false;
    let rafId = 0;
    let audioCtx: AudioContext | null = null;
    let recorder: MediaRecorder | null = null;
    let watchdog = 0;
    // Arm a watchdog immediately: if the file never opens (stalled codec,
    // no onerror, no onloadedmetadata), fall back to the original instead
    // of hanging the upload forever. Re-armed with a duration-aware window
    // once metadata lands.
    watchdog = window.setTimeout(() => finish(fail), VIDEO_OPEN_TIMEOUT_MS);

    const finish = (result: ProcessedVideo) => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(rafId);
      clearTimeout(watchdog);
      try {
        recorder?.stop();
      } catch {
        // Already stopped.
      }
      try {
        if (audioCtx !== null) void audioCtx.close();
      } catch {
        // Context already closed.
      }
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      resolve(result);
    };

    video.onerror = () => finish(fail);

    video.onloadedmetadata = () => {
      const { videoWidth, videoHeight, duration } = video;
      // Too long to wait through a real-time re-encode, or a clip we
      // can't decode — keep the original.
      if (
        !Number.isFinite(duration) ||
        duration <= 0 ||
        duration > VIDEO_MAX_DURATION_SECONDS ||
        videoWidth === 0 ||
        videoHeight === 0
      ) {
        finish(fail);
        return;
      }
      // Already lean — no point spending real-time playback on it.
      if (
        Math.max(videoWidth, videoHeight) <= VIDEO_LEAN_EDGE &&
        file.size <= VIDEO_LEAN_BYTES
      ) {
        finish(fail);
        return;
      }
      const scale = Math.min(
        1,
        VIDEO_MAX_DIMENSION / Math.max(videoWidth, videoHeight),
      );
      // Even dimensions keep every encoder happy.
      const width = Math.max(2, Math.floor((videoWidth * scale) / 2) * 2);
      const height = Math.max(2, Math.floor((videoHeight * scale) / 2) * 2);

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (ctx === null) {
        finish(fail);
        return;
      }

      try {
        // Keep the original audio track alive in the recording. The element
        // source routes the video's audio into a MediaStreamDestination that
        // gets merged with the canvas's video track below.
        const AudioContextClass =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (AudioContextClass === undefined) {
          finish(fail);
          return;
        }
        audioCtx = new AudioContextClass();
        const source = audioCtx.createMediaElementSource(video);
        const dest = audioCtx.createMediaStreamDestination();
        source.connect(dest);

        const canvasStream = canvas.captureStream(VIDEO_FPS);
        const tracks = [
          ...canvasStream.getVideoTracks(),
          ...dest.stream.getAudioTracks(),
        ];
        recorder = new MediaRecorder(new MediaStream(tracks), {
          mimeType: mime,
          videoBitsPerSecond: bitrateFor(height),
          audioBitsPerSecond: 96_000,
        });
      } catch {
        // Audio graph or recorder setup failed — keep the original rather
        // than silently dropping the soundtrack.
        finish(fail);
        return;
      }

      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mime.split(";")[0] });
        // Only swap when the re-encode actually saved meaningful bytes.
        if (blob.size > 0 && blob.size < file.size * 0.9) {
          const base = file.name.replace(/\.[^.]+$/, "") || "video";
          const processedFile = new File(
            [blob],
            `${base}.${videoExtension(mime)}`,
            { type: mime.split(";")[0], lastModified: Date.now() },
          );
          finish({ file: processedFile, processed: true });
        } else {
          finish(fail);
        }
      };

      // Frame pump: draw the video into the canvas as it plays, stop when
      // it ends. The recorder has already started; onstop resolves above.
      const draw = () => {
        ctx.drawImage(video, 0, 0, width, height);
        if (!video.ended && !settled) rafId = requestAnimationFrame(draw);
      };
      video.onended = () => {
        ctx.drawImage(video, 0, 0, width, height);
        try {
          if (recorder !== null && recorder.state !== "inactive") {
            recorder.stop();
          }
        } catch {
          finish(fail);
        }
      };

      // Watchdog: re-encoding plays in real time, so the window is the
      // full duration plus a buffer — anything less would cut off a valid
      // clip right before it finished and upload the original. The open
      // watchdog above must be cleared first, or it fires at 20s and
      // aborts every clip longer than that.
      clearTimeout(watchdog);
      watchdog = window.setTimeout(
        () => finish(fail),
        duration * 1000 + 30_000,
      );

      recorder.start(1_000);
      // Play with sound so the audio track is captured. Transient user
      // activation can expire across the awaits above, so if the first
      // attempt is blocked, resume the AudioContext and try once more
      // before giving up — the original is uploaded as a last resort,
      // never a silently-dropped soundtrack.
      const attemptPlay = (): Promise<void> => video.play();
      void attemptPlay()
        .then(() => {
          rafId = requestAnimationFrame(draw);
        })
        .catch(async () => {
          try {
            if (audioCtx !== null && audioCtx.state === "suspended") {
              await audioCtx.resume();
            }
            await attemptPlay();
            rafId = requestAnimationFrame(draw);
          } catch {
            finish(fail);
          }
        });
    };

    video.load();
  });
}
