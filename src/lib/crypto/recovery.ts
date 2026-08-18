/**
 * Two-factor recovery codes.
 *
 * Each code carries 128 bits of entropy, so unlike a password it needs no slow
 * hash to resist brute force. They are stored as HMAC-SHA256 fingerprints keyed
 * by MASTER_KEY, which keeps verification O(1) per code and keeps the database
 * alone useless for authenticating.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { base32Encode } from "./totp";

export const RECOVERY_CODE_COUNT = 10;
const CODE_BYTES = 16; // 128 bits
const GROUP_SIZE = 5;

export interface RecoveryCodeSet {
  /** Shown to the user exactly once, at enrolment. Never persisted. */
  plaintext: string[];
  /** Persisted fingerprints, in the same order. */
  fingerprints: Buffer[];
}

/** Grouped with dashes purely so they can be transcribed onto paper reliably. */
function formatCode(raw: Buffer): string {
  const encoded = base32Encode(raw);
  const groups: string[] = [];
  for (let i = 0; i < encoded.length; i += GROUP_SIZE) {
    groups.push(encoded.slice(i, i + GROUP_SIZE));
  }
  return groups.join("-");
}

/** Accepts codes typed with or without dashes, in any case. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-7]/g, "");
}

export function fingerprintRecoveryCode(
  code: string,
  masterKey: Buffer,
): Buffer {
  return createHmac("sha256", masterKey)
    .update(`drem:recovery:v1:${normalizeRecoveryCode(code)}`, "utf8")
    .digest();
}

export function generateRecoveryCodes(masterKey: Buffer): RecoveryCodeSet {
  const plaintext = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    formatCode(randomBytes(CODE_BYTES)),
  );
  return {
    plaintext,
    fingerprints: plaintext.map((code) =>
      fingerprintRecoveryCode(code, masterKey),
    ),
  };
}

/**
 * Returns the index of the matching unused code, or -1. The caller must mark
 * that index as consumed: recovery codes are strictly single-use.
 */
export function matchRecoveryCode(
  submitted: string,
  fingerprints: readonly Buffer[],
  masterKey: Buffer,
): number {
  const candidate = fingerprintRecoveryCode(submitted, masterKey);
  let match = -1;
  // All candidates are compared so timing does not reveal which code matched.
  for (let i = 0; i < fingerprints.length; i++) {
    const stored = fingerprints[i]!;
    if (
      stored.length === candidate.length &&
      timingSafeEqual(stored, candidate)
    ) {
      match = i;
    }
  }
  return match;
}
