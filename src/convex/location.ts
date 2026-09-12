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
 * Home-location shape: a public label, optionally with coordinates.
 *
 * The coordinates are never the precise point: `updateProfile` runs them
 * through `coarsenLocation` (rounded to a ~1 km grid) before storing, and
 * `publicLocation` strips them from every client response — no surface
 * ever displays or receives them. The coarsened anchor exists only so the
 * Local feed can center itself server-side when live browser geolocation
 * isn't granted. A label-only home location (user typed a place without
 * picking coordinates) is still valid — the feed just can't center on it.
 */
export const homeLocationValidator = v.object({
  latitude: v.optional(v.number()),
  longitude: v.optional(v.number()),
  label: v.optional(v.string()),
});

/** A location whose coordinates may or may not be present. */
export type CoarsenableLocation = {
  latitude?: number;
  longitude?: number;
  label?: string;
};

/**
 * Round coordinates to a ~1 km grid. A stored home anchor is therefore a
 * neighborhood-scale cell — enough to power the Local feed, never enough
 * to point at a door. Applied server-side on every write. Passes through
 * unchanged when coordinates are absent (label-only home location).
 */
export function coarsenLocation(
  location: CoarsenableLocation,
): CoarsenableLocation {
  if (
    typeof location.latitude !== "number" ||
    typeof location.longitude !== "number"
  ) {
    return { label: location.label };
  }
  return {
    latitude: Number(location.latitude.toFixed(2)),
    longitude: Number(location.longitude.toFixed(2)),
    label: location.label,
  };
}


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
