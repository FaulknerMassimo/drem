import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  RECOVERY_CODE_COUNT,
  generateRecoveryCodes,
  matchRecoveryCode,
  normalizeRecoveryCode,
} from "./recovery";

const masterKey = randomBytes(32);

describe("recovery codes", () => {
  it("issues the expected number of distinct codes", () => {
    const { plaintext } = generateRecoveryCodes(masterKey);
    expect(plaintext).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(plaintext).size).toBe(RECOVERY_CODE_COUNT);
  });

  it("formats codes for transcription onto paper", () => {
    const { plaintext } = generateRecoveryCodes(masterKey);
    for (const code of plaintext) {
      expect(code).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{1,5})+$/);
      // 128 bits of entropy is why these need no slow hash.
      expect(normalizeRecoveryCode(code).length).toBeGreaterThanOrEqual(26);
    }
  });

  it("stores only fingerprints, never the codes", () => {
    const { plaintext, fingerprints } = generateRecoveryCodes(masterKey);
    const stored = Buffer.concat(fingerprints).toString("utf8");
    for (const code of plaintext) {
      expect(stored).not.toContain(normalizeRecoveryCode(code));
    }
  });

  it("matches a submitted code to its position", () => {
    const { plaintext, fingerprints } = generateRecoveryCodes(masterKey);
    expect(matchRecoveryCode(plaintext[3]!, fingerprints, masterKey)).toBe(3);
  });

  it("accepts codes typed without dashes or in lower case", () => {
    const { plaintext, fingerprints } = generateRecoveryCodes(masterKey);
    const sloppy = plaintext[0]!.toLowerCase().replace(/-/g, " ");
    expect(matchRecoveryCode(sloppy, fingerprints, masterKey)).toBe(0);
  });

  it("rejects unknown codes", () => {
    const { fingerprints } = generateRecoveryCodes(masterKey);
    const stranger = generateRecoveryCodes(masterKey).plaintext[0]!;
    expect(matchRecoveryCode(stranger, fingerprints, masterKey)).toBe(-1);
    expect(matchRecoveryCode("", fingerprints, masterKey)).toBe(-1);
  });

  it("rejects a valid code under a different MASTER_KEY", () => {
    const { plaintext, fingerprints } = generateRecoveryCodes(masterKey);
    expect(matchRecoveryCode(plaintext[0]!, fingerprints, randomBytes(32))).toBe(-1);
  });

  it("supports single-use enforcement by consuming a slot", () => {
    const { plaintext, fingerprints } = generateRecoveryCodes(masterKey);
    const used = matchRecoveryCode(plaintext[2]!, fingerprints, masterKey);
    const remaining = fingerprints.filter((_, i) => i !== used);
    expect(matchRecoveryCode(plaintext[2]!, remaining, masterKey)).toBe(-1);
  });
});
