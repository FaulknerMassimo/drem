/**
 * Points the integration suites at a database of their own and migrates it.
 *
 * The suites truncate freely, which is only safe against a catalog nothing else
 * reads. They therefore run against `drem_test` — a database that exists in the
 * development cluster and nowhere else — and they are configured from
 * `.env.development`, so no test process ever holds the production MASTER_KEY.
 *
 * The guard is in `src/lib/db-environment.ts`: DREM_ENV=test refuses any
 * database whose name does not end in `_test`. Pointing this file at `drem` is
 * how an owner's account "disappears" and the app falls back to /setup, so the
 * refusal is a hard error rather than a warning.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { loadEnvironment } from "../scripts/env-file.js";

export const TEST_DATABASE = "drem_test";

const loaded = loadEnvironment("test", {
  fromEnvironment: "development",
  database: TEST_DATABASE,
});

/*
 * `drem_test` is created by the dev cluster's init script, but only on a volume
 * that was created after it was added. Creating it here as well means a
 * checkout with an older dev volume does not have to rebuild it to run tests.
 * The maintenance database is used for the connection: `drem_test` may not
 * exist yet, and `drem_dev` may be mid-rebuild.
 */
const admin = new URL(process.env.DATABASE_URL!);
admin.pathname = "/postgres";
const cluster = postgres(admin.toString(), { max: 1, idle_timeout: 5 });
try {
  const [row] = await cluster`
    SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${loaded.database}) AS present
  `;
  if (!row?.present) {
    await cluster.unsafe(`CREATE DATABASE ${loaded.database}`);
  }
} finally {
  await cluster.end();
}

const globalForTests = globalThis as typeof globalThis & { dremTestMigrated?: true };
if (!globalForTests.dremTestMigrated) {
  const drizzleKit = fileURLToPath(new URL("../node_modules/.bin/drizzle-kit", import.meta.url));
  execFileSync(drizzleKit, ["migrate"], {
    stdio: "inherit",
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: process.env,
  });
  globalForTests.dremTestMigrated = true;
}
