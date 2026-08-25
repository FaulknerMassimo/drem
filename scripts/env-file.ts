/**
 * Loads the environment file for one of the three journals.
 *
 * `next dev` does this for itself — it reads `.env.development` over `.env`
 * without being asked — but nothing else in the repository does, and the
 * scripts are the half that can destroy something. Every script therefore
 * declares which journal it wants, loads that file, and refuses to continue if
 * the connection string it got back disagrees.
 *
 * Hand-rolled rather than pulling in dotenv, matching `test/load-env.ts`: the
 * format we generate is trivial, and this keeps a dependency out of the
 * processes that handle MASTER_KEY.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  databaseMismatch,
  databaseName,
  masterKeyMismatch,
  parseDremEnvironment,
  type DremEnvironment,
} from "../src/lib/db-environment.js";

/**
 * Which files back each environment, in the order Next reads them: a `.local`
 * override first, then the committed file. Both lose to a variable already in
 * the shell, so `DATABASE_URL=... npm run ...` still works.
 *
 * The test suites read the development file. They need a cluster and a key, not
 * a *journal*, and handing them `.env` would put the production MASTER_KEY into
 * every test process for no reason.
 */
const FILES: Record<DremEnvironment, readonly string[]> = {
  production: [".env.local", ".env"],
  development: [".env.development.local", ".env.development"],
  test: [".env.development.local", ".env.development"],
};

export interface LoadOptions {
  /**
   * Replaces the database in DATABASE_URL before the check runs, so the
   * integration harness can say "the test database in whichever cluster the
   * development file points at" without hard-coding a connection string that
   * would then drift from `.env.development`.
   */
  database?: string;

  /**
   * What the connection string is expected to name *before* that replacement.
   *
   * Without it the replacement would launder anything: a DATABASE_URL exported
   * in the shell pointing at the production cluster would have its path
   * rewritten to `/drem_test` and pass, quietly creating a scratch database
   * next to the real journal. Checking the name it arrived with keeps an
   * override honest while still allowing one — a CI cluster is a legitimate
   * thing to point the suites at, the production one is not.
   */
  fromEnvironment?: DremEnvironment;
}

export interface LoadedEnvironment {
  environment: DremEnvironment;
  /** Files that existed and were read, most significant first. */
  files: string[];
  database: string;
  host: string;
}

function repoPath(name: string): string {
  return fileURLToPath(new URL(`../${name}`, import.meta.url));
}

/** Applies a file's assignments, leaving anything already set alone. */
function applyFile(path: string): boolean {
  if (!existsSync(path)) return false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    process.env[trimmed.slice(0, eq)] ??= trimmed.slice(eq + 1);
  }
  return true;
}

/**
 * Populates `process.env` for one journal and proves it is that journal.
 *
 * Must be called before anything that reads `src/lib/env.ts`, which caches on
 * first use — in practice that means before the dynamic imports, not at the top
 * of the file.
 */
export function loadEnvironment(
  environment: DremEnvironment,
  options: LoadOptions = {},
): LoadedEnvironment {
  const files = FILES[environment].filter((name) => applyFile(repoPath(name)));
  if (files.length === 0) {
    throw new Error(
      `No environment file for ${environment}: expected one of ${FILES[environment].join(", ")}.\n` +
        (environment === "production"
          ? "Copy .env.example to .env and run `npm run --silent keygen >> .env`."
          : "`.env.development` is committed — this checkout is missing it."),
    );
  }

  // The caller's choice wins over whatever the file or the shell says: the
  // script knows which journal it is for, and the file does not.
  process.env.DREM_ENV = environment;

  let url = process.env.DATABASE_URL;
  if (!url) throw new Error(`DATABASE_URL is not set in ${files.join(" or ")}`);

  if (options.fromEnvironment) {
    const before = databaseMismatch(url, options.fromEnvironment);
    if (before) throw new Error(`Refusing to run: ${before}`);
  }

  if (options.database) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`DATABASE_URL is not a valid connection string`);
    }
    parsed.pathname = `/${options.database}`;
    url = parsed.toString();
    process.env.DATABASE_URL = url;
  }

  const mismatch = databaseMismatch(url, environment);
  if (mismatch) throw new Error(`Refusing to run: ${mismatch}`);

  const key = process.env.MASTER_KEY;
  if (key) {
    const keyMismatch = masterKeyMismatch(key, environment);
    if (keyMismatch) throw new Error(`Refusing to run: ${keyMismatch}`);
  }

  return {
    environment,
    files,
    database: databaseName(url)!,
    host: new URL(url).host,
  };
}

/**
 * One line naming the journal about to be touched, printed by every script that
 * writes. A command that silently picked the wrong database is the failure this
 * whole module exists to prevent; saying it out loud is the cheapest half.
 */
export function describeTarget(loaded: LoadedEnvironment): string {
  return `${loaded.environment}: ${loaded.database} at ${loaded.host} (${loaded.files[0]})`;
}

/**
 * The environment a script was invoked for: `--env <name>`, else DREM_ENV, else
 * the given fallback. Scripts that can only ever mean one journal pass it as
 * the fallback and do not offer the flag.
 */
export function environmentFromArgv(
  argv: readonly string[],
  fallback: DremEnvironment | null = null,
): DremEnvironment {
  const flag = argv.indexOf("--env");
  const raw = flag === -1 ? process.env.DREM_ENV : argv[flag + 1];
  const parsed = parseDremEnvironment(raw);
  if (parsed) return parsed;
  if (raw !== undefined) {
    throw new Error(`Unknown environment "${raw}" (expected production, development or test)`);
  }
  if (fallback) return fallback;
  throw new Error("No environment given: pass --env <production|development|test> or set DREM_ENV");
}
