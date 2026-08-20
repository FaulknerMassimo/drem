/*
 * drem's service worker.
 *
 * It exists for one reason: so that opening the capture screen with no signal
 * still gives you somewhere to type. Nothing else about this app benefits from
 * working offline — you cannot read an encrypted journal without a server to
 * decrypt it, and pretending otherwise would mean caching decrypted dreams on
 * disk, which is the exact thing the whole architecture refuses to do.
 *
 * So the caching rule here is a whitelist, not a strategy, and it is the most
 * important line in the file:
 *
 *   **Only the empty capture shell and the build's static assets are ever
 *   stored. No other page is touched.**
 *
 * Every other route renders plaintext — the journal, a night, a search result,
 * an insight — and a cached copy of any of them would be a plaintext copy of
 * the journal sitting in the browser's cache directory, surviving lock,
 * logout, and the process restart that is supposed to end every session. Those
 * requests are passed straight through without a `respondWith`, so this worker
 * never even sees their bodies.
 *
 * Written as plain JavaScript in `public/` rather than compiled: it must be
 * servable at the origin root to control the whole scope, it has no imports,
 * and a build step for forty lines would only add a way for the shipped file
 * to differ from the one in the repository.
 */

const VERSION = "v1";
const SHELL_CACHE = `drem-shell-${VERSION}`;

/** The only page this worker will keep a copy of. */
const CAPTURE_PATH = "/capture";

/** Static files by exact path. Everything else must be under /_next/static/. */
const PUBLIC_ASSETS = new Set([
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
  "/favicon.png",
  "/manifest.webmanifest",
]);

self.addEventListener("install", (event) => {
  // The shell cannot be precached: it is server-rendered per session, so there
  // is nothing meaningful to fetch until the writer has actually opened it.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop every cache from an older version, so a change to what counts as
      // cacheable cannot leave yesterday's rules holding yesterday's files.
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

/**
 * Assets that are safe to keep: they are build output and public icons, which
 * are identical for every visitor and contain nothing personal.
 */
function isCacheableAsset(url) {
  return url.pathname.startsWith("/_next/static/") || PUBLIC_ASSETS.has(url.pathname);
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(SHELL_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

/**
 * The capture screen: the network's answer when there is one, yesterday's copy
 * when there is not.
 *
 * A redirect is never stored. Asking for `/capture` without a live session
 * answers with `/login`, and caching that would pin the login page in place of
 * the capture screen for as long as the cache lived.
 */
async function captureShell(request) {
  try {
    const response = await fetch(request);
    if (response.ok && !response.redirected) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(CAPTURE_PATH, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(CAPTURE_PATH);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Mutations are never intercepted. A queued capture is replayed by the page
  // itself, which can hold the CSRF token and read the answer; a worker
  // replaying POSTs would be doing it blind.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    if (url.pathname === CAPTURE_PATH) event.respondWith(captureShell(request));
    // Every other navigation is left alone: see the note at the top of the file.
    return;
  }

  if (isCacheableAsset(url)) event.respondWith(cacheFirst(request));
});
