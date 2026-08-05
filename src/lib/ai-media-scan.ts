/**
 * Pure byte-scanning helpers for AI-generator and deepfake detection.
 *
 * Shared between the Convex action (`src/convex/aiContent.ts`, which scans
 * the uploaded bytes server-side as the authoritative check) and the browser
 * (`src/components/MediaUpload.tsx`, which pre-scans the ORIGINAL bytes
 * before client-side processing strips metadata — so stripping EXIF can
 * never also strip the evidence that an image was machine-made).
 *
 * This module must stay free of Convex and DOM imports so both sides can
 * use it. All parsers are pure byte math over ArrayBuffer — no TextEncoder,
 * no URL, no zlib — so they run in the stripped V8 isolate Convex actions
 * use.
 *
 * The scanner is structured, not just a substring sweep:
 *
 * - It walks each container's real structure — PNG chunks (tEXt/iTXt/zTXt),
 *   JPEG segments (EXIF IFD0/ExifIFD, XMP, comments), MP4/MOV atoms
 *   (moov.udta text atoms), WebP chunks, GIF comment extensions, ID3v2
 *   frames, FLAC Vorbis comments, and RIFF/WAVE INFO chunks — and matches
 *   against the METADATA FIELDS, so markers that live in structured fields
 *   (Software, parameters, encoder atoms) are caught even when the raw
 *   head/tail sweep would miss them (compressed, or beyond the window).
 * - It validates the container against the claimed kind: an image that is
 *   actually a video container, or a file that is not any known image/audio/
 *   video format at all, is a rename-evasion tell and is flagged.
 * - It keeps the original head+tail substring sweep as a final net for
 *   markers embedded in arbitrary bytes.
 */

export type AiScanResult =
  | { status: "clean"; c2pa?: C2paInfo; ocrText?: string }
  | { status: "review"; reason: string; ocrText?: string }
  | { status: "blocked"; reason: string; ocrText?: string };

/**
 * Content Credentials (C2PA) provenance found in a file.
 *
 * C2PA is the open standard cameras and editors use to record how a file
 * was made. Its `digitalSourceType` assertion names the origin: an AI model
 * (`trainedAlgorithmicMedia`, `compositeWithTrainedAlgorithmicMedia`), a
 * camera capture (`digitalCapture`, `compositeCapture`), or other automated
 * processes. Reading it turns a file's own provenance into a verdict:
 *
 * - `aiAsserted` — the manifest itself says an AI model created/edited the
 *   content. Under the platform's zero-tolerance policy that admission is
 *   BLOCKED (it is the machine's own declaration, stronger than a marker).
 * - `humanCapture` — the manifest says a camera captured the content. That
 *   is positive provenance: the post is marked "Content Credentials
 *   verified" instead of merely passing the scan.
 * - presence alone, or an unreadable/compressed manifest, is provenance
 *   only — never a flag on its own.
 */
export type C2paInfo = {
  present: boolean;
  humanCapture: boolean;
  aiAsserted: boolean;
  /** The claim_generator value from the manifest — who created the
   * credentials (e.g. "Adobe Photoshop 26.0", "Google SynthID"). Shown
   * in the admin evidence panel so moderators know the provenance source,
   * not just the verdict. Parsed from the manifest text (latin-1 safe). */
  claimGenerator?: string;
};

// ─────────────────────────── Marker catalogs ───────────────────────────

/**
 * Generator markers embedded in AI image files — EXIF Software/ImageDescription
 * fields and PNG tEXt "parameters" chunks (Stable Diffusion WebUI, ComfyUI,
 * Midjourney, DALL·E, NovelAI, Google Imagen/Gemini, and friends).
 *
 * Google's current stack is listed explicitly — the platform's policy is
 * zero tolerance: no AI-generated media from Google or any other platform.
 */
const IMAGE_GENERATOR_MARKERS = [
  // Stable Diffusion family
  "stable diffusion",
  "stable-diffusion",
  "sdxl",
  "sd3",
  "sd3.5",
  "sd 3.5",
  "flux 1",
  "flux.1",
  "flux dev",
  "flux-dev",
  "flux schnell",
  "flux-schnell",
  "schnell-xl",
  "fooocus",
  "comfyui",
  "class_type",
  "ksampler",
  "a1111",
  "automatic1111",
  "waifu-diffusion",
  "anything-v3",
  "dreamshaper",
  "realistic vision",
  "juggernaut",
  "sampler: ",
  "cfg scale",
  "negative prompt:",
  "seed: ",
  "txt2img",
  "img2img",
  // Commercial generators
  "midjourney",
  "dall-e",
  "dall e",
  "dall·e",
  "dalle",
  "dall-e-3",
  "dall-e-4",
  "gpt-image",
  "gpt image",
  "gpt-image-1",
  "gpt-4o image",
  "chatgpt-4o image",
  "novelai",
  "adobe firefly",
  "firefly",
  "adobe express",
  "leonardo.ai",
  "leonardo ai",
  "dreamstudio",
  "playground ai",
  "playgroundai",
  "bing image creator",
  "microsoft designer",
  "craiyon",
  "hotpot.ai",
  "deepai",
  "nightcafe",
  "artbreeder",
  "wombo",
  "stability.ai",
  "tensorart",
  "recraft",
  "ideogram",
  "seedream",
  "nano-banana",
  // Google's AI image stack — explicit zero-tolerance policy
  "google imagen",
  "imagen 3",
  "imagen 4",
  "imagen-v3",
  "imagen-v4",
  "imagen-4",
  "gemini",
  "gemini 2",
  "gemini 2.5",
  "gemini image",
  "gemini-image",
  "synthid",
  "notebooklm",
  "bard",
  "google ai",
  "google-ai",
  "google ai studio",
  "aistudio",
  "deepmind",
  "veo",
  // xAI and other modern families
  "grok",
  "grok-2",
  "grok-3",
  "x ai",
  "x-ai",
  "flux",
  "krea",
  "canva ai",
  "canva",
  "picsart ai",
  "remini",
  "meitu",
  "photoroom",
  "pixlr ai",
  "fotor ai",
  "stablecascade",
  "stable cascade",
  "hunyuan image",
  "hunyuan-image",
  "workflow:",
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
  "facefusion",
  "ghostface",
  "simswap",
  "inswapper",
  "mushup",
  "fom",
  "first order motion",
];

/** Ambiguous wording/filter names — flagged for a human check, not blocked. */
const DEEPFAKE_REVIEW_MARKERS = ["deepfake", "faceapp"];

/**
 * C2PA / JUMBF provenance and Google SynthID watermark markers.
 *
 * C2PA (Content Credentials) is the open standard cameras and editors use
 * to record how a file was made. `trainedAlgorithmicMedia` and
 * `compositeWithTrainedAlgorithmicMedia` are C2PA's explicit declarations
 * that an AI model created or edited the content — under the platform's
 * zero-tolerance policy those declarations are BLOCKED (they are the
 * machine's own admission). These raw-string markers are the fallback net;
 * the structured C2PA parser (see extractC2pa) is the primary path and
 * reads the manifest's digitalSourceType properly. SynthID is Google's
 * invisible watermarking system for AI-generated media; its presence is a
 * hard block.
 */
const PROVENANCE_BLOCK_MARKERS = [
  "trainedalgorithmicmedia", // C2PA: AI model was involved — explicit admission
  "compositewithtrainedalgorithmicmedia", // C2PA: AI was composited into the media
  "synthid", // Google's invisible AI-media watermark
];

/**
 * Deliberately no C2PA-presence review markers: a bare C2PA manifest is
 * provenance, not a violation — genuine cameras (and editors that sign
 * content) embed Content Credentials too, and flagging every signed photo
 * into the human queue would drown real creators. The structured parser
 * (extractC2pa) decides from the manifest's actual assertion instead, so
 * nothing C2PA-related is added to the review list here.
 */

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
  "sora 2",
  "runwayml",
  "runway ml",
  "runway gen",
  "google veo",
  "veo 3",
  "veo 2",
  "veo 2.0",
  "gemini video",
  "gemini-video",
  "pika labs",
  "pika.art",
  "pikavideo",
  "synthesia",
  "d-id.com",
  "d-id video",
  "luma dream machine",
  "lumaai",
  "luma ray",
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
  "suno ai",
  "suno-v3",
  "suno-v4",
  "wan 2.1",
  "wan2.1",
  "wan 2.2",
  "hunyuan",
  "hedra",
  "gpt-image-1",
  "chatgpt-4o image",
  "google musiclm",
  "musiclm",
  "lyria",
  "google deepmind",
  "kits.ai",
  "revoicer",
  "coqui",
  "xtts",
  "bark tts",
  "microsoft vasa",
  "vasa-1",
  "generative fill",
  "generative expand",
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
  "ai video",
  "ai avatar",
  "text to video",
  "text-to-video",
];

/**
 * TTS / voice-clone AI signatures — the audio half of the zero-tolerance
 * policy. Compound product names, distinctive model IDs, and platform
 * domains are hard-blocked (a file whose encoder atom says "ElevenLabs
 * TTS" or "PlayHT" is machine-made, full stop); generic English phrases
 * and bare brand words are demoted to review so a genuine recording that
 * merely mentions a brand is never rejected automatically.
 *
 * These catch the watermark/container signatures TTS platforms actually
 * write: ID3 TSSE/TXXX/COMM frames (ElevenLabs, PlayHT, Speechify,
 * Descript), FLAC Vorbis ENCODER comments (Google Cloud TTS, Azure), MP4
 * ©too atoms, and WAV LIST-INFO ISFT tags (Amazon Polly). No external
 * API — pure byte signatures, same pipeline as the image scanner.
 */
const TTS_VOICE_MARKERS = [
  // ElevenLabs — the flagship voice-clone platform
  "elevenlabs tts",
  "elevenlabs voice",
  "elevenlabs-tts",
  "elevenlabs api",
  "elevenlabs.io",
  "elevenlabs clone",
  "eleven_turbo_v2",
  "eleven_monolingual",
  "eleven_multilingual",
  // PlayHT
  "playht",
  "play.ht tts",
  "play-ht",
  // Resemble AI
  "resemble ai",
  "resemble-ai",
  "resemble tts",
  // Speechify
  "speechify tts",
  "speechify-tts",
  // Amazon Polly
  "amazon polly",
  "aws polly",
  "polly tts",
  // Microsoft / Azure neural voices
  "azure neural",
  "microsoft neural",
  "microsoft speech",
  // Google Cloud TTS (WaveNet / Neural2 / Chirp)
  "google cloud tts",
  "google tts",
  "google text-to-speech",
  "google text to speech",
  "wavenet",
  "neural2",
  "neural3",
  "chirp3",
  // OpenAI TTS
  "openai tts",
  "openai audio",
  "gpt-4o-mini-tts",
  "gpt-4o-audio",
  // Descript's Underlord TTS engine — the compound is unambiguous; the
  // bare word "underlord" is a real English word (games, fantasy) so it
  // lives in the review tier instead.
  "descript underlord",
  // Other distinctive voice platforms
  "wellsaid labs",
  "lovo ai",
  "lovo.ai",
  "murf tts",
  "narakeet",
  "naturalreader",
  "synthesys",
  // VALL-E is a common word ("valle" = valley in Spanish/Italian) — only
  // the unambiguous Microsoft compound matches, never the bare word.
  "microsoft valle",
  "ms valle",
];

/** Bare TTS/voice-clone brands and generic phrases — human check, not block.
 *  One token per tier: block is checked first, so a brand that is already
 *  block-tier (PlayHT, WaveNet — distinctive enough on their own, in
 *  TTS_VOICE_MARKERS/AV_GENERATOR_MARKERS) has no review copy here. */
const TTS_VOICE_REVIEW_MARKERS = [
  "elevenlabs",
  "eleven labs",
  "resemble",
  "murf",
  "speechify",
  "lovo",
  "voiceover",
  "neural voice",
  "synthetic voice",
  "synthesized voice",
  "voice cloning",
  "voice clone",
  "cloned voice",
  "ai voiceover",
  "ai voice-over",
  "text to speech",
  "text-to-speech",
  "voice deepfake",
  "underlord",
];

// ─────────────────────────── C2PA / Content Credentials ───────────────────────────

/**
 * C2PA digitalSourceType values the platform cares about, per the IPTC
 * newscodes vocabulary. These URIs appear verbatim in the manifest JSON
 * (CBOR-encoded inside JUMBF, but the strings stay plain ASCII), so a
 * byte search of the manifest region reads them without decoding CBOR.
 */
const C2PA_AI_SOURCES = [
  "trainedalgorithmicmedia",
  "compositewithtrainedalgorithmicmedia",
];
const C2PA_HUMAN_SOURCES = ["digitalcapture", "compositecapture"];

/** Classify a manifest region's declared source type. */
function classifyC2pa(text: string): C2paInfo {
  const lower = text.toLowerCase();
  const aiAsserted = C2PA_AI_SOURCES.some((s) => lower.includes(s));
  const humanCapture = !aiAsserted && C2PA_HUMAN_SOURCES.some((s) => lower.includes(s));
  // Extract claim_generator: the tool that created the credentials.
  // "claim_generator"\s*:\s*"([^"]+)" — a loose match over the latin-1
  // bytes; JSON-aware parsing is overkill since the value is always a
  // short ASCII tool name.
  let claimGenerator: string | undefined;
  const cg = /"claim_generator"\s*:\s*"([^"]+?)"/i.exec(text);
  if (cg !== null && cg[1].length > 0 && cg[1].length <= 200) {
    claimGenerator = cg[1];
  }
  return { present: true, humanCapture, aiAsserted, claimGenerator };
}

/**
 * Extract the C2PA manifest region from a JPEG. C2PA lives in an APP11
 * segment whose payload starts with the 8-byte "JPEG-MBX" signature,
 * followed by the JUMBF superbox. Camera-signed JPEGs carry one of these;
 * AI pipelines that embed Content Credentials do too.
 */
function jpegC2pa(bytes: ArrayBuffer): C2paInfo | null {
  const b = u8(bytes);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let off = 2;
  for (let seg = 0; seg < 96; seg++) {
    if (off + 4 > b.length) break;
    if (b[off] !== 0xff) break;
    const marker = b[off + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const len = u16(b, off + 2);
    if (len < 2) break;
    const payload = off + 4;
    const end = payload + len - 2;
    if (end > b.length) break;
    if (marker === 0xeb) {
      // APP11: JPEG-MBX + JUMBF superbox payload
      if (latin1Region(b, payload, 8) === "JPEG-MBX") {
        const text = latin1Region(b, payload + 8, end - payload - 8);
        if (text.length > 0) return classifyC2pa(text);
        return { present: true, humanCapture: false, aiAsserted: false };
      }
    }
    off = end;
  }
  return null;
}

/**
 * Extract the C2PA manifest region from a PNG. The manifest is stored in
 * an iTXt chunk whose keyword is "C2PA" (spec; tEXt appears in the wild).
 * The payload is usually zlib-compressed — we can't inflate in the stripped
 * isolate, so a compressed manifest is detected as present-but-unreadable
 * (provenance only, never a verdict). Uncompressed manifests are read and
 * classified.
 */
function pngC2pa(bytes: ArrayBuffer): C2paInfo | null {
  const b = u8(bytes);
  if (b.length < 8) return null;
  let off = 8;
  for (let chunk = 0; chunk < 64; chunk++) {
    if (off + 8 > b.length) break;
    const len = u32(b, off);
    const type = latin1Region(b, off + 4, 4);
    const dataOff = off + 8;
    const dataEnd = dataOff + len;
    if (dataEnd > b.length) break;
    if (type === "iTXt" || type === "tEXt") {
      const nul = b.indexOf(0, dataOff);
      if (nul !== -1 && nul < dataEnd) {
        const key = latin1Region(b, dataOff, nul - dataOff).toLowerCase();
        if (key === "c2pa") {
          if (type === "tEXt") {
            const val = latin1Region(b, nul + 1, dataEnd - nul - 1);
            return val.length > 0
              ? classifyC2pa(val)
              : { present: true, humanCapture: false, aiAsserted: false };
          }
          // iTXt: keyword\0 compFlag compMethod lang\0 translated\0 text
          const compFlag = b[nul + 1] ?? 0;
          if (compFlag !== 0) {
            // Compressed (zlib) — present, unreadable here.
            return { present: true, humanCapture: false, aiAsserted: false };
          }
          const langStart = nul + 3;
          const nul2 = b.indexOf(0, langStart);
          if (nul2 !== -1 && nul2 + 1 < dataEnd) {
            const transStart = nul2 + 1;
            const nul3 = b.indexOf(0, transStart);
            if (nul3 !== -1 && nul3 + 1 <= dataEnd) {
              const val = utf8Region(b, nul3 + 1, dataEnd - nul3 - 1);
              if (val.length > 0) return classifyC2pa(val);
            }
          }
          return { present: true, humanCapture: false, aiAsserted: false };
        }
      }
    }
    off = dataEnd + 4; // skip CRC
  }
  return null;
}

/**
 * Extract the C2PA manifest region from an MP4/MOV. Manifests are stored
 * as `jumb` boxes (a JUMBF container), typically inside a `jumbo` box or
 * nested in udta/meta. Walk the atom tree and read the first jumb payload.
 */
function mp4C2pa(bytes: ArrayBuffer): C2paInfo | null {
  const b = u8(bytes);
  const find = (start: number, depth: number): string | null => {
    if (depth > 6 || start + 8 > b.length) return null;
    let off = start;
    let boxes = 0;
    while (off + 8 <= b.length && boxes < 512) {
      let size = u32(b, off);
      const type = latin1Region(b, off + 4, 4);
      let header = 8;
      if (size === 1) {
        if (off + 16 > b.length) return null;
        size = u32(b, off + 8);
        header = 16;
      } else if (size === 0) {
        size = b.length - off;
      }
      if (size < header) return null;
      const payload = off + header;
      const end = off + size;
      if (end > b.length) return null;
      boxes++;
      if (type === "jumb") {
        return latin1Region(b, payload, end - payload);
      }
      if (CONTAINER_ATOMS.has(type) || type === "jumbo") {
        const childStart =
          type === "meta" && payload + 4 <= end ? payload + 4 : payload;
        const found = find(childStart, depth + 1);
        if (found !== null) return found;
      }
      off = end;
    }
    return null;
  };
  const text = find(0, 0);
  if (text === null) return null;
  return text.length > 0
    ? classifyC2pa(text)
    : { present: true, humanCapture: false, aiAsserted: false };
}

/** Extract the C2PA manifest region from a WebP (RIFF `jumb` chunk). */
function webpC2pa(bytes: ArrayBuffer): C2paInfo | null {
  const b = u8(bytes);
  if (b.length < 20 || latin1Region(b, 0, 4) !== "RIFF") return null;
  let off = 12;
  for (let chunk = 0; chunk < 32; chunk++) {
    if (off + 8 > b.length) break;
    const fourCC = latin1Region(b, off, 4);
    const len = u32(b, off + 4);
    const dataOff = off + 8;
    const dataEnd = dataOff + len;
    if (dataEnd + (len % 2) > b.length) break;
    if (fourCC === "jumb") {
      const text = latin1Region(b, dataOff, len);
      if (text.length > 0) return classifyC2pa(text);
      return { present: true, humanCapture: false, aiAsserted: false };
    }
    off = dataEnd + (len % 2);
  }
  return null;
}

/**
 * Read a file's Content Credentials manifest for the container it really
 * is. Returns null when the container carries no C2PA/JUMBF region (or the
 * format doesn't support one). Genuine camera photos and AI files that
 * embed credentials both show up here — the assertion decides the verdict.
 */
function extractC2pa(container: Container, bytes: ArrayBuffer): C2paInfo | null {
  switch (container) {
    case "jpeg":
      return jpegC2pa(bytes);
    case "png":
      return pngC2pa(bytes);
    case "mp4":
      return mp4C2pa(bytes);
    case "webp":
      return webpC2pa(bytes);
    default:
      return null;
  }
}

/** Reason for a C2PA-declared AI file: the file's own provenance admits it. */
const C2PA_AI_REASON =
  "This file's Content Credentials declare it was made or edited with an AI model — that isn't allowed on PureWire.";

// ─────────────────────────── Byte helpers ───────────────────────────

const SCAN_HEAD_BYTES = 256 * 1024; // metadata lives at the head of the file
const SCAN_TAIL_BYTES = 128 * 1024; // …and at the tail (MP4 moov/udta boxes)

/** Read the scan window as latin-1 text (head + tail). */
function bytesToLatin1(bytes: ArrayBuffer): string {
  const total = bytes.byteLength;
  const headLen = Math.min(total, SCAN_HEAD_BYTES);
  let text = "";
  const head = new Uint8Array(bytes, 0, headLen);
  for (let i = 0; i < head.length; i++) {
    text += String.fromCharCode(head[i]);
  }
  if (total > SCAN_HEAD_BYTES) {
    const tailStart = Math.max(SCAN_HEAD_BYTES, total - SCAN_TAIL_BYTES);
    const tail = new Uint8Array(bytes, tailStart, total - tailStart);
    for (let i = 0; i < tail.length; i++) {
      text += String.fromCharCode(tail[i]);
    }
  }
  return text.toLowerCase();
}

function u8(bytes: ArrayBuffer): Uint8Array {
  return new Uint8Array(bytes);
}

function u32(bytes: Uint8Array, off: number): number {
  return (
    ((bytes[off] ?? 0) << 24) |
    ((bytes[off + 1] ?? 0) << 16) |
    ((bytes[off + 2] ?? 0) << 8) |
    (bytes[off + 3] ?? 0)
  ) >>> 0;
}

/** RIFF/WAVE and FLAC sizes are little-endian — read them as such. */
function u32le(bytes: Uint8Array, off: number): number {
  return (
    (bytes[off] ?? 0) |
    ((bytes[off + 1] ?? 0) << 8) |
    ((bytes[off + 2] ?? 0) << 16) |
    ((bytes[off + 3] ?? 0) << 24)
  ) >>> 0;
}

function u16(bytes: Uint8Array, off: number): number {
  return (((bytes[off] ?? 0) << 8) | (bytes[off + 1] ?? 0)) >>> 0;
}

/** ASCII/latin-1 decode of a bounded region (stops at NUL or end). */
function latin1Region(bytes: Uint8Array, off: number, len: number): string {
  const end = Math.min(bytes.length, off + len);
  let out = "";
  for (let i = off; i < end; i++) {
    const c = bytes[i];
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out;
}

/** Read a bounded UTF-8 string (used for PNG iTXt). */
function utf8Region(bytes: Uint8Array, off: number, len: number): string {
  const end = Math.min(bytes.length, off + len);
  let out = "";
  let i = off;
  while (i < end) {
    const b = bytes[i];
    if (b === 0) break;
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i++;
    } else if (b < 0xe0 && i + 1 < end) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if (b < 0xf0 && i + 2 < end) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f),
      );
      i += 3;
    } else if (i + 3 < end) {
      const cp =
        ((b & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      out += String.fromCodePoint(cp);
      i += 4;
    } else {
      i++;
    }
  }
  return out;
}

// ─────────────────────────── Scan orchestration ───────────────────────────

/** Parse the right container parser for a detected kind. */
function extractMeta(container: Container, bytes: ArrayBuffer): ExtractedMeta {
  switch (container) {
    case "png":
      return parsePng(bytes);
    case "jpeg":
      return parseJpeg(bytes);
    case "webp":
      return parseWebp(bytes);
    case "gif":
      return parseGif(bytes);
    case "mp4":
      return parseMp4(bytes);
    // WebM/Matroska passes container validation but has no structural
    // parser here — its tags (EBML/SimpleTag) are caught by the raw sweep
    // fallback, same as before this overhaul.
    case "mp3":
      return parseId3(bytes);
    case "flac":
      return parseFlac(bytes);
    case "wav":
      return parseWav(bytes);
    default:
      return emptyMeta;
  }
}


/** Extract human-readable text from image metadata for OCR-based racism
 *  scanning. Modern phones embed screen-recognized text in EXIF/XMP/PNG
 *  metadata — this pulls it out so scanForRacism can check it without a
 *  full OCR engine. The raw head/tail sweep is deliberately excluded:
 *  binary noise is not OCR, and false-positive "text" from random bytes
 *  would pollute the racism scan with garbage. */
function extractImageText(_container: Container, _bytes: ArrayBuffer, meta: ExtractedMeta): string {
  const parts: string[] = [];
  // EXIF ImageDescription (tag 0x010E) and UserComment (tag 0x9286):
  // phone-OCR'd screenshot text and captions are routinely stored here.
  // Skip the raw head/tail sweep — binary noise is not OCR text.
  for (const f of meta.fields) {
    parts.push(f);
  }
  for (const s of meta.free) {
    if (s.length > 2) parts.push(s);
  }
  return parts.filter(p => p.trim().length > 0).join(' | ');
}

/**
 * Match marker lists against every extracted field/value and the raw sweep.
 * Returns the first hard block, else the first review signal, else null.
 * Structured fields are scanned first (a marker in Software is stronger
 * evidence than the same string in arbitrary bytes).
 */
function matchMarkers(
  fields: string[],
  free: string[],
  raw: string,
  blockMarkers: string[],
  reviewMarkers: string[],
  blockedReason: (m: string) => string,
  reviewReason: (m: string) => string,
): AiScanResult | null {
  // Hard blocks: fields + free strings + raw sweep. Structured field
  // values carry real case ("Software: PlayHT", "ENCODER=Amazon Polly")
  // while markers are lowercase — compare both sides case-insensitively,
  // the same rule the free-string path already uses.
  for (const marker of blockMarkers) {
    for (const f of fields) {
      if (f.toLowerCase().includes(marker)) {
        return { status: "blocked", reason: blockedReason(marker) };
      }
    }
  }
  // Free strings (comments, descriptions, chunk values) are free text — the
  // same raw-safe rule applies: a bare brand like "canva" in a comment is
  // not a block; only unambiguous signatures are.
  for (const marker of blockMarkers) {
    if (!isRawSafeMarker(marker)) continue;
    for (const s of free) {
      if (s.toLowerCase().includes(marker)) {
        return { status: "blocked", reason: blockedReason(marker) };
      }
    }
  }
  // Review tier: fields and free strings only (a bare brand mention in
  // arbitrary bytes is too weak to flag on its own).
  for (const marker of reviewMarkers) {
    for (const f of fields) {
      if (f.toLowerCase().includes(marker)) {
        return { status: "review", reason: reviewReason(marker) };
      }
    }
  }
  for (const marker of reviewMarkers) {
    for (const s of free) {
      if (s.toLowerCase().includes(marker)) {
        return { status: "review", reason: reviewReason(marker) };
      }
    }
  }
  // Raw sweep: only signatures that are unambiguous in arbitrary bytes
  // (multi-word tool names, long distinctive tokens, or RAW_SAFE_SHORT) are
  // matched here — a bare brand like "canva" or "gemini" in a photo's raw
  // bytes is noise, so it only ever matches inside structured metadata
  // fields above, never against the whole file.
  for (const marker of blockMarkers) {
    if (isRawSafeMarker(marker) && raw.includes(marker)) {
      return { status: "blocked", reason: blockedReason(marker) };
    }
  }
  for (const marker of reviewMarkers) {
    if (isRawSafeMarker(marker) && raw.includes(marker)) {
      return { status: "review", reason: reviewReason(marker) };
    }
  }
  return null;
}

const ALL_BLOCK = [
  ...IMAGE_GENERATOR_MARKERS,
  ...DEEPFAKE_MARKERS,
  ...AV_GENERATOR_MARKERS,
  ...TTS_VOICE_MARKERS,
  ...PROVENANCE_BLOCK_MARKERS,
];
const ALL_REVIEW = [
  ...DEEPFAKE_REVIEW_MARKERS,
  ...AV_REVIEW_MARKERS,
  ...TTS_VOICE_REVIEW_MARKERS,
];

/**
 * Short but unambiguous tool signatures that are safe to match in RAW bytes
 * (a bare "synthid", "comfyui", or "synthesia" in a file's bytes is itself
 * the signature). Short bare BRANDS — canva, gemini, bard, veo, grok, flux,
 * firefly, pika, suno, udio — are deliberately NOT here: they can appear in
 * a genuine photo's comment/URL or in ordinary prose, so they only ever
 * match inside structured metadata fields ("Software: Canva"), never in
 * arbitrary bytes. Multi-word and long (≥8 chars) signatures are always
 * raw-safe.
 */
const RAW_SAFE_SHORT = new Set([
  "synthid",
  "comfyui",
  "a1111",
  "fooocus",
  "jumbf",
  "c2pa",
  "synthesia",
  "deepfacelab",
  "faceswap",
  "sadtalker",
  "reface",
  "simswap",
  "inswapper",
  "avatarify",
  "swapface",
  "facefusion",
  "xtts",
  "coqui",
  "hedra",
  "hunyuan",
  "lyria",
  "musiclm",
  "tts-1",
  "tts-1-hd",
  "vasa-1",
  "d-id.com",
  "d-id video",
  "kits.ai",
  "murf.ai",
  "play.ht",
  "voice.ai",
  "fakeyou",
  "playht",
  "wavenet",
  "neural2",
  "neural3",
  "chirp3",
  "lumaai",
  "klingai",
  "pikavideo",
  "workflow:",
  "class_type",
  "ksampler",
  "seed: ",
  "txt2img",
  "img2img",
  "dreamstudio",
  "stablecascade",
  "nano-banana",
  "tensorart",
  "seedream",
  "craiyon",
  "nightcafe",
  "artbreeder",
  "deepai",
  "playgroundai",
  "wombo",
  "novelai",
  "dall-e",
  "dall e",
  "dall\u00b7e",
  "dalle",
]);

function isRawSafeMarker(marker: string): boolean {
  if (marker.includes(" ") || marker.length >= 8) return true;
  return RAW_SAFE_SHORT.has(marker);
}

const BLOCK_REASON = (m: string) =>
  `This media carries AI-generator metadata (${m.trim()}), which isn't allowed on PureWire.`;
const REVIEW_REASON = (m: string) =>
  `This media mentions a possible AI tool (${m.trim()}) — flagged for a human check.`;

/** Validate that the detected container matches the claimed kind. */
function containerMismatch(
  container: Container,
  kind: "image" | "media",
): string | null {
  if (container === null) {
    return "This file isn't a recognized image, audio, or video format — it may have been renamed to hide what it is.";
  }
  if (kind === "image" && !IMAGE_CONTAINERS.includes(container)) {
    return "This file isn't really an image — it's a different format that may have been renamed.";
  }
  if (kind === "media" && VIDEO_CONTAINERS.includes(container) === false && AUDIO_CONTAINERS.includes(container) === false) {
    return "This file isn't really audio or video — it's a different format that may have been renamed.";
  }
  return null;
}

/**
 * Scan raw image bytes for generator/deepfake markers. Validates the
 * container first (a renamed file is an evasion tell), then reads the
 * Content Credentials manifest — the file's own provenance — then walks
 * the structured metadata, then falls back to the raw head/tail sweep.
 */
export function scanImageBytes(bytes: ArrayBuffer): AiScanResult {
  const container = detectContainer(bytes);
  const mismatch = containerMismatch(container, "image");
  if (mismatch !== null) {
    return { status: "review", reason: mismatch };
  }
  // C2PA first: the manifest's own digitalSourceType is stronger evidence
  // than any marker — a file that declares itself AI-made is blocked on
  // its own admission; one that declares camera capture is clean with its
  // provenance carried on the verdict.
  const c2pa = extractC2pa(container, bytes);
  if (c2pa !== null && c2pa.aiAsserted) {
    return { status: "blocked", reason: C2PA_AI_REASON };
  }
  const meta = extractMeta(container, bytes);
  const ocrText = extractImageText(container, bytes, meta);
  const raw = bytesToLatin1(bytes);
  const hit = matchMarkers(
    meta.fields,
    meta.free,
    raw,
    ALL_BLOCK,
    ALL_REVIEW,
    BLOCK_REASON,
    REVIEW_REASON,
  );
  if (hit !== null) return { ...hit, ocrText };
  return {
    status: "clean",
    // Carry positive provenance forward so the post can be marked
    // "Content Credentials verified" (see createPostInternal).
    c2pa: c2pa !== null && c2pa.humanCapture ? c2pa : undefined,
    ocrText,
  };
}

/**
 * Scan raw audio/video bytes for AI-generator markers. Same pipeline as
 * images: container validation + C2PA provenance + structured atom/tag
 * parsing + raw sweep.
 */
export function scanMediaBytes(bytes: ArrayBuffer): AiScanResult {
  const container = detectContainer(bytes);
  const mismatch = containerMismatch(container, "media");
  if (mismatch !== null) {
    return { status: "review", reason: mismatch };
  }
  const c2pa = extractC2pa(container, bytes);
  if (c2pa !== null && c2pa.aiAsserted) {
    return { status: "blocked", reason: C2PA_AI_REASON };
  }
  const meta = extractMeta(container, bytes);
  const raw = bytesToLatin1(bytes);
  const hit = matchMarkers(
    meta.fields,
    meta.free,
    raw,
    ALL_BLOCK,
    ALL_REVIEW,
    BLOCK_REASON,
    REVIEW_REASON,
  );
  if (hit !== null) return hit;
  return {
    status: "clean",
    c2pa: c2pa !== null && c2pa.humanCapture ? c2pa : undefined,
  };
}

// ─────────────────────────── Container detection ───────────────────────────

type Container =
  | "png"
  | "jpeg"
  | "gif"
  | "webp"
  | "mp4"
  | "webm"
  | "mp3"
  | "flac"
  | "wav"
  | null;

/** Identify the real container from magic bytes. Null = not any known format. */
function detectContainer(bytes: ArrayBuffer): Container {
  const b = u8(bytes);
  if (b.length < 12) return null;
  // PNG
  if (
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return "png";
  }
  // JPEG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  // GIF
  if (latin1Region(b, 0, 6) === "GIF87a" || latin1Region(b, 0, 6) === "GIF89a") {
    return "gif";
  }
  // WebP (RIFF....WEBP)
  if (
    latin1Region(b, 0, 4) === "RIFF" &&
    latin1Region(b, 8, 4) === "WEBP"
  ) {
    return "webp";
  }
  // MP4/MOV (size + ftyp/moov/wide/mdat/free)
  const box = latin1Region(b, 4, 4);
  if (box === "ftyp" || box === "moov" || box === "wide" || box === "mdat" || box === "free") {
    return "mp4";
  }
  // WebM / Matroska (EBML)
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  // MP3 (ID3 tag or MPEG frame sync)
  if (latin1Region(b, 0, 3) === "ID3") return "mp3";
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "mp3";
  // FLAC
  if (latin1Region(b, 0, 4) === "fLaC") return "flac";
  // WAV / RIFF audio
  if (latin1Region(b, 0, 4) === "RIFF" && latin1Region(b, 8, 4) === "WAVE") return "wav";
  return null;
}

const IMAGE_CONTAINERS: Container[] = ["png", "jpeg", "gif", "webp"];
const VIDEO_CONTAINERS: Container[] = ["mp4", "webm"];
const AUDIO_CONTAINERS: Container[] = ["mp3", "flac", "wav"];

/** Metadata fields extracted from a container, for marker matching. */
type ExtractedMeta = {
  /** Named fields — Software, parameters, encoder, etc. */
  fields: string[];
  /** Free-form strings (comments, descriptions, arbitrary runs). */
  free: string[];
};

const emptyMeta: ExtractedMeta = { fields: [], free: [] };

// ─────────────────────────── PNG ───────────────────────────

/**
 * PNG text keywords that are STRUCTURED evidence when their value names an
 * AI tool — a "Software" field or an "parameters"/"prompt"/"workflow"
 * chunk is the generator speaking directly. Every other keyword
 * (Comment, Description, Title, Author, …) is free text: a bare brand in a
 * comment is exactly the false-positive case the raw-safe filter protects
 * against, so it must reach the matcher as a free string, never as a
 * field. (This mirrors EXIF, where only the software/model tags are
 * fields and COM comments stay free.)
 */
const PNG_FIELD_KEYWORDS = new Set([
  "software",
  "parameters",
  "prompt",
  "workflow",
  "artist",
  "copyright",
  "generator",
  "creation_software",
]);

/**
 * Walk PNG chunks and collect text chunks. Stable Diffusion WebUI writes a
 * `parameters` tEXt chunk; ComfyUI writes `prompt`/`workflow`; editors write
 * `Software`, `Comment`, `Description`. These are the strongest AI signal in
 * PNGs, and a naive head/tail sweep can miss them (or hit a zTXt-compressed
 * variant). Returns the chunk text (latin-1 for tEXt/zTXt, UTF-8 for iTXt).
 */
function parsePng(bytes: ArrayBuffer): ExtractedMeta {
  const b = u8(bytes);
  if (b.length < 8) return emptyMeta;
  const fields: string[] = [];
  const free: string[] = [];
  let off = 8;
  // Up to 64 chunks; metadata lives near the head.
  for (let chunk = 0; chunk < 64; chunk++) {
    if (off + 8 > b.length) break;
    const len = u32(b, off);
    const type = latin1Region(b, off + 4, 4);
    const dataOff = off + 8;
    const dataEnd = dataOff + len;
    if (dataEnd > b.length) break; // truncated chunk — stop
    if (type === "tEXt") {
      // keyword\0text (latin-1)
      const nul = b.indexOf(0, dataOff);
      if (nul !== -1 && nul < dataEnd) {
        const key = latin1Region(b, dataOff, nul - dataOff).toLowerCase();
        const val = latin1Region(b, nul + 1, dataEnd - nul - 1);
        if (PNG_FIELD_KEYWORDS.has(key)) {
          fields.push(`${key}: ${val}`);
        }
        free.push(val);
      }
    } else if (type === "iTXt") {
      // keyword\0 compFlag compMethod lang\0 translatedKeyword\0 text (UTF-8)
      const nul1 = b.indexOf(0, dataOff);
      if (nul1 !== -1 && nul1 + 3 < dataEnd) {
        const key = latin1Region(b, dataOff, nul1 - dataOff).toLowerCase();
        const langStart = nul1 + 3;
        const nul2 = b.indexOf(0, langStart);
        if (nul2 !== -1 && nul2 + 1 < dataEnd) {
          const transStart = nul2 + 1;
          const nul3 = b.indexOf(0, transStart);
          if (nul3 !== -1 && nul3 + 1 <= dataEnd) {
            const val = utf8Region(b, nul3 + 1, dataEnd - nul3 - 1);
            if (PNG_FIELD_KEYWORDS.has(key)) {
              fields.push(`${key}: ${val}`);
            }
            free.push(val);
          }
        }
      }
    } else if (type === "zTXt") {
      // keyword\0 compMethod + zlib data — keyword alone is useful even
      // though the payload is compressed (a zTXt "parameters" chunk is
      // itself an A1111 signature).
      const nul = b.indexOf(0, dataOff);
      if (nul !== -1 && nul < dataEnd) {
        const key = latin1Region(b, dataOff, nul - dataOff).toLowerCase();
        if (PNG_FIELD_KEYWORDS.has(key)) {
          fields.push(`chunk: ${key}`);
        }
      }
    }
    off = dataEnd + 4; // skip CRC
  }
  return { fields, free };
}

// ─────────────────────────── JPEG / EXIF / XMP ───────────────────────────

/** EXIF IFD0/ExifIFD tags that name the creating software or model. */
const EXIF_SOFTWARE_TAGS: Record<number, string> = {
  0x010e: "imagedescription",
  0x010f: "make",
  0x0110: "model",
  0x0131: "software",
  0x0132: "datetime",
  0x013b: "artist",
  0x8298: "copyright",
  0x9c9b: "xptitle",
  0xa420: "imageuniqueid",
  0xa430: "cameraserialnumber",
};

/**
 * Parse a TIFF/EXIF block (as embedded in JPEG APP1, PNG eXIf, WebP EXIF,
 * or TIFF files) for the creator/software tags. Handles both endiannesses.
 * Returns a list of `key: value` fields plus the raw values for free match.
 */
function parseExif(bytes: ArrayBuffer, start = 0): ExtractedMeta {
  const b = u8(bytes);
  const fields: string[] = [];
  const free: string[] = [];
  if (start + 8 > b.length) return emptyMeta;
  const endian = latin1Region(b, start, 2);
  const little = endian === "II";
  if (!little && endian !== "MM") return emptyMeta;
  const getU32 = (o: number): number => {
    if (little) {
      return ((b[o + 3] ?? 0) << 24) | ((b[o + 2] ?? 0) << 16) | ((b[o + 1] ?? 0) << 8) | (b[o] ?? 0);
    }
    return u32(b, o);
  };
  const getU16 = (o: number): number => {
    if (little) return ((b[o + 1] ?? 0) << 8) | (b[o] ?? 0);
    return u16(b, o);
  };
  // Read an ASCII value at an IFD entry (inline if ≤4 bytes, else offset).
  // TIFF string offsets are relative to the TIFF block start — which for a
  // JPEG-embedded APP1/EXIF, PNG eXIf, or WebP EXIF is NONZERO — so offset
  // reads must be `start + off`, never bare `off`.
  const readAscii = (o: number, count: number): string => {
    const capped = Math.min(count, 1024);
    if (capped <= 4) {
      return latin1Region(b, o, capped);
    }
    const off = getU32(o);
    if (start + off + capped > b.length) return "";
    return latin1Region(b, start + off, capped);
  };
  const ifdOff = start + 4 + getU32(start + 4);
  if (ifdOff + 2 > b.length) return emptyMeta;
  const count = getU16(ifdOff);
  let cursor = ifdOff + 2;
  let exifPointer = -1;
  for (let i = 0; i < Math.min(count, 64) && cursor + 12 <= b.length; i++) {
    const tag = getU16(cursor);
    const type = getU16(cursor + 2);
    const valueCount = getU32(cursor + 4);
    const label = EXIF_SOFTWARE_TAGS[tag];
    if (tag === 0x8769) {
      exifPointer = getU32(cursor + 8);
    } else if (label !== undefined && type === 2) {
      const val = readAscii(cursor + 8, valueCount);
      if (val.length > 0) {
        fields.push(`${label}: ${val}`);
        free.push(val);
      }
    } else if (label === "make" || label === "model" || label === "imagedescription") {
      // Some tools store these as BYTE or even in odd types — try as ASCII anyway.
      const val = readAscii(cursor + 8, valueCount);
      if (val.length > 0) {
        fields.push(`${label}: ${val}`);
        free.push(val);
      }
    }
    cursor += 12;
  }
  // ExifIFD: 0x9286 UserComment, 0xa434 LensModel.
  if (exifPointer !== -1) {
    const sub = start + exifPointer;
    if (sub + 2 <= b.length) {
      const subCount = getU16(sub);
      let subCur = sub + 2;
      for (let i = 0; i < Math.min(subCount, 64) && subCur + 12 <= b.length; i++) {
        const tag = getU16(subCur);
        const type = getU16(subCur + 2);
        const valueCount = getU32(subCur + 4);
        if (tag === 0x9286 && type === 7) {
          const off = getU32(subCur + 8);
          const val = latin1Region(b, start + off, Math.min(valueCount, 512));
          if (val.length > 0) {
            fields.push(`usercomment: ${val}`);
            free.push(val);
          }
        } else if (tag === 0xa434 && type === 2) {
          const val = readAscii(subCur + 8, valueCount);
          if (val.length > 0) {
            fields.push(`lensmodel: ${val}`);
            free.push(val);
          }
        }
        subCur += 12;
      }
    }
  }
  return { fields, free };
}

/** Extract creator-tool and format strings from an XMP packet. */
function parseXmp(xml: string): ExtractedMeta {
  const fields: string[] = [];
  const free: string[] = [];
  const re =
    /<(?:xmp:CreatorTool|tiff:Software|photoshop:Creator|dc:format|exif:Make|exif:Model|aux:SerialNumber)[^>]*>([^<]*)<\//gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const tag = m[0].split(":")[1]?.split(/[ >]/)[0] ?? "";
    if (m[1].trim().length > 0) {
      fields.push(`${tag.toLowerCase()}: ${m[1].trim()}`);
      free.push(m[1].trim());
    }
  }
  return { fields, free };
}

/** Walk JPEG segments; parse APP1 EXIF + XMP, COM comments. */
function parseJpeg(bytes: ArrayBuffer): ExtractedMeta {
  const b = u8(bytes);
  const fields: string[] = [];
  const free: string[] = [];
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return emptyMeta;
  let off = 2;
  for (let seg = 0; seg < 96; seg++) {
    if (off + 4 > b.length) break;
    if (b[off] !== 0xff) break; // not a marker — entropy data reached
    const marker = b[off + 1];
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS
    const len = u16(b, off + 2);
    if (len < 2) break;
    const payload = off + 4;
    const end = payload + len - 2;
    if (end > b.length) break;
    if (marker === 0xe1) {
      // APP1: EXIF or XMP
      const sig = latin1Region(b, payload, 6);
      if (sig === "Exif\0\0") {
        const ex = parseExif(bytes, payload + 6);
        fields.push(...ex.fields);
        free.push(...ex.free);
      } else if (latin1Region(b, payload, 28).includes("xap/1.0") || latin1Region(b, payload, 4) === "http") {
        const xml = latin1Region(b, payload, end - payload);
        const xm = parseXmp(xml);
        fields.push(...xm.fields);
        free.push(...xm.free);
      }
    } else if (marker === 0xfe) {
      const comment = latin1Region(b, payload, end - payload);
      if (comment.trim().length > 0) {
        free.push(comment);
      }
    }
    off = end;
  }
  return { fields, free };
}

// ─────────────────────────── MP4 / MOV atoms ───────────────────────────

/** Atom types whose payloads are text metadata (encoder, software, GPS). */
const TEXT_ATOMS = new Set([
  "\u00a9too", "\u00a9swr", "\u00a9nam", "\u00a9mak", "\u00a9mod",
  "\u00a9xyz", "\u00a9gen", "\u00a9aut", "\u00a9alb", "\u00a9art",
  "\u00a9cmt", "cmt1", "cmt2", "cmt3", "cmt4", "keyw", "desc",
  "com.apple.quicktime.software", "com.apple.quicktime.creationdate",
  "com.apple.quicktime.model", "com.apple.quicktime.make",
  "com.apple.quicktime.author", "com.apple.quicktime.copyright",
  "com.apple.quicktime.location.ISO6709",
]);

/** Container atom types to recurse into. */
const CONTAINER_ATOMS = new Set([
  "moov", "trak", "mdia", "minf", "stbl", "udta", "meta", "moof",
  "traf", "edts", "mvex", "mfra", "dinf", "iprp", "ipro",
]);

/** Walk MP4/MOV atoms (size-prefixed boxes), collecting text atoms. */
function parseMp4(bytes: ArrayBuffer): ExtractedMeta {
  const b = u8(bytes);
  const fields: string[] = [];
  const free: string[] = [];
  const walk = (start: number, depth: number) => {
    if (depth > 6 || start + 8 > b.length) return;
    let off = start;
    let boxes = 0;
    while (off + 8 <= b.length && boxes < 512) {
      let size = u32(b, off);
      const type = latin1Region(b, off + 4, 4);
      let header = 8;
      if (size === 1) {
        // 64-bit size
        if (off + 16 > b.length) return;
        size = u32(b, off + 8);
        header = 16;
      } else if (size === 0) {
        size = b.length - off; // to end of file
      }
      if (size < header) return;
      const payload = off + header;
      const end = off + size;
      if (end > b.length) return;
      boxes++;
      if (TEXT_ATOMS.has(type)) {
        // meta/udta are containers (recurse below), never text atoms —
        // they're excluded by TEXT_ATOMS membership. Text atoms are
        // payload-only: read the whole payload as the value.
        const val = latin1Region(b, payload, end - payload)
          // eslint-disable-next-line no-control-regex
          .replace(/[\u0000-\u001f]+/g, " ")
          .trim();
        if (val.length > 0) {
          fields.push(`${type}: ${val}`);
          free.push(val);
        }
      }
      if (CONTAINER_ATOMS.has(type)) {
        const childStart =
          type === "meta" && payload + 4 <= end ? payload + 4 : payload;
        walk(childStart, depth + 1);
      }
      off = end;
    }
  };
  walk(0, 0);
  return { fields, free };
}

// ─────────────────────────── WebP / GIF ───────────────────────────

/** WebP: RIFF container with EXIF / XMP chunks. */
function parseWebp(bytes: ArrayBuffer): ExtractedMeta {
  const b = u8(bytes);
  const fields: string[] = [];
  const free: string[] = [];
  if (b.length < 20 || latin1Region(b, 0, 4) !== "RIFF") return emptyMeta;
  let off = 12;
  for (let chunk = 0; chunk < 32; chunk++) {
    if (off + 8 > b.length) break;
    const fourCC = latin1Region(b, off, 4);
    const len = u32(b, off + 4);
    const dataOff = off + 8;
    const dataEnd = dataOff + len;
    if (dataEnd + (len % 2) > b.length) break;
    if (fourCC === "EXIF") {
      const ex = parseExif(bytes, dataOff);
      fields.push(...ex.fields);
      free.push(...ex.free);
    } else if (fourCC === "XMP ") {
      const xml = latin1Region(b, dataOff, len);
      const xm = parseXmp(xml);
      fields.push(...xm.fields);
      free.push(...xm.free);
    }
    off = dataEnd + (len % 2); // chunks are padded to even size
  }
  return { fields, free };
}

/** GIF: comment extensions carry tool signatures. */
function parseGif(bytes: ArrayBuffer): ExtractedMeta {
  const b = u8(bytes);
  const free: string[] = [];
  if (b.length < 14) return emptyMeta;
  let off = 13;
  for (let block = 0; block < 96; block++) {
    if (off >= b.length) break;
    const marker = b[off];
    if (marker === 0x3b) break; // trailer
    if (marker === 0x21) {
      const label = b[off + 1];
      off += 2;
      if (label === 0xfe) {
        // Comment extension
        let comment = "";
        while (off < b.length) {
          const subLen = b[off];
          off++;
          if (subLen === 0) break;
          if (off + subLen > b.length) break;
          comment += latin1Region(b, off, subLen);
          off += subLen;
        }
        if (comment.trim().length > 0) free.push(comment);
      } else {
        // Other extension — skip its sub-blocks
        while (off < b.length) {
          const subLen = b[off];
          off++;
          if (subLen === 0) break;
          off += subLen;
        }
      }
    } else if (marker === 0x2c) {
      // Image descriptor: 9 bytes + LZW min code size + sub-blocks
      off += 9;
      if (off < b.length) off += 1;
      while (off < b.length) {
        const subLen = b[off];
        off++;
        if (subLen === 0) break;
        off += subLen;
      }
    } else {
      break;
    }
  }
  return { fields: [], free };
}

// ─────────────────────────── Audio (ID3 / FLAC / WAV) ───────────────────────────

/**
 * Decode an ID3v2 text payload by its encoding byte: 0 = ISO-8859-1,
 * 1 = UTF-16 with BOM, 2 = UTF-16BE, 3 = UTF-8 (read bytewise — ASCII
 * markers survive, multi-byte characters come through best-effort). TTS
 * platforms routinely write UTF-16 (enc 1) so their watermarks must not
 * vanish into interleaved NUL bytes.
 */
function decodeId3Text(b: Uint8Array, enc: number, off: number, end: number): string {
  if (enc === 1 || enc === 2) {
    // UTF-16: honour a BOM if present, else assume the platform default.
    let bigEndian = enc === 2;
    let start = off;
    if (start + 1 < end && b[start] === 0xff && b[start + 1] === 0xfe) {
      bigEndian = false;
      start += 2;
    } else if (start + 1 < end && b[start] === 0xfe && b[start + 1] === 0xff) {
      bigEndian = true;
      start += 2;
    }
    let out = "";
    for (let i = start; i + 1 < end; i += 2) {
      const unit = bigEndian ? (b[i] << 8) | b[i + 1] : b[i] | (b[i + 1] << 8);
      if (unit === 0) break;
      out += String.fromCharCode(unit);
    }
    return out;
  }
  return latin1Region(b, off, end - off);
}

/** MP3 ID3v2: TSSE (software), TENC, TXXX, COMM, TIT2, TPE1. */
function parseId3(bytes: ArrayBuffer): ExtractedMeta {
  const b = u8(bytes);
  const fields: string[] = [];
  const free: string[] = [];
  if (b.length < 10 || latin1Region(b, 0, 3) !== "ID3") return emptyMeta;
  const syncSafe = (o: number): number =>
    (((b[o] ?? 0) & 0x7f) << 21) |
    (((b[o + 1] ?? 0) & 0x7f) << 14) |
    (((b[o + 2] ?? 0) & 0x7f) << 7) |
    ((b[o + 3] ?? 0) & 0x7f);
  const tagSize = syncSafe(6);
  const tagEnd = Math.min(b.length, 10 + tagSize);
  let off = 10;
  for (let frame = 0; frame < 96 && off + 10 <= tagEnd; frame++) {
    const id = latin1Region(b, off, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = syncSafe(off + 4);
    const dataOff = off + 10;
    const dataEnd = dataOff + size;
    if (dataEnd > tagEnd) break;
    const enc = b[dataOff] ?? 0;
    if (id === "TXXX") {
      // User text frame: enc + description\0 + value. The description is
      // free-form ("Encoder", "Producer", …) and the VALUE is what TTS
      // tools watermark — read past the description's NUL terminator.
      const descStart = dataOff + 1;
      const nul = b.indexOf(0, descStart);
      if (nul !== -1 && nul + 1 < dataEnd) {
        const desc = latin1Region(b, descStart, nul - descStart);
        const val = decodeId3Text(b, enc, nul + 1, dataEnd);
        if (val.length > 0) {
          fields.push(desc.length > 0 ? `txxx ${desc}: ${val}` : `txxx: ${val}`);
          free.push(val);
        }
      } else {
        // No description terminator (malformed but seen in the wild) —
        // fall back to reading the whole payload as the value so a
        // watermark isn't silently lost.
        const val = decodeId3Text(b, enc, descStart, dataEnd);
        if (val.length > 0) {
          fields.push(`txxx: ${val}`);
          free.push(val);
        }
      }
    } else if (id === "COMM") {
      // Comment frame: enc + 3-byte language + short description\0 + text.
      const langEnd = dataOff + 4;
      const nul = b.indexOf(0, langEnd);
      if (nul !== -1 && nul + 1 < dataEnd) {
        const text = decodeId3Text(b, enc, nul + 1, dataEnd);
        if (text.length > 0) {
          fields.push(`comment: ${text}`);
          free.push(text);
        }
      } else {
        // No description terminator — read the whole frame body.
        const text = decodeId3Text(b, enc, langEnd, dataEnd);
        if (text.length > 0) {
          fields.push(`comment: ${text}`);
          free.push(text);
        }
      }
    } else if (id.startsWith("T")) {
      const textOff = dataOff + 1; // enc byte, then the text
      const raw = decodeId3Text(b, enc, textOff, dataEnd);
      const label =
        id === "TSSE" ? "software" :
        id === "TENC" ? "encoder" :
        id === "TIT2" ? "title" :
        id === "TPE1" ? "artist" :
        id === "TCOP" ? "copyright" :
        id.toLowerCase();
      if (raw.length > 0) {
        fields.push(`${label}: ${raw}`);
        free.push(raw);
      }
    }
    off = dataEnd;
  }
  return { fields, free };
}

/** FLAC VORBIS_COMMENT: ENCODER=, SOFTWARE=, DESCRIPTION=, TITLE=. */
function parseFlac(bytes: ArrayBuffer): ExtractedMeta {
  const b = u8(bytes);
  const fields: string[] = [];
  const free: string[] = [];
  if (b.length < 42 || latin1Region(b, 0, 4) !== "fLaC") return emptyMeta;
  let off = 4;
  for (let block = 0; block < 64; block++) {
    if (off + 4 > b.length) break;
    const header = u32(b, off);
    const last = (header & 0x80000000) !== 0;
    const type = (header >> 24) & 0x7f;
    const len = header & 0xffffff;
    const dataOff = off + 4;
    if (dataOff + len > b.length) break;
    if (type === 4) {
      // VORBIS_COMMENT: vendorLen(4) vendor comments. Every length in the
      // Vorbis comment header is little-endian (same as RIFF/WAVE) — the
      // big-endian u32 helper would read a multigigabyte vendor length and
      // bail before ever reaching the ENCODER= comment where TTS tools
      // (Google Cloud TTS, Azure, ElevenLabs FLAC exports) write their
      // software tag.
      let c = dataOff;
      const vendorLen = u32le(b, c);
      c += 4 + vendorLen;
      if (c + 4 <= dataOff + len) {
        const count = u32le(b, c);
        c += 4;
        for (let i = 0; i < Math.min(count, 128) && c + 4 <= dataOff + len; i++) {
          const clen = u32le(b, c);
          c += 4;
          if (c + clen > dataOff + len) break;
          const entry = latin1Region(b, c, clen);
          fields.push(entry);
          const eq = entry.indexOf("=");
          if (eq !== -1) free.push(entry.slice(eq + 1));
          c += clen;
        }
      }
      break;
    }
    off = dataOff + len;
    if (last) break;
  }
  return { fields, free };
}

/** RIFF/WAVE LIST-INFO: ISFT (software), INAM, ICOP, ICMT, IART. */
function parseWav(bytes: ArrayBuffer): ExtractedMeta {
  const b = u8(bytes);
  const fields: string[] = [];
  const free: string[] = [];
  if (b.length < 12 || latin1Region(b, 0, 4) !== "RIFF") return emptyMeta;
  // RIFF/WAVE writes every size little-endian (unlike PNG/MP4 atoms, which
  // are big-endian) — reading them with the big-endian u32 helper would
  // treat every chunk as gigabytes and never reach the LIST-INFO block
  // where TTS tools (Amazon Polly, etc.) write their ISFT software tag.
  let off = 12;
  for (let chunk = 0; chunk < 64; chunk++) {
    if (off + 8 > b.length) break;
    const id = latin1Region(b, off, 4);
    const len = u32le(b, off + 4);
    const dataOff = off + 8;
    const dataEnd = dataOff + len;
    if (dataEnd > b.length) break;
    if (id === "LIST" && latin1Region(b, dataOff, 4) === "INFO") {
      let sub = dataOff + 4;
      for (let i = 0; i < 32 && sub + 8 <= dataEnd; i++) {
        const subId = latin1Region(b, sub, 4);
        const subLen = u32le(b, sub + 4);
        const subOff = sub + 8;
        if (subOff + subLen > dataEnd) break;
        // eslint-disable-next-line no-control-regex
        const val = latin1Region(b, subOff, subLen).replace(/\u0000+$/, "");
        const label =
          subId === "ISFT" ? "software" :
          subId === "INAM" ? "title" :
          subId === "IART" ? "artist" :
          subId === "ICOP" ? "copyright" :
          subId === "ICMT" ? "comment" :
          subId.toLowerCase();
        if (val.length > 0) {
          fields.push(`${label}: ${val}`);
          free.push(val);
        }
        sub = subOff + subLen + (subLen % 2);
      }
      break;
    }
    off = dataOff + len + (len % 2);
  }
  return { fields, free };
}
