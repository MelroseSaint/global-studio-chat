/**
 * PureWire PWA icon generator — no dependencies.
 *
 * Rasterizes the brand mark (see scripts/brand.mjs) into PNG icons for the
 * web app manifest:
 *
 *   public/icon-192.png          — standard 192px
 *   public/icon-512.png          — standard 512px
 *   public/icon-maskable-192.png — maskable 192px (safe-zone padding)
 *   public/icon-maskable-512.png — maskable 512px (safe-zone padding)
 *
 * Run:  node scripts/generate-icons.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { encodePng, PALETTE, sampleMark } from "./brand.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public");

/**
 * Fill the tile: the mark on the Wire Black rounded tile, exactly as the
 * SVG logo. Outside the mark, the tile color shows through.
 */
function tile(u, v) {
  return sampleMark(u, v) ?? PALETTE.wireBlack;
}

/**
 * Render a size×size icon.
 * - maskable: the mark is scaled into the central safe zone (≈66%) so it
 *   survives any mask shape; the background fills the full tile.
 * - standard: the mark fills the tile.
 *
 * The maskable transform maps tile-normalized (u, v) into the 64-unit
 * design space (mark scaled by `scale`, inset by `offset`), then back to
 * normalized 0..1 for sampleMark — sampleMark itself multiplies by 64, so
 * it must receive normalized coordinates or the mark lands far off-canvas.
 */
function render(size, maskable) {
  const safe = maskable ? 0.66 : 0.94;
  const scale = safe * (64 / 60);
  const offset = (64 - 64 * scale) / 2;
  return encodePng(size, size, (x, y) => {
    // 2×2 supersampling for clean edges.
    let r = 0;
    let g = 0;
    let b = 0;
    for (const sy of [0.25, 0.75]) {
      for (const sx of [0.25, 0.75]) {
        const u = (x + sx) / size;
        const v = (y + sy) / size;
        const u64 = maskable ? offset + u * scale * 64 : u * 64;
        const v64 = maskable ? offset + v * scale * 64 : v * 64;
        const [cr, cg, cb] = tile(u64 / 64, v64 / 64);
        r += cr;
        g += cg;
        b += cb;
      }
    }
    return [Math.round(r / 4), Math.round(g / 4), Math.round(b / 4)];
  });
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
