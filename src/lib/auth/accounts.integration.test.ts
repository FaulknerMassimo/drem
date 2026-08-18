/**
 * End-to-end verification against a real Postgres.
 *
 * The unit suite proves the crypto is correct in isolation; this proves the
 * whole path holds together once data actually lands in the database — and,
 * most importantly, that what lands there is unreadable.
 *
 * Requires: npm run dev:up
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  attachments,
  dreams,
  insights,
  nights,
  recoveryCodes,
  settings,
  tags,
  users,
} from "@/db/schema";
import { decryptString, encrypt } from "@/lib/crypto/aead";
import { totp } from "@/lib/crypto/totp";
import { tagFingerprint } from "@/lib/journal/tags";
import { normalizeRecoveryCode } from "@/lib/crypto/recovery";
import {
  AuthError,
  beginTotpEnrolment,
  checkPassword,
  completeTotpEnrolment,
  consumeRecoveryCode,
  consumeTotp,
  createInitialAccount,
} from "./accounts";

const EMAIL = "dreamer@example.com";
const PASSWORD = "a sufficiently long passphrase";

/**
 * A distinctive phrase that must never appear anywhere in a database dump.
 * Deliberately unlikely to collide with anything Postgres emits on its own.
 */
const CANARY = "zarquon-flying-over-the-cathedral-of-bees";

async function wipeDatabase() {
  await db.execute(
    sql`truncate table ${users}, ${nights}, ${dreams}, ${tags}, ${attachments}, ${insights} restart identity cascade`,
  );
}

afterAll(wipeDatabase);

describe("account setup", () => {
  beforeEach(wipeDatabase);

  it("creates the account, its settings row and its recovery codes", async () => {
    const account = await createInitialAccount(EMAIL, PASSWORD);

    expect(account.recoveryCodes).toHaveLength(10);
    const [stored] = await db.select().from(users).where(eq(users.id, account.userId));
    expect(stored?.email).toBe(EMAIL);
    expect(stored?.totpEnabled).toBe(false);

    const [setting] = await db.select().from(settings).where(eq(settings.userId, account.userId));
    expect(setting).toBeDefined();
    expect(await db.select().from(recoveryCodes)).toHaveLength(10);
  });

  it("refuses a second account on a single-user instance", async () => {
    await createInitialAccount(EMAIL, PASSWORD);
    await expect(createInitialAccount("someone@else.com", PASSWORD)).rejects.toThrow(AuthError);
  });

  it("refuses a short password", async () => {
    await expect(createInitialAccount(EMAIL, "short")).rejects.toThrow(/at least/);
  });

  it("stores no plaintext key material on the user row", async () => {
    const account = await createInitialAccount(EMAIL, PASSWORD);
    const [stored] = await db.select().from(users).where(eq(users.id, account.userId));
    expect(stored!.dekWrapped.includes(account.keys.field)).toBe(false);
    // Background processing is off by default, so there is no second wrap.
    expect(stored!.dekWrappedMaster).toBeNull();
  });
});

describe("login", () => {
  beforeEach(wipeDatabase);

  it("recovers the same data key the account was created with", async () => {
    const account = await createInitialAccount(EMAIL, PASSWORD);
    const check = await checkPassword(EMAIL, PASSWORD);
    expect(check.userId).toBe(account.userId);
    expect(check.keys.field.equals(account.keys.field)).toBe(true);
  });

  it("is case-insensitive about the email", async () => {
    await createInitialAccount(EMAIL, PASSWORD);
    await expect(checkPassword("  DREAMER@Example.COM ", PASSWORD)).resolves.toBeDefined();
  });

  it("rejects a wrong password", async () => {
    await createInitialAccount(EMAIL, PASSWORD);
    await expect(checkPassword(EMAIL, "not the passphrase")).rejects.toThrow(AuthError);
  });

  it("gives an unknown account the same error as a wrong password", async () => {
    await createInitialAccount(EMAIL, PASSWORD);
    const unknown = await checkPassword("nobody@example.com", PASSWORD).catch((e) => e);
    const wrong = await checkPassword(EMAIL, "wrong").catch((e) => e);
    expect(unknown.message).toBe(wrong.message);
    expect(unknown.code).toBe(wrong.code);
  });

  it("refuses a login while the account is locked", async () => {
    await createInitialAccount(EMAIL, PASSWORD);
    await db.update(users).set({ lockedUntil: new Date(Date.now() + 60_000) });
    await expect(checkPassword(EMAIL, PASSWORD)).rejects.toThrow(/locked/);
  });

  it("refuses to open a tampered wrapped key even with the right password", async () => {
    // The password hash still verifies; the key material has been altered.
    const account = await createInitialAccount(EMAIL, PASSWORD);
    const [stored] = await db.select().from(users).where(eq(users.id, account.userId));
    const corrupted = Buffer.from(stored!.dekWrapped);
    corrupted[20] = corrupted[20]! ^ 0x01;
    await db.update(users).set({ dekWrapped: corrupted }).where(eq(users.id, account.userId));

    await expect(checkPassword(EMAIL, PASSWORD)).rejects.toThrow(AuthError);
  });
});

describe("two-factor authentication", () => {
  beforeEach(wipeDatabase);

  it("stays disabled until a first correct code proves the app was set up", async () => {
    const account = await createInitialAccount(EMAIL, PASSWORD);
    const secret = await beginTotpEnrolment(account.userId, account.keys);

    const [midEnrolment] = await db.select().from(users).where(eq(users.id, account.userId));
    expect(midEnrolment!.totpEnabled).toBe(false);
    expect(midEnrolment!.totpSecretEnc).not.toBeNull();

    expect(await completeTotpEnrolment(account.userId, secret, totp(secret))).toBe(true);
    const [enrolled] = await db.select().from(users).where(eq(users.id, account.userId));
    expect(enrolled!.totpEnabled).toBe(true);
  });

  it("stores the TOTP secret encrypted, readable only with the data key", async () => {
    const account = await createInitialAccount(EMAIL, PASSWORD);
    const secret = await beginTotpEnrolment(account.userId, account.keys);

    const [stored] = await db.select().from(users).where(eq(users.id, account.userId));
    expect(stored!.totpSecretEnc!.toString("utf8")).not.toContain(secret);

    const check = await checkPassword(EMAIL, PASSWORD);
    expect(check.totpSecret).toBe(secret);
  });

  it("refuses a wrong code", async () => {
    const account = await createInitialAccount(EMAIL, PASSWORD);
    const secret = await beginTotpEnrolment(account.userId, account.keys);
    expect(await completeTotpEnrolment(account.userId, secret, "000000")).toBe(false);
  });

  it("burns a code so it cannot be replayed inside its own window", async () => {
    // The whole point of tracking the last accepted step: a code seen over
    // your shoulder must not still work seconds later.
    const account = await createInitialAccount(EMAIL, PASSWORD);
    const secret = await beginTotpEnrolment(account.userId, account.keys);
    const code = totp(secret);

    expect(await consumeTotp(account.userId, secret, code)).toBe(true);
    expect(await consumeTotp(account.userId, secret, code)).toBe(false);
  });
});

describe("recovery codes", () => {
  beforeEach(wipeDatabase);

  it("accepts a code once and then never again", async () => {
    const account = await createInitialAccount(EMAIL, PASSWORD);
    const code = account.recoveryCodes[0]!;

    expect(await consumeRecoveryCode(account.userId, code)).toBe(true);
    expect(await consumeRecoveryCode(account.userId, code)).toBe(false);
  });

  it("accepts a code typed without its dashes", async () => {
    const account = await createInitialAccount(EMAIL, PASSWORD);
    const sloppy = normalizeRecoveryCode(account.recoveryCodes[1]!).toLowerCase();
    expect(await consumeRecoveryCode(account.userId, sloppy)).toBe(true);
  });

  it("rejects an invented code", async () => {
    const account = await createInitialAccount(EMAIL, PASSWORD);
    expect(await consumeRecoveryCode(account.userId, "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FF")).toBe(false);
  });

  it("leaves the other codes usable", async () => {
    const account = await createInitialAccount(EMAIL, PASSWORD);
    await consumeRecoveryCode(account.userId, account.recoveryCodes[0]!);
    expect(await consumeRecoveryCode(account.userId, account.recoveryCodes[1]!)).toBe(true);
  });
});

describe("what a stolen database actually contains", () => {
  beforeEach(wipeDatabase);

  /** Writes a full entry the way the app will, then dumps the whole database. */
  async function seedAndDump(): Promise<string> {
    const account = await createInitialAccount(EMAIL, PASSWORD);
    const { userId, keys } = account;

    const nightId = randomUUID();
    const dreamId = randomUUID();
    const tagId = randomUUID();

    await db.insert(nights).values({
      id: nightId,
      userId,
      date: "2026-08-17",
      techniques: ["mild", "wbtb"],
      notesEnc: encrypt(keys.field, `notes: ${CANARY}`, {
        table: "nights",
        column: "notes_enc",
        id: nightId,
      }),
    });

    await db.insert(dreams).values({
      id: dreamId,
      userId,
      nightId,
      dreamDate: "2026-08-17",
      titleEnc: encrypt(keys.field, CANARY, {
        table: "dreams",
        column: "title_enc",
        id: dreamId,
      }),
      bodyEnc: encrypt(keys.field, `I dreamt of ${CANARY} and became lucid.`, {
        table: "dreams",
        column: "body_enc",
        id: dreamId,
      }),
      isLucid: true,
      lucidity: 4,
      wordCount: 8,
    });

    await db.insert(tags).values({
      id: tagId,
      userId,
      nameEnc: encrypt(keys.field, CANARY, {
        table: "tags",
        column: "name_enc",
        id: tagId,
      }),
      nameBidx: tagFingerprint(keys, CANARY),
    });

    return execFileSync(
      "docker",
      ["exec", "drem-db-1", "pg_dump", "-U", "drem", "-d", "drem"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  }

  it("contains no dream content anywhere in a full pg_dump", async () => {
    const dump = await seedAndDump();
    // The single most important assertion in this codebase.
    expect(dump).not.toContain(CANARY);
    expect(dump.toLowerCase()).not.toContain("cathedral of bees");
    expect(dump).not.toContain("became lucid");
  });

  it("contains no password or key material in a full pg_dump", async () => {
    const dump = await seedAndDump();
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain(process.env.MASTER_KEY);
  });

  it("does contain the structural metadata the heatmap needs", async () => {
    // The trade-off, made explicit: dates and lucidity are readable by design.
    const dump = await seedAndDump();
    expect(dump).toContain("2026-08-17");
    expect(dump).toContain("mild");
  });

  it("still round-trips the content for someone holding the key", async () => {
    await seedAndDump();
    const { keys } = await checkPassword(EMAIL, PASSWORD);
    const [dream] = await db.select().from(dreams).limit(1);

    expect(
      decryptString(keys.field, dream!.titleEnc!, {
        table: "dreams",
        column: "title_enc",
        id: dream!.id,
      }),
    ).toBe(CANARY);
  });

  it("lets tags be found by blind index without decrypting them", async () => {
    await seedAndDump();
    const { keys } = await checkPassword(EMAIL, PASSWORD);

    const found = await db
      .select()
      .from(tags)
      .where(eq(tags.nameBidx, tagFingerprint(keys, CANARY)));

    expect(found).toHaveLength(1);
    expect(
      decryptString(keys.field, found[0]!.nameEnc, {
        table: "tags",
        column: "name_enc",
        id: found[0]!.id,
      }),
    ).toBe(CANARY);
  });
});
