import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { recoveryCodes, settings, users } from "@/db/schema";
import { encrypt } from "@/lib/crypto/aead";
import {
  provisionUser,
  unlock,
  type UserKeys,
} from "@/lib/crypto/envelope";
import { DEFAULT_KDF_PARAMS, parseKdfParams, verifyPassword } from "@/lib/crypto/kdf";
import { generateRecoveryCodes, matchRecoveryCode } from "@/lib/crypto/recovery";
import { generateTotpSecret, verifyTotp } from "@/lib/crypto/totp";
import { decryptString } from "@/lib/crypto/aead";
import { env, masterKey } from "@/lib/env";

export const MIN_PASSWORD_LENGTH = 12;

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_CREDENTIALS"
      | "ACCOUNT_EXISTS"
      | "LOCKED"
      | "WEAK_PASSWORD"
      | "NO_TOTP",
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Creates the one account this instance holds.
 *
 * Refuses to run a second time. Single-user was a deliberate choice, and an
 * open setup route on a self-hosted app is how a journal ends up with an
 * uninvited second owner.
 */
export async function createInitialAccount(
  email: string,
  password: string,
): Promise<{ userId: string; keys: UserKeys; recoveryCodes: string[] }> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      "WEAK_PASSWORD",
    );
  }

  const [existing] = await db.select({ id: users.id }).from(users).limit(1);
  if (existing) {
    throw new AuthError("An account already exists on this instance", "ACCOUNT_EXISTS");
  }

  const { material, keys } = await provisionUser(password, masterKey(), {
    allowBackgroundProcessing: env().ALLOW_BACKGROUND_PROCESSING,
    kdfParams: DEFAULT_KDF_PARAMS,
  });

  const codes = generateRecoveryCodes(masterKey());

  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: material.userId,
      email: email.trim().toLowerCase(),
      passwordHash: material.passwordHash,
      kekSalt: material.kekSalt,
      kdfParams: material.kdfParams,
      dekWrapped: material.dekWrapped,
      dekWrappedMaster: material.dekWrappedMaster,
    });
    await tx.insert(settings).values({ userId: material.userId });
    await tx.insert(recoveryCodes).values(
      codes.fingerprints.map((fingerprint) => ({
        id: randomUUID(),
        userId: material.userId,
        fingerprint,
      })),
    );
  });

  return { userId: material.userId, keys, recoveryCodes: codes.plaintext };
}

export interface PasswordCheck {
  userId: string;
  keys: UserKeys;
  totpEnabled: boolean;
  totpSecret: string | null;
}

/**
 * Verifies a password and recovers the data key.
 *
 * Both checks must pass: the stored hash confirms the password, and unwrapping
 * confirms the key material is intact. They are separate because a database
 * where only one of the two matches has been tampered with.
 */
export async function checkPassword(
  email: string,
  password: string,
): Promise<PasswordCheck> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);

  if (!user) {
    // Burn comparable time so a missing account is not detectable by timing.
    await verifyPassword(
      "$argon2id$v=19$m=524288,t=4,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      password,
      masterKey(),
    );
    throw new AuthError("Invalid email or password", "INVALID_CREDENTIALS");
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AuthError("Account is temporarily locked", "LOCKED");
  }

  if (!(await verifyPassword(user.passwordHash, password, masterKey()))) {
    throw new AuthError("Invalid email or password", "INVALID_CREDENTIALS");
  }

  let keys: UserKeys;
  try {
    keys = await unlock(
      password,
      {
        userId: user.id,
        kekSalt: user.kekSalt,
        kdfParams: parseKdfParams(user.kdfParams),
        dekWrapped: user.dekWrapped,
      },
      masterKey(),
    );
  } catch {
    // The password hash matched but the wrapped key did not open: the row has
    // been altered. Say nothing specific to the caller.
    throw new AuthError("Invalid email or password", "INVALID_CREDENTIALS");
  }

  const totpSecret = user.totpSecretEnc
    ? decryptString(keys.field, user.totpSecretEnc, {
        table: "users",
        column: "totp_secret_enc",
        id: user.id,
      })
    : null;

  return {
    userId: user.id,
    keys,
    totpEnabled: user.totpEnabled,
    totpSecret,
  };
}

/**
 * Checks a TOTP code and burns its time step.
 *
 * Refusing a step that has already been accepted is what makes each code truly
 * single-use — without it, a code glimpsed over your shoulder stays valid for
 * the rest of its thirty-second window.
 */
export async function consumeTotp(
  userId: string,
  secret: string,
  token: string,
): Promise<boolean> {
  const [user] = await db
    .select({ totpLastStep: users.totpLastStep })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return false;

  const result = verifyTotp(secret, token);
  if (!result.valid || result.step === null) return false;

  const lastStep = user.totpLastStep ? BigInt(user.totpLastStep) : -1n;
  if (result.step <= lastStep) return false;

  await db
    .update(users)
    .set({ totpLastStep: result.step.toString() })
    .where(eq(users.id, userId));
  return true;
}

/** Consumes one unused recovery code, returning false if none matches. */
export async function consumeRecoveryCode(
  userId: string,
  submitted: string,
): Promise<boolean> {
  const rows = await db
    .select()
    .from(recoveryCodes)
    .where(eq(recoveryCodes.userId, userId));

  const unused = rows.filter((row) => row.usedAt === null);
  const index = matchRecoveryCode(
    submitted,
    unused.map((row) => row.fingerprint),
    masterKey(),
  );
  if (index === -1) return false;

  await db
    .update(recoveryCodes)
    .set({ usedAt: new Date() })
    .where(eq(recoveryCodes.id, unused[index]!.id));
  return true;
}

/**
 * Begins TOTP enrolment. The secret is stored encrypted immediately but stays
 * inactive until a first correct code proves the authenticator was set up —
 * otherwise a mis-scanned QR code would lock the owner out of their own journal.
 */
export async function beginTotpEnrolment(
  userId: string,
  keys: UserKeys,
): Promise<string> {
  const secret = generateTotpSecret();
  await db
    .update(users)
    .set({
      totpSecretEnc: encrypt(keys.field, secret, {
        table: "users",
        column: "totp_secret_enc",
        id: userId,
      }),
      totpEnabled: false,
    })
    .where(eq(users.id, userId));
  return secret;
}

export async function completeTotpEnrolment(
  userId: string,
  secret: string,
  token: string,
): Promise<boolean> {
  if (!(await consumeTotp(userId, secret, token))) return false;
  await db.update(users).set({ totpEnabled: true }).where(eq(users.id, userId));
  return true;
}
