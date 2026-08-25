/**
 * Which journal a process is allowed to write to.
 *
 * drem runs three journals on one machine: the real one, a development one
 * full of generated nights, and a throwaway the integration suites truncate.
 * They are separate Postgres clusters holding separate key material, so the
 * failure this guards against is not "the wrong rows are readable" — a
 * development process cannot decrypt a production row whatever it does. It is
 * the blunter one: a script, or an agent, pointed at the real journal by a
 * stale environment variable, and truncating it.
 *
 * The rule is the *database name*, because a name is the one thing carried in
 * every connection string, survives copy-paste between shells, and appears in
 * the error when it is wrong. A flag or a port can be right while the
 * connection string is not.
 *
 * Deliberately imports nothing — not even `server-only` — so `src/lib/env.ts`,
 * the scripts and the test harness share one definition of "am I about to
 * write to the real journal".
 */

export const DREM_ENVIRONMENTS = ["production", "development", "test"] as const;

export type DremEnvironment = (typeof DREM_ENVIRONMENTS)[number];

/** The suffix a database name must carry. Production is the unmarked case. */
const REQUIRED_SUFFIX: Record<DremEnvironment, string | null> = {
  production: null,
  development: "_dev",
  test: "_test",
};

/** Suffixes production must refuse, so the app cannot be run over scratch data. */
const RESERVED_SUFFIXES = ["_dev", "_test"] as const;

/**
 * The key `.env.development` ships, committed in the clear.
 *
 * A development journal holds nothing worth protecting, and a key that is the
 * same on every checkout is one fewer step between cloning and running. It
 * decodes to ASCII that says so. Production refuses it: a real journal encrypted
 * under a key published in this repository has no first factor at all.
 */
export const PUBLIC_DEV_MASTER_KEY = "ZHJlbSBkZXYga2V5IC0gbm90IGEgc2VjcmV0IC0tLS0=";

/** The database a connection string names, or null if it names none. */
export function databaseName(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.pathname.replace(/^\//, "") || null;
}

/**
 * Why this connection string is wrong for this environment, or null if it is
 * right. Returns prose rather than a boolean: this is read by someone whose
 * command just refused to run, and "false" would not tell them which of the
 * two halves to change. Phrased to follow a "Refusing to run:" or a field name,
 * since it is shown both by the scripts and by the app's configuration errors.
 */
export function databaseMismatch(url: string, environment: DremEnvironment): string | null {
  const name = databaseName(url);
  if (!name) {
    return "DATABASE_URL does not name a database (expected a path like /drem_dev)";
  }

  const required = REQUIRED_SUFFIX[environment];
  if (required) {
    if (name.endsWith(required)) return null;
    return (
      `this is a ${environment} process, so DATABASE_URL must name a database ending ` +
      `in "${required}" — it points at "${name}". Either the environment or the ` +
      `connection string is stale; work out which before changing either.`
    );
  }

  const reserved = RESERVED_SUFFIXES.find((suffix) => name.endsWith(suffix));
  if (reserved) {
    return (
      `this is a production process, so DATABASE_URL must not name a scratch database — ` +
      `"${name}" ends in "${reserved}", which the suites truncate and the seed script fills.`
    );
  }
  return null;
}

/**
 * Why this key is wrong for this environment, or null if it is right.
 *
 * Only one direction is checkable. Production running under the published
 * development key is detectable and catastrophic, so it is refused. Development
 * running under the production key is undetectable from here — nothing in the
 * repository knows what that key is — and is caught instead by the database
 * name, since a production key travels in the same `.env` as a production
 * connection string.
 */
export function masterKeyMismatch(key: string, environment: DremEnvironment): string | null {
  if (environment !== "production") return null;
  if (key !== PUBLIC_DEV_MASTER_KEY) return null;
  return (
    "this is the development key committed to this repository, which is public. A " +
    "production journal encrypted under it has no first factor. Run `npm run keygen`."
  );
}

/** Narrows a raw string, for the scripts that read DREM_ENV out of the shell. */
export function parseDremEnvironment(value: string | undefined): DremEnvironment | null {
  return DREM_ENVIRONMENTS.includes(value as DremEnvironment)
    ? (value as DremEnvironment)
    : null;
}
