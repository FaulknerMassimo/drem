/**
 * Creates the single account a development journal needs.
 *
 * The real setup flow is a browser form and a TOTP enrolment, which is correct
 * for an account guarding a decade of dreams and is three minutes every time a
 * contributor rebuilds a scratch database. This does the same thing with the
 * credentials published in `.env.development`, and skips TOTP so login is one
 * step.
 *
 * Run through `tsx --conditions=react-server` (see package.json): the auth
 * modules import `server-only`.
 */
import { describeTarget, loadEnvironment } from "./env-file.js";

// Before the dynamic imports below: `src/lib/env.ts` caches on first read.
const loaded = loadEnvironment("development");

const email = process.env.DREM_DEV_EMAIL ?? "dev@drem.local";
const password = process.env.DREM_DEV_PASSWORD ?? "development-journal";

const { createInitialAccount, AuthError } = await import("../src/lib/auth/accounts.js");

console.error(`Creating the development account in ${describeTarget(loaded)}`);

try {
  await createInitialAccount(email, password);
} catch (error) {
  if (error instanceof AuthError && error.code === "ACCOUNT_EXISTS") {
    console.log("An account already exists in this journal; leaving it alone.");
    process.exit(0);
  }
  throw error;
}

// No recovery codes printed: they are only needed once TOTP is enrolled, and a
// script that prints credentials is a habit this repository should not start.
console.log(`Account created: ${email} / ${password}  (no TOTP)`);
process.exit(0);
