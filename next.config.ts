import type { NextConfig } from "next";

const config: NextConfig = {
  // Standalone output keeps the production image small.
  output: "standalone",
  // Dream content must never leak through the framework's own network calls.
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ["@node-rs/argon2", "sharp", "postgres"],
  experimental: {
    // Encrypted attachments are streamed through route handlers, so allow
    // generous request bodies for multi-page journal photo imports.
    serverActions: { bodySizeLimit: "25mb" },
  },
  /**
   * The service worker's own headers.
   *
   * It is excluded from the middleware matcher, so its CSP is set here rather
   * than inheriting the per-request nonce one — a nonce means nothing to a
   * worker, and `strict-dynamic` in a script that was never loaded from a tag
   * is a way to have it refuse to run. This policy is what governs the
   * worker's own fetches, and `default-src 'self'` is the point: a compromised
   * worker sits between the app and every request it makes, so it must have
   * nowhere to send them.
   *
   * `no-store` because a stale worker outlives a deploy and would keep serving
   * the rules it was written with.
   */
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default config;
