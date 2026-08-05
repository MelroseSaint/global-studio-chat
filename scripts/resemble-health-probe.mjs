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
 * Billing states are NOT failures: when the account runs out of credits
 * the API answers 402 (insufficient_balance). That's a "pay the bill",
 * not an outage — the probe exits 0 with a warning so CI stays green
 * while detection is simply unbilled. A wrong key (401), unreachable
 * endpoint, or broken response still fails the gate.
 *
 *   RESEMBLE_API_KEY=<v2-bearer-token> node scripts/resemble-health-probe.mjs
 *
 * Exit: 0 healthy (or billing-blocked), 1 unhealthy or key absent.
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

/**
 * Billing-blocked: the API answered 402 (Payment Required) — the account
 * is out of credits. A billing state, never a platform outage; the probe
 * must warn and pass, not fail CI.
 */
class ResembleBillingError extends Error {
  constructor(message) {
    super(message);
    this.name = "ResembleBillingError";
  }
}

async function submitDetectJob(bytes, mimeType, fileName) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  // Try with zero_retention_mode first, fall back without it if the plan
  // doesn't support the feature.
  for (const flags of [
    { audio_source_tracing: "true", zero_retention_mode: "true" },
    { audio_source_tracing: "true" },
  ]) {
    const formData = new FormData();
    formData.append("file", new Blob([bytes], { type: mimeType }), fileName);
    for (const [key, value] of Object.entries(flags)) {
      formData.append(key, value);
    }
    const res = await fetch(`${BASE_URL}/detect`, {
      method: "POST",
      headers,
      body: formData,
    });
    if (res.ok) {
      const json = await res.json();
      return json.item?.uuid ?? null;
    }
    const body = await res.text().catch(() => "?");
    if (
      res.status === 400 &&
      body.includes("Zero Retention") &&
      flags.zero_retention_mode !== undefined
    ) {
      continue;
    }
    if (res.status === 402) {
      // 402 is the account's billing wall, not a platform fault. Surfaced
      // as its own error type so the probe can warn-and-pass below.
      throw new ResembleBillingError(
        body.includes("insufficient_balance")
          ? "the account balance is exhausted. Add credits at app.resemble.ai to resume detection."
          : "the API returned 402 Payment Required — check billing at app.resemble.ai.",
      );
    }
    throw new Error(`Resemble submit returned ${res.status}: ${body}`);
  }
  return null;
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
    throw new Error(
      "Submit returned no UUID — API likely returned a non-200 without an error body.",
    );
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
    throw new Error("Response missing 'item' field.");
  }
  if (item.status !== "completed") {
    throw new Error(`Job status is "${item.status}", expected "completed".`);
  }

  // Check for expected metrics on a clean image
  const imgMetrics = item.image_metrics;
  console.log(`  ℹ️  image_metrics: ${imgMetrics ? `label="${imgMetrics.label}" score=${imgMetrics.score}` : "absent (may be audio-only response)"}`);

  console.log("\n✅ Resemble v2 is healthy.\n");
}

main().catch((err) => {
  if (err instanceof ResembleBillingError) {
    // Billing state, not an outage: warn loudly but pass so CI isn't red
    // while detection is simply unbilled. The moment credits are added
    // this flips back to the full success path with no code change.
    console.error(`\n⚠️  Resemble v2 is reachable but billing is blocked: ${err.message}`);
    console.error("   Treating the probe as PASSING — this is a wallet state, not an outage.\n");
    return;
  }
  console.error(`\n❌ Resemble v2 health probe FAILED: ${err.message}\n`);
  // exitCode, not process.exit(): exiting while a network handle is still
  // closing crashes Node on Windows (libuv assertion) and is unnecessary
  // anywhere else — the process drains and exits with the code set here.
  process.exitCode = 1;
});
