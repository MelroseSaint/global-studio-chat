#!/usr/bin/env node
/**
 * PureWire anti-AI scanner QA — the byte-level overhaul, verified.
 *
 * Synthesizes real container structures (PNG tEXt chunks, JPEG EXIF IFD
 * tables + XMP, MP4 atoms, ID3v2 frames, FLAC Vorbis comments, RIFF/WAVE
 * INFO) and text samples, then asserts the hardened scanner — structured
 * container parsing + magic-byte kind validation + expanded Google/other
 * generator markers — returns exactly the right verdict for each.
 *
 * Pure offline unit test: imports the shared libs directly (Node 22+ type
 * stripping), no harness, no network. Run locally or in CI:
 *
 *   node scripts/ai-scan-qa.mjs
 *
 * Exit codes: 0 all checks passed, 1 a check failed.
 */
// The shared libs are TS with a `@/` path alias. Node 22+ can strip TS
// types natively but cannot resolve `@/` without help — register a
// resolve hook before importing anything, then load the modules after.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Map `@/` to src/ first (the TS sources use that alias), then try the
    // default resolution and only fall back to appending `.ts` when the
    // normal resolution fails — so `./_generated/server` still finds
    // `server.js` via Node's own rules.
    const baseUrl = new URL(context.parentURL ?? import.meta.url);
    // Absolute file URL for the extensionless resolution attempts.
    let target;
    if (specifier.startsWith("@/")) {
      target = new URL(`../src/${specifier.slice(2)}`, import.meta.url);
    } else if (specifier.startsWith("./")) {
      target = new URL(specifier, baseUrl);
    } else {
      return nextResolve(specifier, context);
    }
    try {
      return nextResolve(target.href, context);
    } catch (err) {
      // Node ESM never auto-appends extensions for relative imports — try
      // `.ts` (source files) then `.js` (generated files) explicitly.
      for (const ext of [".ts", ".js"]) {
        try {
          const candidate = new URL(`${target.href}${ext}`);
          if (existsSync(candidate)) return nextResolve(candidate.href, context);
        } catch {
          // fall through
        }
      }
      throw err;
    }
  },
});

const [{ scanImageBytes, scanMediaBytes }, { scanText }] = await Promise.all([
  import("../src/lib/ai-media-scan.ts"),
  import("../src/convex/aiContent.ts"),
]);

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  \u2705 ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \u274c ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── byte builders ────────────────────────────────────────────────────────

function bytesOf(parts) {
  const arrays = parts.map((p) => {
    if (typeof p === "string") return new TextEncoder().encode(p);
    if (p instanceof ArrayBuffer) return new Uint8Array(p);
    return p;
  });
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out.buffer;
}

function u32be(n) {
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 0xff;
  b[1] = (n >>> 16) & 0xff;
  b[2] = (n >>> 8) & 0xff;
  b[3] = n & 0xff;
  return b;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A minimal PNG with a tEXt chunk whose keyword/value are settable. */
function pngWithText(keyword, value) {
  const textData = bytesOf([`${keyword}\0${value}`]);
  const chunks = [bytesOf(["IHDR", u32be(13), new Uint8Array(13), u32be(0)])];
  chunks.push(
    bytesOf([u32be(textData.byteLength), "tEXt", new Uint8Array(textData), u32be(0)]),
  );
  return bytesOf([new Uint8Array(PNG_SIG), ...chunks]);
}

/** A minimal JPEG (SOI + a few segments) with an EXIF APP1. */
function jpegWithExif(software) {
  // TIFF little-endian: II*\0, IFD0 at 8, one Software (0x0131) ASCII entry.
  const tiff = new Uint8Array(8 + 2 + 12 + 4 + software.length + 1);
  tiff[0] = 0x49; tiff[1] = 0x49; tiff[2] = 0x2a; tiff[3] = 0x00;
  tiff[4] = 8; tiff[5] = 0; tiff[6] = 0; tiff[7] = 0; // IFD0 offset
  const ifd = 8;
  tiff[ifd] = 1; tiff[ifd + 1] = 0; // one entry
  const e = ifd + 2;
  // tag 0x0131 (Software), type 2 (ASCII)
  tiff[e] = 0x31; tiff[e + 1] = 0x01;
  tiff[e + 2] = 2; tiff[e + 3] = 0;
  const n = software.length + 1;
  tiff[e + 4] = n & 0xff; tiff[e + 5] = (n >> 8) & 0xff; tiff[e + 6] = 0; tiff[e + 7] = 0;
  const valueOff = e + 8;
  const strOff = e + 12; // value overflows 4 bytes -> offset here
  tiff[valueOff] = strOff & 0xff;
  tiff[valueOff + 1] = (strOff >> 8) & 0xff;
  for (let i = 0; i < software.length; i++) tiff[strOff + i] = software.charCodeAt(i);
  tiff[strOff + software.length] = 0; // NUL terminator
  const exif = bytesOf(["Exif\0\0", tiff]);
  const app1 = bytesOf([u32be(exif.byteLength + 2), new Uint8Array(exif)]);
  // SOI + APP1 (length covers the 2 length bytes) + a tiny SOS-ish tail
  return bytesOf([
    new Uint8Array([0xff, 0xd8]),
    new Uint8Array([0xff, 0xe1]),
    app1,
    new Uint8Array([0xff, 0xd9]),
  ]);
}

/**
 * A JPEG whose EXIF Software value sits at a nonzero TIFF-relative offset
 * (after an 8-byte padding blob), so the string exists ONLY in structured
 * EXIF — the raw head/tail sweep sees a different byte region and cannot
 * mask a broken offset read.
 */
function jpegWithExifOffset(software) {
  const pad = new Uint8Array(8); // pushes the string off the inline region
  const tiff = new Uint8Array(8 + 2 + 12 + 4 + pad.length + software.length + 1);
  tiff[0] = 0x49; tiff[1] = 0x49; tiff[2] = 0x2a; tiff[3] = 0x00;
  tiff[4] = 8; tiff[5] = 0; tiff[6] = 0; tiff[7] = 0; // IFD0 offset
  const ifd = 8;
  tiff[ifd] = 1; tiff[ifd + 1] = 0;
  const e = ifd + 2;
  tiff[e] = 0x31; tiff[e + 1] = 0x01; // Software tag
  tiff[e + 2] = 2; tiff[e + 3] = 0; // ASCII
  const n = software.length + 1;
  tiff[e + 4] = n & 0xff; tiff[e + 5] = (n >> 8) & 0xff; tiff[e + 6] = 0; tiff[e + 7] = 0;
  const strOff = e + 12 + pad.length; // beyond the padding blob
  tiff[e + 8] = strOff & 0xff;
  tiff[e + 9] = (strOff >> 8) & 0xff;
  for (let i = 0; i < pad.length; i++) tiff[e + 12 + i] = 0x20; // pad
  for (let i = 0; i < software.length; i++) tiff[strOff + i] = software.charCodeAt(i);
  tiff[strOff + software.length] = 0;
  const exif = bytesOf(["Exif\0\0", tiff]);
  const app1 = bytesOf([u32be(exif.byteLength + 2), new Uint8Array(exif)]);
  return bytesOf([new Uint8Array([0xff, 0xd8]), new Uint8Array([0xff, 0xe1]), app1, new Uint8Array([0xff, 0xd9])]);
}

/** A minimal MP4: ftyp + moov.udta with a ©too text atom. */
function mp4WithAtom(atomType, value) {
  const text = bytesOf([value]);
  const atomData = bytesOf([u32be(text.byteLength + 8), atomType, new Uint8Array(text)]);
  const udta = bytesOf([u32be(atomData.byteLength + 8), "udta", new Uint8Array(atomData)]);
  const moov = bytesOf([u32be(udta.byteLength + 8), "moov", new Uint8Array(udta)]);
  const ftyp = bytesOf([u32be(16), "ftyp", "isom", u32be(0)]);
  return bytesOf([ftyp, moov]);
}

/** A minimal ID3v2 tag with one TSSE frame. */
function id3WithFrame(frameId, value) {
  const payload = bytesOf([new Uint8Array([0x03]), value]); // encoding + text
  const frame = bytesOf([
    frameId,
    u32be(payload.byteLength),
    new Uint8Array(4),
    new Uint8Array(payload),
  ]);
  const total = 10 + frame.byteLength;
  const sizeBytes = [
    (total >> 21) & 0x7f,
    (total >> 14) & 0x7f,
    (total >> 7) & 0x7f,
    total & 0x7f,
  ];
  return bytesOf([
    "ID3",
    new Uint8Array([0x03, 0x00, 0x00]),
    new Uint8Array(sizeBytes),
    new Uint8Array(frame),
  ]);
}

/** A minimal FLAC with a VORBIS_COMMENT block carrying ENCODER=. */
function flacWithComment(comment) {
  const vendor = bytesOf(["PureWireTest"]);
  const entry = bytesOf([comment]);
  const body = bytesOf([
    u32be(vendor.byteLength),
    new Uint8Array(vendor),
    u32be(1),
    u32be(entry.byteLength),
    new Uint8Array(entry),
  ]);
  const header = new Uint8Array(4);
  header[0] = 4; // VORBIS_COMMENT
  header[1] = (body.byteLength >> 16) & 0xff;
  header[2] = (body.byteLength >> 8) & 0xff;
  header[3] = body.byteLength & 0xff;
  return bytesOf(["fLaC", header, new Uint8Array(body)]);
}

// ── text cases ───────────────────────────────────────────────────────────

function textChecks() {
  console.log("\nText scan (scanText)");
  check("ordinary human text is clean", scanText("I went to the bakery this morning and bought a loaf of sourdough. It was still warm.").status === "clean");
  const gemini = scanText("This post was generated by Gemini, Google's AI model, for demonstration purposes.");
  check("self-identified Gemini text is blocked", gemini.status === "blocked", gemini.reason);
  const grok = scanText("Grok wrote this entire paragraph about the future of cities.");
  check("self-identified Grok text is blocked", grok.status === "blocked", grok.reason);
  const google = scanText("I am Google's AI assistant and here is my answer.");
  check("'I am Google's AI' is blocked", google.status === "blocked", google.reason);
  const humanClaude = scanText("My friend Claude wrote that song last week and it was great.");
  check("a human named Claude is not blocked", humanClaude.status === "clean", humanClaude.reason);
  const formulaic =
    "Moreover, this landscape underscores a testament to the ever-evolving digital space. Furthermore, it is important to note that, additionally, in conclusion, we must not overlook how notably, crucially, and significantly this matters overall.";
  const fr = scanText(formulaic);
  check("formulaic machine-sounding text goes to review", fr.status === "review", fr.reason);
}

// ── image cases ──────────────────────────────────────────────────────────

function imageChecks() {
  console.log("\nImage scan (scanImageBytes)");

  // PNG tEXt parameters chunk — the A1111 signature.
  const sdPng = scanImageBytes(
    pngWithText("parameters", "Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 12345678, Size: 512x512, Model: realistic-vision"),
  );
  check("PNG tEXt parameters chunk is blocked", sdPng.status === "blocked", sdPng.reason);

  const comfyPng = scanImageBytes(
    pngWithText("prompt", '{"3": {"class_type": "KSampler"}}'),
  );
  check("PNG with a prompt chunk (ComfyUI shape) is blocked", comfyPng.status === "blocked", comfyPng.reason);

  // A clean PNG with ordinary metadata must stay clean.
  const cleanPng = scanImageBytes(pngWithText("Software", "GIMP 2.10"));
  check("GIMP PNG with ordinary metadata is clean", cleanPng.status === "clean", cleanPng.reason);

  // JPEG EXIF Software = Google Imagen — the explicit Google zero-tolerance case.
  const jpegImagen = scanImageBytes(jpegWithExif("Google Imagen 3"));
  check("JPEG EXIF Software 'Google Imagen 3' is blocked", jpegImagen.status === "blocked", jpegImagen.reason);

  const jpegMidjourney = scanImageBytes(jpegWithExif("Midjourney"));
  check("JPEG EXIF Software 'Midjourney' is blocked", jpegMidjourney.status === "blocked", jpegMidjourney.reason);

  // The EXIF parser must read string values at TIFF-RELATIVE offsets (the
  // review caught a real bug here: offset reads ignored the TIFF block's
  // nonzero start). Build a JPEG whose Software string lives only at a
  // nonzero offset so the raw sweep cannot mask a broken parse.
  const jpegOffsetSoftware = scanImageBytes(jpegWithExifOffset("Imagen 4"));
  check("JPEG EXIF Software at a nonzero TIFF offset is still blocked", jpegOffsetSoftware.status === "blocked", jpegOffsetSoftware.reason);

  // A real phone's EXIF must NOT be flagged.
  const jpegPhone = scanImageBytes(jpegWithExif("Pixel 8 Pro"));
  check("JPEG EXIF 'Pixel 8 Pro' (a real phone) is clean", jpegPhone.status === "clean", jpegPhone.reason);

  // Bare brand words must NOT block when they appear only in arbitrary raw
  // bytes (a genuine photo whose comment happens to say "Canva" or "Gemini")
  // — only a structured Software field naming the tool is a block.
  const rawOnlyCanva = scanImageBytes(
    pngWithText("Comment", "Edited this with canva before posting, check the gallery"),
  );
  check("bare 'canva' in a free-text comment stays clean (no false positive)", rawOnlyCanva.status === "clean", rawOnlyCanva.reason);

  // Rename evasion: a PNG handed to the image scanner is fine, but an MP4
  // handed to the image scanner is a container mismatch.
  const mp4AsImage = scanImageBytes(mp4WithAtom("\u00a9too", "Synthesia"));
  check("a video container scanned as an image is flagged (rename evasion)", mp4AsImage.status === "review", mp4AsImage.reason);
}

// ── audio/video cases ────────────────────────────────────────────────────

function mediaChecks() {
  console.log("\nAudio/video scan (scanMediaBytes)");

  const synthMp4 = scanMediaBytes(mp4WithAtom("\u00a9too", "Synthesia"));
  check("MP4 ©too atom 'Synthesia' is blocked", synthMp4.status === "blocked", synthMp4.reason);

  const veoMp4 = scanMediaBytes(mp4WithAtom("\u00a9too", "Google Veo 3"));
  check("MP4 ©too atom 'Google Veo 3' is blocked", veoMp4.status === "blocked", veoMp4.reason);

  const cleanMp4 = scanMediaBytes(mp4WithAtom("\u00a9too", "Lavf58.29.100"));
  check("MP4 ©too atom 'Lavf58.29.100' (a real encoder) is clean", cleanMp4.status === "clean", cleanMp4.reason);

  const sunoMp3 = scanMediaBytes(id3WithFrame("TSSE", "Suno AI v4"));
  check("MP3 ID3 TSSE 'Suno AI v4' is blocked", sunoMp3.status === "blocked", sunoMp3.reason);

  const elevenMp3 = scanMediaBytes(id3WithFrame("TSSE", "ElevenLabs"));
  check("MP3 ID3 TSSE 'ElevenLabs' goes to review", elevenMp3.status === "review", elevenMp3.reason);

  const cleanMp3 = scanMediaBytes(id3WithFrame("TSSE", "LAME 3.100"));
  check("MP3 ID3 TSSE 'LAME 3.100' (a real encoder) is clean", cleanMp3.status === "clean", cleanMp3.reason);

  const flacAi = scanMediaBytes(flacWithComment("ENCODER=Google MusicLM"));
  check("FLAC Vorbis comment 'ENCODER=Google MusicLM' is blocked", flacAi.status === "blocked", flacAi.reason);

  const flacClean = scanMediaBytes(flacWithComment("ENCODER=reference libFLAC 1.4.3"));
  check("FLAC comment 'ENCODER=libFLAC' (a real encoder) is clean", flacClean.status === "clean", flacClean.reason);

  // Container mismatch on the media path: a PNG as audio/video.
  const pngAsMedia = scanMediaBytes(pngWithText("Software", "GIMP 2.10"));
  check("an image container scanned as audio/video is flagged", pngAsMedia.status === "review", pngAsMedia.reason);
}

textChecks();
imageChecks();
mediaChecks();

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log("Failing checks:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
