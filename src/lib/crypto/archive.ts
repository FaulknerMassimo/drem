/**
 * The passphrase-sealed backup container.
 *
 * Everything else in this directory protects the journal with *two* factors:
 * the password and MASTER_KEY, neither of which is enough alone. A backup
 * cannot work that way. The whole point of one is to survive the machine it was
 * taken from, and an archive that still needed MASTER_KEY would be lost by
 * exactly the accident it exists to insure against — at which point it adds
 * nothing a `pg_dump` did not already give you.
 *
 * So this is deliberately weaker, and it is the only thing in the codebase that
 * is: **an archive is protected by its passphrase alone.** Anyone holding the
 * file can attack it offline with nothing else, which is why the KDF runs at
 * the full cost parameters, why the passphrase has a length floor, and why the
 * export screen says so in as many words before it hands the file over.
 *
 * Wire format, so a future reader can open one without this code:
 *
 *   magic       16 bytes  "drem-archive-v1\n"
 *   headerLen    4 bytes  big-endian uint32
 *   header       N bytes  UTF-8 JSON: version, kdf params, salt, id, createdAt
 *   payload      rest     AES-256-GCM as written by `aead.encrypt`
 *
 * The header is plaintext because it has to be: it says how to derive the key.
 * It is authenticated all the same — the payload's AAD is a digest of the exact
 * header bytes, so an attacker cannot edit the recorded cost parameters, or
 * splice one archive's header onto another's payload, without decryption
 * failing outright.
 */
import { hashRaw } from "@node-rs/argon2";
import { createHash, hkdfSync, randomUUID } from "node:crypto";
import { z } from "zod";
import { decrypt, encrypt, DecryptionError, type Aad } from "./aead";
import {
  DEFAULT_KDF_PARAMS,
  KEY_BYTES,
  SALT_BYTES,
  argon2Options,
  generateSalt,
  parseKdfParams,
  wipe,
  type KdfParams,
} from "./kdf";

export const ARCHIVE_MAGIC = "drem-archive-v1\n";
export const ARCHIVE_VERSION = 1;

const MAGIC_BYTES = Buffer.from(ARCHIVE_MAGIC, "utf8");
const LENGTH_BYTES = 4;

/** Bounded so a hostile file cannot ask us to allocate a header of any size. */
const MAX_HEADER_BYTES = 4096;

/**
 * One factor means the passphrase is the entire defence, so it is held to a
 * higher bar than a login password would be — a login is also rate-limited and
 * peppered with MASTER_KEY, and an offline attack on a file is neither.
 *
 * A floor on length is a weak proxy for entropy, and it is the only one that
 * can be checked without lying to the user about how strong their choice is.
 * The UI asks for a passphrase of several words rather than a password.
 */
export const MIN_PASSPHRASE_LENGTH = 12;

/** Domain separation: an archive key must never collide with a KEK. */
const ARCHIVE_INFO = "drem:archive:v1";

const headerSchema = z.object({
  version: z.literal(ARCHIVE_VERSION),
  kdf: z.literal("argon2id"),
  params: z.object({
    memoryCost: z.number().int(),
    timeCost: z.number().int(),
    parallelism: z.number().int(),
  }),
  salt: z.string(),
  id: z.string(),
  createdAt: z.string(),
});

export type ArchiveHeader = z.infer<typeof headerSchema>;

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

/**
 * Binds the ciphertext to the exact header bytes that describe it.
 *
 * The `id` slot of the AAD is a digest rather than a row's primary key because
 * an archive has no row — the thing this ciphertext must be inseparable from is
 * its own header. Same rule as everywhere else, applied to a file.
 */
function payloadAad(headerBytes: Buffer): Aad {
  return {
    table: "archive",
    column: "payload",
    id: createHash("sha256").update(headerBytes).digest("hex"),
  };
}

/**
 * Derives the archive key from the passphrase alone.
 *
 * No `secret` is passed to Argon2, unlike every other derivation here. That
 * omission *is* the feature — see the note at the top of the file — and it is
 * why the default cost parameters are not negotiable downwards.
 */
async function deriveArchiveKey(
  passphrase: string,
  salt: Buffer,
  params: KdfParams,
): Promise<Buffer> {
  const ikm = await hashRaw(passphrase, {
    ...argon2Options(params),
    salt,
    outputLen: KEY_BYTES,
  });
  const derived = hkdfSync("sha256", ikm, salt, ARCHIVE_INFO, KEY_BYTES);
  ikm.fill(0);
  return Buffer.from(derived);
}

export function assertUsablePassphrase(passphrase: string): void {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new ArchiveError(
      `A backup passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters — it is the only thing protecting the file.`,
    );
  }
}

export async function sealArchive(
  passphrase: string,
  plaintext: Buffer | string,
  options: { params?: KdfParams; now?: Date } = {},
): Promise<Buffer> {
  assertUsablePassphrase(passphrase);

  // Parsed rather than trusted, so a caller cannot quietly seal an archive
  // under parameters below the floor the rest of the app enforces.
  const params = parseKdfParams(options.params ?? DEFAULT_KDF_PARAMS);
  const salt = generateSalt();

  const header: ArchiveHeader = {
    version: ARCHIVE_VERSION,
    kdf: "argon2id",
    params,
    salt: salt.toString("base64"),
    id: randomUUID(),
    createdAt: (options.now ?? new Date()).toISOString(),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  if (headerBytes.length > MAX_HEADER_BYTES) {
    throw new ArchiveError("Archive header is implausibly large");
  }

  const key = await deriveArchiveKey(passphrase, salt, params);
  try {
    const payload = encrypt(key, plaintext, payloadAad(headerBytes));
    const length = Buffer.alloc(LENGTH_BYTES);
    length.writeUInt32BE(headerBytes.length);
    return Buffer.concat([MAGIC_BYTES, length, headerBytes, payload]);
  } finally {
    wipe(key);
  }
}

/** Reads the header without needing the passphrase — for showing what a file is. */
export function readArchiveHeader(file: Buffer): ArchiveHeader {
  if (file.length < MAGIC_BYTES.length + LENGTH_BYTES) {
    throw new ArchiveError("That file is not a drem archive.");
  }
  if (!file.subarray(0, MAGIC_BYTES.length).equals(MAGIC_BYTES)) {
    throw new ArchiveError("That file is not a drem archive.");
  }

  const headerLength = file.readUInt32BE(MAGIC_BYTES.length);
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) {
    throw new ArchiveError("That archive's header is unreadable.");
  }

  const start = MAGIC_BYTES.length + LENGTH_BYTES;
  if (file.length < start + headerLength) {
    throw new ArchiveError("That archive is truncated.");
  }

  const parsed = headerSchema.safeParse(
    tryJson(file.subarray(start, start + headerLength).toString("utf8")),
  );
  if (!parsed.success) {
    throw new ArchiveError("That archive was written by a version this cannot read.");
  }

  // The floor applies to a file arriving from outside just as it does to the
  // database: an archive claiming trivial cost parameters is refused rather
  // than obligingly derived under them.
  try {
    parseKdfParams(parsed.data.params);
  } catch {
    throw new ArchiveError("That archive asks for a key derivation this will not perform.");
  }
  if (Buffer.from(parsed.data.salt, "base64").length !== SALT_BYTES) {
    throw new ArchiveError("That archive's header is unreadable.");
  }

  return parsed.data;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function openArchive(passphrase: string, file: Buffer): Promise<Buffer> {
  const header = readArchiveHeader(file);

  /*
   * The AAD is computed over the header's own bytes as they were written, not
   * over a re-serialisation of the parsed object: `JSON.stringify` is not
   * guaranteed to reproduce key order or spacing, and a digest over a
   * re-encoding would fail to match a file this very code wrote.
   */
  const start = MAGIC_BYTES.length + LENGTH_BYTES;
  const headerLength = file.readUInt32BE(MAGIC_BYTES.length);
  const exactHeader = file.subarray(start, start + headerLength);

  const key = await deriveArchiveKey(
    passphrase,
    Buffer.from(header.salt, "base64"),
    header.params,
  );
  try {
    return decrypt(key, file.subarray(start + headerLength), payloadAad(exactHeader));
  } catch (error) {
    // A wrong passphrase and a tampered file are indistinguishable on purpose,
    // exactly as in `aead.decrypt`.
    if (error instanceof DecryptionError) {
      throw new ArchiveError("Wrong passphrase, or this archive has been altered.");
    }
    throw error;
  } finally {
    wipe(key);
  }
}
