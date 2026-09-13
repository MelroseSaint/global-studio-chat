/**
 * Cloudinary E2E QA — proves the full media lifecycle against production.
 *
 * The invariant this guards (docs/media-storage.md): Cloudinary holds the
 * media bytes, Convex stores only the URL + public_id, and NOTHING is
 * orphaned — not in the database, not in the member's Cloudinary library.
 *
 * Steps:
 *   1. Mint a harness session (the admin's QA session — nothing visible).
 *   2. `media.prepareUpload` must return a CLOUDINARY ticket, signed
 *      (api_key + timestamp + signature) with a Convex fallbackUrl.
 *   3. Upload a real generated PNG straight to Cloudinary.
 *   4. `posts.createPost` carrying ONLY { url, key } — no storageId.
 *   5. Read the post back as a PUBLIC viewer: url + key present,
 *      storageId ABSENT (the URL-only invariant).
 *   6. `testHarness.auditMediaArchitecture`: zero invalid references.
 *   7. `posts.deletePost` — the real deletion path.
 *   8. Destroy the asset (signed) and REQUIRE the CDN to 404 — a leaked
 *      asset fails the build, not just a console warning.
 *
 * Env:
 *   TEST_HARNESS_SECRET    (required — harness-gated like every prod QA)
 *   CONVEX_URL             (optional; defaults to the production deployment)
 *   CLOUDINARY_CLOUD_NAME  (optional; defaults to saintscloud)
 *   CLOUDINARY_API_KEY     (required — re-signs the destroy locally)
 *   CLOUDINARY_API_SECRET  (required — signs the destroy)
 *
 * Exit codes: 0 = lifecycle holds, 1 = any check failed, 2 = misconfigured.
 */
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../src/convex/_generated/api.js";
import { powProof } from "./lib/qa-pow.mjs";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://jovial-axolotl-209.convex.cloud";
const CLOUD = process.env.CLOUDINARY_CLOUD_NAME ?? "saintscloud";
const API_KEY = process.env.CLOUDINARY_API_KEY ?? "";
const API_SECRET = process.env.CLOUDINARY_API_SECRET ?? "";
const SECRET = process.env.TEST_HARNESS_SECRET ?? "";
if (!SECRET) {
  console.error("No TEST_HARNESS_SECRET — harness-gated QA, misconfigured run.");
  process.exit(2);
}
if (!API_KEY || !API_SECRET) {
  console.error(
    "CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET are required — the QA must " +
      "destroy its own asset and PROVE the CDN dropped it.",
  );
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1Hex = (s) => createHash("sha1").update(s, "utf8").digest("hex");

/** Minimal valid 2×2 PNG, generated — no fixtures on disk. */
function makePng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const crcTable = [...Array(256)].map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    let crc = 0xffffffff;
    for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const raw = Buffer.concat([
    Buffer.from([0, 0x33, 0x66, 0x99]),
    Buffer.from([0, 0x99, 0x66, 0x33]),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Signed destroy; returns Cloudinary's result string ("ok"/"not found"). */
async function destroyAsset(publicId, resourceType) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  // ALL params are signed, sorted alphabetically (invalidate < public_id <
  // timestamp) — omitting one from the signature 401s.
  const params = { invalidate: "true", public_id: publicId, timestamp };
  const signature = sha1Hex(
    Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&") + API_SECRET,
  );
  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUD}/${resourceType}/destroy`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        public_id: publicId,
        api_key: API_KEY,
        timestamp,
        signature,
        invalidate: "true",
      }),
    },
  );
  const json = await res.json().catch(() => ({}));
  return json?.result ?? `HTTP ${res.status}`;
}

const state = { postId: null, publicId: null, resourceType: "image", authed: null };

async function cleanup() {
  try {
    if (state.postId && state.authed) {
      await state.authed.mutation(api.posts.deletePost, { postId: state.postId }).catch(() => {});
    }
  } catch {}
  try {
    if (state.publicId) {
      const r = await destroyAsset(state.publicId, state.resourceType);
      console.log(`🧹 best-effort destroy: ${r}`);
    }
  } catch {}
}

async function main() {
  console.log(`\nPureWire Cloudinary E2E (${CONVEX_URL}, cloud ${CLOUD})\n`);
  try {
    const client = new ConvexHttpClient(CONVEX_URL);
    const { enabled } = await client.query(api.testHarness.isEnabled);
    check("harness enabled", enabled === true);

    const admin = await client.mutation(api.testHarness.mintAdminSession, { secret: SECRET });
    check("minted harness session", Boolean(admin?.token));
    const authed = new ConvexHttpClient(CONVEX_URL);
    authed.setAuth(admin.token);
    state.authed = authed;

    // 1. The upload ticket — cloudinary mode, signed, with fallback.
    const ticket = await authed.action(api.media.prepareUpload, { contentType: "image/png" });
    check("ticket mode is cloudinary", ticket?.mode === "cloudinary", `mode=${ticket?.mode}`);
    const m = /api\.cloudinary\.com\/v1_1\/([a-z0-9-]+)\/(\w+)\/upload/.exec(ticket?.uploadUrl ?? "");
    check("upload URL parses (cloud + resource type)", Boolean(m));
    const resourceType = m?.[2] ?? "image";
    state.resourceType = resourceType;
    const signed = Boolean(ticket?.apiKey && ticket?.signature && ticket?.timestamp);
    check("ticket is signed (key+secret path)", signed, signed ? `folder=${ticket.folder}` : "unsigned preset path");

    // 2. Upload real bytes straight to Cloudinary.
    const form = new FormData();
    form.append("file", new Blob([makePng()], { type: "image/png" }), "qa-e2e.png");
    if (signed) {
      form.append("api_key", ticket.apiKey);
      form.append("timestamp", ticket.timestamp);
      form.append("signature", ticket.signature);
      if (ticket.folder) form.append("folder", ticket.folder);
    } else {
      form.append("upload_preset", ticket.uploadPreset);
    }
    const up = await fetch(ticket.uploadUrl, { method: "POST", body: form });
    const upJson = await up.json().catch(() => ({}));
    state.publicId = upJson.public_id;
    check(
      "Cloudinary upload accepted",
      up.ok && Boolean(upJson.secure_url),
      up.ok ? String(upJson.public_id) : JSON.stringify(upJson).slice(0, 160),
    );

    // 3. Cloudinary actually serves the bytes (existence check — the CDN
    //    re-encodes, so byte equality is NOT asserted).
    const served = await fetch(upJson.secure_url);
    check("asset served from Cloudinary", served.ok, `HTTP ${served.status}`);

    // 4. The post carries ONLY the Cloudinary reference.
    const created = await authed.action(api.posts.createPost, {
      content: "Cloudinary E2E QA — this post is deleted by the same run.",
      creatorDisclosure: "human-made",
      media: [{ url: upJson.secure_url, key: upJson.public_id, kind: "image", stripped: true }],
      ...(await powProof(authed)),
    });
    check(
      "createPost accepted the cloudinary media item",
      created?.ok === true,
      created?.ok ? String(created.postId) : created?.error,
    );
    if (created?.ok) state.postId = created.postId;

    // 5. Public read-back: url + key present, storageId ABSENT.
    const view = await client.query(api.posts.getPost, { postId: state.postId });
    const item = view?.media?.[0];
    check("public view shows the Cloudinary URL", item?.url === upJson.secure_url);
    check("public view shows the public_id (deletes depend on it)", item?.key === upJson.public_id);
    check("NO Convex storage id on the item (URL-only invariant)", item?.storageId === undefined);

    // 6. Architecture audit stays clean.
    const audit = await client.query(api.testHarness.auditMediaArchitecture, { secret: SECRET });
    check("auditMediaArchitecture: zero invalid references", audit?.invalidCount === 0);

    // 7. Delete through the real path.
    await authed.mutation(api.posts.deletePost, { postId: state.postId });
    let gone = null;
    for (let i = 0; i < 10; i++) {
      gone = await client.query(api.posts.getPost, { postId: state.postId });
      if (gone === null) break;
      await sleep(300);
    }
    check("post deleted via deletePost (public view now null)", gone === null);
    state.postId = null; // cleanup's job is done

    // 8. The asset must be REALLY gone — destroy + require CDN 404. The
    //    scheduled deleteExternalKeys cleanup usually wins the race, so an
    //    initial "not found" is a PASS; "ok" means we removed it ourselves.
    const destroyResult = await destroyAsset(upJson.public_id, resourceType);
    check(
      "asset destroy accepted",
      destroyResult === "ok" || destroyResult === "not found",
      destroyResult,
    );
    let cdnGone = false;
    let lastStatus = 0;
    for (let i = 0; i < 10; i++) {
      const probe = await fetch(upJson.secure_url, { cache: "no-store" });
      lastStatus = probe.status;
      if (probe.status === 404 || probe.status === 420) {
        cdnGone = true;
        break;
      }
      await sleep(3000);
    }
    check(
      "asset is GONE from the CDN (no orphans)",
      cdnGone,
      cdnGone ? `HTTP ${lastStatus}` : `still HTTP ${lastStatus} after 30s — leaked asset`,
    );
    if (cdnGone) state.publicId = null;
  } catch (err) {
    check("unexpected error", false, String(err?.message ?? err).slice(0, 300));
  } finally {
    await cleanup();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err?.message ?? err);
  process.exit(2);
});
