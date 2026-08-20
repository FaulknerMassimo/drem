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
