/**
 * CSRF defence.
 *
 * Three independent layers, because each has a known failure mode:
 *
 *   1. SameSite=Lax on the session cookie — stops the common cases, but is a
 *      browser policy this app cannot audit.
 *   2. Origin/Referer checking against APP_ORIGIN — strong, but absent on some
 *      legitimate requests.
 *   3. A double-submit token — works even when the first two are unavailable.
 *
 * A mutation must pass 2 and 3 to proceed.
 */
import { generateToken, tokensMatch } from "./tokens";

export { CSRF_COOKIE, CSRF_FIELD, CSRF_HEADER } from "./constants";

export function issueCsrfToken(): string {
  return generateToken();
}

/**
 * The Origin header is the reliable signal; Referer is the fallback for the
 * handful of navigations that omit Origin.
 *
 * A request carrying *neither* is rejected. Being strict is affordable here: a
 * self-hosted single-user app has no third-party integrations to break.
 */
export function originAllowed(
  headers: Headers,
  appOrigin: string,
): { allowed: boolean; reason?: string } {
  const origin = headers.get("origin");
  if (origin) {
    return origin === appOrigin
      ? { allowed: true }
      : { allowed: false, reason: `origin ${origin} is not ${appOrigin}` };
  }

  const referer = headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === appOrigin
        ? { allowed: true }
        : { allowed: false, reason: `referer ${referer} is not ${appOrigin}` };
    } catch {
      return { allowed: false, reason: "referer is not a valid URL" };
    }
  }

  return { allowed: false, reason: "no Origin or Referer header" };
}

/**
 * The cookie is readable by scripts on this origin so the client can echo it
 * back; that is safe precisely because a cross-origin attacker cannot read it.
 */
export function csrfTokenMatches(
  cookieToken: string | undefined,
  submittedToken: string | undefined | null,
): boolean {
  if (!cookieToken || !submittedToken) return false;
  return tokensMatch(cookieToken, submittedToken);
}

export interface CsrfCheck {
  ok: boolean;
  reason?: string;
}

export function verifyCsrf(
  headers: Headers,
  cookieToken: string | undefined,
  submittedToken: string | undefined | null,
  appOrigin: string,
): CsrfCheck {
  const origin = originAllowed(headers, appOrigin);
  if (!origin.allowed) return { ok: false, reason: origin.reason };
  if (!csrfTokenMatches(cookieToken, submittedToken)) {
    return { ok: false, reason: "CSRF token missing or mismatched" };
  }
  return { ok: true };
}

/** Safe methods are exempt: they must not change state in the first place. */
export function requiresCsrf(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}
