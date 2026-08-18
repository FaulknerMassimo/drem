import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

/**
 * A single pooled client, reused across hot reloads in development so each edit
 * does not leak another pool.
 */
const globalForDb = globalThis as unknown as {
  dremClient?: ReturnType<typeof postgres>;
};

function client() {
  globalForDb.dremClient ??= postgres(env().DATABASE_URL, {
    max: 10,
    idle_timeout: 30,
    // Dream text is encrypted before it reaches the driver, but query logging
    // would still expose structure and timing. Keep it off.
    debug: false,
  });
  return globalForDb.dremClient;
}

export const db = drizzle(client(), { schema });
export { schema };
