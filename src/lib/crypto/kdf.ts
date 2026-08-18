/**
 * Password-based key derivation.
 *
 * Two independent values are derived from the same password:
 *
 *   1. an *authentication* hash, stored verbatim and used only to check logins;
 *   2. a *key-encryption key* (KEK), never stored, used to unwrap the data key.
 *
 * They use different salts, so possession of the stored authentication hash
 * reveals nothing about the KEK. Both feed MASTER_KEY in as the Argon2 `secret`
 * (a pepper), which means a stolen database cannot even be brute-forced offline
 * without also stealing the environment file.
 */
import { hashRaw, verify } from "@node-rs/argon2";
import type { Algorithm } from "@node-rs/argon2";
import { hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * The cost parameters are part of the key, not just a policy knob: deriving the
 * KEK with different parameters yields a different key and would render the
 * journal permanently unreadable. They are therefore *stored per account* and
 * replayed on every unlock, so the defaults below can be raised for new and
 * rotated credentials without touching existing ones.
 */
export interface KdfParams {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

/**
 * OWASP's Argon2id floor is m=19MiB/t=2/p=1; this runs far above it. Measured
 * at ~220ms per derivation on the target machine, so a login (one verification
 * plus one KEK derivation) costs roughly half a second — a price worth paying
 * once a day for a single-user journal.
 */
export const DEFAULT_KDF_PARAMS: KdfParams = {
  memoryCost: 524288, // 512 MiB
  timeCost: 4,
  parallelism: 4,
};

const kdfParamsSchema = z.object({
  // Never accept parameters weaker than the OWASP floor, even from the
  // database: a tampered user row must not be able to downgrade the KDF.
  memoryCost: z.number().int().min(19456).max(2 ** 22),
  timeCost: z.number().int().min(2).max(64),
  parallelism: z.number().int().min(1).max(255),
});

/** Parses stored parameters, rejecting anything that weakens the derivation. */
export function parseKdfParams(value: unknown): KdfParams {
  return kdfParamsSchema.parse(value);
}

/**
 * `Algorithm.Argon2id`, inlined. The upstream enum is an ambient `const enum`,
 * which cannot be read as a value under `verbatimModuleSyntax`.
 */
const ARGON2ID = 2 as Algorithm;

function argon2Options(params: KdfParams) {
  return {
    algorithm: ARGON2ID,
    memoryCost: params.memoryCost,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
  } as const;
}

export const SALT_BYTES = 16;
export const KEY_BYTES = 32;

/** Domain separation, so the same inputs can never yield the same key twice. */
const KEK_INFO = "drem:kek:v1";

export function generateSalt(): Buffer {
  return randomBytes(SALT_BYTES);
}

/**
 * Derives the key that wraps the user's data key.
 *
 * MASTER_KEY appears twice by design — as the Argon2 pepper and as the HKDF
 * salt. Both the password and MASTER_KEY are required; neither alone is enough.
 */
export async function deriveKek(
  password: string,
  kekSalt: Buffer,
  masterKey: Buffer,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<Buffer> {
  const ikm = await hashRaw(password, {
    ...argon2Options(params),
    salt: kekSalt,
    secret: masterKey,
    outputLen: KEY_BYTES,
  });
  const derived = hkdfSync("sha256", ikm, masterKey, KEK_INFO, KEY_BYTES);
  ikm.fill(0);
  return Buffer.from(derived);
}

/**
 * Produces the stored login verifier. Returns a PHC string, so the Argon2
 * parameters travel with the hash and can be raised later without invalidating
 * existing credentials.
 */
export async function hashPassword(
  password: string,
  masterKey: Buffer,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<string> {
  const { hash } = await import("@node-rs/argon2");
  return hash(password, {
    ...argon2Options(params),
    secret: masterKey,
    outputLen: KEY_BYTES,
  });
}

/**
 * The stored PHC string carries its own parameters, so verification does not
 * need them supplied and old hashes keep working after the defaults are raised.
 */
export async function verifyPassword(
  storedHash: string,
  password: string,
  masterKey: Buffer,
): Promise<boolean> {
  try {
    return await verify(storedHash, password, { secret: masterKey });
  } catch {
    // A malformed stored hash must read as "wrong password", never as a crash
    // that could be used to probe account state.
    return false;
  }
}

/**
 * Derives a subkey from an existing high-entropy key. Used to split the data
 * key into purpose-specific keys (field encryption, blind indexing, ...) so a
 * single key never serves two cryptographic roles.
 */
export function deriveSubkey(
  key: Buffer,
  info: string,
  length = KEY_BYTES,
): Buffer {
  return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), info, length));
}

/** Constant-time comparison that tolerates differing lengths. */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Best-effort scrub of key material once a session ends. */
export function wipe(...buffers: (Buffer | null | undefined)[]): void {
  for (const buffer of buffers) buffer?.fill(0);
}
