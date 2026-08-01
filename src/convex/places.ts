import { v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import { cleanLocationLabel, coarsenLocation } from "./location";
import { mutation } from "./_generated/server";

/**
 * Server-side place search for the location picker.
 *
 * The browser never talks to a third-party geocoder: every search and
 * reverse-geocode runs inside PureWire's backend against Nominatim
 * (OpenStreetMap), and results are cached per query for a week so repeated
 * lookups never hit the geocoder again. Coordinates returned to the client
 * are already coarsened to a ~1 km cell (`coarsenLocation`) — the same
 * treatment they get on every stored write — so no precise point ever
 * leaves the server.
 *
 * These are mutations (not actions) so the cache read/write happens
 * directly on `ctx.db` with no internal-function indirection — the same
 * fetch-inside-mutation pattern the URL previews use (see links.ts).
 */

const SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const USER_AGENT = "PureWire/1.0 (https://purewire.com)";

/** Search for places by name; returns coarsened coordinates + clean labels. */
export const searchPlaces = mutation({
  args: { query: v.string() },
  returns: v.array(
    v.object({
      label: v.string(),
      latitude: v.number(),
      longitude: v.number(),
    }),
  ),
  handler: async (ctx, { query }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    const q = query.trim().toLowerCase();
    if (q.length < 2) {
      return [];
    }
    const cacheKey = q.slice(0, 100);
    const cached = await ctx.db
      .query("placeCache")
      .withIndex("by_query", (q) => q.eq("query", cacheKey))
      .first();
    if (cached !== null && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.results;
    }
    try {
      const url = `${SEARCH_URL}?format=json&limit=6&q=${encodeURIComponent(query.trim())}`;
      const res = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        return [];
      }
      const data = (await res.json()) as Array<{
        display_name?: string;
        lat?: string;
        lon?: string;
      }>;
      const results = data
        .map((row) => {
          const latitude = Number(row.lat);
          const longitude = Number(row.lon);
          const label = cleanLocationLabel(row.display_name);
          if (!label || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            return null;
          }
          return coarsenLocation({ latitude, longitude, label });
        })
        .filter((r): r is { label: string; latitude: number; longitude: number } =>
          r !== null,
        );
      // Don't cache empty result sets: a transient geocoder hiccup that
      // returns zero rows must not block real results for a week.
      if (results.length > 0) {
        const payload = { query: cacheKey, results, fetchedAt: Date.now() };
        if (cached !== null) {
          await ctx.db.patch(cached._id, payload);
        } else {
          await ctx.db.insert("placeCache", payload);
        }
      }
      return results;
    } catch {
      return [];
    }
  },
});

/**
 * Turn coordinates into a place label ("my current location"). The label is
 * cached under the coarsened cell, so nearby positions share one entry and
 * never re-hit the geocoder. Returns the coarsened anchor + label.
 */
export const reverseGeocode = mutation({
  args: { latitude: v.number(), longitude: v.number() },
  returns: v.union(
    v.null(),
    v.object({
      label: v.string(),
      latitude: v.number(),
      longitude: v.number(),
    }),
  ),
  handler: async (ctx, { latitude, longitude }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return null;
    }
    const coarse = coarsenLocation({ latitude, longitude });
    if (typeof coarse.latitude !== "number" || typeof coarse.longitude !== "number") {
      return null;
    }
    const cacheKey = `rev:${coarse.latitude},${coarse.longitude}`;
    const cached = await ctx.db
      .query("placeCache")
      .withIndex("by_query", (q) => q.eq("query", cacheKey))
      .first();
    if (cached !== null && cached.results.length > 0 && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.results[0];
    }
    try {
      const url = `${REVERSE_URL}?format=json&lat=${latitude}&lon=${longitude}&zoom=12`;
      const res = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        return null;
      }
      const data = (await res.json()) as { display_name?: string };
      const label = cleanLocationLabel(data.display_name);
      if (!label) {
        return null;
      }
      const result = { label, latitude: coarse.latitude, longitude: coarse.longitude };
      const payload = { query: cacheKey, results: [result], fetchedAt: Date.now() };
      if (cached !== null) {
        await ctx.db.patch(cached._id, payload);
      } else {
        await ctx.db.insert("placeCache", payload);
      }
      return result;
    } catch {
      return null;
    }
  },
});
