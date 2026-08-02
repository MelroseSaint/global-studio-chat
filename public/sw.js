/**
 * PureWire service worker — offline-capable PWA, no external dependencies.
 *
 * Strategy:
 * - Precaches the app shell (index, manifest, icons) at install time, plus
 *   every hashed JS/CSS chunk listed in /precache-manifest.json (written by
 *   a build-time Vite plugin). That includes the lazy-loaded Admin route, so
 *   the whole app — admin dashboard included — opens without a connection
 *   after install, not only after each route has been visited once.
 * - Navigations are network-first with an offline fallback to the cached
 *   shell, so a fresh deployment is always served when online while the app
 *   still opens without a connection.
 * - Hashed build assets (/assets/*) are immutable, so they are cache-first
 *   with a background refresh — fast loads, no stale UI.
 * - Every other same-origin GET (logos, manifest) is stale-while-revalidate.
 * - Convex API calls (cross-origin POSTs to the backend) are never cached.
 *
 * The cache is versioned; on activate, old versions are purged.
 */

const CACHE = "purewire-v1";

// Cap on cached hashed assets. Each deploy emits new immutable /assets/*
// files, so without eviction the cache would grow without bound.
const MAX_ASSETS = 80;

/** Keep the asset cache bounded by evicting the oldest entries. */
async function pruneAssetCache() {
  const cache = await caches.open(CACHE);
  const keys = await cache.keys();
  const assets = keys.filter((req) =>
    new URL(req.url).pathname.startsWith("/assets/"),
  );
  if (assets.length > MAX_ASSETS) {
    // The Cache API returns keys in insertion order — drop the oldest.
    const stale = assets.slice(0, assets.length - MAX_ASSETS);
    await Promise.all(stale.map((req) => cache.delete(req)));
  }
}

const SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/logo.svg",
  "/favicon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-192.png",
  "/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(async (cache) => {
        // Precache the shell one file at a time: a single missing asset must
        // never fail the whole install and silently disable offline support.
        await Promise.all(
          SHELL.map((url) => cache.add(url).catch(() => {})),
        );
        // Precache every hashed chunk the build emitted (the lazy Admin
        // route included) from the manifest the Vite plugin wrote.
        try {
          const manifest = await fetch("./precache-manifest.json").then((r) =>
            r.json(),
          );
          await Promise.all(
            (manifest.assets ?? []).map((url) =>
              cache.add(url).catch(() => {}),
            ),
          );
        } catch {
          // No manifest (e.g. dev server) — the shell alone is still
          // precached, so offline support degrades rather than breaking.
        }
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Only handle same-origin requests; the Convex backend is cross-origin
  // and must always go to the network.
  if (url.origin !== self.location.origin) return;

  // Navigations: network first, offline fallback to the shell. Only a real
  // page (response.ok) is stored — an error page must never become the
  // offline shell.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches
              .open(CACHE)
              .then((cache) => cache.put("/index.html", copy))
              .catch(() => {});
          }
          return response;
        })
        .catch(() =>
          caches
            .match("/index.html")
            .then((hit) => hit || caches.match("/")),
        ),
    );
    return;
  }

  // Immutable hashed assets: cache-first, refresh in the background, and
  // keep the cache bounded across deployments.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then((hit) => {
        const refresh = fetch(request)
          .then((response) => {
            if (response.ok) {
              caches
                .open(CACHE)
                .then((cache) => cache.put(request, response.clone()))
                .then(() => pruneAssetCache())
                .catch(() => {});
            }
            return response;
          })
          .catch(() => hit);
        return hit || refresh;
      }),
    );
    return;
  }

  // Everything else same-origin: stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            caches
              .open(CACHE)
              .then((cache) => cache.put(request, response.clone()))
              .catch(() => {});
          }
          return response;
        })
        .catch(() => hit);
      return hit || network;
    }),
  );
});
