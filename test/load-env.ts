/**
 * Loads .env for integration tests, then retargets DATABASE_URL at a dedicated
 * `drem_test` database and migrates it.
 *
 * The suites truncate freely. They must never be able to do that to the
 * journal the owner actually uses — that is how an account "disappears" and
 * the app falls back to /setup.
 *
 * Hand-rolled rather than pulling in dotenv: the format we generate is
 * trivial, and this keeps a dependency out of a process that handles MASTER_KEY.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export const TEST_DATABASE = "drem_test";

const content = readFileSync(new URL("../.env", import.meta.url), "utf8");
for (const line of content.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) continue;
  const key = trimmed.slice(0, eq);
  process.env[key] ??= trimmed.slice(eq + 1);
}

const appUrl = process.env.DATABASE_URL;
if (!appUrl) throw new Error("DATABASE_URL is required for integration tests");

const parsed = new URL(appUrl);
if (parsed.pathname.replace(/^\//, "") !== TEST_DATABASE) {
  const admin = postgres(appUrl, { max: 1, idle_timeout: 5 });
  try {
    const [row] = await admin`
      SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${TEST_DATABASE}) AS present
    `;
    if (!row?.present) {
      await admin.unsafe(`CREATE DATABASE ${TEST_DATABASE}`);
    }
  } finally {
    await admin.end();
  }
  parsed.pathname = `/${TEST_DATABASE}`;
  process.env.DATABASE_URL = parsed.toString();
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
