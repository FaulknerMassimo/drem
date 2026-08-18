import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  DecryptionError,
  decrypt,
  decryptString,
  decryptStringOptional,
  encrypt,
  encryptOptional,
  type Aad,
} from "./aead";

const key = randomBytes(32);
const aad: Aad = { table: "dreams", column: "body", id: "dream-1" };
const secret = "I was flying over the house I grew up in.";

describe("field encryption", () => {
  it("round-trips text", () => {
    expect(decryptString(key, encrypt(key, secret, aad), aad)).toBe(secret);
  });

  it("round-trips binary", () => {
    const blob = randomBytes(4096);
    const restored = decrypt(key, encrypt(key, blob, aad), aad);
    expect(restored.equals(blob)).toBe(true);
  });

  it("produces a different ciphertext every time", () => {
    // Otherwise an observer could tell that two dreams share a body.
    const a = encrypt(key, secret, aad);
    const b = encrypt(key, secret, aad);
    expect(a.equals(b)).toBe(false);
  });

  it("never leaves plaintext in the ciphertext", () => {
    expect(encrypt(key, secret, aad).toString("utf8")).not.toContain("flying");
  });

  it("rejects a wrong key", () => {
    const payload = encrypt(key, secret, aad);
    expect(() => decrypt(randomBytes(32), payload, aad)).toThrow(
      DecryptionError,
    );
  });

  it("rejects a key of the wrong length", () => {
    expect(() => encrypt(randomBytes(16), secret, aad)).toThrow(/32-byte key/);
  });
});

describe("row and column binding", () => {
  const payload = encrypt(key, secret, aad);

  it("rejects a ciphertext moved to another row", () => {
    expect(() => decrypt(key, payload, { ...aad, id: "dream-2" })).toThrow(
      DecryptionError,
    );
  });

  it("rejects a ciphertext moved to another column", () => {
    expect(() => decrypt(key, payload, { ...aad, column: "title" })).toThrow(
      DecryptionError,
    );
  });

  it("rejects a ciphertext moved to another table", () => {
    expect(() => decrypt(key, payload, { ...aad, table: "nights" })).toThrow(
      DecryptionError,
    );
  });

  it("refuses ambiguous AAD components", () => {
    expect(() => encrypt(key, secret, { ...aad, table: "a:b" })).toThrow(/':'/);
  });
});

describe("tamper detection", () => {
  it("rejects a flipped bit in the ciphertext body", () => {
    const payload = encrypt(key, secret, aad);
    payload[20] = payload[20]! ^ 0x01;
    expect(() => decrypt(key, payload, aad)).toThrow(DecryptionError);
  });

  it("rejects a flipped bit in the nonce", () => {
    const payload = encrypt(key, secret, aad);
    payload[3] = payload[3]! ^ 0x01;
    expect(() => decrypt(key, payload, aad)).toThrow(DecryptionError);
  });

  it("rejects a flipped bit in the auth tag", () => {
    const payload = encrypt(key, secret, aad);
    payload[payload.length - 1] = payload[payload.length - 1]! ^ 0x01;
    expect(() => decrypt(key, payload, aad)).toThrow(DecryptionError);
  });

  it("rejects an unknown format version", () => {
    const payload = encrypt(key, secret, aad);
    payload[0] = 99;
    expect(() => decrypt(key, payload, aad)).toThrow(/version 99/);
  });

  it("rejects a truncated payload", () => {
    const payload = encrypt(key, secret, aad).subarray(0, 12);
    expect(() => decrypt(key, payload, aad)).toThrow(/too short/);
  });

  it("does not distinguish failure modes to the caller", () => {
    // A wrong key and a tampered ciphertext must be indistinguishable.
    const tampered = encrypt(key, secret, aad);
    tampered[20] = tampered[20]! ^ 0x01;
    const wrongKey = () => decrypt(randomBytes(32), encrypt(key, secret, aad), aad);
    const tamperedRead = () => decrypt(key, tampered, aad);
    expect(() => wrongKey()).toThrow("Failed to authenticate ciphertext");
    expect(() => tamperedRead()).toThrow("Failed to authenticate ciphertext");
  });
});

describe("optional values", () => {
  it("maps null and empty strings to SQL NULL", () => {
    expect(encryptOptional(key, null, aad)).toBeNull();
    expect(encryptOptional(key, undefined, aad)).toBeNull();
    expect(encryptOptional(key, "", aad)).toBeNull();
    expect(decryptStringOptional(key, null, aad)).toBeNull();
  });

  it("round-trips present values", () => {
    const payload = encryptOptional(key, secret, aad);
    expect(decryptStringOptional(key, payload, aad)).toBe(secret);
  });
});
