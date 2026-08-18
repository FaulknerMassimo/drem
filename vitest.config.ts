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
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
