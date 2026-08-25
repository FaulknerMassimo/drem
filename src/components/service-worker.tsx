"use client";

import { useEffect } from "react";

/**
 * Registers the service worker, and unregisters it where it cannot help.
 *
 * Deliberately not `next/script` and not inline: registration is a two-line
 * effect, and an inline script would need the CSP nonce threaded down here for
 * no benefit.
 *
 * Registration is silent on failure. A browser that refuses — private
 * browsing, an insecure origin, a user who has disabled workers — loses
 * offline capture and nothing else, and an error banner about it on every page
 * load would be noise about a feature most sessions never use.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    /*
     * Never in development.
     *
     * The worker is cache-first over `/_next/static/`, which is correct for a
     * build — those filenames carry a content hash, so changed bytes arrive at
     * a new URL. `next dev` serves the same path with different contents, and
     * the worker then pins the first stylesheet it ever saw: the app renders
     * with yesterday's CSS and no amount of reloading fixes it, because the
     * request never reaches the server. Any worker left over from a production
     * build on this origin is unregistered rather than merely ignored — it is
     * already installed and would keep answering.
     */
    if (process.env.NODE_ENV !== "production") {
      void navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => {
          for (const registration of registrations) void registration.unregister();
        })
        .catch(() => {});
      return;
    }

    /*
     * Service workers require a secure context, and a self-hosted instance on
     * plain HTTP over a LAN is not one — `localhost` is the exception browsers
     * make. Registering there fails anyway; this just avoids the console noise.
     */
    if (!window.isSecureContext) return;

    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // Nothing to do and nothing worth saying: see above.
    });
  }, []);

  return null;
}
