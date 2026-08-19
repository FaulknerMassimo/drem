import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    // .tsx as well: the presentational components are rendered to markup here,
    // which is the only cheap way to catch a component that throws.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Integration tests need a live database; they run from their own config.
    exclude: ["src/**/*.integration.test.ts", "node_modules/**"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Modules that guard themselves with `server-only` throw outside a React
      // Server Component graph. The unit suites exercise them directly in Node,
      // so it is stubbed away here exactly as the integration config does.
      "server-only": fileURLToPath(new URL("./test/server-only.ts", import.meta.url)),
    },
  },
});
