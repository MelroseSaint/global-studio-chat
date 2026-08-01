import { v } from "convex/values";

/**
 * Optional location attached to a post or a profile's home location.
 * `label` is an optional human-readable place name the user typed.
 */
export const locationValidator = v.object({
  latitude: v.number(),
  longitude: v.number(),
  label: v.optional(v.string()),
});

export type LocationDoc = {
  latitude: number;
  longitude: number;
  label?: string;
};

/**
 * Home-location shape: a public label only.
 *
 * Coordinates get the exact treatment plain-text email does: they are never
 * stored on the profile. The Local feed anchors on the viewer's ephemeral
 * browser location — used to build one request, never saved — so a home
 * location needs nothing but the label the user chose to show publicly.
 */
export const homeLocationValidator = v.object({
  label: v.optional(v.string()),
});



/**
 * Approximate bounding box around (lat, lng) covering `radiusKm`.
 *
 * Uses a flat-earth approximation — fine for the Local feed's range
 * (kilometers to a few hundred kilometers): 1° latitude ≈ 111.32 km and
 * 1° longitude ≈ 111.32 × cos(lat) km. The box is square in degrees, so
 * corner posts are slightly beyond the radius; that is acceptable for a
 * "nearby" filter, and the exact distance is never promised in the UI.
 */
export function boundingBox(
  latitude: number,
  longitude: number,
  radiusKm: number,
): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  const dLat = radiusKm / 111.32;
  const dLng = radiusKm / (111.32 * Math.max(0.01, Math.cos((latitude * Math.PI) / 180)));
  return {
    minLat: latitude - dLat,
    maxLat: latitude + dLat,
    minLng: longitude - dLng,
    maxLng: longitude + dLng,
  };
}

/** Validate a plain-text location label before it is stored. */
export function cleanLocationLabel(label: string | undefined): string | undefined {
  const trimmed = label?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, 60);
}

/**
 * True when coordinates are finite and inside the valid range. Called
 * server-side before storing, so garbage coordinates never reach the table.
 */
export function isValidLocation(location: {
  latitude: number;
  longitude: number;
}): boolean {
  return (
    Number.isFinite(location.latitude) &&
    Number.isFinite(location.longitude) &&
    Math.abs(location.latitude) <= 90 &&
    Math.abs(location.longitude) <= 180
  );
}
