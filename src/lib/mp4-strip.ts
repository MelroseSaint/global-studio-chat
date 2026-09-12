/**
 * MP4/MOV container metadata stripper — PureWire's server-side safety net
 * for video privacy.
 *
 * The browser already re-encodes most videos, which drops container
 * metadata. But any clip that passes through untouched (longer than the
 * re-encode budget, already small, or undecodable) keeps its original
 * MP4/MOV atoms — including GPS coordinates (`©xyz`), camera make/model
 * (`©mak` / `©mod`), and vendor user-data boxes (`udta`, `meta`, `uuid`).
 *
 * This module rebuilds the container without those boxes. It is a remux,
 * not a transcode: the media payload (`mdat`) is copied byte-for-byte, so
 * every frame, track, and timestamp survives intact — only the metadata
 * atoms disappear. Pure functions, no runtime dependencies, erasable TS so
 * the QA script can import it directly under Node's type stripping.
 */

export interface StripResult {
  bytes: Uint8Array;
  changed: boolean;
}

interface ParsedBox {
  type: string;
  start: number;
  payloadStart: number;
  payloadEnd: number;
}

/** Boxes that recurse into children. Everything else is a leaf. */
const CONTAINERS = new Set([
  "moov", // movie
  "trak", // track
  "edts", // edit list
  "mdia", // media
  "minf", // media info
  "stbl", // sample table
  "dinf", // data info
  "mvex", // movie extends (fragmented MP4)
  "moof", // movie fragment
  "traf", // track fragment
  "mfra", // movie fragment random access
]);

/**
 * Boxes that carry GPS/device/author metadata and are safe to drop. `meta`
 * and `udta` are optional metadata containers per the ISO BMFF spec;
 * `uuid` holds vendor user extensions (some devices store GPS there).
 * Box types beginning with `©` (0xA9) are QuickTime metadata tags
 * (`©xyz` GPS coordinates, `©mak` / `©mod` device, etc.).
 */
function isDropped(type: string): boolean {
  return (
    type === "udta" ||
    type === "meta" ||
    type === "uuid" ||
    type.charCodeAt(0) === 0xa9
  );
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, false);
}

function typeAt(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/**
 * Parse a run of boxes in [start, end). Returns null on any malformed
 * structure — callers then pass the file through unchanged rather than
 * risk corrupting it.
 */
function parseBoxes(
  start: number,
  end: number,
  view: DataView,
): ParsedBox[] | null {
  const boxes: ParsedBox[] = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) return null;
    const size32 = readU32(view, offset);
    const type = typeAt(view, offset + 4);
    let headerSize = 8;
    let total = size32;
    if (size32 === 1) {
      // 64-bit largesize: next 8 bytes.
      if (offset + 16 > end) return null;
      const hi = readU32(view, offset + 8);
      const lo = readU32(view, offset + 12);
      total = hi * 0x100000000 + lo;
      headerSize = 16;
    } else if (size32 === 0) {
      // Box extends to the end of the containing run.
      total = end - offset;
    }
    if (total < headerSize || offset + total > end) return null;
    boxes.push({
      type,
      start: offset,
      payloadStart: offset + headerSize,
      payloadEnd: offset + total,
    });
    offset += total;
  }
  return boxes;
}

function serializeBox(type: string, payload: Uint8Array): Uint8Array {
  // 4-byte size + 4-byte type. A container exceeding 4 GiB is absurd for
  // real uploads; if it somehow happens, callers keep the original box.
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 8 + payload.length, false);
  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i) & 0xff;
  }
  out.set(payload, 8);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Rebuild the box tree in [start, end), dropping metadata boxes. Returns
 * null when the structure can't be parsed (caller passes through).
 */
function rebuild(
  bytes: Uint8Array,
  start: number,
  end: number,
  view: DataView,
): { parts: Uint8Array[]; changed: boolean } | null {
  const boxes = parseBoxes(start, end, view);
  if (boxes === null) return null;
  const parts: Uint8Array[] = [];
  let changed = false;
  for (const box of boxes) {
    if (isDropped(box.type)) {
      changed = true;
      continue;
    }
    if (CONTAINERS.has(box.type)) {
      const inner = rebuild(bytes, box.payloadStart, box.payloadEnd, view);
      if (inner === null) {
        // Container couldn't be parsed — keep it whole rather than risk it.
        parts.push(bytes.subarray(box.start, box.payloadEnd));
        continue;
      }
      if (inner.changed) {
        changed = true;
        const payload = concat(inner.parts);
        // Containers are metadata-sized; guard the pathological case.
        if (payload.length <= 0xfffffffe - 8) {
          parts.push(serializeBox(box.type, payload));
        } else {
          parts.push(bytes.subarray(box.start, box.payloadEnd));
        }
      } else {
        parts.push(bytes.subarray(box.start, box.payloadEnd));
      }
    } else {
      parts.push(bytes.subarray(box.start, box.payloadEnd));
    }
  }
  return { parts, changed };
}

/**
 * Strip GPS/device/author metadata atoms from an MP4/MOV file.
 *
 * Returns null when the input isn't a recognizable MP4/MOV container (e.g.
 * WebM, Matroska, Ogg) or can't be parsed — the caller then keeps the file
 * unchanged. Returns `{ bytes, changed: false }` when no metadata boxes
 * were found. Never throws.
 */
export function stripMp4Metadata(input: Uint8Array): StripResult | null {
  if (input.length < 12) return null;
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const firstType = typeAt(view, 4);
  // Recognize real MP4/MOV containers. WebM begins with 0x1A45DFA3, Ogg
  // with "OggS", RIFF with "RIFF" — all rejected here and passed through.
  const recognized =
    firstType === "ftyp" ||
    firstType === "moov" ||
    firstType === "wide" ||
    firstType === "free" ||
    firstType === "skip" ||
    firstType === "mdat" ||
    firstType === "styp" ||
    firstType === "sidx" ||
    firstType === "moof" ||
    firstType === "pdin" ||
    firstType === "uuid" ||
    firstType === "meta" ||
    firstType === "udta";
  if (!recognized) return null;
  const rebuilt = rebuild(input, 0, input.length, view);
  if (rebuilt === null) return null;
  if (!rebuilt.changed) return { bytes: input, changed: false };
  return { bytes: concat(rebuilt.parts), changed: true };
}
