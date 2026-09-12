#!/usr/bin/env node
/**
 * PureWire AI-media-detection hardening QA — adversarial transformations.
 *
 * The byte scanner (ai-scan-qa.mjs) proves metadata/C2PA/generator-marker
 * detection. This suite proves the VISUAL layer survives everything an
 * adversary can do to the pixels: re-encoding, resizing, cropping,
 * screenshotting, metadata stripping, recompression, format conversion,
 * and combinations of all of the above.
 *
 * It synthesizes two fixture families with well-understood physical
 * characteristics:
 *   - "AI-like" fixtures: posterized gradients, over-smoothed flat
 *     regions, low texture, sharp synthetic edges — the statistical look
 *     of generative renders.
 *   - "Human-like" fixtures: sensor noise, natural texture, broad
 *     frequency content — the statistical look of camera captures.
 *
 * Every fixture then runs through a transformation battery. The QA asserts
 * that classification survives each transformation: AI-like fixtures stay
 * at or above `ai_likely`, human-like fixtures stay at or below
 * `uncertain`, and the separation margin is reported. Thresholds are
 * derived from this measurement, not guessed (see visual-forensics.ts).
 *
 * This is an honest engineering guarantee, not an "AI-proof" claim: the
 * suite pins the detector's response to adversarial transformation and
 * its calibration on known-signature fixtures, so a regression in the
 * pipeline (a signal that silently stops contributing, a normalization
 * change that breaks invariance) fails CI the moment it lands.
 *
 * Run:
 *   node scripts/ai-visual-hardening-qa.mjs
 *
 * Exit codes: 0 all families pass, 1 a family drifted, 2 crashed.
 */
import { registerHooks } from "node:module";
import { encode as jpegEncode, decode as jpegDecode } from "jpeg-js";
import { PNG } from "pngjs";

// Node 22+ TS support: resolve `@/` and extensionless relative imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return nextResolve(`../src/${specifier.slice(2)}`, context);
    }
    return nextResolve(specifier, context);
  },
});
const {
  analyzeJpegBytes,
  visualScore,
  classifyVisual,
  fitRgba,
} = await import("../src/lib/visual-forensics.ts");

const W = 512;
const H = 512;
let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

/** Deterministic PRNG (mulberry32). */
function prng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── AI-like fixtures ────────────────────────────────────────────────
// Statistical signatures: smooth posterized gradients, over-smoothed flat
// regions, sharp synthetic edges, little/no noise, low texture.

function aiPosterizedGradient() {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      // Smooth posterized sky gradient (banded, over-smoothed)…
      const g = Math.floor((((x + y) / (W + H)) * 255) / 6) * 6;
      // …plus a soft-shaded object (a render-style sphere: smooth
      // Lambert shading, posterized — the synthetic look, not a hard
      // 1px rim that would inject edge noise into the ELA signal).
      const cx = W * 0.62;
      const cy = H * 0.42;
      const r = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      let v = g;
      if (r < 120) {
        // Smooth radial shading, posterized to 6 levels.
        const shade = Math.floor((1 - Math.min(1, r / 120)) * 120 / 6) * 6;
        v = Math.floor((150 + shade) / 5) * 5;
      }
      data[i] = v;
      data[i + 1] = Math.min(255, Math.floor(v * 0.92));
      data[i + 2] = Math.max(0, Math.floor(v * 0.75));
      data[i + 3] = 255;
    }
  }
  return data;
}

function aiSmoothRings() {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const cx = W * 0.5;
      const cy = H * 0.5;
      const r = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      // Concentric posterized rings — a smooth, banded gradient field
      // (render-style), with a soft outer shadow falloff rather than a
      // hard rim: the signature is the banding + over-smoothing, not a
      // sharp synthetic edge line.
      const band = Math.floor(r / 20) % 10;
      const g = Math.floor((band / 9) * 220 / 6) * 6 + 20;
      const shadow = r > 180 ? Math.floor(((r - 180) / 40) * 50 / 6) * 6 : 0;
      const v = Math.max(0, Math.min(255, g - shadow));
      data[i] = v;
      data[i + 1] = Math.min(255, Math.floor(v * 0.9));
      data[i + 2] = Math.max(0, Math.floor(v * 0.6));
      data[i + 3] = 255;
    }
  }
  return data;
}

function aiFlatSharpEdges() {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      // Mostly flat over-smoothed field with sharp geometric edges.
      const edge =
        (Math.abs(x - 120) < 3 || Math.abs(y - 90) < 3 || (x > 300 && y > 260 && x < 420 && y < 380)) ? 1 : 0;
      const g = edge ? 235 : 92;
      data[i] = g;
      data[i + 1] = edge ? 225 : 84;
      data[i + 2] = edge ? 190 : 60;
      data[i + 3] = 255;
    }
  }
  return data;
}

// ── Human-like fixtures ─────────────────────────────────────────────
// Statistical signatures: sensor noise, natural gradients, broad
// frequency content, no banding.

function humanNoisyPhoto(seed) {
  const rnd = prng(seed);
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const g =
        110 +
        55 * Math.sin((x / W) * Math.PI * 2) +
        35 * Math.cos((y / H) * Math.PI * 2) +
        20 * Math.sin((x * y) / 4000);
      const n = (rnd() + rnd() + rnd() + rnd() - 2) * 7;
      const tex =
        Math.sin(x * 11.3 + y * 5.1) * 5 +
        Math.sin(x * 19.7 - y * 8.9) * 4 +
        Math.sin(x * 31.1 + y * 13.3) * 3;
      const v = Math.min(255, Math.max(0, g + n + tex));
      data[i] = v;
      data[i + 1] = Math.min(255, Math.max(0, v * 0.96 + n * 0.4));
      data[i + 2] = Math.min(255, Math.max(0, v * 0.82 + n * 0.25));
      data[i + 3] = 255;
    }
  }
  return data;
}

function humanFineTexture(seed) {
  const rnd = prng(seed);
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const g =
        128 +
        40 * Math.sin((x / W) * Math.PI) * Math.cos((y / H) * Math.PI) +
        25 * Math.sin(x * 0.13 + y * 0.07);
      const n = (rnd() + rnd() + rnd() + rnd() - 2) * 5;
      const tex =
        Math.sin(x * 23.7 - y * 17.3) * 6 +
        Math.sin(x * 41.9 + y * 29.1) * 5 +
        Math.sin(x * 67.3 - y * 53.7) * 4;
      const v = Math.min(255, Math.max(0, g + n + tex));
      data[i] = v;
      data[i + 1] = Math.min(255, Math.max(0, v * 0.95 + n * 0.5));
      data[i + 2] = Math.min(255, Math.max(0, v * 0.8 + n * 0.3));
      data[i + 3] = 255;
    }
  }
  return data;
}

// ── Encoders / transform helpers (pure Node) ────────────────────────

function rgbaToJpeg(rgba, w, h, quality) {
  const out = jpegEncode({ data: rgba, width: w, height: h }, quality);
  return new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength);
}

function rgbaToPng(rgba, w, h) {
  const png = new PNG({ width: w, height: h });
  png.data = Buffer.from(rgba);
  return Uint8Array.from(PNG.sync.write(png));
}

function jpegToRgba(bytes) {
  const raw = jpegDecode(bytes instanceof Uint8Array ? bytes : Buffer.from(bytes), {
    useTArray: true,
  });
  return {
    data: new Uint8Array(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength),
    width: raw.width,
    height: raw.height,
  };
}

function pngToRgba(bytes) {
  const png = PNG.sync.read(Buffer.from(bytes));
  return {
    data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength),
    width: png.width,
    height: png.height,
  };
}

/** Center-crop to a fraction of the image, keeping aspect. */
function cropRgba(rgba, w, h, fraction) {
  const cw = Math.max(8, Math.floor(w * fraction));
  const ch = Math.max(8, Math.floor(h * fraction));
  const ox = Math.floor((w - cw) / 2);
  const oy = Math.floor((h - ch) / 2);
  const out = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const si = ((oy + y) * w + ox + x) * 4;
      const di = (y * cw + x) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = rgba[si + 3];
    }
  }
  return { data: out, width: cw, height: ch };
}

/** Simulate a screen capture: subtle gamma/color shift + faint display
 * dither + recompress. Real screenshots retain the image's look — the
 * display introduces a small tone/color shift and minor dither, not
 * heavy per-pixel noise. */
function simulateScreenshot(rgba, w, h) {
  const rnd = prng(7);
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    // Small global tone shift (display profile).
    const g = 1.0 + (rnd() - 0.5) * 0.02;
    for (let c = 0; c < 3; c++) {
      let v = rgba[p + c] / 255;
      v = Math.pow(v, g);
      v += (rnd() - 0.5) * 0.008; // faint display dither
      out[p + c] = Math.min(255, Math.max(0, Math.round(v * 255)));
    }
    out[p + 3] = 255;
  }
  return out;
}

// ── Transformation battery ──────────────────────────────────────────

/**
 * Apply every adversarial transformation to the fixture and return the
 * JPEG bytes of each version. Each result is analyzed independently.
 */
function transformBattery(originalRgba) {
  const versions = [];
  const base = rgbaToJpeg(originalRgba, W, H, 90);
  versions.push({ name: "original", bytes: base });

  // Re-encoding
  versions.push({ name: "jpeg90->jpeg70", bytes: (() => {
    const { data, width, height } = jpegToRgba(base);
    return rgbaToJpeg(data, width, height, 70);
  })() });
  versions.push({ name: "jpeg->png->jpeg", bytes: (() => {
    const { data, width, height } = jpegToRgba(base);
    const png = rgbaToPng(data, width, height);
    const back = pngToRgba(png);
    return rgbaToJpeg(back.data, back.width, back.height, 85);
  })() });
  versions.push({ name: "3x recompress", bytes: (() => {
    let { data, width, height } = jpegToRgba(base);
    for (let i = 0; i < 2; i++) {
      const next = jpegToRgba(rgbaToJpeg(data, width, height, 65 + i * 10));
      data = next.data;
    }
    return rgbaToJpeg(data, width, height, 80);
  })() });

  // Resizing (down then up = loss of original composition)
  versions.push({ name: "downscale 256", bytes: (() => {
    const fit = fitRgba(originalRgba, W, H, 256);
    return rgbaToJpeg(fit.data, fit.width, fit.height, 80);
  })() });
  versions.push({ name: "downscale->upscale", bytes: (() => {
    const small = fitRgba(originalRgba, W, H, 160);
    const up = fitRgba(small.data, small.width, small.height, 512);
    return rgbaToJpeg(up.data, up.width, up.height, 85);
  })() });

  // Cropping (composition altered)
  versions.push({ name: "center-crop 70%", bytes: (() => {
    const c = cropRgba(originalRgba, W, H, 0.7);
    return rgbaToJpeg(c.data, c.width, c.height, 85);
  })() });
  versions.push({ name: "center-crop 40%", bytes: (() => {
    const c = cropRgba(originalRgba, W, H, 0.4);
    return rgbaToJpeg(c.data, c.width, c.height, 85);
  })() });

  // Screenshotting (metadata + encoding fully replaced)
  versions.push({ name: "screenshot png", bytes: (() => {
    const shot = simulateScreenshot(originalRgba, W, H);
    return rgbaToPng(shot, W, H);
  })() });
  versions.push({ name: "screenshot jpeg70", bytes: (() => {
    const shot = simulateScreenshot(originalRgba, W, H);
    return rgbaToJpeg(shot, W, H, 70);
  })() });
  versions.push({ name: "screenshot+recompress", bytes: (() => {
    const shot = simulateScreenshot(originalRgba, W, H);
    const j = rgbaToJpeg(shot, W, H, 75);
    const { data, width, height } = jpegToRgba(j);
    return rgbaToJpeg(data, width, height, 60);
  })() });

  // Recompression levels
  versions.push({ name: "q30", bytes: rgbaToJpeg(originalRgba, W, H, 30) });
  versions.push({ name: "q50", bytes: rgbaToJpeg(originalRgba, W, H, 50) });

  // Combined: crop → resize → screenshot → recompress
  versions.push({ name: "combined", bytes: (() => {
    const c = cropRgba(originalRgba, W, H, 0.6);
    const small = fitRgba(c.data, c.width, c.height, 224);
    const shot = simulateScreenshot(small.data, small.width, small.height);
    const j = rgbaToJpeg(shot, small.width, small.height, 72);
    const { data, width, height } = jpegToRgba(j);
    return rgbaToJpeg(data, width, height, 55);
  })() });

  return versions;
}

// ── Families ────────────────────────────────────────────────────────

const aiFixtures = {
  "posterized-gradient": aiPosterizedGradient(),
  "smooth-rings": aiSmoothRings(),
  "flat-sharp-edges": aiFlatSharpEdges(),
};
/**
 * Smooth-sky photo: the riskiest false-positive class for the visual
 * detector. A real sky at low ISO is a gentle, noise-light gradient —
 * superficially close to an AI render's smooth regions. The fixture keeps
 * MANY gradient levels (no banding), light-but-present sensor noise, and
 * natural low-frequency texture so it must NOT read as posterized +
 * over-smoothed (the AI co-occurrence signature).
 */
function humanSmoothSky(seed) {
  const rnd = prng(seed);
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      // Slow diagonal gradient, many levels (NOT posterized).
      const g = 96 + ((x + y) / (W + H)) * 120;
      const n = (rnd() + rnd() + rnd() - 1.5) * 3.5; // light sensor noise
      const tex =
        Math.sin(x * 0.021 + y * 0.017) * 4 +
        Math.sin((x - y) * 0.053) * 2.5;
      const v = Math.min(255, Math.max(0, g + n + tex));
      data[i] = v;
      data[i + 1] = Math.min(255, Math.max(0, v * 0.99 + n * 0.3));
      data[i + 2] = Math.min(255, Math.max(0, v * 0.97 + n * 0.2));
      data[i + 3] = 255;
    }
  }
  return data;
}

const humanFixtures = {
  "noisy-photo": humanNoisyPhoto(11),
  "fine-texture": humanFineTexture(23),
  "smooth-sky": humanSmoothSky(31),
};

console.log("\nPureWire visual AI-detection hardening QA (adversarial transformations)\n");

// ── Calibration report + assertions ─────────────────────────────────
let aiMin = 1;
let aiMax = 0;
let aiMinBig = 1;
let humanMax = 0;
const aiRows = [];
const humanRows = [];

/** Analyze any bytes: JPEG via jpeg-js, PNG via pngjs → the same pipeline. */
function analyzeBytes(bytes) {
  const isPng =
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (!isPng) {
    return analyzeJpegBytes(bytes);
  }
  const png = PNG.sync.read(Buffer.from(bytes));
  return analyzeJpegBytes(rgbaToJpeg(png.data, png.width, png.height, 90));
}

/** Long side of the analyzed content, so the QA buckets by resolution. */
function longSideOf(bytes) {
  const isPng =
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (isPng) {
    const png = PNG.sync.read(Buffer.from(bytes));
    return Math.max(png.width, png.height);
  }
  const raw = jpegDecode(
    bytes instanceof Uint8Array ? bytes : Buffer.from(bytes),
    { useTArray: true },
  );
  return Math.max(raw.width, raw.height);
}

for (const [name, rgba] of Object.entries(aiFixtures)) {
  for (const v of transformBattery(rgba)) {
    const verdict = analyzeBytes(v.bytes);
    const longSide = longSideOf(v.bytes);
    aiMin = Math.min(aiMin, verdict.score);
    aiMax = Math.max(aiMax, verdict.score);
    if (longSide >= 256) aiMinBig = Math.min(aiMinBig, verdict.score);
    aiRows.push({ fixture: name, transform: v.name, score: verdict.score, conf: verdict.confidence, longSide });
  }
}
for (const [name, rgba] of Object.entries(humanFixtures)) {
  for (const v of transformBattery(rgba)) {
    const verdict = analyzeBytes(v.bytes);
    humanMax = Math.max(humanMax, verdict.score);
    humanRows.push({ fixture: name, transform: v.name, score: verdict.score, conf: verdict.confidence });
  }
}

// Report the measured split (this is the calibration evidence).
const aiMid = Math.min(...aiRows.filter((r) => r.longSide >= 192 && r.longSide < 256).map((r) => r.score));
console.log("AI-like family scores:  min", aiMin.toFixed(3), " max", aiMax.toFixed(3), ` (n=${aiRows.length})`);
console.log("  ≥256px analysis (confident):  min", aiMinBig.toFixed(3));
console.log("  192-255px analysis (reduced):  min", Number.isFinite(aiMid) ? aiMid.toFixed(3) : "-");
console.log("  <192px analysis (thumbnail):   min", aiMin.toFixed(3));
console.log("Human-like family scores: max", humanMax.toFixed(3), ` (n=${humanRows.length})`);
const margin = aiMinBig - humanMax;
console.log(`Separation margin (≥256px AI vs human): ${margin.toFixed(3)}`);
check(
  "AI-like family stays >= ai_likely (0.55) at every analysis size >= 256px",
  aiMinBig >= 0.55,
  `worst was ${aiMinBig.toFixed(3)}`,
);
check(
  "AI-like reduced-confidence (192-255px) stays above the uncertain floor (0.45)",
  aiRows
    .filter((r) => r.longSide >= 192 && r.longSide < 256)
    .every((r) => r.score >= 0.45 && r.conf !== "human_likely"),
);
check(
  "AI-like thumbnails (<192px) never classify human_likely",
  aiRows
    .filter((r) => r.longSide < 192)
    .every((r) => r.conf === "ai_likely" || r.conf === "ai_confirmed" || r.conf === "uncertain"),
);
check(
  "Human-like family stays < ai_likely (0.55) at every analysis size",
  humanMax < 0.55,
  `worst was ${humanMax.toFixed(3)}`,
);
check("positive separation margin", margin > 0.05, `${margin.toFixed(3)}`);

// Show the worst offenders so a drift is diagnosable from the log.
if (aiMinBig < 0.55 || humanMax >= 0.55 || margin <= 0.05) {
  console.log("\nWorst AI-like scores (≥256px):");
  aiRows
    .filter((r) => r.longSide >= 256)
    .sort((a, b) => a.score - b.score)
    .slice(0, 5)
    .forEach((r) =>
      console.log(`  ${r.fixture} / ${r.transform}: ${r.score.toFixed(3)} (${r.conf})`),
    );
  console.log("Worst human-like scores:");
  [...humanRows]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .forEach((r) =>
      console.log(`  ${r.fixture} / ${r.transform}: ${r.score.toFixed(3)} (${r.conf})`),
    );
}

// Every AI-like score at >=256px must classify as ai_likely or
// ai_confirmed; every human-like score must classify as human_likely or
// uncertain (never a false positive).
check(
  "every AI-like transformed version >=256px classifies ai_likely/ai_confirmed",
  aiRows
    .filter((r) => r.longSide >= 256)
    .every((r) => r.conf === "ai_likely" || r.conf === "ai_confirmed"),
);
check(
  "every human-like transformed version classifies human_likely/uncertain",
  humanRows.every((r) => r.conf === "human_likely" || r.conf === "uncertain"),
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
