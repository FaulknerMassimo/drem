/**
 * The journal, end to end against a real Postgres.
 *
 * The unit suites cover the grid and streak arithmetic in isolation. What can
 * only be proved here is that the encrypted write path holds together: that an
 * entry round-trips through the database, that its ciphertext is welded to the
 * row it belongs to, that tags can be filtered on without being readable, and
 * — the assertion this whole architecture exists for — that none of it can be
 * read out of the stored bytes.
 *
 * Requires: npm run dev:up
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  attachments,
  dreamTags,
  dreams,
  insights,
  nights,
  tags,
  users,
} from "@/db/schema";
import { DecryptionError } from "@/lib/crypto/aead";
import type { UserKeys } from "@/lib/crypto/envelope";
import { createInitialAccount } from "@/lib/auth/accounts";
import { saveAiConfig } from "@/lib/ai/config";
import { emptyRoles } from "@/lib/ai/schema";
import { saveInsight } from "@/lib/ai/insights";
import { createImageAttachment, saveReading } from "@/lib/capture/attachments";
import { dreamFromTranscript } from "@/lib/capture/fields";
import { prepareImage } from "@/lib/capture/image";
import {
  captureDream,
  createDream,
  deleteDream,
  dreamsForNight,
  getDream,
  listDrafts,
  listDreams,
  updateDream,
} from "./dreams";
import { deleteNight, getNight, saveNight } from "./nights";
import { activityForYear, journalTotals, journalledYears } from "./stats";
import { computeStreaks } from "./streaks";
import { listTagCounts } from "./tags";
import type { DreamInput, JournalFilters, NightInput } from "./validation";

const EMAIL = "dreamer@example.com";
const PASSWORD = "a sufficiently long passphrase";

/** Distinctive enough that a hit anywhere is unambiguous. */
const CANARY = "zarquon-flying-over-the-cathedral-of-bees";

let userId: string;
let keys: UserKeys;

async function wipeAll() {
  await db.execute(
    sql`truncate table ${users}, ${nights}, ${dreams}, ${tags}, ${attachments}, ${insights} restart identity cascade`,
  );
}

async function wipeJournal() {
  await db.execute(sql`truncate table ${nights}, ${dreams}, ${tags}, ${attachments} restart identity cascade`);
}

/** A dream input with everything optional left out. */
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

function filters(overrides: Partial<JournalFilters> = {}): JournalFilters {
  return {
    from: null,
    to: null,
    lucidOnly: false,
    nightmaresOnly: false,
    includeFragments: true,
    tag: null,
    sort: "newest",
    page: 1,
    ...overrides,
  };
}

beforeAll(async () => {
  await wipeAll();
  // Argon2id at the real cost parameters is slow, so the account is created
  // once and the journal tables are cleared between tests instead.
  const account = await createInitialAccount(EMAIL, PASSWORD);
  userId = account.userId;
  keys = account.keys;
});

afterAll(wipeAll);
beforeEach(wipeJournal);

describe("writing an entry", () => {
  it("round-trips the text it was given", async () => {
    const id = await createDream(
      userId,
      keys,
      dreamInput({
        title: "The cathedral",
        body: "I was flying over it.\n\nThen I knew.",
        lucidity: 4,
        vividness: 5,
        emotionalValence: 2,
        tags: ["flying", "lucid"],
      }),
    );

    const stored = await getDream(userId, keys, id);
    expect(stored?.title).toBe("The cathedral");
    expect(stored?.body).toBe("I was flying over it.\n\nThen I knew.");
    expect(stored?.vividness).toBe(5);
    expect(stored?.emotionalValence).toBe(2);
    expect(stored?.tags).toEqual(["flying", "lucid"]);
  });

  it("derives the lucid flag from the lucidity rating", async () => {
    // Two controls that can disagree is how a "lucid" filter starts lying.
    const lucid = await createDream(userId, keys, dreamInput({ body: "aware", lucidity: 3 }));
    const plain = await createDream(userId, keys, dreamInput({ body: "not aware", lucidity: 0 }));

    expect((await getDream(userId, keys, lucid))?.isLucid).toBe(true);
    expect((await getDream(userId, keys, plain))?.isLucid).toBe(false);
  });

  it("stores the word count in the clear so statistics need no key", async () => {
    const id = await createDream(
      userId,
      keys,
      dreamInput({ body: "one two three four five" }),
    );
    const [row] = await db.select().from(dreams).where(eq(dreams.id, id));
    expect(row?.wordCount).toBe(5);
  });

  it("creates the night the entry belongs to", async () => {
    await createDream(userId, keys, dreamInput({ body: "something", nightDate: "2026-08-17" }));
    const night = await getNight(userId, keys, "2026-08-17");
    expect(night).not.toBeNull();
  });

  it("stops claiming no recall once a dream lands on the night", async () => {
    await saveNight(userId, keys, {
      date: "2026-08-17",
      bedTime: null,
      wakeTime: null,
      wbtbTime: null,
      sleepQuality: null,
      techniques: ["mild"],
      noRecall: true,
      notes: null,
    });
    expect((await getNight(userId, keys, "2026-08-17"))?.noRecall).toBe(true);

    await createDream(userId, keys, dreamInput({ body: "it came back after all" }));
    expect((await getNight(userId, keys, "2026-08-17"))?.noRecall).toBe(false);
  });

  it("moves the entry to another night when its date is changed", async () => {
    const id = await createDream(
      userId,
      keys,
      dreamInput({ body: "misfiled", nightDate: "2026-08-17" }),
    );
    await updateDream(
      userId,
      keys,
      id,
      dreamInput({ body: "misfiled", nightDate: "2026-08-18" }),
    );

    expect(await dreamsForNight(userId, keys, "2026-08-17")).toHaveLength(0);
    expect(await dreamsForNight(userId, keys, "2026-08-18")).toHaveLength(1);
    // The original night stays: it was still journalled.
    expect(await getNight(userId, keys, "2026-08-17")).not.toBeNull();
  });

  it("keeps the night on record when its last entry is deleted", async () => {
    const id = await createDream(userId, keys, dreamInput({ body: "gone" }));
    expect(await deleteDream(userId, id)).toBe(true);

    // A hole in the heatmap here would misreport a journalled night as skipped.
    expect(await getNight(userId, keys, "2026-08-17")).not.toBeNull();
    expect(await dreamsForNight(userId, keys, "2026-08-17")).toHaveLength(0);
  });

  it("takes a night's entries with it when the night is deleted", async () => {
    await createDream(userId, keys, dreamInput({ body: "one" }));
    await createDream(userId, keys, dreamInput({ body: "two" }));

    const result = await deleteNight(userId, "2026-08-17");
    expect(result).toEqual({ deleted: true, dreamCount: 2 });
    expect(await dreamsForNight(userId, keys, "2026-08-17")).toHaveLength(0);
  });

  it("saves a night's notes and reads them back", async () => {
    await saveNight(userId, keys, {
      date: "2026-08-17",
      bedTime: "23:30",
      wakeTime: "07:15",
      wbtbTime: "04:00",
      sleepQuality: 4,
      techniques: ["mild", "wbtb"],
      noRecall: false,
      notes: "Woke at four and stayed up twenty minutes.",
    });

    const night = await getNight(userId, keys, "2026-08-17");
    expect(night?.notes).toBe("Woke at four and stayed up twenty minutes.");
    expect(night?.bedTime).toBe("23:30");
    expect(night?.techniques).toEqual(["mild", "wbtb"]);
  });

  it("keeps notes readable when a night is edited twice", async () => {
    // The second save must reuse the existing row id, or the notes would be
    // encrypted under an AAD that no longer matches where they land.
    const input: NightInput = {
      date: "2026-08-17",
      bedTime: null,
      wakeTime: null,
      wbtbTime: null,
      sleepQuality: null,
      techniques: [],
      noRecall: false,
      notes: "first",
    };

    await saveNight(userId, keys, { ...input });
    await saveNight(userId, keys, { ...input, notes: "second" });
    expect((await getNight(userId, keys, "2026-08-17"))?.notes).toBe("second");
  });
});

describe("what the stored bytes are bound to", () => {
  it("refuses a ciphertext moved into another entry's row", async () => {
    const source = await createDream(userId, keys, dreamInput({ body: "the real one" }));
    const target = await createDream(userId, keys, dreamInput({ body: "the other one" }));

    const [row] = await db.select().from(dreams).where(eq(dreams.id, source));
    // An attacker with write access swaps one dream's body into another row.
    await db.update(dreams).set({ bodyEnc: row!.bodyEnc }).where(eq(dreams.id, target));

    await expect(getDream(userId, keys, target)).rejects.toThrow(DecryptionError);
  });

  it("refuses a ciphertext moved between columns of the same row", async () => {
    const id = await createDream(
      userId,
      keys,
      dreamInput({ title: "a title", body: "a body" }),
    );
    const [row] = await db.select().from(dreams).where(eq(dreams.id, id));
    await db.update(dreams).set({ titleEnc: row!.bodyEnc }).where(eq(dreams.id, id));

    await expect(getDream(userId, keys, id)).rejects.toThrow(DecryptionError);
  });

  it("scopes every read to the owner", async () => {
    const id = await createDream(userId, keys, dreamInput({ body: "private" }));
    // A different user id must not reach the row even with the right key.
    expect(await getDream(randomUUID(), keys, id)).toBeNull();
  });
});

describe("tags", () => {
  it("attaches the same tag to two entries rather than duplicating it", async () => {
    await createDream(userId, keys, dreamInput({ body: "one", tags: ["water"] }));
    await createDream(userId, keys, dreamInput({ body: "two", tags: ["water"] }));

    const counts = await listTagCounts(userId, keys);
    expect(counts).toHaveLength(1);
    expect(counts[0]).toMatchObject({ name: "water", dreamCount: 2 });
  });

  it("treats a differently-capitalised tag as the same tag", async () => {
    await createDream(userId, keys, dreamInput({ body: "one", tags: ["Water"] }));
    await createDream(userId, keys, dreamInput({ body: "two", tags: ["water"] }));

    const counts = await listTagCounts(userId, keys);
    expect(counts).toHaveLength(1);
    // The first spelling wins; renaming is a separate act, not a side effect.
    expect(counts[0]?.name).toBe("Water");
    expect(counts[0]?.dreamCount).toBe(2);
  });

  it("finds entries by tag without the database ever seeing the word", async () => {
    await createDream(userId, keys, dreamInput({ body: "wet", tags: ["water"] }));
    await createDream(userId, keys, dreamInput({ body: "dry", tags: ["desert"] }));

    const page = await listDreams(userId, keys, filters({ tag: "water" }));
    expect(page.total).toBe(1);
    expect(page.items[0]?.preview).toBe("wet");

    // The stored fingerprint is not the word.
    const [row] = await db.select().from(tags).limit(1);
    expect(row!.nameBidx.toString("utf8")).not.toContain("water");
  });

  it("matches a tag filter typed with different capitalisation", async () => {
    await createDream(userId, keys, dreamInput({ body: "wet", tags: ["Water"] }));
    expect((await listDreams(userId, keys, filters({ tag: "  WATER " }))).total).toBe(1);
  });

  it("attaches one tag once when two names fold to the same fingerprint", async () => {
    // Normalisation folds Unicode composition, case and whitespace together, so
    // these are one tag — attaching both would collide on the join table's key.
    const id = await createDream(
      userId,
      keys,
      dreamInput({ body: "one", tags: ["caf\u00e9", "cafe\u0301", "CAFÉ"] }),
    );

    const stored = await getDream(userId, keys, id);
    expect(stored?.tags).toHaveLength(1);
    expect(await listTagCounts(userId, keys)).toHaveLength(1);
  });

  it("forgets a tag once nothing uses it any more", async () => {
    const id = await createDream(userId, keys, dreamInput({ body: "one", tags: ["water"] }));
    await updateDream(userId, keys, id, dreamInput({ body: "one", tags: ["fire"] }));

    const counts = await listTagCounts(userId, keys);
    expect(counts.map((tag) => tag.name)).toEqual(["fire"]);
    // The orphan's fingerprint is a standing leak of a word no longer present.
    expect(await db.select().from(dreamTags)).toHaveLength(1);
  });
});

describe("filtering and sorting", () => {
  beforeEach(async () => {
    await createDream(
      userId,
      keys,
      dreamInput({ nightDate: "2026-08-15", body: "one two three", lucidity: 0 }),
    );
    await createDream(
      userId,
      keys,
      dreamInput({ nightDate: "2026-08-16", body: "a much longer entry with more words in it", lucidity: 3 }),
    );
    await createDream(
      userId,
      keys,
      dreamInput({ nightDate: "2026-08-17", body: "scrap", isFragment: true }),
    );
    await createDream(
      userId,
      keys,
      dreamInput({ nightDate: "2026-08-17", body: "chased", isNightmare: true }),
    );
  });

  it("returns everything by default, newest first", async () => {
    const page = await listDreams(userId, keys, filters());
    expect(page.total).toBe(4);
    expect(page.items[0]?.dreamDate).toBe("2026-08-17");
  });

  it("restricts to a date range inclusively", async () => {
    const page = await listDreams(
      userId,
      keys,
      filters({ from: "2026-08-16", to: "2026-08-16" }),
    );
    expect(page.total).toBe(1);
  });

  it("filters to lucid entries", async () => {
    const page = await listDreams(userId, keys, filters({ lucidOnly: true }));
    expect(page.total).toBe(1);
    expect(page.items[0]?.isLucid).toBe(true);
  });

  it("filters to nightmares", async () => {
    const page = await listDreams(userId, keys, filters({ nightmaresOnly: true }));
    expect(page.total).toBe(1);
  });

  it("hides fragments when asked", async () => {
    const page = await listDreams(userId, keys, filters({ includeFragments: false }));
    expect(page.total).toBe(3);
    expect(page.items.every((item) => !item.isFragment)).toBe(true);
  });

  it("sorts oldest first and longest first", async () => {
    const oldest = await listDreams(userId, keys, filters({ sort: "oldest" }));
    expect(oldest.items[0]?.dreamDate).toBe("2026-08-15");

    const longest = await listDreams(userId, keys, filters({ sort: "longest" }));
    expect(longest.items[0]?.wordCount).toBe(9);
  });

  it("clamps a page number past the end rather than returning nothing", async () => {
    const page = await listDreams(userId, keys, filters({ page: 99 }));
    expect(page.page).toBe(1);
    expect(page.items).toHaveLength(4);
  });
});

describe("capture and the draft queue", () => {
  it("saves a capture as a draft with no metadata required", async () => {
    await captureDream(userId, keys, "2026-08-17", "there was a corridor");

    const drafts = await listDrafts(userId, keys);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.preview).toBe("there was a corridor");
    expect(drafts[0]?.source).toBe("quick_capture");
  });

  it("counts a draft towards the night straight away", async () => {
    // The point of capturing is that it is journalled the moment it is saved,
    // not once it has been tidied up.
    await captureDream(userId, keys, "2026-08-17", "a corridor");
    const activity = await activityForYear(userId, 2026);
    expect(activity.find((day) => day.date === "2026-08-17")?.dreamCount).toBe(1);
  });

  it("leaves the queue once it is written up", async () => {
    const id = await captureDream(userId, keys, "2026-08-17", "a corridor");
    await updateDream(
      userId,
      keys,
      id,
      dreamInput({ body: "a corridor, tiled, going down", lucidity: 2 }),
    );

    expect(await listDrafts(userId, keys)).toHaveLength(0);
    const stored = await getDream(userId, keys, id);
    expect(stored?.isDraft).toBe(false);
    // The way it was captured is still recorded.
    expect(stored?.source).toBe("quick_capture");
  });
});

describe("the activity view", () => {
  it("reports a journalled night with no recall separately from a missed one", async () => {
    await saveNight(userId, keys, {
      date: "2026-08-16",
      bedTime: null,
      wakeTime: null,
      wbtbTime: null,
      sleepQuality: null,
      techniques: [],
      noRecall: true,
      notes: null,
    });
    await createDream(userId, keys, dreamInput({ nightDate: "2026-08-17", body: "a dream" }));

    const activity = await activityForYear(userId, 2026);
    const sixteenth = activity.find((day) => day.date === "2026-08-16");
    const seventeenth = activity.find((day) => day.date === "2026-08-17");

    expect(sixteenth).toMatchObject({ journalled: true, dreamCount: 0 });
    expect(seventeenth).toMatchObject({ journalled: true, dreamCount: 1 });
    expect(activity.find((day) => day.date === "2026-08-15")).toBeUndefined();
  });

  it("aggregates several entries onto one night", async () => {
    await createDream(
      userId,
      keys,
      dreamInput({ nightDate: "2026-08-17", body: "one two", lucidity: 4 }),
    );
    await createDream(
      userId,
      keys,
      dreamInput({ nightDate: "2026-08-17", body: "three four five" }),
    );

    const day = (await activityForYear(userId, 2026)).find((d) => d.date === "2026-08-17");
    expect(day).toMatchObject({ dreamCount: 2, lucidCount: 1, wordCount: 5 });
  });

  it("keeps years apart", async () => {
    await createDream(userId, keys, dreamInput({ nightDate: "2025-12-31", body: "old" }));
    await createDream(userId, keys, dreamInput({ nightDate: "2026-01-01", body: "new" }));

    expect(await activityForYear(userId, 2025)).toHaveLength(1);
    expect(await activityForYear(userId, 2026)).toHaveLength(1);
    expect(await journalledYears(userId, new Date(2026, 0, 2))).toEqual([2026, 2025]);
  });

  it("feeds streaks that survive the query round-trip", async () => {
    for (const date of ["2026-08-15", "2026-08-16", "2026-08-17"]) {
      await createDream(userId, keys, dreamInput({ nightDate: date, body: "recalled" }));
    }
    const streaks = computeStreaks(await activityForYear(userId, 2026), "2026-08-17");
    expect(streaks.recall.current).toBe(3);
  });

  it("reports the lucid rate over nights that were recalled", async () => {
    await createDream(
      userId,
      keys,
      dreamInput({ nightDate: "2026-08-16", body: "aware", lucidity: 3 }),
    );
    await createDream(userId, keys, dreamInput({ nightDate: "2026-08-17", body: "not aware" }));

    const totals = await journalTotals(userId);
    expect(totals).toMatchObject({ dreams: 2, lucidDreams: 1, nights: 2 });
    expect(totals.lucidRate).toBeCloseTo(0.5);
  });
});

describe("what a stolen database actually contains", () => {
  /**
   * Reads every value out of every table and renders it as text.
   *
   * The equivalent of the `pg_dump` scan in the accounts suite, done in SQL so
   * it runs wherever the tests do. Bytea columns are decoded as UTF-8, so any
   * field that was accidentally stored as plaintext would show up in full.
   */
  async function everyStoredValue(): Promise<string> {
    const tables = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );

    const chunks: string[] = [];
    for (const { table_name: table } of tables) {
      const rows = await db.execute(sql.raw(`select * from "${table}"`));
      for (const row of rows) {
        for (const value of Object.values(row as Record<string, unknown>)) {
          if (value === null || value === undefined) continue;
          if (value instanceof Uint8Array) chunks.push(Buffer.from(value).toString("utf8"));
          else if (typeof value === "object") chunks.push(JSON.stringify(value));
          else chunks.push(String(value));
        }
      }
    }
    return chunks.join("\n");
  }

  it("holds no dream content written through the app's own write path", async () => {
    await saveNight(userId, keys, {
      date: "2026-08-17",
      bedTime: "23:30",
      wakeTime: "07:00",
      wbtbTime: null,
      sleepQuality: 4,
      techniques: ["mild", "wbtb"],
      noRecall: false,
      notes: `night notes: ${CANARY}`,
    });
    const dreamId = await createDream(
      userId,
      keys,
      dreamInput({
        title: CANARY,
        body: `I dreamt of ${CANARY} and became lucid.`,
        lucidity: 4,
        tags: [CANARY],
      }),
    );
    await captureDream(userId, keys, "2026-08-18", `at 4am: ${CANARY}`);
    await saveInsight(userId, keys, {
      dreamId,
      kind: "lucidity",
      provider: "Ollama",
      model: "llama3.2",
      promptVersion: "lucidity.v1",
      content: `coach notes about ${CANARY}`,
    });
    await saveAiConfig(userId, keys, {
      providers: [
        {
          id: "openai",
          kind: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiKey: `sk-${CANARY}`,
          enabled: true,
        },
      ],
      roles: emptyRoles(),
    });
    const jpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 10, b: 20 } },
    })
      .jpeg()
      .toBuffer();
    const prepared = await prepareImage(jpeg);
    const uploaded = await createImageAttachment(userId, keys, prepared, null);
    await saveReading(userId, keys, uploaded.id, [dreamFromTranscript(`ocr of ${CANARY}`, 0.8)]);

    const stored = await everyStoredValue();
    // The single most important assertion in this codebase, over phase 2's
    // write path rather than a hand-built row.
    expect(stored).not.toContain(CANARY);
    expect(stored.toLowerCase()).not.toContain("cathedral of bees");
    expect(stored).not.toContain("became lucid");
    expect(stored).not.toContain("night notes");
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain(process.env.MASTER_KEY);
  });

  it("does hold the structural metadata the heatmap needs", async () => {
    // The trade-off, stated out loud: dates, counts, lucidity and word totals
    // are readable by design, because a heatmap that needs the key to render is
    // a heatmap nobody looks at.
    await createDream(
      userId,
      keys,
      dreamInput({ body: `${CANARY} ${CANARY}`, lucidity: 4, nightDate: "2026-08-17" }),
    );

    const stored = await everyStoredValue();
    expect(stored).toContain("2026-08-17");

    const [row] = await db.select().from(dreams).limit(1);
    expect(row?.wordCount).toBe(2);
    expect(row?.isLucid).toBe(true);
  });

  it("still reads back for someone holding the key", async () => {
    const id = await createDream(
      userId,
      keys,
      dreamInput({ title: CANARY, body: `about ${CANARY}`, tags: [CANARY] }),
    );

    const dream = await getDream(userId, keys, id);
    expect(dream?.title).toBe(CANARY);
    expect(dream?.body).toBe(`about ${CANARY}`);
    expect(dream?.tags).toEqual([CANARY]);
  });

  it("keeps the audit log free of entry content", async () => {
    await createDream(userId, keys, dreamInput({ title: CANARY, body: CANARY }));
    const events = await db.execute(sql`select detail from auth_events`);
    for (const row of events) {
      expect(JSON.stringify(row)).not.toContain(CANARY);
    }
  });
});

describe("nights and dreams stay consistent", () => {
  it("never has two nights for the same date", async () => {
    await createDream(userId, keys, dreamInput({ nightDate: "2026-08-17", body: "one" }));
    await createDream(userId, keys, dreamInput({ nightDate: "2026-08-17", body: "two" }));
    await saveNight(userId, keys, {
      date: "2026-08-17",
      bedTime: null,
      wakeTime: null,
      wbtbTime: null,
      sleepQuality: 3,
      techniques: [],
      noRecall: false,
      notes: "notes",
    });

    const rows = await db
      .select()
      .from(nights)
      .where(and(eq(nights.userId, userId), eq(nights.date, "2026-08-17")));
    expect(rows).toHaveLength(1);
  });

  it("points every dream at the night matching its date", async () => {
    await createDream(userId, keys, dreamInput({ nightDate: "2026-08-17", body: "one" }));
    const [dream] = await db.select().from(dreams).limit(1);
    const [night] = await db.select().from(nights).where(eq(nights.id, dream!.nightId));
    expect(night?.date).toBe(dream?.dreamDate);
  });
});
