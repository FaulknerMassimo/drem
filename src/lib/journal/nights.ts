import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, type Executor } from "@/db";
import { dreams, nights } from "@/db/schema";
import { decryptStringOptional, encryptOptional, type Aad } from "@/lib/crypto/aead";
import type { UserKeys } from "@/lib/crypto/envelope";
import type { IsoDate } from "./dates";
import type { Technique } from "./labels";
import type { NightInput } from "./validation";

/**
 * Nights.
 *
 * The night is the unit of the habit, not the dream. A night you journalled and
 * remembered nothing is a real data point — it keeps the heatmap honest and it
 * is what makes technique statistics mean anything — so a night row exists
 * independently of whether any dream hangs off it.
 */
export interface NightRecord {
  id: string;
  date: IsoDate;
  bedTime: string | null;
  wakeTime: string | null;
  wbtbTime: string | null;
  sleepQuality: number | null;
  techniques: Technique[];
  noRecall: boolean;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function notesAad(id: string): Aad {
  return { table: "nights", column: "notes_enc", id };
}

/** Postgres hands `time` back as HH:MM:SS; the form wants HH:MM. */
function toClockTime(value: string | null): string | null {
  return value ? value.slice(0, 5) : null;
}

function decodeNight(
  keys: UserKeys,
  row: typeof nights.$inferSelect,
): NightRecord {
  return {
    id: row.id,
    date: row.date,
    bedTime: toClockTime(row.bedTime),
    wakeTime: toClockTime(row.wakeTime),
    wbtbTime: toClockTime(row.wbtbTime),
    sleepQuality: row.sleepQuality,
    techniques: row.techniques as Technique[],
    noRecall: row.noRecall,
    notes: decryptStringOptional(keys.field, row.notesEnc, notesAad(row.id)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getNight(
  userId: string,
  keys: UserKeys,
  date: IsoDate,
): Promise<NightRecord | null> {
  const [row] = await db
    .select()
    .from(nights)
    .where(and(eq(nights.userId, userId), eq(nights.date, date)))
    .limit(1);
  return row ? decodeNight(keys, row) : null;
}

/**
 * Returns the id of the night for a date, creating a bare row if there is none.
 *
 * Saving a dream implies the morning was journalled, so the night has to exist;
 * without this a dream could outlive its night and the heatmap would show a day
 * with entries but no journalling.
 */
export async function ensureNight(
  exec: Executor,
  userId: string,
  date: IsoDate,
): Promise<string> {
  const [existing] = await exec
    .select({ id: nights.id })
    .from(nights)
    .where(and(eq(nights.userId, userId), eq(nights.date, date)))
    .limit(1);
  if (existing) return existing.id;

  const id = randomUUID();
  await exec.insert(nights).values({ id, userId, date });
  return id;
}

/**
 * Creates or updates the night for a date.
 *
 * The row's id has to be resolved *before* the notes are encrypted: the AAD
 * binds a ciphertext to the row it lives in, so encrypting under a freshly
 * minted id and then landing in an existing row would produce notes that can
 * never be decrypted again.
 */
export async function saveNight(
  userId: string,
  keys: UserKeys,
  input: NightInput,
): Promise<NightRecord> {
  return db.transaction(async (tx) => {
    const id = await ensureNight(tx, userId, input.date);

    // "I remembered nothing" cannot be true of a night that has dreams on it.
    const [recalled] = await tx
      .select({ id: dreams.id })
      .from(dreams)
      .where(and(eq(dreams.userId, userId), eq(dreams.nightId, id)))
      .limit(1);

    const [row] = await tx
      .update(nights)
      .set({
        bedTime: input.bedTime,
        wakeTime: input.wakeTime,
        wbtbTime: input.wbtbTime,
        sleepQuality: input.sleepQuality,
        techniques: input.techniques,
        noRecall: recalled ? false : input.noRecall,
        notesEnc: encryptOptional(keys.field, input.notes, notesAad(id)),
        updatedAt: new Date(),
      })
      .where(and(eq(nights.id, id), eq(nights.userId, userId)))
      .returning();

    return decodeNight(keys, row!);
  });
}

/** Clears the "no recall" flag once a dream is attached to the night. */
export async function clearNoRecall(
  exec: Executor,
  userId: string,
  nightId: string,
): Promise<void> {
  await exec
    .update(nights)
    .set({ noRecall: false, updatedAt: new Date() })
    .where(and(eq(nights.id, nightId), eq(nights.userId, userId)));
}

/**
 * Deletes a night and, by cascade, every dream on it. Returns how many dreams
 * went with it so the caller can say so before it is irreversible.
 */
export async function deleteNight(
  userId: string,
  date: IsoDate,
): Promise<{ deleted: boolean; dreamCount: number }> {
  return db.transaction(async (tx) => {
    const [night] = await tx
      .select({ id: nights.id })
      .from(nights)
      .where(and(eq(nights.userId, userId), eq(nights.date, date)))
      .limit(1);
    if (!night) return { deleted: false, dreamCount: 0 };

    const attached = await tx
      .select({ id: dreams.id })
      .from(dreams)
      .where(and(eq(dreams.userId, userId), eq(dreams.nightId, night.id)));

    const { purgeBlobsForDreams } = await import("@/lib/capture/attachments");
    await purgeBlobsForDreams(
      userId,
      attached.map((row) => row.id),
    );

    await tx.delete(nights).where(and(eq(nights.id, night.id), eq(nights.userId, userId)));
    return { deleted: true, dreamCount: attached.length };
  });
}

/** How many dreams a night holds, for the confirmation screen. */
export async function countDreamsOnNight(
  userId: string,
  date: IsoDate,
): Promise<number> {
  const rows = await db
    .select({ id: dreams.id })
    .from(dreams)
    .where(and(eq(dreams.userId, userId), eq(dreams.dreamDate, date)));
  return rows.length;
}
