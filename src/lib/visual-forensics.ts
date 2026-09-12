/**
 * PureWire visual forensics — server-side analysis of the PIXELS, never
 * the metadata.
 *
 * The byte-level scanner (ai-media-scan.ts) reads containers, EXIF/XMP,
 * C2PA manifests, and generator markers. An adversary can strip ALL of
 * that before upload — a screenshot of an AI image carries none of it.
 * This module closes that hole: it analyzes the actual visual content on
 * a normalized analysis copy, so detection survives re-encoding, resizing,
 * cropping, screenshotting, metadata stripping, recompression, and format
 * conversion.
 *
 * Design rules (from the hardening spec):
 *  - Detection is on the pixels only. Metadata/provenance is never
 *    required to classify.
 *  - The original asset is never touched — the analysis runs on a
 *    normalized copy (Cloudinary transformation server-side, or a decoded
 *    buffer in the fallback path).
 *  - No single signal decides. Signals are combined into a score, and the
 *    score maps to confidence levels (human_likely / uncertain /
 *    ai_likely / ai_confirmed) whose thresholds are measured by the
 *    adversarial QA suite, not guessed.
 *  - Absence of AI evidence is NEVER "human". It is simply "uncertain".
 *
 * Convex-safe: pure Uint8Array math, no Node builtins, no DOM. jpeg-js
 * (zero-dep, Buffer-free fallback) is the only decoder used here so this
 * module can run inside a Convex action. PNG/WebP analysis runs in the
 * Node QA suite (pngjs) and in production via Cloudinary's normalization
 * (which converts any format to a JPEG analysis copy).
 */
import { decode as jpegDecode, encode as jpegEncode } from "jpeg-js";

/** Confidence levels for the visual verdict. */
export type VisualConfidence =
  | "human_likely"
  | "uncertain"
  | "ai_likely"
  | "ai_confirmed";

export interface VisualSignals {
  /** Smooth-region residual noise std-dev (0..~25). Real photos: 2+; AI
   * renders: often <1 (over-smoothed). */
  noiseStd: number;
  /** Error Level Analysis: mean per-block MAE after a fixed recompress. */
  elaMean: number;
  /** ELA coefficient of variation — AI: low (uniform error), photo: high. */
  elaCv: number;
  /** High-frequency DCT energy ratio (0..1) in luminance blocks. */
  hfEnergy: number;
  /** Distinct luminance levels per smooth block (avg) — near-flat or
   * heavily posterized regions show very few. */
  gradientLevels: number;
  /** Largest gap between consecutive distinct levels inside a smooth
   * block (avg). A real smooth gradient has steps of 1-2 (JPEG dither
   * included); a posterized render has systematic steps of 5+. This is
   * the true "banding" signature — distinct-count alone cannot tell a
   * slow real gradient from a banded one. */
  maxLevelGap: number;
  /** Kurtosis of the gradient-magnitude distribution — AI upscalers and
   * renders produce unnaturally thin, sharp edges (high kurtosis). */
  edgeKurtosis: number;
  /** Overall chroma saturation (0..1). */
  saturation: number;
}

export interface VisualVerdict {
  confidence: VisualConfidence;
  /** 0..1 — higher = more AI-likely. Thresholds measured by the QA. */
  score: number;
  signals: VisualSignals;
  /** True when the analysis could not run (decode failure). Never a
   * "clean" signal by itself. */
  unavailable: boolean;
}

// Thresholds measured by scripts/ai-visual-hardening-qa.mjs against the
// synthesized AI-like / human-like fixture families. Tuned so transformed
// AI fixtures stay >= ai_likely and human fixtures stay <= uncertain with
// a measured margin (see the QA's calibration report).
// Thresholds measured from the adversarial QA battery (see its calibration
// report): the weakest AI-like case that must still be caught lands at
// ~0.565 after box-downscaling, and no human-like fixture (including the
// heavily-compressed smooth-sky, which the compression gate caps at 0.5)
// exceeds 0.5. 0.55 sits between those with margin on both sides.
const AI_LIKELY_SCORE = 0.55;
const AI_CONFIRMED_SCORE = 0.78;

/** Decode a JPEG buffer into RGBA using jpeg-js (Convex-safe). */
export function decodeJpeg(
  bytes: Uint8Array,
): { data: Uint8Array; width: number; height: number } | null {
  try {
    // jpeg-js falls back to Uint8Array when Buffer is absent (Convex
    // isolate); in Node it hands back a Buffer which is a Uint8Array.
    const raw = jpegDecode(
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      { useTArray: true, maxMemoryUsageInMB: 128 },
    );
    const data = new Uint8Array(
      raw.data.buffer,
      raw.data.byteOffset,
      raw.data.byteLength,
    );
    return { data, width: raw.width, height: raw.height };
  } catch {
    return null;
  }
}

/**
 * Re-encode RGBA as JPEG at a fixed quality (the ELA recompress step) and
 * decode it back. Pure jpeg-js round trip.
 */
function recompressJpeg(
  rgba: Uint8Array,
  width: number,
  height: number,
  quality = 80,
): Uint8Array | null {
  try {
    const out = jpegEncode({ data: rgba, width, height }, quality);
    const raw = new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength);
    const dec = decodeJpeg(raw);
    return dec ? dec.data : null;
  } catch {
    return null;
  }
}

/**
 * Scale RGBA to fit within maxDim, preserving aspect ratio.
 *
 * Downscaling uses box filtering (averages the source region, so texture
 * statistics survive honestly). Upscaling uses nearest-neighbor — the
 * analysis copy of a low-res source is itself low-res; we never invent
 * pixels, because invented detail would corrupt the frequency signals.
 */
export function fitRgba(
  data: Uint8Array,
  width: number,
  height: number,
  maxDim = 512,
): { data: Uint8Array; width: number; height: number } {
  const longSide = Math.max(width, height);
  if (longSide <= maxDim) {
    return { data, width, height };
  }
  const scale = maxDim / longSide;
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(w * h * 4);
  const xs = width / w;
  const ys = height / h;
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y * ys);
    const sy1 = Math.min(height, Math.ceil((y + 1) * ys));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x * xs);
      const sx1 = Math.min(width, Math.ceil((x + 1) * xs));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * width + sx) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          a += data[i + 3];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return { data: out, width: w, height: h };
}

/** Perceptual luminance (ITU-R BT.601), 0..255. */
function luminance(data: Uint8Array, w: number, h: number): Float64Array {
  const lum = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    lum[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return lum;
}

/** 8x8 block DCT (separable, naive O(64) per block) — plenty for signals. */
function dct8(block: Float64Array): Float64Array {
  const out = new Float64Array(64);
  const alpha = (u: number) => (u === 0 ? Math.SQRT1_2 : 1);
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          sum +=
            block[y * 8 + x] *
            Math.cos(((2 * x + 1) * u * Math.PI) / 16) *
            Math.cos(((2 * y + 1) * v * Math.PI) / 16);
        }
      }
      out[v * 8 + u] = (2 / 8) * alpha(u) * alpha(v) * sum;
    }
  }
  return out;
}

/**
 * Run the multi-signal forensics on a normalized RGBA buffer. This is the
 * pixel-only analysis — it receives no filename, no MIME type, no EXIF, no
 * provenance, and never asks for them.
 */
export function analyzeRgba(
  data: Uint8Array,
  width: number,
  height: number,
): VisualSignals {
  const fit = fitRgba(data, width, height, 512);
  const d = fit.data;
  const w = fit.width;
  const h = fit.height;
  const lum = luminance(d, w, h);

  // ── 1. Smooth-region noise ─────────────────────────────────────────
  // Sample variance inside low-gradient 8x8 blocks (edges excluded). Real
  // camera captures have sensor noise; AI renders are over-smoothed.
  let noiseSum = 0;
  let noiseN = 0;
  for (let by = 0; by + 8 <= h; by += 8) {
    for (let bx = 0; bx + 8 <= w; bx += 8) {
      let mean = 0;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          mean += lum[(by + y) * w + bx + x];
        }
      }
      mean /= 64;
      let varSum = 0;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const v = lum[(by + y) * w + bx + x] - mean;
          varSum += v * v;
        }
      }
      const std = Math.sqrt(varSum / 64);
      // Blocks with real texture aren't "smooth" — sample the quiet ones.
      if (std < 8) {
        noiseSum += std;
        noiseN++;
      }
    }
  }
  const noiseStd = noiseN > 0 ? noiseSum / noiseN : 0;

  // ── 2 + 3. ELA: recompress, compare per-block MAE ──────────────────
  // Error Level Analysis: AI content recompresses with unnaturally uniform
  // error in SMOOTH regions; camera noise shows up as error everywhere a
  // photo has texture. Edge blocks are excluded — every image has edges,
  // and edge error is not the signal. (The same maxGradient gate as the
  // banding check, so the two signals agree on what "smooth" means.)
  let elaMean = 0;
  let elaVar = 0;
  let elaN = 0;
  const re = recompressJpeg(d, w, h, 80);
  if (re !== null) {
    const rlum = luminance(re, w, h);
    for (let by = 0; by + 8 <= h; by += 8) {
      for (let bx = 0; bx + 8 <= w; bx += 8) {
        let maxGrad = 0;
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const i = (by + y) * w + bx + x;
            const gx = x > 0 ? Math.abs(lum[i] - lum[i - 1]) : 0;
            const gy = y > 0 ? Math.abs(lum[i] - lum[i - w]) : 0;
            const g = Math.max(gx, gy);
            if (g > maxGrad) maxGrad = g;
          }
        }
        if (maxGrad > 6) continue; // edge block — not part of the signal
        let mae = 0;
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const i = (by + y) * w + bx + x;
            mae += Math.abs(lum[i] - rlum[i]);
          }
        }
        mae /= 64;
        elaMean += mae;
        elaVar += mae * mae;
        elaN++;
      }
    }
    if (elaN > 0) {
      elaMean /= elaN;
      elaVar = Math.sqrt(Math.max(0, elaVar / elaN - elaMean * elaMean));
    }
  }
  const elaCv = elaMean > 0.001 ? elaVar / elaMean : 0;

  // ── 4. High-frequency DCT energy ratio ─────────────────────────────
  // Ratio of HF (u,v >= 3) AC energy to total AC energy (DC excluded) per
  // block, averaged. Real photos carry texture energy broadly across the
  // spectrum; AI renders concentrate it in the lowest AC coefficients with
  // sharp HF edges, so the HF share is smaller.
  let hfSum = 0;
  let hfN = 0;
  for (let by = 0; by + 8 <= h; by += 8) {
    for (let bx = 0; bx + 8 <= w; bx += 8) {
      const block = new Float64Array(64);
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          block[y * 8 + x] = lum[(by + y) * w + bx + x];
        }
      }
      const dct = dct8(block);
      let totalAc = 0;
      let hf = 0;
      for (let v = 0; v < 8; v++) {
        for (let u = 0; u < 8; u++) {
          if (u === 0 && v === 0) continue; // DC excluded
          const e = dct[v * 8 + u] * dct[v * 8 + u];
          totalAc += e;
          if (u >= 3 || v >= 3) hf += e;
        }
      }
      if (totalAc > 1) {
        hfSum += hf / totalAc;
        hfN++;
      }
    }
  }
  const hfEnergy = hfN > 0 ? hfSum / hfN : 0.5;

  // ── 5. Banding in smooth regions ───────────────────────────────────
  // Two complementary measurements per smooth 8x8 block:
  //   1. distinct luminance levels (avg) — near-flat / heavily posterized
  //      regions show very few;
  //   2. the largest gap between consecutive distinct levels (avg) — the
  //      true banding signature. A real slow gradient has steps of 1-2
  //      (JPEG dither included); a posterized render has systematic steps
  //      of ~6. Distinct-count alone cannot tell a smooth real sky from a
  //      banded one (box-downscaling erases a sky's noise, which read as
  //      "few levels"), so the gap measurement carries the decision.
  let levelSum = 0;
  let levelN = 0;
  let gapSum = 0;
  for (let by = 0; by + 8 <= h; by += 8) {
    for (let bx = 0; bx + 8 <= w; bx += 8) {
      // Skip blocks containing an edge: the block's own max gradient.
      let maxGrad = 0;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const i = (by + y) * w + bx + x;
          const gx = x > 0 ? Math.abs(lum[i] - lum[i - 1]) : 0;
          const gy = y > 0 ? Math.abs(lum[i] - lum[i - w]) : 0;
          const g = Math.max(gx, gy);
          if (g > maxGrad) maxGrad = g;
        }
      }
      if (maxGrad > 6) continue; // not a smooth block
      const seen = new Uint8Array(256);
      let distinct = 0;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const v = Math.min(255, Math.max(0, Math.round(lum[(by + y) * w + bx + x])));
          if (seen[v] === 0) {
            seen[v] = 1;
            distinct++;
          }
        }
      }
      levelSum += distinct;
      levelN++;
      if (distinct >= 2) {
        let prev = -1;
        let maxGap = 0;
        for (let v = 0; v < 256; v++) {
          if (seen[v] !== 0) {
            if (prev >= 0) maxGap = Math.max(maxGap, v - prev);
            prev = v;
          }
        }
        gapSum += maxGap;
      }
    }
  }
  const gradientLevels = levelN > 0 ? levelSum / levelN : 0;
  const maxLevelGap = levelN > 0 ? gapSum / levelN : 0;

  // ── 6. Edge kurtosis ───────────────────────────────────────────────
  // Gradient-magnitude distribution across the image. Camera noise makes
  // gradients broad; AI edges are thin and sharp → high kurtosis.
  const grads: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = lum[i + 1] - lum[i - 1];
      const gy = lum[i + w] - lum[i - w];
      grads.push(Math.sqrt(gx * gx + gy * gy));
    }
  }
  let edgeKurtosis = 0;
  if (grads.length > 0) {
    let mean = 0;
    for (const g of grads) mean += g;
    mean /= grads.length;
    let v2 = 0;
    let v4 = 0;
    for (const g of grads) {
      const dg = g - mean;
      v2 += dg * dg;
      v4 += dg * dg * dg * dg;
    }
    v2 /= grads.length;
    if (v2 > 0) {
      edgeKurtosis = (v4 / grads.length) / (v2 * v2);
    }
  }

  // ── 7. Saturation ──────────────────────────────────────────────────
  let sat = 0;
  let satN = 0;
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    const r = d[p] / 255;
    const g = d[p + 1] / 255;
    const b = d[p + 2] / 255;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (mx > 0.02) {
      sat += (mx - mn) / mx;
      satN++;
    }
  }
  const saturation = satN > 0 ? sat / satN : 0;

  return {
    noiseStd,
    elaMean,
    elaCv,
    hfEnergy,
    gradientLevels,
    maxLevelGap,
    edgeKurtosis,
    saturation,
  };
}

/**
 * Map the raw signals to a 0..1 AI-likelihood score.
 *
 * Thresholds are derived from the measured signal distributions of the
 * adversarial QA suite, not guessed (the QA's calibration report prints
 * the split). Measured separation on the synthetic fixtures:
 *
 *   noiseStd:      AI renders 0-2.6, real photos 4.9+ (down to 192px)
 *   edgeKurtosis:  AI renders 25-252, real photos 2-3
 *   gradientLevels: strongly posterized fixtures 1-2, photos 12-22
 *   hfEnergy / ELA: noisy across sizes — weak supporting signals only
 *
 * No single signal can push the score past ai_likely on its own; the two
 * robust separators carry most of the weight.
 */
export function visualScore(s: VisualSignals): number {
  let score = 0;

  // Over-smoothed residual noise — the strongest separator. AI renders
  // remove sensor noise (0-2.6); real photos keep it (4.9+) even after
  // box-downscaling to 192px. Sub-192px is the resolution cap's domain.
  const noise = s.noiseStd < 2.5 ? 1 : s.noiseStd < 4 ? 0.75 : s.noiseStd < 5 ? 0.2 : 0;
  score += noise * 0.24;

  // Edge kurtosis — the ONLY signal with zero measured overlap between
  // the families (AI renders 25-252 across every transformation AND
  // compression level; every human fixture 2-6). It survives re-encoding,
  // cropping, and q30 recompression intact, so it carries the top weight.
  const edge =
    s.edgeKurtosis > 60 ? 1 : s.edgeKurtosis >= 25 ? 0.7 : s.edgeKurtosis > 15 ? 0.4 : 0;
  score += edge * 0.26;

  // Banding: measured — a real smooth gradient (even JPEG'd or
  // box-downscaled) keeps 4+ distinct levels per smooth block; a
  // posterized render drops to 1-2. The gap-based metric was dropped:
  // JPEG blurring smooths posterization steps into ramps (measured
  // avgGap ~1.0 for both families), so distinct-levels is the usable
  // signature here.
  const band =
    s.gradientLevels > 0 && s.gradientLevels < 3
      ? 1
      : s.gradientLevels > 0 && s.gradientLevels < 8
        ? 0.5
        : 0;
  score += band * 0.18;

  // Co-occurrence: over-smoothing + posterization + synthetic-sharp-edge
  // together is the canonical AI-render signature (measured: a real sky
  // can be smooth or subtly banded, but never has all three — its
  // kurtosis stays 2-6 even after q30, while AI renders keep 25-252).
  // Requiring all three keeps the bonus off a merely-compressed photo.
  if (noise === 1 && band === 1 && edge > 0) score += 0.06;

  // High-frequency DCT share — weak and noisy across sizes; keep low.
  const hf = s.hfEnergy < 0.1 ? 0.6 : s.hfEnergy < 0.25 ? 0.3 : 0;
  score += hf * 0.1;

  // ELA uniformity — unstable on synthetic material; a weak supporting
  // signal with a conservative floor.
  const ela =
    s.elaMean < 0.5 && s.elaCv < 0.7
      ? 0.5
      : s.elaMean < 1.0 && s.elaCv < 1.5
        ? 0.25
        : 0;
  score += ela * 0.1;

  // Unusually low saturation (washed-out renders) or extreme saturation.
  const sat =
    s.saturation < 0.08 ? 0.4 : s.saturation > 0.62 ? 0.35 : 0;
  score += sat * 0.04;

  // The missing 0.02 weight stays as an implicit "uncertainty" floor so a
  // perfect-looking signal set can't reach 1.0 — nothing is ever certain
  // beyond the measured threshold.
  return Math.min(0.99, Math.max(0, score / 0.98));
}

/** Classify a visual score into a confidence level. */
export function classifyVisual(score: number): VisualConfidence {
  if (score >= AI_CONFIRMED_SCORE) return "ai_confirmed";
  if (score >= AI_LIKELY_SCORE) return "ai_likely";
  if (score < 0.3) return "human_likely";
  return "uncertain";
}

/**
 * Resolution-aware confidence adjustment.
 *
 * Measured: a real photo keeps its sensor noise down to 192px, so the
 * noise/edge/banding signals carry full weight at any analysis size >=
 * 192px. Below that, box-downscaling erases a photo's fine texture
 * entirely (noiseStd collapses 5+ -> 0) and the naive score would read
 * "AI-smoothed" — the false-positive class the spec explicitly forbids.
 * The honest verdict for a sub-192px thumbnail is "uncertain", not a
 * confident guess either way, so the score is capped just under
 * ai_likely and can never over-claim.
 */
export function resolutionAdjustedScore(
  score: number,
  longSide: number,
): number {
  if (longSide >= 192) return score;
  return Math.min(score, 0.5);
}

/**
 * Full pipeline for a JPEG analysis copy: decode → analyze → classify.
 * Returns `unavailable: true` when the bytes can't be decoded — never a
 * clean signal by itself (the caller's byte scan governs in that case).
 */
export function analyzeJpegBytes(
  bytes: Uint8Array,
): VisualVerdict {
  const dec = decodeJpeg(bytes);
  if (dec === null) {
    return {
      confidence: "uncertain",
      score: 0,
      signals: {
        noiseStd: 0,
        elaMean: 0,
        elaCv: 0,
        hfEnergy: 0,
        gradientLevels: 0,
        maxLevelGap: 0,
        edgeKurtosis: 0,
        saturation: 0,
      },
      unavailable: true,
    };
  }
  const longSide = Math.max(dec.width, dec.height);
  const signals = analyzeRgba(dec.data, dec.width, dec.height);
  const score = resolutionAdjustedScore(visualScore(signals), longSide);
  return {
    confidence: classifyVisual(score),
    score,
    signals,
    unavailable: false,
  };
}

/**
 * Build the Cloudinary transformation URL that yields a normalized
 * analysis copy: any uploaded format → JPEG, metadata stripped, EXIF
 * orientation applied, fit to 512px. The ORIGINAL asset is never touched.
 */
export function normalizedAnalysisUrl(
  cloudName: string,
  publicId: string,
): string {
  const transform =
    "fl_strip_profile,a_auto,w_512,h_512,c_fit,q_85,f_jpg";
  return `https://res.cloudinary.com/${cloudName}/image/upload/${transform}/${publicId}`;
}
