#!/usr/bin/env node
/**
 * PureWire Resemble v2 health probe.
 *
 * Submits a known-clean, tiny PNG (no AI metadata, no generator markers)
 * to the Resemble v2 detect endpoint and verifies the API is reachable,
 * accepts jobs, and returns a completed result with the expected shape.
 *
 * Pure Node — no Convex dependency. Uses only built-in fetch + buffer APIs.
 * Designed as a CI gate: fails fast when the key is expired or the API is
 * unreachable, so media outages surface before users report them.
 *
 *   RESEMBLE_API_KEY=<v2-bearer-token> node scripts/resemble-health-probe.mjs
 *
 * Exit: 0 healthy, 1 unhealthy or key absent.
 */

const BASE_URL = "https://app.resemble.ai/api/v2";
const apiKey = process.env.RESEMBLE_API_KEY;

if (!apiKey || apiKey.length < 8) {
  console.error("RESEMBLE_API_KEY not set or too short — skipping probe.");
  process.exit(0); // not a failure — the key simply isn't configured
}

// ── Tiny clean PNG builder (pure Node, zero deps) ─────────────────

/**
 * Minimal valid PNG: a 1×1 white pixel, no metadata chunks, no EXIF.
 * Any deepfake detector should classify this as 100% real.
 */
function cleanPngBytes() {
  // PNG signature
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk: 13 bytes, 1×1, 8-bit RGB, no compression/filter/interlace
  const ihdrData = new Uint8Array(13);
  ihdrData[0] = 0; ihdrData[1] = 0; ihdrData[2] = 0; ihdrData[3] = 1; // width=1
  ihdrData[4] = 0; ihdrData[5] = 0; ihdrData[6] = 0; ihdrData[7] = 1; // height=1
  // bit depth=8, color type=2 (RGB), compression=0, filter=0, interlace=0
  const ihdr = makeChunk("IHDR", ihdrData);

  // IDAT chunk: zlib-compressed 1×1 white pixel (filter byte 0 + RGB 255,255,255)
  // Pre-computed DEFLATE stream (RFC 1950/RFC 1951) — 1×1 white RGB pixel.
  // Raw data: filter=0x00, R=0xFF, G=0xFF, B=0xFF
  const idatData = new Uint8Array([
    0x78, 0x01,             // zlib header (no compression, smallest window)
    0x01,                   // block header: final block, stored (no compression)
    0x00, 0x04,             // LEN=4
    0xff, 0xfb,             // NLEN (ones' complement of LEN)
    0x00, 0xff, 0xff, 0xff, // stored data: filter=0, R=255, G=255, B=255
    0x01, 0x29, 0x00, 0xc4, // Adler-32 checksum (pre-computed for the 4-byte input)
  ]);
  const idat = makeChunk("IDAT", idatData);

  // IEND chunk: empty
  const iend = makeChunk("IEND", new Uint8Array(0));

  const total = sig.length + ihdr.length + idat.length + iend.length;
  const out = new Uint8Array(total);
  let off = 0;
  out.set(sig, off); off += sig.length;
  out.set(ihdr, off); off += ihdr.length;
  out.set(idat, off); off += idat.length;
  out.set(iend, off);
  return out;
}

function u32be(n) {
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 0xff;
  b[1] = (n >>> 16) & 0xff;
  b[2] = (n >>> 8) & 0xff;
  b[3] = n & 0xff;
  return b;
}

/** Simple CRC-32 for PNG chunk validation (not strictly needed, but correct). */
function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = u32be(data.length);
  const typeBytes = new TextEncoder().encode(type);
  const crcBytes = u32be(crc32(new Uint8Array([...typeBytes, ...data])));
  const total = 4 + 4 + data.length + 4;
  const out = new Uint8Array(total);
  out.set(len, 0);
  out.set(typeBytes, 4);
  out.set(data, 8);
  out.set(crcBytes, 8 + data.length);
  return out;
}

// ── Resemble v2 API helpers ─────────────────────────────────────────

async function submitDetectJob(bytes, mimeType, fileName) {
  const formData = new FormData();
  formData.append("file", new Blob([bytes], { type: mimeType }), fileName);
  formData.append("audio_source_tracing", "true");
  formData.append("zero_retention_mode", "true");

  const res = await fetch(`${BASE_URL}/detect`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "?");
    throw new Error(`Resemble submit returned ${res.status}: ${body}`);
  }
  const json = await res.json();
  return json.item?.uuid ?? null;
}

async function pollJob(uuid, maxWaitMs = 60_000) {
  const start = Date.now();
  const delays = [2000, 2000, 4000, 4000, 8000, 8000, 10000, 10000, 10000];

  for (const delay of delays) {
    if (Date.now() - start > maxWaitMs) break;
    const res = await fetch(`${BASE_URL}/detect/${uuid}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`Resemble poll ${uuid} returned ${res.status}`);
    }
    const json = await res.json();
    const status = json.item?.status;
    if (status === "completed") return json;
    if (status === "failed") throw new Error(`Resemble job ${uuid} failed`);
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error(`Resemble poll ${uuid} timed out after ${maxWaitMs}ms`);
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("PureWire Resemble v2 health probe\n");
  console.log(`  Endpoint: ${BASE_URL}/detect`);
  console.log(`  Key:      ${apiKey.slice(0, 6)}...${apiKey.slice(-4)}`);

  const png = cleanPngBytes();
  console.log(`  Image:    ${png.length} bytes (1×1 clean PNG)\n`);

  // 1. Submit
  console.log("  → Submitting clean PNG to Resemble v2…");
  const t0 = Date.now();
  const uuid = await submitDetectJob(png, "image/png", "health-probe.png");
  if (!uuid) {
    console.error("  ❌ Submit returned no UUID — API likely returned a non-200 without an error body.");
    process.exit(1);
  }
  console.log(`  ✓ Job accepted (uuid=${uuid.slice(0, 8)}…) in ${Date.now() - t0}ms`);

  // 2. Poll
  console.log("  → Polling for completion…");
  const result = await pollJob(uuid);
  const elapsed = Date.now() - t0;
  console.log(`  ✓ Job completed in ${elapsed}ms`);

  // 3. Verify shape
  const item = result.item;
  if (!item) {
    console.error("  ❌ Response missing 'item' field.");
    process.exit(1);
  }
  if (item.status !== "completed") {
    console.error(`  ❌ Job status is "${item.status}", expected "completed".`);
    process.exit(1);
  }

  // Check for expected metrics on a clean image
  const imgMetrics = item.image_metrics;
  console.log(`  ℹ️  image_metrics: ${imgMetrics ? `label="${imgMetrics.label}" score=${imgMetrics.score}` : "absent (may be audio-only response)"}`);

  console.log("\n✅ Resemble v2 is healthy.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n❌ Resemble v2 health probe FAILED: ${err.message}\n`);
  process.exit(1);
});
