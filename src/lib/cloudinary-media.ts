/**
 * Responsive Cloudinary media delivery.
 *
 * Media bytes never live in Convex — the browser uploads straight to
 * Cloudinary and posts store only the URL (+ public_id for deletion). This
 * module makes that delivery fast: Cloudinary re-encodes on the fly from
 * the URL, so every render can ask for the exact width it needs
 * (`f_auto,q_auto,w_640`) instead of shipping the original full-resolution
 * file to every screen. Non-Cloudinary URLs (the Convex-storage fallback)
 * pass through untouched.
 *
 * URL shapes (unsigned upload):
 *   https://res.cloudinary.com/<cloud>/image/upload/v<ts>/<public_id>
 *   https://res.cloudinary.com/<cloud>/video/upload/v<ts>/<public_id>
 * The transformation chain is injected between the resource type and the
 * version segment.
 */

// Captures the scheme+host+`/image/upload/` prefix and the version tail.
const IMAGE_RESOURCE_RE =
  /^(https?:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.*)$/;
const VIDEO_RESOURCE_RE =
  /^(https?:\/\/res\.cloudinary\.com\/[^/]+\/video\/upload\/)(.*)$/;

/** True for a Cloudinary image URL that can be transformed. */
export function isCloudinaryImageUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && IMAGE_RESOURCE_RE.test(url);
}

/** True for a Cloudinary video/audio URL (audio rides the video resource). */
export function isCloudinaryVideoUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && VIDEO_RESOURCE_RE.test(url);
}

/**
 * The public_id tail (`v<ts>/<id>`) is untransformed only when it starts
 * with a version segment — the shape unsigned uploads produce. If a URL
 * already carries a transformation chain, leave it alone.
 */
function untransformedTail(tail: string): boolean {
  return /^v\d+\//.test(tail);
}

/**
 * A Cloudinary image URL at the given width (auto format + quality, so the
 * CDN serves WebP/AVIF at the right compression). Non-Cloudinary URLs are
 * returned unchanged.
 */
export function cloudinaryImageUrl(
  url: string | null | undefined,
  width?: number,
): string | null | undefined {
  if (!isCloudinaryImageUrl(url)) return url;
  const m = IMAGE_RESOURCE_RE.exec(url as string);
  if (!m || !untransformedTail(m[2])) return url;
  const chain = `f_auto,q_auto${width !== undefined ? `,w_${width}` : ""}`;
  return `${m[1]}${chain}/${m[2]}`;
}

/**
 * A Cloudinary video/audio URL with auto quality (bandwidth savings; the
 * width is left to the player). Non-Cloudinary URLs pass through.
 */
export function cloudinaryVideoUrl(
  url: string | null | undefined,
): string | null | undefined {
  if (!isCloudinaryVideoUrl(url)) return url;
  const m = VIDEO_RESOURCE_RE.exec(url as string);
  if (!m || !untransformedTail(m[2])) return url;
  return `${m[1]}q_auto/${m[2]}`;
}

/**
 * The attribute set for a responsive <img>: a transformed src plus a
 * srcSet across common viewport widths. Convex-storage fallback URLs get
 * plain `src` only.
 *
 * `sizes` MUST describe the real rendered width or the browser will pick a
 * candidate that is far too large — a feed-column image rendered at ~600px
 * that advertises `100vw` downloads the biggest candidate on desktop, and
 * a DPR-3 phone asking for 1125px would grab a 1600px image for a ~350px
 * slot. Defaults to `100vw` (correct for the fullscreen story viewer);
 * call sites pass honest values for smaller slots. The candidate list caps
 * at 1280 because no render slot in the app is wider than ~640 CSS px (the
 * max the 1280 candidate covers at DPR 2) — nothing ever needs a 1600px
 * download.
 */
export function responsiveImageAttrs(
  url: string | null | undefined,
  sizes = "100vw",
): {
  src?: string;
  srcSet?: string;
  sizes?: string;
} {
  if (!isCloudinaryImageUrl(url)) {
    return { src: url ?? undefined };
  }
  const widths = [320, 480, 640, 960, 1280];
  const srcSet = widths
    .map((w) => `${cloudinaryImageUrl(url, w)} ${w}w`)
    .join(", ");
  return { src: cloudinaryImageUrl(url, 960) ?? undefined, srcSet, sizes };
}
