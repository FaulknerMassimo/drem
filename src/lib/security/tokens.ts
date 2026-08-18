/**
 * Opaque bearer tokens for session cookies and CSRF.
 *
 * Tokens are random, never derived from user data, and are stored only as
 * SHA-256 digests. A leaked database therefore cannot be replayed as a live
 * session; it contains fingerprints, not credentials.
 *
 * SHA-256 rather than Argon2 is correct here: these carry 256 bits of entropy,
 * so there is no dictionary to defend against and a slow hash would only add
 * latency to every request.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_BYTES = 32;

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Constant-time comparison of two tokens supplied as strings. */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Hashes a client IP for the audit log.
 *
 * Keyed with MASTER_KEY so the log cannot be correlated across installs, and
 * truncated so it functions as a coarse "same device?" signal rather than a
 * recoverable location history.
 */
export function hashIp(ip: string, masterKey: Buffer): Buffer {
  return createHash("sha256")
    .update(masterKey)
    .update(`drem:ip:v1:${ip}`, "utf8")
    .digest()
    .subarray(0, 16);
}
