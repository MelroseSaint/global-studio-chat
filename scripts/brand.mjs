/**
 * PureWire brand toolkit — shared by the PWA icon generator and the Open
 * Graph image generator. Dependency-free on purpose: a mark this important
 * is drawn by code the project owns, not by a rasterizer someone else ships.
 *
 * The mark — the "P-wire monogram". A single paper wire draws the letter P
 * (stem + open bowl, one continuous stroke), grounded on a moss baseline.
 * From that ground an oxide voice bar rises, and a copper spark crowns it:
 * PureWire's letter, carrying your voice. Every palette color has a role.
 */

export const PALETTE = {
  // Wire Black #171918 — independence and strength.
  wireBlack: [23, 25, 24],
  // Paper #F4F0E8 — openness and space.
  paper: [244, 240, 232],
  // Oxide #B84A32 — rebellion, expression, breaking from convention.
  oxide: [184, 74, 50],
  // Moss #465A4C — independence and grounding.
  moss: [70, 90, 76],
  // Copper #C97952 — the secondary expressive accent.
  copper: [201, 121, 82],
};

// ---- Geometry helpers -----------------------------------------------------

/** Distance from a point to a finite line segment. */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = Math.min(1, Math.max(0, ((px - x1) * dx + (py - y1) * dy) / len2));
  }
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Sample a cubic bezier into a polyline of points. */
export function cubicPoints(x1, y1, c1x, c1y, c2x, c2y, x2, y2, n = 14) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    pts.push([
      a * x1 + b * c1x + c * c2x + d * x2,
      a * y1 + b * c1y + c * c2y + d * y2,
    ]);
  }
  return pts;
}

/** Distance from a point to a stroked polyline (round caps, radius r). */
export function distToStroke(px, py, pts, radius) {
  let min = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distToSegment(
      px,
      py,
      pts[i][0],
      pts[i][1],
      pts[i + 1][0],
      pts[i + 1][1],
    );
    if (d < min) min = d;
  }
  return min - radius;
}

/** Is a point inside a circle? */
function inCircle(px, py, cx, cy, r) {
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

// ---- The mark --------------------------------------------------------------

// Defined in a 64×64 design space, matching public/logo.svg.
//
// The mark — the "open wire P". A paper wire draws the letter P, but its
// bowl never closes: the loop stays open, and an oxide spark sits in the
// opening — the voice that completes the letter, PureWire's "say it anyway".
// A copper broadcast arc carries the signal outward, and the whole mark
// stands on a moss grounding line. Every palette color has a role.
const GROUND = { x1: 11, y1: 51, x2: 52, y2: 51, r: 1.3 }; // moss baseline
const STEM = { x1: 16, y1: 50, x2: 16, y2: 17, r: 2.1 }; // paper stem
// The bowl: one open loop drawn in two cubics; its free end floats away
// from the stem instead of closing the letter.
const BOWL_PTS = cubicPoints(16, 25, 24, 17, 38, 18.5, 40, 29).concat(
  cubicPoints(40, 29, 40, 39, 29, 44, 28, 44.5).slice(1),
);
const BOWL_R = 2.1;
// The oxide spark completes the open loop — the voice that says it anyway.
const SPARK = { cx: 21, cy: 44, r: 3.4 };
// The copper broadcast arc: a thin ring segment arcing away from the bowl's
// shoulder — the signal going out. Sampled as a polyline so the SVG and the
// raster stay pixel-identical.
const ARC_PTS = (() => {
  const cx = 37;
  const cy = 22;
  const r = 10;
  const pts = [];
  for (const deg of [-70, -55, -40, -25, -10, 5, 20]) {
    const rad = (deg * Math.PI) / 180;
    pts.push([cx + r * Math.cos(rad), cy + r * Math.sin(rad)]);
  }
  return pts;
})();
const ARC_R = 1.3;

/**
 * Sample the mark at normalized 0..1 coordinates over the 64-space.
 * Returns an [r,g,b] palette color, or null for background (the caller
 * decides what sits behind the mark — the tile for icons, the gradient
 * for the share image).
 */
export function sampleMark(u, v) {
  const px = u * 64;
  const py = v * 64;
  if (distToStroke(px, py, ARC_PTS, ARC_R) <= 0) return PALETTE.copper;
  if (inCircle(px, py, SPARK.cx, SPARK.cy, SPARK.r)) return PALETTE.oxide;
  if (distToStroke(px, py, BOWL_PTS, BOWL_R) <= 0) return PALETTE.paper;
  if (
    distToStroke(px, py, [[STEM.x1, STEM.y1], [STEM.x2, STEM.y2]], STEM.r) <= 0
  ) {
    return PALETTE.paper;
  }
  if (
    distToStroke(
      px,
      py,
      [
        [GROUND.x1, GROUND.y1],
        [GROUND.x2, GROUND.y2],
      ],
      GROUND.r,
    ) <= 0
  ) {
    return PALETTE.moss;
  }
  return null;
}

// ---- PNG encoder (8-bit RGB, no filters) -----------------------------------

import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * Encode an RGB image. pixelFn(x, y) must return [r, g, b] (0-255).
 */
export function encodePng(width, height, pixelFn) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelFn(x, y);
      const i = 1 + x * 4;
      row[i] = r;
      row[i + 1] = g;
      row[i + 2] = b;
      row[i + 3] = 255;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
