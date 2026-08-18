/**
 * Envelope encryption.
 *
 *   password ──argon2id(saltA, pepper=MASTER_KEY)──> auth hash  (stored)
 *            └─argon2id(saltB, pepper=MASTER_KEY)──> KEK        (never stored)
 *                                                       │
 *   DEK (random 32B) ──AES-256-GCM(KEK)──> dekWrapped           (stored)
 *
 * Only the wrapped data key is ever written to disk. The unwrapped DEK exists
 * solely in the process memory of a live session, which is why a database dump
 * — even together with the application image — yields nothing readable.
 *
 * Changing the password rewraps the same DEK rather than re-encrypting the
 * journal, so a password change is instant regardless of archive size.
 */
import { randomUUID } from "node:crypto";
import { randomBytes } from "node:crypto";
import { decrypt, encrypt, type Aad } from "./aead";
import {
  DEFAULT_KDF_PARAMS,
  deriveKek,
  deriveSubkey,
  generateSalt,
  hashPassword,
  KEY_BYTES,
  parseKdfParams,
  wipe,
  type KdfParams,
} from "./kdf";

/** Purpose-separated keys derived from the single per-user data key. */
export interface UserKeys {
  /** Encrypts dream text, notes, insights, transcripts, provider API keys. */
  field: Buffer;
  /** Encrypts attachment blobs (photos, audio). */
  blob: Buffer;
  /** HMAC key for blind indexes over tags and dream-sign labels. */
  index: Buffer;
  /** Encrypts embedding vectors when the encrypted search backend is active. */
  vector: Buffer;
}

/** Everything persisted on the user row to make future logins possible. */
export interface UserKeyMaterial {
  userId: string;
  passwordHash: string;
  kekSalt: Buffer;
  /**
   * The Argon2 cost parameters this account's KEK was derived under. Replayed
   * verbatim on every unlock: deriving with anything else produces a different
   * key and the journal would not open.
   */
  kdfParams: KdfParams;
  dekWrapped: Buffer;
  /** Present only when headless background processing is enabled. */
  dekWrappedMaster: Buffer | null;
}

export interface ProvisionedUser {
  material: UserKeyMaterial;
  keys: UserKeys;
}

function dekAad(userId: string): Aad {
  return { table: "users", column: "dek_wrapped", id: userId };
}

function dekMasterAad(userId: string): Aad {
  return { table: "users", column: "dek_wrapped_master", id: userId };
}

/** Splits the data key into one key per cryptographic role. */
export function deriveUserKeys(dek: Buffer): UserKeys {
  return {
    field: deriveSubkey(dek, "drem:field:v1"),
    blob: deriveSubkey(dek, "drem:blob:v1"),
    index: deriveSubkey(dek, "drem:bidx:v1"),
    vector: deriveSubkey(dek, "drem:vector:v1"),
  };
}

export function wipeUserKeys(keys: UserKeys): void {
  wipe(keys.field, keys.blob, keys.index, keys.vector);
}

/**
 * Creates a brand new account's key material.
 *
 * `allowBackgroundProcessing` additionally wraps the DEK under MASTER_KEY alone
 * so queued jobs can run while nobody is logged in. This is a real weakening —
 * MASTER_KEY plus the database then suffices to decrypt everything — and is why
 * it is opt-in rather than the default.
 */
export async function provisionUser(
  password: string,
  masterKey: Buffer,
  options: {
    userId?: string;
    allowBackgroundProcessing?: boolean;
    /** Overridable for weaker hardware, and to keep the test suite fast. */
    kdfParams?: KdfParams;
  } = {},
): Promise<ProvisionedUser> {
  const userId = options.userId ?? randomUUID();
  const kekSalt = generateSalt();
  const kdfParams = parseKdfParams(options.kdfParams ?? DEFAULT_KDF_PARAMS);
  const dek = randomBytes(KEY_BYTES);

  const kek = await deriveKek(password, kekSalt, masterKey, kdfParams);
  const dekWrapped = encrypt(kek, dek, dekAad(userId));
  wipe(kek);

  const dekWrappedMaster = options.allowBackgroundProcessing
    ? encrypt(masterKey, dek, dekMasterAad(userId))
    : null;

  const passwordHash = await hashPassword(password, masterKey, kdfParams);
  const keys = deriveUserKeys(dek);
  wipe(dek);

  return {
    material: {
      userId,
      passwordHash,
      kekSalt,
      kdfParams,
      dekWrapped,
      dekWrappedMaster,
    },
    keys,
  };
}

/**
 * Recovers the data key at login. Throws DecryptionError on a wrong password —
 * callers must treat that identically to a failed password verification so the
 * two are indistinguishable to an attacker.
 */
export async function unwrapDek(
  password: string,
  material: Pick<
    UserKeyMaterial,
    "userId" | "kekSalt" | "kdfParams" | "dekWrapped"
  >,
  masterKey: Buffer,
): Promise<Buffer> {
  const kek = await deriveKek(
    password,
    material.kekSalt,
    masterKey,
    parseKdfParams(material.kdfParams),
  );
  try {
    return decrypt(kek, material.dekWrapped, dekAad(material.userId));
  } finally {
    wipe(kek);
  }
}

export async function unlock(
  password: string,
  material: Pick<
    UserKeyMaterial,
    "userId" | "kekSalt" | "kdfParams" | "dekWrapped"
  >,
  masterKey: Buffer,
): Promise<UserKeys> {
  const dek = await unwrapDek(password, material, masterKey);
  const keys = deriveUserKeys(dek);
  wipe(dek);
  return keys;
}

/** Unlocks without a password, for queued work. Requires the opt-in wrap. */
export function unlockForBackground(
  material: Pick<UserKeyMaterial, "userId" | "dekWrappedMaster">,
  masterKey: Buffer,
): UserKeys {
  if (!material.dekWrappedMaster) {
    throw new Error(
      "Background processing is disabled for this account: no master-wrapped data key",
    );
  }
  const dek = decrypt(
    masterKey,
    material.dekWrappedMaster,
    dekMasterAad(material.userId),
  );
  const keys = deriveUserKeys(dek);
  wipe(dek);
  return keys;
}

/**
 * Rewraps the existing DEK under a key derived from the new password, and takes
 * the opportunity to upgrade to the current cost parameters. The journal itself
 * is untouched, so this stays O(1) rather than O(entries).
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
  material: UserKeyMaterial,
  masterKey: Buffer,
): Promise<
  Pick<
    UserKeyMaterial,
    "passwordHash" | "kekSalt" | "kdfParams" | "dekWrapped"
  >
> {
  const dek = await unwrapDek(currentPassword, material, masterKey);
  try {
    // A password change is the natural moment to adopt stronger parameters,
    // since the KEK is being rebuilt from scratch anyway.
    const kdfParams = DEFAULT_KDF_PARAMS;
    const kekSalt = generateSalt();
    const kek = await deriveKek(newPassword, kekSalt, masterKey, kdfParams);
    const dekWrapped = encrypt(kek, dek, dekAad(material.userId));
    wipe(kek);
    return {
      passwordHash: await hashPassword(newPassword, masterKey, kdfParams),
      kekSalt,
      kdfParams,
      dekWrapped,
    };
  } finally {
    wipe(dek);
  }
}
