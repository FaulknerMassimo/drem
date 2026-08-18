/**
 * Response security headers.
 *
 * The threat this mostly guards against is an injected script exfiltrating
 * decrypted dream text from a page that is, by necessity, rendering plaintext.
 * The CSP is therefore written to make outbound requests impossible rather than
 * merely to block obvious XSS: `connect-src 'self'` means even a successful
 * injection has nowhere to send what it reads.
 */

export interface CspOptions {
  nonce: string;
  /** Dev builds need eval and websockets for React Fast Refresh. */
  dev?: boolean;
  /**
   * Whether the app is actually served over HTTPS.
   *
   * Distinct from `dev`: a self-hosted instance may well run a production build
   * over plain HTTP on localhost or a LAN hostname. Sending
   * `upgrade-insecure-requests` there rewrites the app's own requests to https
   * and breaks it, so both that and HSTS are gated on this rather than on the
   * build mode.
   */
  secure?: boolean;
}

export function buildCsp({ nonce, dev = false, secure = false }: CspOptions): string {
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    // Lets nonce-verified scripts load their own chunks, without needing a
    // nonce threaded onto every dynamically inserted tag.
    "'strict-dynamic'",
    ...(dev ? ["'unsafe-eval'"] : []),
  ];

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": scriptSrc,
    // Next injects inline styles; there is no nonce hook for them, and style
    // injection cannot exfiltrate data while connect-src stays locked down.
    "style-src": ["'self'", "'unsafe-inline'"],
    // blob: covers decrypted attachments rendered from memory.
    "img-src": ["'self'", "blob:", "data:"],
    "media-src": ["'self'", "blob:"],
    "font-src": ["'self'"],
    // The single most important line here: no third party can be reached from
    // the page, so decrypted content cannot leave the browser.
    "connect-src": dev ? ["'self'", "ws:"] : ["'self'"],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'none'"],
    "object-src": ["'none'"],
  };

  const serialised = Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");

  return secure ? `${serialised}; upgrade-insecure-requests` : serialised;
}

export function securityHeaders(options: CspOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": buildCsp(options),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    /**
     * `same-origin`, not `no-referrer`.
     *
     * `no-referrer` looks stricter but is actively harmful here: browsers send
     * `Origin: null` on a native form POST under that policy, which breaks both
     * Next's Server Action origin check and this app's own CSRF check -- the
     * two things standing between a dream journal and a cross-site write.
     *
     * `same-origin` gives up nothing that matters: no referrer is sent to any
     * other site, and this app makes no cross-origin requests anyway
     * (`connect-src 'self'`).
     */
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": [
      // Microphone stays available: voice capture depends on it.
      "microphone=(self)",
      "camera=(self)",
      "geolocation=()",
      "payment=()",
      "usb=()",
      "interest-cohort=()",
    ].join(", "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  };

  // Pointless over plain HTTP, and actively harmful if the instance is only
  // ever reachable that way.
  if (options.secure) {
    headers["Strict-Transport-Security"] =
      "max-age=63072000; includeSubDomains; preload";
  }

  return headers;
}
