/**
 * Rebuilds the development journal from nothing.
 *
 * Drops the database, migrates, creates the account and seeds months of nights,
 * so "my dev data is in a strange state" is one command rather than an
 * afternoon. It is destructive by design, which is exactly why it will only
 * ever run against a database whose name marks it as scratch — see
 * `src/lib/db-environment.ts`.
 *
 *   npm run dev:reset
 *   npm run dev:reset -- --days 120
 *   npm run dev:reset -- --no-seed     # empty journal, account only
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { describeTarget, loadEnvironment } from "./env-file.js";

const loaded = loadEnvironment("development");
const root = fileURLToPath(new URL("..", import.meta.url));

function isConnectionRefused(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.some(isConnectionRefused);
  return (error as { code?: string } | null)?.code === "ECONNREFUSED";
}

const daysAt = process.argv.indexOf("--days");
const days = (daysAt === -1 ? undefined : process.argv[daysAt + 1]) ?? "400";
const seed = !process.argv.includes("--no-seed");

console.error(`Rebuilding ${describeTarget(loaded)}`);

/*
 * Dropping requires a connection to something other than the database being
 * dropped; `postgres` is the maintenance database every cluster has. FORCE
 * (Postgres 13+) evicts the `npm run dev` server, which otherwise holds a pool
 * open and turns this into "database is being accessed by other users".
 */
const adminUrl = new URL(process.env.DATABASE_URL!);
adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.toString(), { max: 1, idle_timeout: 5 });
try {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${loaded.database} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${loaded.database}`);
} catch (error) {
  // postgres.js reports a refused connection as an AggregateError with no
  // message at all, which reads as a crash rather than as "start the database".
  if (isConnectionRefused(error)) {
    throw new Error(
      `Cannot reach the development cluster at ${loaded.host}. Start it with \`npm run dev:up\`.`,
    );
  }
  throw error;
} finally {
  await admin.end();
}
console.error(`  dropped and recreated ${loaded.database}`);

/*
 * Attachments are files, not rows, so an empty database still leaves the blobs
 * of the journal that used to exist. They are encrypted under a data key that
 * no longer exists anywhere, which makes them unreadable rather than harmless:
 * every one of them would fail to decrypt for the rest of the checkout's life.
 */
const uploads = path.resolve(root, process.env.UPLOAD_DIR ?? "./data/dev-uploads");
const dataDir = path.resolve(root, "data");
if (!uploads.startsWith(`${dataDir}${path.sep}`) || !path.basename(uploads).includes("dev")) {
  throw new Error(
    `Refusing to empty ${uploads}: expected a directory under ./data whose name says it is for development.`,
  );
}
rmSync(uploads, { recursive: true, force: true });
mkdirSync(uploads, { recursive: true });
console.error(`  emptied ${path.relative(root, uploads)}`);

function run(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: "inherit", cwd: root, env: process.env });
}

const tsx = path.join(root, "node_modules/.bin/tsx");
run(path.join(root, "node_modules/.bin/drizzle-kit"), ["migrate"]);
run(tsx, ["--conditions=react-server", path.join(root, "scripts/dev-account.ts")]);

if (seed) {
  run(tsx, [
    "--conditions=react-server",
    path.join(root, "scripts/seed.ts"),
    "--days",
    days,
  ]);
}

const origin = process.env.APP_ORIGIN ?? "http://localhost:43818";
console.log(
  `\nReady. \`npm run dev\`, then log in at ${origin} as ` +
    `${process.env.DREM_DEV_EMAIL ?? "dev@drem.local"}.`,
);
process.exit(0);
