/**
 * External media storage for PureWire — Cloudinary.
 *
 * Media bytes live in the member's Cloudinary account (cloud name
 * `saintscloud` in production) and Convex stores only a tiny URL plus the
 * asset's public_id. Thousands of uploads then cost nothing against
 * Convex's file-storage quota.
 *
 * The pipeline is dual-mode on purpose:
 *
 *   - When the CLOUDINARY_* env vars are configured, the browser uploads
 *     straight to Cloudinary using an unsigned upload preset (`prepareUpload`
 *     in media.ts returns the upload URL + preset name), and every media item
 *     on a post/story/profile carries an external `url` (secure_url) and
 *     `key` (public_id, used for deletions) instead of a Convex storage id.
 *   - When they are absent, media falls back to Convex's built-in storage
 *     exactly as before, so production keeps working unchanged until the
 *     vars are set.
 *
 * Env vars (set via `npx convex env set`):
 *   CLOUDINARY_CLOUD_NAME        your cloud name (e.g. saintscloud)
 *   CLOUDINARY_UPLOAD_PRESET     an UNSIGNED upload preset (dashboard:
 *                                Settings → Upload → Upload presets →
 *                                Add preset → Signing mode: Unsigned)
 *   CLOUDINARY_API_KEY           API key (for signed deletes + re-uploads)
 *   CLOUDINARY_API_SECRET        API secret (never sent to the browser)
 *
 * Privacy stays whole: uploads are still re-encoded in the browser (GPS
 * and device metadata stripped) before they leave the client, and the
 * server-side video remux still overwrites any pass-through clip.
 */
import { getAuthUserId } from "@convex-dev/auth/server";

import { v } from "convex/values";

import {
  internalAction,
  internalMutation,
} from "./_generated/server";

import type { Id } from "./_generated/dataModel";

/**
 * Auth + status + budget gate for uploads. Lives in this module (not in
 * media.ts) so the `prepareUpload` action there can call it via the
 * `internal` namespace without a circular type reference — an action may
 * not call an internal function defined in its own file.
 *
 * The account-status and upload-budget checks are inlined here (mirroring
 * security.ts's `enforceActive`/`enforceRateLimit`) rather than imported:
 * this module must stay free of the generated `internal` api namespace so
 * the action's inferred return type never resolves back through it — a
 * module that imports the api namespace pulls in `typeof media` (via the
 * generated bindings), which includes `prepareUpload` itself, closing a
 * circular type reference.
 */
export const uploadSlot = internalMutation({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    const user = await ctx.db.get(userId);
    if (user?.accountStatus === "banned") {
      throw new Error(
        "This account has been banned for violating the PureWire Standard.",
      );
    }
    if (user?.accountStatus === "restricted") {
      throw new Error(
        "This account is restricted pending review. Contact Support if this looks like a mistake.",
      );
    }
    // Upload URL minting is a public-ish surface used for bulk media
    // collection — budget it (200/hour, rolling window, same as the
    // security module) so scraping tools can't mint unlimited upload
    // tickets to fill PureWire's storage.
    const now = Date.now();
    const rows = await ctx.db
      .query("rateLimits")
      .withIndex("by_user_action", (q) =>
        q.eq("userId", userId as Id<"users">).eq("action", "upload"),
      )
      .collect();
    const recent = rows.filter((r) => r.windowStart >= now - 60 * 60_000);
    if (recent.length >= 200) {
      throw new Error(
        "You're moving a little too fast. Slow down and try again in a moment.",
      );
    }
    await ctx.db.insert("rateLimits", {
      userId,
      action: "upload",
      windowStart: now,
    });
    const convexUrl = await ctx.storage.generateUploadUrl();
    return { userId, convexUrl };
  },
});

export interface CloudinaryConfig {
  cloudName: string;
  uploadPreset: string;
  apiKey?: string;
  apiSecret?: string;
}

/** Read the Cloudinary config from the environment. Null when not configured. */
export function cloudinaryConfig(): CloudinaryConfig | null {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET;
  if (!cloudName || !uploadPreset) {
    return null;
  }
  return {
    cloudName,
    uploadPreset,
    apiKey: process.env.CLOUDINARY_API_KEY || undefined,
    apiSecret: process.env.CLOUDINARY_API_SECRET || undefined,
  };
}

/**
 * Cloudinary resource type for a media kind. Audio rides the `video`
 * resource type — Cloudinary streams audio containers the same way.
 */
export function resourceTypeFor(
  kind: "image" | "video" | "audio",
): string {
  return kind === "image" ? "image" : "video";
}

/** Cloudinary resource type for an upload content type. */
export function resourceTypeForContentType(contentType: string): string {
  return contentType.startsWith("image/") ? "image" : "video";
}

/** The upload endpoint the browser POSTs the file + preset to. */
export function uploadUrlFor(
  cfg: CloudinaryConfig,
  resourceType: string,
): string {
  return `https://api.cloudinary.com/v1_1/${cfg.cloudName}/${resourceType}/upload`;
}

/**
 * Pure-JS SHA-1 hex digest. Cloudinary signs every server request with
 * SHA-1 over the sorted request parameters. Convex mutations run in a
 * deterministic V8 isolate that strips crypto.subtle and TextEncoder, so
 * this implementation uses nothing beyond plain numbers, Uint8Array, and
 * bitwise operators — matching the pure-JS SHA-256 precedent in privacy.ts.
 */
export function sha1Hex(input: string): string {
  // UTF-8 encode (no TextEncoder dependency).
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    // Surrogate pair → 4-byte sequence (U+10000..U+10FFFF).
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < input.length) {
      const lo = input.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        i++;
        const cp = 0x10000 + ((c & 0x3ff) << 10) + (lo & 0x3ff);
        bytes.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f),
        );
        continue;
      }
      // Lone high surrogate: encode it as a 3-byte sequence (lossy but
      // deterministic; never produced by valid input in practice).
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      continue;
    }
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const lenHi = Math.floor(bitLen / 0x100000000);
  const lenLo = bitLen >>> 0;
  bytes.push(
    (lenHi >>> 24) & 0xff,
    (lenHi >>> 16) & 0xff,
    (lenHi >>> 8) & 0xff,
    lenHi & 0xff,
    (lenLo >>> 24) & 0xff,
    (lenLo >>> 16) & 0xff,
    (lenLo >>> 8) & 0xff,
    lenLo & 0xff,
  );
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Array<number>(80);
  for (let i = 0; i < bytes.length; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] =
        ((bytes[i + t * 4] << 24) |
          (bytes[i + t * 4 + 1] << 16) |
          (bytes[i + t * 4 + 2] << 8) |
          bytes[i + t * 4 + 3]) >>>
        0;
    }
    for (let t = 16; t < 80; t++) {
      const n = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
      w[t] = ((n << 1) | (n >>> 31)) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let t = 0; t < 80; t++) {
      let f: number;
      let k: number;
      if (t < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (t < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4]
    .map((h) => h.toString(16).padStart(8, "0"))
    .join("");
}

/**
 * Cloudinary request signature: SHA-1 over the sorted request parameters
 * (all except cloud_name / resource_type / api_key / signature / file)
 * joined `key=value&key=value` with the api_secret appended.
 */
function cloudinarySignature(
  apiSecret: string,
  params: Record<string, string>,
): string {
  const sorted = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return sha1Hex(sorted + apiSecret);
}

/**
 * Fire-and-forget delete of Cloudinary assets. Scheduled after documents
 * are removed so the row write never depends on Cloudinary availability; a
 * failed delete simply leaves an orphan asset (cheap, and re-runnable).
 * Requires the API key + secret (signed requests); without them the delete
 * is skipped rather than failing the caller. Lives in this module so the
 * cleanup helpers in mediaCleanup.ts can schedule it via
 * `internal.mediaStorage` without a circular type reference.
 */
export const deleteExternalKeys = internalAction({
  args: {
    keys: v.array(
      v.object({
        key: v.string(),
        resourceType: v.string(),
      }),
    ),
  },
  handler: async (_ctx, { keys }) => {
    const cfg = cloudinaryConfig();
    if (
      cfg === null ||
      cfg.apiKey === undefined ||
      cfg.apiSecret === undefined ||
      keys.length === 0
    ) {
      return;
    }
    for (const { key, resourceType } of keys) {
      try {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = cloudinarySignature(cfg.apiSecret, {
          public_id: key,
          timestamp,
          invalidate: "true",
        });
        const form = new FormData();
        form.append("public_id", key);
        form.append("timestamp", timestamp);
        form.append("invalidate", "true");
        form.append("api_key", cfg.apiKey);
        form.append("signature", signature);
        const res = await fetch(
          `https://api.cloudinary.com/v1_1/${cfg.cloudName}/${resourceType}/destroy`,
          { method: "POST", body: form },
        );
        // Non-2xx leaves an orphaned asset (harmless and cheap); the caller
        // already committed, so never throw here.
        void res;
      } catch {
        // Best-effort: never fail the caller over a storage delete.
      }
    }
  },
});

/**
 * Server-side signed upload that overwrites an existing asset under the
 * SAME public_id (used by the video remux to replace a cleaned clip — the
 * URL never changes). Returns true when the overwrite actually succeeded,
 * so the caller only claims "metadata stripped" when the object really was
 * replaced. Requires the API key + secret.
 */
export async function uploadOverwriteBytes(
  cfg: CloudinaryConfig,
  key: string,
  resourceType: string,
  contentType: string,
  bytes: Uint8Array,
): Promise<boolean> {
  if (cfg.apiKey === undefined || cfg.apiSecret === undefined) {
    return false;
  }
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = cloudinarySignature(cfg.apiSecret, {
    invalidate: "true",
    overwrite: "true",
    public_id: key,
    timestamp,
  });
  const form = new FormData();
  // .slice() copies into a fresh ArrayBuffer-backed Uint8Array, which TS
  // types as Uint8Array<ArrayBuffer> and is assignable to BlobPart.
  form.append(
    "file",
    new Blob([bytes.slice()], { type: contentType }),
    "clean.mp4",
  );
  form.append("public_id", key);
  form.append("overwrite", "true");
  form.append("invalidate", "true");
  form.append("api_key", cfg.apiKey);
  form.append("timestamp", timestamp);
  form.append("signature", signature);
  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${cfg.cloudName}/${resourceType}/upload`,
    { method: "POST", body: form },
  );
  return res.ok;
}

/**
 * Derive a Cloudinary public_id from a stored secure URL (for deletions),
 * or null when it can't be parsed. URLs we store look like
 * `https://res.cloudinary.com/{cloud}/{type}/upload/v{version}/{public_id}.{ext}`
 * — the version segment and trailing extension are stripped. Items created
 * through the app always store `key` (public_id) explicitly, so this is
 * only a fallback for legacy rows.
 */
export function keyFromPublicUrl(url: string): string | null {
  const cfg = cloudinaryConfig();
  if (cfg === null) {
    return null;
  }
  const marker = `/${cfg.cloudName}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) {
    return null;
  }
  // e.g. "image/upload/v123456/folder/abc123.jpg"
  const rest = url.slice(idx + marker.length);
  const parts = rest.split("/");
  if (parts.length < 3) {
    return null;
  }
  // Drop the resource type + delivery type ("image/upload/"), then the
  // leading version segment ("v123456/").
  let path = parts.slice(2).join("/").replace(/^v\d+\//, "");
  if (path.length === 0) {
    return null;
  }
  const dot = path.lastIndexOf(".");
  if (dot > 0) {
    path = path.slice(0, dot);
  }
  return path.length > 0 ? path : null;
}
