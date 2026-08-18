import "server-only";
import { cookies, headers } from "next/headers";
import { env } from "@/lib/env";
import { CSRF_COOKIE, CSRF_FIELD, verifyCsrf } from "./csrf";

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
  const [cookieToken, requestHeaders] = await Promise.all([
    readCsrfToken(),
    headers(),
  ]);

  const submitted = formData.get(CSRF_FIELD);
  const result = verifyCsrf(
    requestHeaders,
    cookieToken,
    typeof submitted === "string" ? submitted : null,
    env().APP_ORIGIN,
  );

  if (!result.ok) throw new CsrfError(result.reason ?? "CSRF check failed");
}
