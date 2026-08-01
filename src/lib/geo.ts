/**
 * Browser geolocation helpers for the Local feed.
 *
 * Geolocation is always opt-in: the browser asks the user before any
 * coordinates leave the device, and PureWire never stores the viewer's
 * position — it is only used to build the current Local feed request.
 */

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/** Ask the browser for the current position (user must grant permission). */
export function getBrowserLocation(): Promise<GeoPoint | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 },
    );
  });
}
