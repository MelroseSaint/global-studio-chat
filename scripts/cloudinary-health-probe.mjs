#!/usr/bin/env node
/**
 * PureWire Cloudinary health probe.
 *
 * Proves the SIGNED upload path actually works, end-to-end — the exact
 * path the browser uses for real uploads (the composer mints a server-side
 * signature, no unsigned preset):
 *
 *   1. Uploads a tiny 1x1 PNG to Cloudinary with a freshly-minted
 *      signature from CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET.
 *   2. If the upload succeeds, the probe asset is destroyed immediately via
 *      a signed destroy call so nothing is left behind in the media library.
 *
 * This is the earliest possible detection of the failure that otherwise
 * silently breaks every user upload: a revoked API key, an API key whose
 * permission set lacks Upload/create (returns `403 missing permissions`),
 * an account suspension, or a quota block.
 *
 * Env:
 *   CLOUDINARY_CLOUD_NAME      (required; production: saintscloud)
 *   CLOUDINARY_API_KEY         (required — signs the upload AND cleans up)
 *   CLOUDINARY_API_SECRET      (required — signs the upload AND cleans up)
 *
 * Exit codes: 0 = uploads healthy, 1 = uploads broken or not cleanable
 * (alert), 2 = config missing (misconfigured run, treated as an alert too).
 */
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

const CLOUD = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;

/** Tiny 1x1 PNG so the probe exercises the real upload pipeline. */
function makeProbePng() {
  const size = 8;
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 3)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const p = y * (1 + size * 3) + 1 + x * 3;
      raw[p] = 180; // Oxide
      raw[p + 1] = 74;
      raw[p + 2] = 50;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const crc32 = (buf) => {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Raw SHA-1 hex (node:crypto) for the signed destroy. */
function sha1Hex(input) {
  return createHash("sha1").update(input, "utf8").digest("hex");
}

async function main() {
  if (!CLOUD || !API_KEY || !API_SECRET) {
    console.error(
      "Cloudinary health probe: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY " +
        "and CLOUDINARY_API_SECRET are required (the app signs uploads with " +
        "the API key + secret; there is no unsigned preset path anymore).",
    );
    process.exit(2);
  }
  console.log(
    `Cloudinary health probe: cloud=${CLOUD} signed upload with api_key=${API_KEY.slice(0, 4)}…`,
  );

  // 1. The upload itself — signed, exactly like the composer's server-minted
  //    signature (params sorted, joined `k=v&k=v`, SHA-1 with the secret).
  const timestamp = String(Math.floor(Date.now() / 1000));
  const uploadParams = { timestamp, folder: "qa-probe" };
  const signature = sha1Hex(
    Object.keys(uploadParams)
      .sort()
      .map((k) => `${k}=${uploadParams[k]}`)
      .join("&") + API_SECRET,
  );
  const form = new FormData();
  form.append("file", new Blob([makeProbePng()], { type: "image/png" }), "health-probe.png");
  form.append("timestamp", timestamp);
  form.append("folder", uploadParams.folder);
  form.append("api_key", API_KEY);
  form.append("signature", signature);
  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`,
    { method: "POST", body: form },
  );
  const bodyText = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const message = parsed?.error?.message ?? bodyText.slice(0, 200);
    const hint = /missing permissions/i.test(message)
      ? " — the API key lacks the Upload/create permission in the Cloudinary dashboard (Settings → Access Keys → edit the key → enable Upload). This is a console setting, not a code issue."
      : "";
    console.error(`FAIL: Cloudinary upload rejected (HTTP ${res.status}): ${message}${hint}`);
    process.exit(1);
  }

  const publicId = parsed?.public_id;
  console.log(`OK: signed upload succeeded (public_id: ${publicId})`);

  // 2. Cleanup — destroy the probe asset so the media library stays clean.
  if (publicId && API_KEY && API_SECRET) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const params = { public_id: publicId, timestamp, invalidate: "true" };
    const signature = sha1Hex(
      Object.keys(params)
        .sort()
        .map((k) => `${k}=${params[k]}`)
        .join("&") + API_SECRET,
    );
    const del = new FormData();
    del.append("public_id", publicId);
    del.append("timestamp", timestamp);
    del.append("invalidate", "true");
    del.append("api_key", API_KEY);
    del.append("signature", signature);
    const dres = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUD}/image/destroy`,
      { method: "POST", body: del },
    );
    const dbody = await dres.text();
    let dresult = null;
    try {
      dresult = JSON.parse(dbody).result;
    } catch {
      dresult = null;
    }
    // Cloudinary destroy returns {"result":"ok"} when the asset existed
    // and was deleted, and {"result":"not found"} when it was already
    // gone — both mean the media library is clean.
    if (dres.ok && (dresult === "ok" || dresult === "not found")) {
      console.log(`OK: probe asset destroyed (${publicId})`);
    } else {
      console.error(
        `FAIL: probe asset ${publicId} could not be destroyed ` +
          `(HTTP ${dres.status} ${dbody.slice(0, 120)}).`,
      );
      process.exit(1);
    }
  } else if (publicId) {
    // A probe that cannot clean up after itself would orphan one tiny PNG
    // per nightly run. That must surface as an alert, not a silent leak.
    console.error(
      "FAIL: upload succeeded but CLOUDINARY_API_KEY / " +
        "CLOUDINARY_API_SECRET are not set, so the probe asset " +
        `${publicId} cannot be destroyed. Set the secrets so nightly runs ` +
        "never leak assets.",
    );
    process.exit(1);
  }

  console.log("Cloudinary uploads healthy.");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL: Cloudinary health probe crashed:", e.message);
  process.exit(1);
});
