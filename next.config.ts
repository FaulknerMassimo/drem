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
};

export default config;
