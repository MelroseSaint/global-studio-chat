/**
 * PureWire PWA icon generator — no dependencies.
 *
 * Rasterizes the brand mark (wire-black tile, paper wire, oxide voice bars,
 * copper spark) into PNG icons for the web app manifest:
 *
 *   public/icon-192.png          — standard 192px
 *   public/icon-512.png          — standard 512px
 *   public/icon-maskable-192.png — maskable 192px (safe-zone padding)
 *   public/icon-maskable-512.png — maskable 512px (safe-zone padding)
 *
 * Run:  node scripts/generate-icons.mjs
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public");

// Brand palette (matches logo.svg).
const WIRE_BLACK = [23, 25, 24];
const PAPER = [244, 240, 232];
const OXIDE = [184, 74, 50];
const COPPER = [201, 121, 82];

// Shape definitions in a 64×64 design space (mirrors logo.svg).
// The mark: a paper "wire" baseline, three rising oxide voice bars, and a
// copper spark above the tallest bar.
const WIRE = { y: 46, x0: 13, x1: 51, r: 1.75 };
const BARS = [
  { x: 17, y: 37, w: 6, h: 9, r: 3 },
  { x: 26, y: 31, w: 6, h: 15, r: 3 },
  { x: 35, y: 24, w: 6, h: 22, r: 3 },
];
const SPARK = { cx: 38, cy: 16.5, r: 3.25 };

/** Is a point inside a rounded rectangle? */
function inRoundedRect(px, py, x, y, w, h, r) {
  const rx = Math.min(r, w / 2);
  const ry = Math.min(r, h / 2);
  const cx = Math.min(Math.max(px, x + rx), x + w - rx);
  const cy = Math.min(Math.max(py, y + ry), y + h - ry);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= rx * rx + ry * ry;
}

/** Is a point inside a horizontal capsule (the wire)? */
function inWire(px, py) {
  if (py < WIRE.y - WIRE.r || py > WIRE.y + WIRE.r) return false;
  const cx = Math.min(Math.max(px, WIRE.x0), WIRE.x1);
  return Math.abs(px - cx) <= WIRE.r;
}

/** Sample the mark at a 0..1 normalized coordinate within the tile. */
function sampleMark(u, v) {
  const px = u * 64;
  const py = v * 64;
  // Spark, then bars, then wire — topmost shapes first.
  const dx = px - SPARK.cx;
  const dy = py - SPARK.cy;
  if (dx * dx + dy * dy <= SPARK.r * SPARK.r) return COPPER;
  for (const b of BARS) {
    if (inRoundedRect(px, py, b.x, b.y, b.w, b.h, b.r)) return OXIDE;
  }
  if (inWire(px, py)) return PAPER;
  return WIRE_BLACK;
}

/**
 * Render a size×size icon.
 * - maskable: the mark is scaled into the central safe zone (≈66%) so it
 *   survives any mask shape; the background fills the full tile.
 * - standard: the mark fills the tile with a rounded-tile background.
 */
function render(size, maskable) {
  const safe = maskable ? 0.66 : 0.94;
  const scale = safe * (64 / 60);
  const offset = (64 - 64 * scale) / 2;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      // 2×2 supersampling for clean edges.
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const sy of [0.25, 0.75]) {
        for (const sx of [0.25, 0.75]) {
          const u = (x + sx) / size;
          const v = (y + sy) / size;
          const [cr, cg, cb] = sampleMark(
            maskable ? offset + u * scale * 64 : u,
            maskable ? offset + v * scale * 64 : v,
          );
          r += cr;
          g += cg;
          b += cb;
          a += 255;
        }
      }
      const i = 1 + x * 4;
      row[i] = Math.round(r / 4);
      row[i + 1] = Math.round(g / 4);
      row[i + 2] = Math.round(b / 4);
      row[i + 3] = Math.round(a / 4);
    }
    rows.push(row);
  }
  return encodePng(size, rows);
}

// ---- Minimal PNG encoder (8-bit RGBA, no filters) ----

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

function encodePng(size, rows) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const idat = deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const [name, size, maskable] of [
  ["icon-192.png", 192, false],
  ["icon-512.png", 512, false],
  ["icon-maskable-192.png", 192, true],
  ["icon-maskable-512.png", 512, true],
]) {
  const file = join(OUT, name);
  writeFileSync(file, render(size, maskable));
  console.log(`wrote ${file}`);
}
