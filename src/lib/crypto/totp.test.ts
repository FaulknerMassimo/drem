import { describe, expect, it } from "vitest";
import {
  TOTP_PERIOD_SECONDS,
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  totp,
  totpUri,
  verifyTotp,
} from "./totp";

/** RFC 4226 / RFC 6238 reference seeds. */
const SEED_SHA1 = Buffer.from("12345678901234567890", "ascii");
const SEED_SHA256 = Buffer.from("12345678901234567890123456789012", "ascii");
const SEED_SHA512 = Buffer.from(
  "1234567890123456789012345678901234567890123456789012345678901234",
  "ascii",
);

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    const input = Buffer.from("12345678901234567890", "ascii");
    expect(base32Decode(base32Encode(input)).equals(input)).toBe(true);
  });

  it("matches the known encoding of the RFC seed", () => {
    expect(base32Encode(SEED_SHA1)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("tolerates padding, spaces and lower case", () => {
    expect(base32Decode("gezd gnbv=").equals(base32Decode("GEZDGNBV"))).toBe(
      true,
    );
  });

  it("rejects characters outside the alphabet", () => {
    expect(() => base32Decode("GEZD1088")).toThrow(/Invalid base32/);
  });
});

describe("HOTP, RFC 4226 Appendix D", () => {
  const expected = [
    "755224", "287082", "359152", "969429", "338314",
    "254676", "287922", "162583", "399871", "520489",
  ];

  it.each(expected.map((code, counter) => ({ counter, code })))(
    "counter $counter produces $code",
    ({ counter, code }) => {
      expect(hotp(SEED_SHA1, BigInt(counter))).toBe(code);
    },
  );
});

describe("TOTP, RFC 6238 Appendix B", () => {
  const vectors = [
    { seconds: 59, sha1: "94287082", sha256: "46119246", sha512: "90693936" },
    { seconds: 1111111109, sha1: "07081804", sha256: "68084774", sha512: "25091201" },
    { seconds: 1111111111, sha1: "14050471", sha256: "67062674", sha512: "99943326" },
    { seconds: 1234567890, sha1: "89005924", sha256: "91819424", sha512: "93441116" },
    { seconds: 2000000000, sha1: "69279037", sha256: "90698825", sha512: "38618901" },
    { seconds: 20000000000, sha1: "65353130", sha256: "77737706", sha512: "47863826" },
  ];

  it.each(vectors)("at T=$seconds", ({ seconds, sha1, sha256, sha512 }) => {
    const step = BigInt(Math.floor(seconds / TOTP_PERIOD_SECONDS));
    expect(hotp(SEED_SHA1, step, 8, "sha1")).toBe(sha1);
    expect(hotp(SEED_SHA256, step, 8, "sha256")).toBe(sha256);
    expect(hotp(SEED_SHA512, step, 8, "sha512")).toBe(sha512);
  });

  it("drives the public totp() helper from wall-clock milliseconds", () => {
    const secret = base32Encode(SEED_SHA1);
    expect(totp(secret, 59_000, 8)).toBe("94287082");
    expect(totp(secret, 1234567890_000, 8)).toBe("89005924");
  });
});

describe("verification", () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;

  it("accepts the current code", () => {
    const result = verifyTotp(secret, totp(secret, now), { atMs: now });
    expect(result.valid).toBe(true);
    expect(result.step).toBe(BigInt(Math.floor(now / 1000 / TOTP_PERIOD_SECONDS)));
  });

  it("tolerates one step of clock drift in both directions", () => {
    const stepMs = TOTP_PERIOD_SECONDS * 1000;
    expect(verifyTotp(secret, totp(secret, now - stepMs), { atMs: now }).valid).toBe(true);
    expect(verifyTotp(secret, totp(secret, now + stepMs), { atMs: now }).valid).toBe(true);
  });

  it("rejects drift beyond the window", () => {
    const stepMs = TOTP_PERIOD_SECONDS * 1000;
    expect(verifyTotp(secret, totp(secret, now - 2 * stepMs), { atMs: now }).valid).toBe(false);
  });

  it("reports the matched step so it can be burned after use", () => {
    // Without single-use enforcement, a shoulder-surfed code stays valid for
    // the rest of its window.
    const stepMs = TOTP_PERIOD_SECONDS * 1000;
    const previous = verifyTotp(secret, totp(secret, now - stepMs), { atMs: now });
    const current = verifyTotp(secret, totp(secret, now), { atMs: now });
    expect(previous.step).not.toBe(current.step);
  });

  it("rejects wrong and malformed codes", () => {
    for (const bad of ["000000", "12345", "1234567", "abcdef", "", "12 34 56"]) {
      expect(verifyTotp(secret, bad, { atMs: now }).valid).toBe(false);
    }
  });

  it("ignores whitespace in a correctly typed code", () => {
    const code = totp(secret, now);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotp(secret, spaced, { atMs: now }).valid).toBe(true);
  });

  it("rejects a valid code from a different secret", () => {
    const other = generateTotpSecret();
    expect(verifyTotp(secret, totp(other, now), { atMs: now }).valid).toBe(false);
  });
});

describe("enrolment", () => {
  it("generates 160-bit secrets", () => {
    expect(base32Decode(generateTotpSecret())).toHaveLength(20);
  });

  it("builds a scannable otpauth URI", () => {
    const secret = generateTotpSecret();
    const uri = new URL(totpUri(secret, "massimo@example.com"));
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.searchParams.get("secret")).toBe(secret);
    expect(uri.searchParams.get("issuer")).toBe("drem");
    expect(uri.searchParams.get("period")).toBe("30");
  });
});
