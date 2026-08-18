import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, securityHeaders } from "@/lib/security/headers";
import { CSRF_COOKIE } from "@/lib/security/constants";

/**
 * Runs on every request, before any route.
 *
 * Two jobs only: attach the security headers with a fresh per-request nonce,
 * and make sure a CSRF token exists. It deliberately does *not* authenticate —
 * middleware has no database access, and a cookie's mere presence proves
 * nothing. Real validation happens in the route layer, which can check the
 * session row and the in-process key store together.
 */
export function middleware(request: NextRequest) {
  const dev = process.env.NODE_ENV !== "production";
  // Read from the request rather than APP_ORIGIN: middleware cannot import the
  // validated env module (it pulls in node:crypto, unavailable on the edge).
  const secure = request.nextUrl.protocol === "https:";

  // Web Crypto rather than node:crypto: middleware runs on the edge runtime.
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = btoa(String.fromCharCode(...nonceBytes));

  const requestHeaders = new Headers(request.headers);
  // Forwarded so server components can put the nonce on their own script tags.
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", buildCsp({ nonce, dev, secure }));

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  for (const [header, value] of Object.entries(securityHeaders({ nonce, dev, secure }))) {
    response.headers.set(header, value);
  }

  // Readable by same-origin scripts so they can echo it back on mutations;
  // a cross-origin attacker can neither read it nor guess it.
  if (!request.cookies.get(CSRF_COOKIE)) {
    const token = new Uint8Array(32);
    crypto.getRandomValues(token);
    response.cookies.set(CSRF_COOKIE, btoa(String.fromCharCode(...token)), {
      httpOnly: false,
      sameSite: "lax",
      secure,
      path: "/",
    });
  }

  return response;
}

export const config = {
  // Static assets need no headers and would only add per-request overhead.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
