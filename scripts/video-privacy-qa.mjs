#!/usr/bin/env node
/**
 * PureWire video-privacy QA check.
 *
 * Verifies the server-side MP4/MOV metadata stripper (src/lib/mp4-strip.ts)
 * against synthetic containers: it must drop GPS (`©xyz`), device
 * (`©mak`/`©mod`), and vendor (`udta`/`meta`/`uuid`) atoms while copying
 * the media payload (`mdat`) byte-for-byte, reject non-MP4 input, and be
 * idempotent — the properties the live remux path depends on.
 *
 * Pure function test — no deployment needed. Run:
 *
 *   npm run qa:video-privacy
 *
 * Exit codes: 0 all checks passed, 1 a check failed.
 */
import { stripMp4Metadata } from "../src/lib/mp4-strip.ts";

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

function box(type, payload) {
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt32BE(8 + payload.length, 0);
  buf.write(type, 4, "latin1");
  payload.copy(buf, 8);
  return buf;
}

function box64(type, payload) {
  // 64-bit largesize box: size field = 1, then an 8-byte largesize.
  const buf = Buffer.alloc(16 + payload.length);
  buf.writeUInt32BE(1, 0);
  buf.write(type, 4, "latin1");
  buf.writeBigUInt64BE(BigInt(16 + payload.length), 8);
  payload.copy(buf, 16);
  return buf;
}

const concat = (...parts) => Buffer.concat(parts);

// A GPS + device + vendor metadata payload, nested the way real camera
// files carry it: ©xyz under udta, ©mak/©mod under meta.
const gpsBox = box("\u00a9xyz", Buffer.from("40.7128-74.0060"));
const makeBox = box("\u00a9mak", Buffer.from("Pixel 8 Pro"));
const modelBox = box("\u00a9mod", Buffer.from("Pixel 8 Pro"));
const udta = box("udta", gpsBox);
const meta = box("meta", concat(makeBox, modelBox));
const uuid = box("uuid", Buffer.alloc(16, 0x5a));

const mdatPayload = Buffer.alloc(256, 0xab);
const mdat = box("mdat", mdatPayload);
const ftyp = box("ftyp", Buffer.from("isom"));

function hasType(buf, type) {
  // A box type as a 4-byte literal (latin1, so © becomes 0xA9).
  const needle = Buffer.from(type, "latin1");
  for (let i = 0; i + 4 <= buf.length; i++) {
    // Only match at a box boundary (after a 4-byte size).
    if (buf.subarray(i + 4, i + 8).equals(needle)) return true;
  }
  return false;
}

function countMarker(buf, byte) {
  let n = 0;
  for (const b of buf) if (b === byte) n++;
  return n;
}

// ── 1. Dirty MP4: GPS + device + vendor atoms must all vanish ─────────────
{
  const dirty = concat(ftyp, mdat, box("moov", concat(udta, meta, uuid)));
  const result = stripMp4Metadata(new Uint8Array(dirty));
  check("dirty MP4 is recognized as MP4", result !== null);
  if (result !== null) {
    const out = Buffer.from(result.bytes);
    check("remux reports a change", result.changed === true);
    check("GPS ©xyz atom dropped", !hasType(out, "\u00a9xyz"));
    check("camera ©mak atom dropped", !hasType(out, "\u00a9mak"));
    check("camera ©mod atom dropped", !hasType(out, "\u00a9mod"));
    check("udta box dropped", !hasType(out, "udta"));
    check("meta box dropped", !hasType(out, "meta"));
    check("uuid box dropped", !hasType(out, "uuid"));
    check("ftyp preserved", hasType(out, "ftyp"));
    check("mdat preserved", hasType(out, "mdat"));
    check(
      "media payload copied byte-for-byte",
      countMarker(out, 0xab) === mdatPayload.length,
    );
    // Idempotent: stripping the already-clean output is a no-op.
    const again = stripMp4Metadata(new Uint8Array(out));
    check("remux is idempotent", again !== null && again.changed === false);
  }
}

// ── 2. 64-bit largesize box survives the remux ─────────────────────────────
{
  const bigMdat = box64("mdat", mdatPayload);
  const dirty = concat(ftyp, bigMdat, box("moov", concat(udta, uuid)));
  const result = stripMp4Metadata(new Uint8Array(dirty));
  check("64-bit largesize MP4 is recognized", result !== null);
  if (result !== null) {
    const out = Buffer.from(result.bytes);
    check("largesize mdat payload preserved", countMarker(out, 0xab) === mdatPayload.length);
    check("largesize mdat box survives", hasType(out, "mdat"));
    check("metadata still stripped in largesize file", !hasType(out, "\u00a9xyz"));
  }
}

// ── 3. Clean MP4: no change, no rewrite ────────────────────────────────────
{
  const clean = concat(ftyp, mdat, box("moov", box("trak", box("mdia", box("minf", box("stbl", box("stts", Buffer.alloc(8))))))));
  const result = stripMp4Metadata(new Uint8Array(clean));
  check("clean MP4 is recognized", result !== null);
  if (result !== null) {
    check("clean MP4 reports no change", result.changed === false);
    check("clean MP4 bytes untouched", Buffer.from(result.bytes).equals(clean));
  }
}

// ── 4. Non-MP4 containers pass through untouched ───────────────────────────
{
  const webm = new Uint8Array([
    0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ...Buffer.alloc(128),
  ]);
  check("WebM is not misparsed as MP4", stripMp4Metadata(webm) === null);
  const ogg = new Uint8Array([
    ...Buffer.from("OggS", "latin1"),
    ...Buffer.alloc(128),
  ]);
  check("Ogg is not misparsed as MP4", stripMp4Metadata(ogg) === null);
  const tooShort = new Uint8Array([0x00, 0x00, 0x00, 0x18]);
  check("tiny input is rejected safely", stripMp4Metadata(tooShort) === null);
}

// ── 5. Corrupt structure never throws, falls back to unchanged ─────────────
{
  // A container whose declared size overruns the buffer.
  const corrupt = new Uint8Array([
    0x00, 0x00, 0x00, 0xff, ...Buffer.from("moov", "latin1"),
    ...Buffer.alloc(64, 0x00),
  ]);
  let result = null;
  let threw = false;
  try {
    result = stripMp4Metadata(corrupt);
  } catch {
    threw = true;
  }
  check("corrupt container never throws", threw === false);
  check("corrupt container falls back to unchanged", result === null || result.changed === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("Failed checks:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
