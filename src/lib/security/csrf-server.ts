import "server-only";
import { cookies, headers } from "next/headers";
import { env } from "@/lib/env";
import { CSRF_COOKIE, CSRF_FIELD, CSRF_HEADER, verifyCsrf } from "./csrf";

/**
 * Server-side half of the double-submit check.
 *
 * Next's Server Actions already verify Origin, but this is checked
 * independently rather than delegated: the whole point of defence in depth is
 * not to rely on one framework behaviour staying true across upgrades.
 */
export async function readCsrfToken(): Promise<string> {
  return (await cookies()).get(CSRF_COOKIE)?.value ?? "";
}

export class CsrfError extends Error {
  constructor(reason: string) {
    super(`Rejected: ${reason}`);
    this.name = "CsrfError";
  }
}

/** Throws unless the request proves it originated from this app's own UI. */
export async function assertCsrf(formData: FormData): Promise<void> {
  const submitted = formData.get(CSRF_FIELD);
  await assertCsrfToken(typeof submitted === "string" ? submitted : null);
}

/**
 * The same check for a request that carries no form.
 *
 * Journal chat streams over `fetch`, so its token rides in the `x-drem-csrf`
 * header rather than in a field. The check itself is unchanged — the token is
 * still read from the cookie no other origin can see, and the Origin header is
 * still verified — because a route handler gets none of the Server Action
 * origin checking that Next does on top of ours.
 */
export async function assertCsrfHeader(request: Request): Promise<void> {
  await assertCsrfToken(request.headers.get(CSRF_HEADER));
}

async function assertCsrfToken(submitted: string | null): Promise<void> {
  const [cookieToken, requestHeaders] = await Promise.all([
    readCsrfToken(),
    headers(),
  ]);

  const result = verifyCsrf(requestHeaders, cookieToken, submitted, env().APP_ORIGIN);
  if (!result.ok) throw new CsrfError(result.reason ?? "CSRF check failed");
}
