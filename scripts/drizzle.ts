/**
 * Runs drizzle-kit against a named journal.
 *
 * drizzle-kit loads `.env` and only `.env`, so every migration it ran was aimed
 * at production whatever the caller meant — including the ones a contributor
 * runs against a scratch database all day. This resolves the connection string
 * first, says which database it landed on, and hands drizzle-kit an environment
 * it cannot reinterpret.
 *
 *   npm run db:migrate            # development
 *   npm run db:migrate:prod       # the real journal, spelled out
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describeTarget, environmentFromArgv, loadEnvironment } from "./env-file.js";

const args = process.argv.slice(2);
const commandAt = args.findIndex((arg) => !arg.startsWith("--"));
if (commandAt === -1) {
  throw new Error("Usage: tsx scripts/drizzle.ts <migrate|push|studio|generate|check> --env <name>");
}
const command = args[commandAt]!;

const environment = environmentFromArgv(args);
const loaded = loadEnvironment(environment);

// `generate` reads the schema files and writes SQL; it never opens a
// connection. Saying "→ drem" for it would teach the operator to ignore a line
// that matters everywhere else.
const touchesDatabase = command !== "generate";
console.error(
  touchesDatabase
    ? `drizzle-kit ${command} → ${describeTarget(loaded)}`
    : `drizzle-kit ${command} (no database)`,
);

const binary = fileURLToPath(new URL("../node_modules/.bin/drizzle-kit", import.meta.url));
const passthrough = args.filter((arg, index) => {
  if (index === commandAt) return false;
  if (arg === "--env") return false;
  return args[index - 1] !== "--env";
});

try {
  execFileSync(binary, [command, ...passthrough], {
    stdio: "inherit",
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: process.env,
  });
} catch {
  // drizzle-kit has already printed whatever went wrong; a stack trace from
  // this wrapper on top of it only buries it.
  process.exit(1);
}
