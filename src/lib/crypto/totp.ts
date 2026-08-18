/**
 * RFC 6238 TOTP, implemented directly against the spec.
 *
 * Hand-rolled rather than pulled from a package: the algorithm is small and
 * fully specified, it is verified here against the official RFC test vectors,
 * and it keeps a dependency out of the authentication path.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
const SECRET_BYTES = 20; // 160 bits, per RFC 4226

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/[=\s]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error("Invalid base32 character in TOTP secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/**
 * HOTP (RFC 4226) - the dynamic-truncation core that TOTP builds on.
 *
 * `algorithm` is a parameter purely so the RFC 6238 SHA-256/SHA-512 test
 * vectors can be exercised; enrolment always uses SHA-1, which is what
 * authenticator apps implement.
 */
export function hotp(
  secret: Buffer,
  counter: bigint,
  digits = TOTP_DIGITS,
  algorithm: "sha1" | "sha256" | "sha512" = "sha1",
): string {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(counter);
  const digest = createHmac(algorithm, secret).update(counterBytes).digest();

  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

export function totp(
  secretBase32: string,
  atMs: number = Date.now(),
  digits = TOTP_DIGITS,
): string {
  const counter = BigInt(Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS));
  return hotp(base32Decode(secretBase32), counter, digits);
}

/**
 * Verifies a submitted code, allowing `window` steps of clock drift either way.
 * Comparison is constant-time so a response cannot be timed to recover digits.
 *
 * Returns the matched time step, which the caller must persist and refuse to
 * accept a second time - otherwise a code observed over the user's shoulder
 * stays valid for the remainder of its 30-second window.
 */
export function verifyTotp(
  secretBase32: string,
  token: string,
  options: { atMs?: number; window?: number; digits?: number } = {},
): { valid: boolean; step: bigint | null } {
  const { atMs = Date.now(), window = 1, digits = TOTP_DIGITS } = options;
  const normalized = token.replace(/\s/g, "");
  if (!new RegExp(`^[0-9]{${digits}}$`).test(normalized)) {
    return { valid: false, step: null };
  }

  const secret = base32Decode(secretBase32);
  const current = BigInt(Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS));
  const submitted = Buffer.from(normalized, "utf8");

  let matched: bigint | null = null;
  // Every candidate is checked even after a match, so verification takes the
  // same time regardless of which step (if any) was correct.
  for (let offset = -window; offset <= window; offset++) {
    const step = current + BigInt(offset);
    const expected = Buffer.from(hotp(secret, step, digits), "utf8");
    if (
      expected.length === submitted.length &&
      timingSafeEqual(expected, submitted)
    ) {
      matched = step;
    }
  }
  return { valid: matched !== null, step: matched };
}

/** otpauth:// URI for authenticator-app QR enrolment. */
export function totpUri(
  secretBase32: string,
  account: string,
  issuer = "drem",
): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
