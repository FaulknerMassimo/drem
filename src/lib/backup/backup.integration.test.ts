/**
 * Backup and restore, end to end against a real Postgres.
 *
 * Two things can only be proved here. The first is the one the whole feature
 * has to earn: that an archive written out of a live journal reproduces that
 * journal when read back, ratings, tags, notes and ordering included — a backup
 * that quietly drops a column is worse than no backup, because it is not
 * discovered until it is needed.
 *
 * The second is the assertion this architecture exists for, applied to a file
 * instead of a database: **not one word of dream content may appear in the
 * bytes an archive is made of.** `accounts.integration.test.ts` makes it over a
 * `pg_dump`; this makes it over the thing the app hands to the browser and the
 * owner copies onto a USB stick — which is, if anything, the copy more likely
 * to end up somewhere it should not.
 *
 * Requires: npm run dev:up
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { attachments, dreamTags, dreams, insights, nights, tags, users } from "@/db/schema";
import { createInitialAccount } from "@/lib/auth/accounts";
import { ArchiveError, openArchive } from "@/lib/crypto/archive";
import type { UserKeys } from "@/lib/crypto/envelope";
import { createDream, dreamsForNight, getDream } from "@/lib/journal/dreams";
import { getNight, saveNight } from "@/lib/journal/nights";
import { journalTotals } from "@/lib/journal/stats";
import type { DreamInput, NightInput } from "@/lib/journal/validation";
import { parseDocument } from "./document";
import { buildDocument, exportArchive } from "./export";
import { restoreArchive } from "./restore";

const EMAIL = "dreamer@example.com";
const PASSWORD = "a sufficiently long passphrase";
const ARCHIVE_PASSPHRASE = "a different sufficiently long passphrase";

/**
 * Every one of these must be absent from the archive bytes. Distinctive enough
 * that a hit anywhere is unambiguous, and spread across every encrypted field
 * the archive carries: title, body, night notes, and a tag name.
 */
const CANARIES = {
  title: "zarquon-cathedral",
  body: "the-clock-had-no-hands-and-the-bees-were-singing",
  notes: "slept-badly-after-the-argument-with-marguerite",
  tag: "vespertine-recursion",
};

let userId: string;
let keys: UserKeys;

async function wipeAll() {
  await db.execute(
    sql`truncate table ${users}, ${nights}, ${dreams}, ${tags}, ${attachments}, ${insights} restart identity cascade`,
  );
}

async function wipeJournal() {
  await db.execute(
    sql`truncate table ${nights}, ${dreams}, ${tags}, ${dreamTags}, ${attachments} restart identity cascade`,
  );
}

function dreamInput(overrides: Partial<DreamInput> = {}): DreamInput {
  return {
    nightDate: "2026-08-17",
    title: null,
    body: null,
    lucidity: 0,
    vividness: null,
    control: null,
    recallClarity: null,
    emotionalValence: null,
    isNightmare: false,
    isRecurring: false,
    isFragment: false,
    isDraft: false,
    tags: [],
    ...overrides,
  };
}

function nightInput(overrides: Partial<NightInput> = {}): NightInput {
  return {
    date: "2026-08-17",
    bedTime: null,
    wakeTime: null,
    wbtbTime: null,
    sleepQuality: null,
    techniques: [],
    noRecall: false,
    notes: null,
    ...overrides,
  };
}

/** A journal with something in every field the archive is supposed to carry. */
async function seedJournal() {
  await saveNight(
    userId,
    keys,
    nightInput({
      date: "2026-08-17",
      bedTime: "23:30",
      wakeTime: "07:15",
      wbtbTime: "04:00",
      sleepQuality: 3,
      techniques: ["mild", "wbtb"],
      notes: CANARIES.notes,
    }),
  );

  await createDream(
    userId,
    keys,
    dreamInput({
      nightDate: "2026-08-17",
      title: CANARIES.title,
      body: CANARIES.body,
      lucidity: 4,
      vividness: 5,
      control: 3,
      recallClarity: 4,
      emotionalValence: 2,
      isRecurring: true,
      tags: [CANARIES.tag, "flying"],
    }),
  );

  // A second night, with a night that was journalled and recalled nothing.
  await saveNight(userId, keys, nightInput({ date: "2026-08-18", noRecall: true }));
}

beforeAll(async () => {
  await wipeAll();
  // Argon2id at the real cost parameters is slow, so the account is made once.
  const account = await createInitialAccount(EMAIL, PASSWORD);
  userId = account.userId;
  keys = account.keys;
});

afterAll(wipeAll);
beforeEach(wipeJournal);

describe("the archive file", () => {
  it("holds not one word of the journal in its bytes", async () => {
    await seedJournal();
    const { file } = await exportArchive(userId, keys, ARCHIVE_PASSPHRASE);

    // latin1 rather than utf8: it maps every byte to a character, so a match
    // cannot be missed because some run of bytes was not valid UTF-8.
    const haystack = file.toString("latin1");
    for (const [field, canary] of Object.entries(CANARIES)) {
      expect(haystack, `${field} leaked into the archive`).not.toContain(canary);
    }

    // Nor the passphrases, nor anything that reads like the journal's shape.
    expect(haystack).not.toContain(ARCHIVE_PASSPHRASE);
    expect(haystack).not.toContain(PASSWORD);
    expect(haystack).not.toContain("drem-journal");
  });

  it("is refused by the wrong passphrase", async () => {
    await seedJournal();
    const { file } = await exportArchive(userId, keys, ARCHIVE_PASSPHRASE);
    await expect(openArchive("a wholly different passphrase", file)).rejects.toBeInstanceOf(
      ArchiveError,
    );
  });

  it("opens with its own passphrase and nothing else", async () => {
    await seedJournal();
    const { file, summary } = await exportArchive(userId, keys, ARCHIVE_PASSPHRASE);

    const document = parseDocument(
      (await openArchive(ARCHIVE_PASSPHRASE, file)).toString("utf8"),
    );
    expect(document.dreams).toHaveLength(1);
    expect(document.dreams[0]!.title).toBe(CANARIES.title);
    expect(summary.dreams).toBe(1);
    expect(summary.nights).toBe(2);
  });
});

describe("what the archive carries", () => {
  it("keeps every field a night and a dream were written with", async () => {
    await seedJournal();
    const document = await buildDocument(userId, keys);

    const night = document.nights.find((row) => row.date === "2026-08-17")!;
    expect(night.bedTime).toBe("23:30");
    expect(night.wakeTime).toBe("07:15");
    expect(night.wbtbTime).toBe("04:00");
    expect(night.sleepQuality).toBe(3);
    expect(night.techniques).toEqual(["mild", "wbtb"]);
    expect(night.notes).toBe(CANARIES.notes);

    const dream = document.dreams[0]!;
    expect(dream.lucidity).toBe(4);
    expect(dream.vividness).toBe(5);
    expect(dream.control).toBe(3);
    expect(dream.recallClarity).toBe(4);
    expect(dream.emotionalValence).toBe(2);
    expect(dream.isRecurring).toBe(true);
    expect(dream.tags.sort()).toEqual([CANARIES.tag, "flying"].sort());
  });

  it("keeps a night that was journalled with nothing recalled", async () => {
    await seedJournal();
    const document = await buildDocument(userId, keys);
    // The night that proves the habit held is exactly the one with no dream on
    // it; an archive that only carried dreams would lose it.
    expect(document.nights.find((row) => row.date === "2026-08-18")?.noRecall).toBe(true);
  });
});

describe("restoring", () => {
  async function exportThenWipe() {
    await seedJournal();
    const before = await journalTotals(userId);
    const { file } = await exportArchive(userId, keys, ARCHIVE_PASSPHRASE);
    await wipeJournal();
    return { file, before };
  }

  it("reproduces the journal it was taken from", async () => {
    const { file, before } = await exportThenWipe();
    expect((await journalTotals(userId)).dreams).toBe(0);

    const document = parseDocument(
      (await openArchive(ARCHIVE_PASSPHRASE, file)).toString("utf8"),
    );
    const result = await restoreArchive(userId, keys, document);

    expect(result.restoredNights).toBe(2);
    expect(result.restoredDreams).toBe(1);
    expect(await journalTotals(userId)).toEqual(before);

    const restored = (await dreamsForNight(userId, keys, "2026-08-17"))[0]!;
    expect(restored.title).toBe(CANARIES.title);
    expect(restored.body).toBe(CANARIES.body);
    expect(restored.vividness).toBe(5);
    expect(restored.isLucid).toBe(true);
    expect(restored.tags.sort()).toEqual([CANARIES.tag, "flying"].sort());

    const night = await getNight(userId, keys, "2026-08-17");
    expect(night?.notes).toBe(CANARIES.notes);
    expect(night?.techniques).toEqual(["mild", "wbtb"]);
  });

  it("changes nothing the second time it is run", async () => {
    const { file } = await exportThenWipe();
    const document = parseDocument(
      (await openArchive(ARCHIVE_PASSPHRASE, file)).toString("utf8"),
    );

    await restoreArchive(userId, keys, document);
    const afterFirst = await journalTotals(userId);

    const second = await restoreArchive(userId, keys, document);
    expect(second.restoredDreams).toBe(0);
    expect(second.duplicateDreams).toBe(1);
    // The whole point of the fingerprint: a repeated restore is not cumulative.
    expect(await journalTotals(userId)).toEqual(afterFirst);
  });

  it("leaves a night the journal has already moved on from alone", async () => {
    const { file } = await exportThenWipe();
    const document = parseDocument(
      (await openArchive(ARCHIVE_PASSPHRASE, file)).toString("utf8"),
    );

    // The night was rewritten after the backup was taken. The live journal wins.
    await saveNight(
      userId,
      keys,
      nightInput({ date: "2026-08-17", sleepQuality: 1, notes: "rewritten since" }),
    );

    const result = await restoreArchive(userId, keys, document);
    expect(result.existingNights).toBe(1);

    const night = await getNight(userId, keys, "2026-08-17");
    expect(night?.notes).toBe("rewritten since");
    expect(night?.sleepQuality).toBe(1);

    // The dream from the archive is still restored onto it — merging a night's
    // entries is not the same as overwriting the night's own fields.
    expect(await dreamsForNight(userId, keys, "2026-08-17")).toHaveLength(1);
  });

  it("never deletes anything already in the journal", async () => {
    const { file } = await exportThenWipe();
    const document = parseDocument(
      (await openArchive(ARCHIVE_PASSPHRASE, file)).toString("utf8"),
    );

    const written = await createDream(
      userId,
      keys,
      dreamInput({ nightDate: "2026-08-17", body: "written after the backup" }),
    );

    await restoreArchive(userId, keys, document);
    expect((await getDream(userId, keys, written))?.body).toBe("written after the backup");
    expect(await dreamsForNight(userId, keys, "2026-08-17")).toHaveLength(2);
  });

  it("puts a night's entries back in the order they were written", async () => {
    await wipeJournal();
    for (const [index, body] of ["first", "second", "third"].entries()) {
      const id = await createDream(userId, keys, dreamInput({ body }));
      // Stagger the write times, as a real night of three fragments would be.
      await db
        .update(dreams)
        .set({ createdAt: new Date(Date.UTC(2026, 7, 17, 7, index)) })
        .where(eq(dreams.id, id));
    }

    const { file } = await exportArchive(userId, keys, ARCHIVE_PASSPHRASE);
    await wipeJournal();
    await restoreArchive(
      userId,
      keys,
      parseDocument((await openArchive(ARCHIVE_PASSPHRASE, file)).toString("utf8")),
    );

    const restored = await dreamsForNight(userId, keys, "2026-08-17");
    expect(restored.map((entry) => entry.body)).toEqual(["first", "second", "third"]);
  });

  it("restores into an account that has never had a journal", async () => {
    const { file } = await exportThenWipe();
    const document = parseDocument(
      (await openArchive(ARCHIVE_PASSPHRASE, file)).toString("utf8"),
    );

    const result = await restoreArchive(userId, keys, document);
    expect(result.restoredDreams).toBe(1);
    expect(result.duplicateDreams).toBe(0);
    expect(result.existingNights).toBe(0);
  });

  it("exports an empty journal without complaining", async () => {
    const { file, summary } = await exportArchive(userId, keys, ARCHIVE_PASSPHRASE);
    expect(summary.dreams).toBe(0);
    expect(summary.nights).toBe(0);

    const document = parseDocument(
      (await openArchive(ARCHIVE_PASSPHRASE, file)).toString("utf8"),
    );
    expect(await restoreArchive(userId, keys, document)).toMatchObject({
      restoredDreams: 0,
      restoredNights: 0,
    });
  });
});
