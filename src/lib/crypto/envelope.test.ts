import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptString, encrypt, DecryptionError, type Aad } from "./aead";
import {
  changePassword,
  deriveUserKeys,
  provisionUser,
  unlock,
  unlockForBackground,
  unwrapDek,
} from "./envelope";
import {
  DEFAULT_KDF_PARAMS,
  deriveKek,
  generateSalt,
  hashPassword,
  parseKdfParams,
  verifyPassword,
} from "./kdf";

const masterKey = randomBytes(32);
/**
 * Deliberately at the OWASP floor rather than the production default: these
 * tests exercise the scheme, not the work factor. The real defaults are
 * asserted separately below.
 */
const FAST_KDF = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

/**
 * The budget for a test that runs the production work factor.
 *
 * `changePassword` deliberately re-derives at `DEFAULT_KDF_PARAMS` — 512 MiB
 * and four passes — and a test that then unlocks under the rotated parameters
 * pays for four of those. That is one to four seconds each depending on what
 * else the machine is doing, so the default five-second budget fails on a
 * laptop under load and passes on the same laptop idle. Raising it only where
 * the real cost is the point keeps the rest of the suite honest about being
 * fast; lowering `DEFAULT_KDF_PARAMS` to suit the tests would be testing
 * something nobody ships.
 */
const REAL_COST_MS = 60_000;
const password = "correct horse battery staple";
const dreamAad: Aad = { table: "dreams", column: "body", id: "dream-1" };
const secret = "I noticed my hands had six fingers and realised I was dreaming.";

describe("key derivation", () => {
  it("derives the same KEK from the same inputs", async () => {
    const salt = generateSalt();
    const a = await deriveKek(password, salt, masterKey, FAST_KDF);
    const b = await deriveKek(password, salt, masterKey, FAST_KDF);
    expect(a.equals(b)).toBe(true);
    expect(a).toHaveLength(32);
  });

  it("derives a different KEK for a different salt", async () => {
    const a = await deriveKek(password, generateSalt(), masterKey, FAST_KDF);
    const b = await deriveKek(password, generateSalt(), masterKey, FAST_KDF);
    expect(a.equals(b)).toBe(false);
  });

  it("derives a different KEK under a different MASTER_KEY", async () => {
    // This is what makes the environment file a genuine second factor.
    const salt = generateSalt();
    const a = await deriveKek(password, salt, masterKey, FAST_KDF);
    const b = await deriveKek(password, salt, randomBytes(32), FAST_KDF);
    expect(a.equals(b)).toBe(false);
  });

  it("splits the data key into unrelated per-purpose keys", () => {
    const keys = deriveUserKeys(randomBytes(32));
    const distinct = new Set(
      [keys.field, keys.blob, keys.index, keys.vector].map((k) =>
        k.toString("hex"),
      ),
    );
    expect(distinct.size).toBe(4);
  });
});

describe("password verification", () => {
  it("accepts the right password and rejects the wrong one", async () => {
    const stored = await hashPassword(password, masterKey, FAST_KDF);
    expect(await verifyPassword(stored, password, masterKey)).toBe(true);
    expect(await verifyPassword(stored, "wrong", masterKey)).toBe(false);
  });

  it("rejects the right password under the wrong MASTER_KEY", async () => {
    const stored = await hashPassword(password, masterKey, FAST_KDF);
    expect(await verifyPassword(stored, password, randomBytes(32))).toBe(false);
  });

  it("treats a corrupt stored hash as a failed login, not a crash", async () => {
    expect(await verifyPassword("not-a-phc-string", password, masterKey)).toBe(
      false,
    );
  });
});

describe("account provisioning", () => {
  it("unlocks the journal with the right password", async () => {
    const { material, keys } = await provisionUser(password, masterKey, { kdfParams: FAST_KDF });
    const ciphertext = encrypt(keys.field, secret, dreamAad);

    const reopened = await unlock(password, material, masterKey);
    expect(decryptString(reopened.field, ciphertext, dreamAad)).toBe(secret);
  });

  it("refuses the wrong password", async () => {
    const { material } = await provisionUser(password, masterKey, { kdfParams: FAST_KDF });
    await expect(unwrapDek("wrong", material, masterKey)).rejects.toThrow(
      DecryptionError,
    );
  });

  it("refuses the right password without MASTER_KEY", async () => {
    // A stolen database on its own must be inert.
    const { material } = await provisionUser(password, masterKey, { kdfParams: FAST_KDF });
    await expect(
      unwrapDek(password, material, randomBytes(32)),
    ).rejects.toThrow(DecryptionError);
  });

  it("never stores the data key in the clear", async () => {
    const { material, keys } = await provisionUser(password, masterKey, { kdfParams: FAST_KDF });
    expect(material.dekWrapped.includes(keys.field)).toBe(false);
    expect(material.dekWrapped.includes(keys.index)).toBe(false);
  });

  it("gives two accounts with the same password different keys", async () => {
    const a = await provisionUser(password, masterKey, { kdfParams: FAST_KDF });
    const b = await provisionUser(password, masterKey, { kdfParams: FAST_KDF });
    expect(a.keys.field.equals(b.keys.field)).toBe(false);
  });
});

describe("background processing", () => {
  it("is unavailable unless explicitly enabled", async () => {
    const { material } = await provisionUser(password, masterKey, { kdfParams: FAST_KDF });
    expect(material.dekWrappedMaster).toBeNull();
    expect(() => unlockForBackground(material, masterKey)).toThrow(
      /Background processing is disabled/,
    );
  });

  it("yields the same keys as a password unlock when enabled", async () => {
    const { material, keys } = await provisionUser(password, masterKey, {
      allowBackgroundProcessing: true,
      kdfParams: FAST_KDF,
    });
    const headless = unlockForBackground(material, masterKey);
    expect(headless.field.equals(keys.field)).toBe(true);
  });
});

describe("password change", () => {
  it(
    "keeps existing entries readable without re-encrypting them",
    async () => {
      const { material, keys } = await provisionUser(password, masterKey, { kdfParams: FAST_KDF });
      const ciphertext = encrypt(keys.field, secret, dreamAad);

      const updated = await changePassword(
        password,
        "a new and much longer passphrase",
        material,
        masterKey,
      );
      const rotated = { ...material, ...updated };

      const reopened = await unlock(
        "a new and much longer passphrase",
        rotated,
        masterKey,
      );
      // Same data key underneath: the untouched ciphertext still decrypts.
      expect(decryptString(reopened.field, ciphertext, dreamAad)).toBe(secret);
      expect(reopened.field.equals(keys.field)).toBe(true);
    },
    REAL_COST_MS,
  );

  it(
    "invalidates the old password",
    async () => {
      const { material } = await provisionUser(password, masterKey, { kdfParams: FAST_KDF });
      const updated = await changePassword(password, "new one", material, masterKey);
      const rotated = { ...material, ...updated };

      await expect(unwrapDek(password, rotated, masterKey)).rejects.toThrow(
        DecryptionError,
      );
      expect(await verifyPassword(rotated.passwordHash, password, masterKey)).toBe(
        false,
      );
    },
    REAL_COST_MS,
  );

  it(
    "refuses to rotate without the current password",
    async () => {
      const { material } = await provisionUser(password, masterKey, { kdfParams: FAST_KDF });
      await expect(
        changePassword("guess", "new one", material, masterKey),
      ).rejects.toThrow(DecryptionError);
    },
    REAL_COST_MS,
  );
});

describe("cost parameters", () => {
  it("ships defaults well above the OWASP Argon2id floor", () => {
    expect(DEFAULT_KDF_PARAMS.memoryCost).toBeGreaterThanOrEqual(19456);
    expect(DEFAULT_KDF_PARAMS.timeCost).toBeGreaterThanOrEqual(2);
    expect(() => parseKdfParams(DEFAULT_KDF_PARAMS)).not.toThrow();
  });

  it("records the parameters an account was provisioned under", async () => {
    const { material } = await provisionUser(password, masterKey, {
      kdfParams: FAST_KDF,
    });
    expect(material.kdfParams).toEqual(FAST_KDF);
  });

  it("cannot unlock an account under different parameters", async () => {
    // This is precisely why the parameters are stored per account: raising the
    // defaults without replaying the originals would brick every entry.
    const { material } = await provisionUser(password, masterKey, {
      kdfParams: FAST_KDF,
    });
    const drifted = {
      ...material,
      kdfParams: { ...FAST_KDF, timeCost: FAST_KDF.timeCost + 1 },
    };
    await expect(unwrapDek(password, drifted, masterKey)).rejects.toThrow(
      DecryptionError,
    );
  });

  it(
    "upgrades to the current defaults on password change",
    async () => {
      const { material } = await provisionUser(password, masterKey, {
        kdfParams: FAST_KDF,
      });
      const updated = await changePassword(password, "a longer one", material, masterKey);
      expect(updated.kdfParams).toEqual(DEFAULT_KDF_PARAMS);
    },
    REAL_COST_MS,
  );

  it("refuses parameters weaker than the floor, even from the database", async () => {
    // A tampered user row must not be able to downgrade the derivation.
    expect(() => parseKdfParams({ memoryCost: 8, timeCost: 1, parallelism: 1 })).toThrow();
    expect(() => parseKdfParams({ memoryCost: 19456, timeCost: 1, parallelism: 1 })).toThrow();
    await expect(
      provisionUser(password, masterKey, {
        kdfParams: { memoryCost: 1024, timeCost: 1, parallelism: 1 },
      }),
    ).rejects.toThrow();
  });
});
