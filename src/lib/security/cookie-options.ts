/**
 * Whether auth cookies should carry the Secure flag.
 *
 * Matches middleware's CSRF cookie logic: only mark Secure when the request
 * actually arrived over HTTPS. NODE_ENV must not drive this — a production
 * build served over plain HTTP (typical for LAN Docker) would otherwise set
 * Secure cookies that browsers refuse to store outside localhost.
 */
export function cookieSecureFromHeaders(
  requestHeaders: Headers,
  appOrigin: string,
): boolean {
  const forwarded = requestHeaders.get("x-forwarded-proto");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim().toLowerCase() === "https";
  }
  return appOrigin.startsWith("https://");
}
