import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Integration tests: these talk to a real Postgres and are therefore kept out
 * of `npm test`, which must stay runnable with no infrastructure.
 *
 *   npm run dev:up && npm run test:integration
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    setupFiles: ["./test/load-env.ts"],
    // The suite shares one database, so parallel files would race.
    fileParallelism: false,
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./test/server-only.ts", import.meta.url)),
    },
  },
});
