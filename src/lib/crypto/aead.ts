/**
 * Authenticated encryption for individual database fields and blobs.
 *
 * Every ciphertext is bound to the exact row and column it belongs to via the
 * GCM additional-authenticated-data. An attacker with write access to the
 * database therefore cannot move a ciphertext from one row to another (or from
 * one column to another) without decryption failing — swapping two dreams'
 * bodies, or pasting a stored value into a field it was never meant for, is
 * detected rather than silently accepted.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const AEAD_VERSION = 1;

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Identifies the exact slot a ciphertext is allowed to live in. */
export interface Aad {
  /** Table name, e.g. "dreams". */
  table: string;
  /** Column name, e.g. "body". */
  column: string;
  /** Primary key of the owning row. */
  id: string;
}

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptionError";
  }
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Expected a ${KEY_BYTES}-byte key, received ${key.length}`);
  }
}

/**
 * The AAD is versioned so the binding scheme can change later without silently
 * accepting values produced under the old rules.
 */
export function aadBytes(aad: Aad): Buffer {
  if (aad.table.includes(":") || aad.column.includes(":")) {
    throw new Error("AAD components must not contain ':'");
  }
  return Buffer.from(
    `drem:v${AEAD_VERSION}:${aad.table}:${aad.column}:${aad.id}`,
    "utf8",
  );
}

/**
 * Wire format: version(1) || nonce(12) || ciphertext || tag(16)
 *
 * The nonce is random per call. Reusing a nonce under the same key would be
 * catastrophic for GCM, so it is never derived from row data.
 */
export function encrypt(
  key: Buffer,
  plaintext: string | Buffer,
  aad: Aad,
): Buffer {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(aadBytes(aad));
  const input =
    typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const body = Buffer.concat([cipher.update(input), cipher.final()]);
  return Buffer.concat([
    Buffer.of(AEAD_VERSION),
    nonce,
    body,
    cipher.getAuthTag(),
  ]);
}

export function decrypt(key: Buffer, payload: Buffer, aad: Aad): Buffer {
  assertKey(key);
  if (payload.length < 1 + NONCE_BYTES + TAG_BYTES) {
    throw new DecryptionError("Ciphertext is too short to be well-formed");
  }
  const version = payload[0];
  if (version !== AEAD_VERSION) {
    throw new DecryptionError(`Unsupported ciphertext version ${version}`);
  }
  const nonce = payload.subarray(1, 1 + NONCE_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const body = payload.subarray(1 + NONCE_BYTES, payload.length - TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAAD(aadBytes(aad));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    // Deliberately opaque: the caller must not be able to distinguish a wrong
    // key from a tampered ciphertext from a mismatched AAD.
    throw new DecryptionError("Failed to authenticate ciphertext");
  }
}

export function decryptString(key: Buffer, payload: Buffer, aad: Aad): string {
  return decrypt(key, payload, aad).toString("utf8");
}

/** Encrypts only when there is something to encrypt, preserving SQL NULLs. */
export function encryptOptional(
  key: Buffer,
  plaintext: string | Buffer | null | undefined,
  aad: Aad,
): Buffer | null {
  if (plaintext === null || plaintext === undefined) return null;
  if (typeof plaintext === "string" && plaintext.length === 0) return null;
  return encrypt(key, plaintext, aad);
}

export function decryptStringOptional(
  key: Buffer,
  payload: Buffer | null | undefined,
  aad: Aad,
): string | null {
  if (payload === null || payload === undefined) return null;
  return decryptString(key, payload, aad);
}
