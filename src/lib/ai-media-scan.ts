/**
 * Pure byte-scanning helpers for AI-generator and deepfake markers.
 *
 * Shared between the Convex action (`src/convex/aiContent.ts`, which scans
 * the uploaded bytes server-side as the authoritative check) and the browser
 * (`src/components/MediaUpload.tsx`, which pre-scans the ORIGINAL bytes
 * before client-side processing strips metadata — so stripping EXIF can
 * never also strip the evidence that an image was machine-made).
 *
 * This module must stay free of Convex and DOM imports so both sides can
 * use it.
 */

export type AiScanResult =
  | { status: "clean" }
  | { status: "review"; reason: string }
  | { status: "blocked"; reason: string };

/**
 * Generator markers embedded in AI image files — EXIF Software/ImageDescription
 * fields and PNG tEXt "parameters" chunks (Stable Diffusion WebUI, ComfyUI,
 * Midjourney, DALL·E, NovelAI, and friends). Scanned from the raw bytes.
 */
const IMAGE_GENERATOR_MARKERS = [
  "stable diffusion",
  "stable-diffusion",
  "midjourney",
  "dall-e",
  "dall e",
  "dall·e",
  "dalle",
  "novelai",
  "adobe firefly",
  "leonardo.ai",
  "leonardo ai",
  "dreamstudio",
  "sdxl",
  "flux 1",
  "flux.1",
  "playground ai",
  "playgroundai",
  "bing image creator",
  "craiyon",
  "hotpot.ai",
  "deepai",
  "nightcafe",
  "artbreeder",
  "wombo",
  "stability.ai",
  "fooocus",
  "comfyui",
  "a1111",
  "waifu-diffusion",
  "anything-v3",
  "dreamshaper",
  "realistic vision",
  "juggernaut",
  "sampler: ",
  "cfg scale",
  "negative prompt:",
  "seed: ",
];

/**
 * Deepfake / face-manipulation tool markers found in image metadata or
 * container tags. Only tool-specific signatures are hard-blocked — a
 * generic word like "deepfake" or a consumer filter like "faceapp" is
 * demoted to the review tier so real photos are never rejected on a hunch.
 */
const DEEPFAKE_MARKERS = [
  "deepfacelab",
  "deep face lab",
  "faceswap",
  "face swap",
  "reface",
  "avatarify",
  "sadtalker",
  "roop",
  "inswap",
  "swapface",
];

/** Ambiguous wording/filter names — flagged for a human check, not blocked. */
const DEEPFAKE_REVIEW_MARKERS = ["deepfake", "faceapp"];

/**
 * Audio/video AI-generator signatures. Compound tool names are
 * hard-blocked; standalone brand words (Suno, ElevenLabs, Runway) are
 * demoted to review so legitimate metadata that merely mentions a brand
 * is never rejected automatically.
 */
const AV_GENERATOR_MARKERS = [
  "openai sora",
  "sora video",
  "sora-generated",
  "runwayml",
  "runway ml",
  "runway gen",
  "google veo",
  "veo 3",
  "pika labs",
  "pika.art",
  "pikavideo",
  "synthesia",
  "d-id.com",
  "d-id video",
  "luma dream machine",
  "lumaai",
  "kling ai",
  "klingai",
  "hailuo",
  "minimax video",
  "motion one",
  "musicgen",
  "riffusion",
  "fakeyou",
  "voice.ai",
  "lovoai",
  "resemble.ai",
  "murf.ai",
  "wellsaid",
  "play.ht",
  "tts-1",
  "tts-1-hd",
];

/** Standalone brand names — flagged for a human check, not blocked. */
const AV_REVIEW_MARKERS = [
  "suno",
  "elevenlabs",
  "eleven labs",
  "heygen",
  "hey gen",
  "runway",
  "pika",
  "udio",
  "descript",
  "ai voice",
];

const SCAN_HEAD_BYTES = 256 * 1024; // metadata lives at the head of the file

function bytesToLatin1(bytes: ArrayBuffer): string {
  const head = new Uint8Array(
    bytes,
    0,
    Math.min(bytes.byteLength, SCAN_HEAD_BYTES),
  );
  let text = "";
  for (let i = 0; i < head.length; i++) {
    text += String.fromCharCode(head[i]);
  }
  return text.toLowerCase();
}

/** Scan raw image bytes for generator and deepfake metadata markers. */
export function scanImageBytes(bytes: ArrayBuffer): AiScanResult {
  const lower = bytesToLatin1(bytes);
  for (const marker of IMAGE_GENERATOR_MARKERS) {
    if (lower.includes(marker)) {
      return {
        status: "blocked",
        reason: `This image carries AI-generator metadata (${marker.trim()}), which isn't allowed on PureWire.`,
      };
    }
  }
  for (const marker of DEEPFAKE_MARKERS) {
    if (lower.includes(marker)) {
      return {
        status: "blocked",
        reason: `This image looks deepfake-manipulated (${marker.trim()}), which isn't allowed on PureWire.`,
      };
    }
  }
  for (const marker of DEEPFAKE_REVIEW_MARKERS) {
    if (lower.includes(marker)) {
      return {
        status: "review",
        reason: `This image mentions a possible manipulation tool (${marker.trim()}) — flagged for a human check.`,
      };
    }
  }
  return { status: "clean" };
}

/** Scan raw audio/video bytes for AI-generator markers in container tags. */
export function scanMediaBytes(bytes: ArrayBuffer): AiScanResult {
  const lower = bytesToLatin1(bytes);
  for (const marker of AV_GENERATOR_MARKERS) {
    if (lower.includes(marker)) {
      return {
        status: "blocked",
        reason: `This media carries AI-generator metadata (${marker.trim()}), which isn't allowed on PureWire.`,
      };
    }
  }
  for (const marker of AV_REVIEW_MARKERS) {
    if (lower.includes(marker)) {
      return {
        status: "review",
        reason: `This media mentions a possible AI tool (${marker.trim()}) — flagged for a human check.`,
      };
    }
  }
  return { status: "clean" };
}
