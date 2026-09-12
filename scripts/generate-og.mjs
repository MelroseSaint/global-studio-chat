/**
 * PureWire Open Graph share image generator — no dependencies.
 *
 * Renders the 1200×630 card used when a PureWire link is shared:
 *
 *   public/og-image.png
 *
 * The composition: a Wire Black field with soft Oxide/Moss/Copper glows,
 * the P-wire monogram on the left, and a wire-style "PUREWIRE" wordmark
 * with the "Say it anyway." tagline on the right. Every letterform is
 * drawn as strokes in the same visual language as the logo — a custom
 * geometric sans, rounded caps, no font file needed.
 *
 * Run:  node scripts/generate-og.mjs
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cubicPoints,
  distToStroke,
  encodePng,
  PALETTE,
  sampleMark,
} from "./brand.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public");

const W = 1200;
const H = 630;

// ---- The wire font ---------------------------------------------------------
// Each glyph lives in a unit box: x 0..1 (advance in `w`), y 0..1 where 0
// is the top and 1 is the baseline (descenders may exceed 1). A stroke is
// either a line [x1,y1,x2,y2], a cubic [x1,y1,c1x,c1y,c2x,c2y,x2,y2], or a
// dot { c: [x, y], r }. Stroke thickness = FONT_STROKE × glyph height.

const FONT_STROKE = 0.13;
// Unit-space stroke radius is constant: thickness/2, scaled by glyph height
// cancels out because every distance test runs in normalized glyph space.
const STROKE_R = FONT_STROKE / 2;

const GLYPHS = {
  // Uppercase — the wordmark.
  P: {
    w: 0.62,
    s: [
      [0.18, 0.05, 0.18, 0.95],
      [0.18, 0.05, 0.6, 0.05],
      [0.6, 0.05, 0.6, 0.45],
      [0.6, 0.45, 0.18, 0.45],
    ],
  },
  U: {
    w: 0.62,
    s: [
      [0.18, 0.05, 0.18, 0.68],
      [0.18, 0.68, 0.62, 0.68],
      [0.62, 0.68, 0.62, 0.05],
    ],
  },
  R: {
    w: 0.66,
    s: [
      [0.18, 0.05, 0.18, 0.95],
      [0.18, 0.05, 0.6, 0.05],
      [0.6, 0.05, 0.6, 0.45],
      [0.6, 0.45, 0.18, 0.45],
      [0.6, 0.45, 0.8, 0.95],
    ],
  },
  E: {
    w: 0.6,
    s: [
      [0.18, 0.05, 0.18, 0.95],
      [0.18, 0.05, 0.66, 0.05],
      [0.18, 0.5, 0.58, 0.5],
      [0.18, 0.95, 0.66, 0.95],
    ],
  },
  W: {
    w: 0.88,
    s: [
      [0.08, 0.05, 0.28, 0.95, 0.45, 0.3, 0.62, 0.95, 0.82, 0.05],
    ],
  },
  I: { w: 0.3, s: [[0.38, 0.05, 0.38, 0.95]] },
  // Lowercase — the tagline.
  s: {
    w: 0.58,
    s: [
      [0.6, 0.32, 0.5, 0.26, 0.32, 0.28, 0.3, 0.42],
      [0.3, 0.42, 0.28, 0.58, 0.55, 0.55, 0.55, 0.7],
      [0.55, 0.7, 0.55, 0.8, 0.42, 0.84, 0.32, 0.78],
    ],
  },
  a: {
    w: 0.62,
    s: [
      [0.5, 0.4, 0.5, 0.95],
      [0.5, 0.42, 0.35, 0.36, 0.2, 0.42, 0.2, 0.6],
      [0.2, 0.6, 0.2, 0.8, 0.36, 0.9, 0.5, 0.9],
    ],
  },
  y: {
    w: 0.58,
    s: [
      [0.24, 0.32, 0.4, 0.6],
      [0.4, 0.6, 0.4, 1.25],
      [0.4, 0.58, 0.55, 0.32],
    ],
  },
  i: { w: 0.32, s: [[0.4, 0.4, 0.4, 0.95], { c: [0.4, 0.22], r: 0.09 }] },
  t: {
    w: 0.5,
    s: [
      [0.42, 0.24, 0.42, 0.95],
      [0.3, 0.52, 0.58, 0.52],
    ],
  },
  n: {
    w: 0.62,
    s: [
      [0.22, 0.95, 0.22, 0.42],
      [0.22, 0.42, 0.32, 0.32, 0.5, 0.32, 0.56, 0.44],
      [0.56, 0.44, 0.56, 0.95],
    ],
  },
  w: {
    w: 0.85,
    s: [[0.08, 0.42, 0.28, 0.95, 0.45, 0.5, 0.62, 0.95, 0.82, 0.42]],
  },
  o: {
    w: 0.62,
    s: [
      [0.32, 0.6, 0.32, 0.34, 0.68, 0.34, 0.68, 0.6],
      [0.68, 0.6, 0.68, 0.86, 0.32, 0.86, 0.32, 0.6],
    ],
  },
  ".": { w: 0.2, s: [{ c: [0.5, 0.86], r: 0.09 }] },
  " ": { w: 0.35, s: [] },
};

/**
 * Flatten a glyph's strokes into a set of unit-space polylines (cubics
 * sampled, dots kept as circles) plus its expanded bounding box.
 */
function flattenGlyph(glyph, strokeR) {
  const polylines = [];
  const dots = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const bound = (pts) => {
    for (const [px, py] of pts) {
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
  };
  for (const stroke of glyph.s) {
    if (Array.isArray(stroke)) {
      const pts =
        stroke.length === 4
          ? [
              [stroke[0], stroke[1]],
              [stroke[2], stroke[3]],
            ]
          : cubicPoints(...stroke);
      polylines.push(pts);
      bound(pts);
    } else {
      dots.push(stroke);
      const { c, r } = stroke;
      if (c[0] - r < minX) minX = c[0] - r;
      if (c[1] - r < minY) minY = c[1] - r;
      if (c[0] + r > maxX) maxX = c[0] + r;
      if (c[1] + r > maxY) maxY = c[1] + r;
    }
  }
  // Expand the box by the stroke radius for edge coverage.
  return {
    polylines,
    dots,
    box: [minX - strokeR, minY - strokeR, maxX + strokeR, maxY + strokeR],
  };
}

/** A fully placed, flattened run of glyph text at (x, yb) with height h. */
function placeText(text, x0, yb, h, color, spacing = 0.14) {
  const strokeR = FONT_STROKE;
  const placed = [];
  let cursor = x0;
  for (const ch of text) {
    const glyph = GLYPHS[ch];
    if (glyph === undefined) continue;
    placed.push({
      x: cursor,
      yb,
      h,
      color,
      ...flattenGlyph(glyph, strokeR),
    });
    cursor += (glyph.w + spacing) * h;
  }
  return { x0, width: cursor - x0, placed };
}

/** Is the pixel inside a placed glyph? Returns the color or null. */
function glyphAt(px, py, placed) {
  for (const g of placed) {
    // Unit space: x grows right (0 → glyph width), y grows downward from
    // the glyph top (0) to the baseline (1), with descenders beyond 1.
    const u = (px - g.x) / g.h;
    const v = (py - (g.yb - g.h)) / g.h;
    const [bx0, by0, bx1, by1] = g.box;
    if (u < bx0 || u > bx1 || v < by0 || v > by1) continue;
    let hit = false;
    for (const pts of g.polylines) {
      if (distToStroke(u, v, pts, STROKE_R) <= 0) {
        hit = true;
        break;
      }
    }
    if (!hit) {
      for (const { c, r } of g.dots) {
        const dx = u - c[0];
        const dy = v - c[1];
        if (dx * dx + dy * dy <= (r + STROKE_R) ** 2) {
          hit = true;
          break;
        }
      }
    }
    if (hit) return g.color;
  }
  return null;
}

// ---- Composition ------------------------------------------------------------

const WORDMARK = placeText("PUREWIRE", 480, 262, 100, PALETTE.paper, 0.13);
const TAGLINE = placeText("Say it anyway.", 486, 396, 58, PALETTE.oxide, 0.16);

// The mark, sampled into a 4.5× scale box on the left.
const MARK_SIZE = 4.5 * 64;
const MARK_X0 = 118;
const MARK_Y0 = 172;

// Layered radial glows over the Wire Black field.
const GLOWS = [
  { cx: 130, cy: 100, r: 560, color: PALETTE.oxide, strength: 0.16 },
  { cx: 1150, cy: 640, r: 640, color: PALETTE.moss, strength: 0.2 },
  { cx: 150, cy: 590, r: 380, color: PALETTE.copper, strength: 0.12 },
];

function glowColor(x, y) {
  let r = PALETTE.wireBlack[0];
  let g = PALETTE.wireBlack[1];
  let b = PALETTE.wireBlack[2];
  for (const { cx, cy, r: radius, color, strength } of GLOWS) {
    const dx = x - cx;
    const dy = y - cy;
    const d = Math.hypot(dx, dy) / radius;
    if (d >= 1) continue;
    const a = (1 - d) ** 2 * strength;
    r += (color[0] - r) * a;
    g += (color[1] - g) * a;
    b += (color[2] - b) * a;
  }
  return [r, g, b];
}

const png = encodePng(W, H, (x, y) => {
  // Mark first (on top), then text, then the glow field behind.
  const u = (x - MARK_X0) / MARK_SIZE;
  const v = (y - MARK_Y0) / MARK_SIZE;
  if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
    const mark = sampleMark(u, v);
    if (mark !== null) return mark;
  }
  const word = glyphAt(x, y, WORDMARK.placed);
  if (word !== null) return word;
  const tag = glyphAt(x, y, TAGLINE.placed);
  if (tag !== null) return tag;
  return glowColor(x, y);
});

writeFileSync(join(OUT, "og-image.png"), png);
console.log(`wrote ${join(OUT, "og-image.png")} (${W}×${H})`);
