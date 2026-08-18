import { beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { buildCsp, securityHeaders } from "./headers";
import {
  csrfTokenMatches,
  issueCsrfToken,
  originAllowed,
  requiresCsrf,
  verifyCsrf,
} from "./csrf";
import {
  LOGIN_RULES,
  TOTP_RULES,
  __resetAllRateLimits,
  checkRateLimit,
  resetRateLimit,
  sweepRateLimits,
} from "./rate-limit";
import { generateToken, hashIp, hashToken, tokensMatch } from "./tokens";
import { cookieSecureFromHeaders } from "./cookie-options";

const APP_ORIGIN = "https://dreams.example.com";

describe("tokens", () => {
  it("issues unpredictable 256-bit tokens", () => {
    const tokens = new Set(Array.from({ length: 200 }, generateToken));
    expect(tokens.size).toBe(200);
    expect(Buffer.from(generateToken(), "base64url")).toHaveLength(32);
  });

  it("stores only a digest, never the token", () => {
    const token = generateToken();
    const digest = hashToken(token);
    expect(digest).toHaveLength(32);
    expect(digest.toString("base64url")).not.toBe(token);
  });

  it("hashes deterministically so lookups work", () => {
    const token = generateToken();
    expect(hashToken(token).equals(hashToken(token))).toBe(true);
  });

  it("compares tokens without leaking length-independent timing", () => {
    const token = generateToken();
    expect(tokensMatch(token, token)).toBe(true);
    expect(tokensMatch(token, generateToken())).toBe(false);
    expect(tokensMatch(token, token.slice(0, -1))).toBe(false);
  });

  it("keys IP hashes to MASTER_KEY so audit logs cannot be correlated", () => {
    const a = hashIp("192.0.2.10", randomBytes(32));
    const b = hashIp("192.0.2.10", randomBytes(32));
    expect(a.equals(b)).toBe(false);
    expect(a).toHaveLength(16);
  });

  it("hashes the same IP consistently under one key", () => {
    const key = randomBytes(32);
    expect(hashIp("192.0.2.10", key).equals(hashIp("192.0.2.10", key))).toBe(true);
    expect(hashIp("192.0.2.10", key).equals(hashIp("192.0.2.11", key))).toBe(false);
  });
});

describe("content security policy", () => {
  const csp = buildCsp({ nonce: "abc123" });

  it("blocks every outbound destination but this origin", () => {
    // The load-bearing directive: injected script has nowhere to send
    // decrypted dream text.
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/connect-src[^;]*\*/);
  });

  it("binds scripts to the request nonce", () => {
    expect(csp).toContain("'nonce-abc123'");
    expect(csp).toContain("'strict-dynamic'");
  });

  it("forbids framing, plugins and base-tag hijacking", () => {
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it("permits eval only in development", () => {
    expect(csp).not.toContain("unsafe-eval");
    expect(buildCsp({ nonce: "n", dev: true })).toContain("'unsafe-eval'");
  });

  it("upgrades insecure requests only when actually served over HTTPS", () => {
    // A production build on http://localhost must NOT get this: it would
    // rewrite the app's own requests to https and break every form post.
    expect(csp).not.toContain("upgrade-insecure-requests");
    expect(buildCsp({ nonce: "n", secure: true })).toContain("upgrade-insecure-requests");
  });
});

describe("security headers", () => {
  const headers = securityHeaders({ nonce: "n" });

  it("sets the expected hardening headers", () => {
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    // Must not be "no-referrer": that makes browsers send `Origin: null` on
    // form posts, breaking the CSRF origin check entirely.
    expect(headers["Referrer-Policy"]).toBe("same-origin");
    expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
  });

  it("keeps a dream journal out of search indexes", () => {
    expect(headers["X-Robots-Tag"]).toContain("noindex");
  });

  it("allows microphone for voice capture but denies geolocation", () => {
    expect(headers["Permissions-Policy"]).toContain("microphone=(self)");
    expect(headers["Permissions-Policy"]).toContain("geolocation=()");
  });

  it("sends HSTS only over HTTPS", () => {
    expect(headers["Strict-Transport-Security"]).toBeUndefined();
    expect(
      securityHeaders({ nonce: "n", secure: true })["Strict-Transport-Security"],
    ).toContain("max-age=63072000");
  });
});

describe("session cookie Secure flag", () => {
  it("follows APP_ORIGIN when no proxy header is present", () => {
    const h = new Headers();
    expect(cookieSecureFromHeaders(h, "http://192.168.1.221:3000")).toBe(false);
    expect(cookieSecureFromHeaders(h, "https://dreams.example.com")).toBe(true);
  });

  it("honours x-forwarded-proto from a TLS-terminating proxy", () => {
    const h = new Headers({ "x-forwarded-proto": "https" });
    expect(cookieSecureFromHeaders(h, "http://192.168.1.221:3000")).toBe(true);

    const plain = new Headers({ "x-forwarded-proto": "http" });
    expect(cookieSecureFromHeaders(plain, "https://dreams.example.com")).toBe(false);
  });
});

describe("CSRF", () => {
  function headersWith(init: Record<string, string>): Headers {
    return new Headers(init);
  }

  it("exempts safe methods only", () => {
    expect(requiresCsrf("GET")).toBe(false);
    expect(requiresCsrf("head")).toBe(false);
    expect(requiresCsrf("POST")).toBe(true);
    expect(requiresCsrf("DELETE")).toBe(true);
  });

  it("accepts a matching Origin", () => {
    expect(originAllowed(headersWith({ origin: APP_ORIGIN }), APP_ORIGIN).allowed).toBe(true);
  });

  it("rejects a foreign Origin", () => {
    expect(originAllowed(headersWith({ origin: "https://evil.example" }), APP_ORIGIN).allowed).toBe(false);
  });

  it("falls back to Referer when Origin is absent", () => {
    const headers = headersWith({ referer: `${APP_ORIGIN}/dreams/new` });
    expect(originAllowed(headers, APP_ORIGIN).allowed).toBe(true);
  });

  it("rejects a request carrying neither header", () => {
    const result = originAllowed(headersWith({}), APP_ORIGIN);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/no Origin or Referer/);
  });

  it("rejects a malformed Referer rather than guessing", () => {
    expect(originAllowed(headersWith({ referer: "not-a-url" }), APP_ORIGIN).allowed).toBe(false);
  });

  it("requires the double-submit token to match", () => {
    const token = issueCsrfToken();
    expect(csrfTokenMatches(token, token)).toBe(true);
    expect(csrfTokenMatches(token, issueCsrfToken())).toBe(false);
    expect(csrfTokenMatches(token, undefined)).toBe(false);
    expect(csrfTokenMatches(undefined, token)).toBe(false);
  });

  it("demands both the origin check and the token", () => {
    const token = issueCsrfToken();
    const good = headersWith({ origin: APP_ORIGIN });
    const bad = headersWith({ origin: "https://evil.example" });

    expect(verifyCsrf(good, token, token, APP_ORIGIN).ok).toBe(true);
    // A correct token is not enough if the request came from elsewhere.
    expect(verifyCsrf(bad, token, token, APP_ORIGIN).ok).toBe(false);
    // Nor is a correct origin enough without the token.
    expect(verifyCsrf(good, token, "wrong", APP_ORIGIN).ok).toBe(false);
  });
});

describe("rate limiting", () => {
  beforeEach(__resetAllRateLimits);

  it("allows attempts up to the limit", () => {
    for (let i = 0; i < LOGIN_RULES.perAccount.limit; i++) {
      expect(checkRateLimit("acct", LOGIN_RULES.perAccount).allowed).toBe(true);
    }
  });

  it("blocks once the limit is exceeded", () => {
    for (let i = 0; i < LOGIN_RULES.perAccount.limit; i++) {
      checkRateLimit("acct", LOGIN_RULES.perAccount);
    }
    const blocked = checkRateLimit("acct", LOGIN_RULES.perAccount);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("backs off harder on each repeat offence", () => {
    const rule = LOGIN_RULES.perAccount;
    const trip = (now: number) => {
      for (let i = 0; i < rule.limit + 1; i++) checkRateLimit("acct", rule, now);
      return checkRateLimit("acct", rule, now).retryAfterMs;
    };
    const first = trip(0);
    // Well past the first penalty, so the next burst counts as a fresh offence.
    const second = trip(60 * 60 * 1000);
    expect(second).toBeGreaterThan(first);
  });

  it("caps the penalty at fifteen minutes", () => {
    const rule = TOTP_RULES.perAccount;
    let now = 0;
    let retryAfterMs = 0;
    for (let round = 0; round < 12; round++) {
      now += 60 * 60 * 1000;
      for (let i = 0; i < rule.limit + 1; i++) checkRateLimit("burst", rule, now);
      retryAfterMs = checkRateLimit("burst", rule, now).retryAfterMs;
    }
    expect(retryAfterMs).toBeLessThanOrEqual(15 * 60 * 1000);
  });

  it("keeps buckets independent", () => {
    for (let i = 0; i < LOGIN_RULES.perAccount.limit + 1; i++) {
      checkRateLimit("acct-a", LOGIN_RULES.perAccount);
    }
    expect(checkRateLimit("acct-a", LOGIN_RULES.perAccount).allowed).toBe(false);
    expect(checkRateLimit("acct-b", LOGIN_RULES.perAccount).allowed).toBe(true);
  });

  it("forgives attempts once the window rolls past", () => {
    const rule = LOGIN_RULES.perAccount;
    for (let i = 0; i < rule.limit; i++) checkRateLimit("acct", rule, 0);
    expect(checkRateLimit("acct", rule, rule.windowMs + 1).allowed).toBe(true);
  });

  it("clears the slate after a successful login", () => {
    for (let i = 0; i < LOGIN_RULES.perAccount.limit + 1; i++) {
      checkRateLimit("acct", LOGIN_RULES.perAccount);
    }
    resetRateLimit("acct");
    expect(checkRateLimit("acct", LOGIN_RULES.perAccount).allowed).toBe(true);
  });

  it("guards TOTP more tightly than passwords", () => {
    // Only a million possible codes, so the attacker gets fewer tries.
    expect(TOTP_RULES.perAccount.limit).toBeLessThanOrEqual(LOGIN_RULES.perAccount.limit);
    expect(TOTP_RULES.perAccount.windowMs).toBeLessThan(LOGIN_RULES.perAccount.windowMs);
  });

  it("sweeps stale buckets so uptime does not leak memory", () => {
    checkRateLimit("old", LOGIN_RULES.perAccount, 0);
    sweepRateLimits(48 * 60 * 60 * 1000);
    // A swept bucket starts over with a full allowance.
    expect(checkRateLimit("old", LOGIN_RULES.perAccount, 48 * 60 * 60 * 1000).remaining).toBe(
      LOGIN_RULES.perAccount.limit - 1,
    );
  });
});
