import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { dreams, nights } from "@/db/schema";
import { decryptStringOptional } from "@/lib/crypto/aead";
import type { UserKeys } from "@/lib/crypto/envelope";
import { createDream } from "@/lib/journal/dreams";
import { saveNight } from "@/lib/journal/nights";
import { dreamInputSchema } from "@/lib/journal/validation";
import { queueLocalEmbeddings } from "@/lib/semantic/queue";
import { dreamFingerprint, type ArchiveDocument, type ArchiveDream } from "./document";

/**
 * Putting a backup back.
 *
 * Restore **merges**; it does not replace. Nothing here deletes anything, and a
 * night that already exists in the live journal is left exactly as it is. The
 * reasoning is that the overwhelmingly common restores are "I lost the machine"
 * (into an empty journal, where merge and replace are the same thing) and "I
 * want the entries from March back" (into a live journal, where replacing would
 * destroy everything written since the backup). A destructive restore has no
 * safe version of the second case, so it is not offered.
 *
 * The consequence to be careful about is duplication: run the same restore
 * twice and, naively, every entry appears twice. `dreamFingerprint()` is what
 * stops that — an entry whose date and text already exist is skipped, so a
 * restore is repeatable rather than cumulative.
 */

export interface RestorePlan {
  /** Nights in the archive that this journal has no row for. */
  newNights: number;
  /** Nights the archive and the journal both have; the journal's version wins. */
  existingNights: number;
  /** Dreams that would be written. */
  newDreams: number;
  /** Dreams already present, by date and text. */
  duplicateDreams: number;
}

export interface RestoreResult extends RestorePlan {
  restoredNights: number;
  restoredDreams: number;
}

/**
 * Fingerprints of the entries already on the archive's dates.
 *
 * Only those dates are read, so the cost is proportional to the archive rather
 * than to the journal. Each one has to be decrypted to be fingerprinted —
 * unavoidable, since the whole point is to compare what was written, and the
 * database cannot compare ciphertext.
 */
async function existingFingerprints(
  userId: string,
  keys: UserKeys,
  dates: readonly string[],
): Promise<Set<string>> {
  const seen = new Set<string>();
  if (dates.length === 0) return seen;

  const rows = await db
    .select({
      id: dreams.id,
      dreamDate: dreams.dreamDate,
      titleEnc: dreams.titleEnc,
      bodyEnc: dreams.bodyEnc,
    })
    .from(dreams)
    .where(and(eq(dreams.userId, userId), inArray(dreams.dreamDate, [...dates])));

  for (const row of rows) {
    seen.add(
      dreamFingerprint({
        nightDate: row.dreamDate,
        title: decryptStringOptional(keys.field, row.titleEnc, {
          table: "dreams",
          column: "title_enc",
          id: row.id,
        }),
        body: decryptStringOptional(keys.field, row.bodyEnc, {
          table: "dreams",
          column: "body_enc",
          id: row.id,
        }),
      }),
    );
  }
  return seen;
}

/**
 * The archive's dates that this journal already has a night for.
 *
 * One query rather than a `getNight` per night: an archive covers as many
 * nights as the journal has years of days, and a restore that opened a
 * connection for each of them would spend minutes doing nothing.
 */
async function existingNightDates(
  userId: string,
  dates: readonly string[],
): Promise<Set<string>> {
  if (dates.length === 0) return new Set();
  const rows = await db
    .select({ date: nights.date })
    .from(nights)
    .where(and(eq(nights.userId, userId), inArray(nights.date, [...dates])));
  return new Set(rows.map((row) => row.date));
}

function archiveDates(document: ArchiveDocument): string[] {
  return [
    ...new Set([
      ...document.nights.map((night) => night.date),
      ...document.dreams.map((dream) => dream.nightDate),
    ]),
  ];
}

/** Shared by the plan and the restore, so the two cannot disagree. */
function planAgainst(
  document: ArchiveDocument,
  present: Set<string>,
  fingerprints: Set<string>,
): RestorePlan {
  let newNights = 0;
  let existingNights = 0;
  for (const night of document.nights) {
    if (present.has(night.date)) existingNights += 1;
    else newNights += 1;
  }

  // Counted against a set that grows as we go, so an archive holding the same
  // entry twice reports one write and one duplicate rather than two writes.
  const planned = new Set(fingerprints);
  let newDreams = 0;
  let duplicateDreams = 0;
  for (const dream of document.dreams) {
    const print = dreamFingerprint(dream);
    if (planned.has(print)) duplicateDreams += 1;
    else {
      planned.add(print);
      newDreams += 1;
    }
  }

  return { newNights, existingNights, newDreams, duplicateDreams };
}

/** What a restore would do, without doing any of it. */
export async function planRestore(
  userId: string,
  keys: UserKeys,
  document: ArchiveDocument,
): Promise<RestorePlan> {
  const dates = archiveDates(document);
  const [present, fingerprints] = await Promise.all([
    existingNightDates(userId, dates),
    existingFingerprints(userId, keys, dates),
  ]);
  return planAgainst(document, present, fingerprints);
}

function toInput(dream: ArchiveDream) {
  /*
   * Back through the editor's own schema, so an archive cannot write anything
   * the editor could not. A row that fails validation is dropped rather than
   * failing the whole restore: one bad entry must not cost the other nine
   * hundred.
   */
  return dreamInputSchema.safeParse({
    nightDate: dream.nightDate,
    title: dream.title,
    body: dream.body,
    lucidity: dream.lucidity,
    vividness: dream.vividness,
    control: dream.control,
    recallClarity: dream.recallClarity,
    emotionalValence: dream.emotionalValence,
    isNightmare: dream.isNightmare,
    isRecurring: dream.isRecurring,
    isFragment: dream.isFragment,
    isDraft: dream.isDraft,
    tags: dream.tags,
  });
}

export async function restoreArchive(
  userId: string,
  keys: UserKeys,
  document: ArchiveDocument,
): Promise<RestoreResult> {
  const dates = archiveDates(document);
  const [present, fingerprints] = await Promise.all([
    existingNightDates(userId, dates),
    existingFingerprints(userId, keys, dates),
  ]);
  const plan = planAgainst(document, present, fingerprints);
  const written = new Set(fingerprints);

  let restoredNights = 0;
  for (const night of document.nights) {
    // The live journal wins: a night written since the backup keeps whatever it
    // says now, and only the ones missing entirely are filled in.
    if (present.has(night.date)) continue;
    await saveNight(userId, keys, {
      date: night.date,
      bedTime: night.bedTime,
      wakeTime: night.wakeTime,
      wbtbTime: night.wbtbTime,
      sleepQuality: night.sleepQuality,
      techniques: night.techniques,
      noRecall: night.noRecall,
      notes: night.notes,
    });
    restoredNights += 1;
  }

  const restored: string[] = [];
  for (const dream of document.dreams) {
    const print = dreamFingerprint(dream);
    if (written.has(print)) continue;

    const parsed = toInput(dream);
    if (!parsed.success) continue;

    const id = await createDream(userId, keys, parsed.data, dream.source);
    written.add(print);
    restored.push(id);

    /*
     * The original write time, put back.
     *
     * A night's entries are ordered by `createdAt`, so leaving them all stamped
     * with the restore's own clock would silently reorder every multi-dream
     * night in the archive. Written after the insert rather than through
     * `createDream`, which has no reason to take a timestamp for any other
     * caller.
     */
    const createdAt = new Date(dream.createdAt);
    if (!Number.isNaN(createdAt.getTime())) {
      await db
        .update(dreams)
        .set({ createdAt })
        .where(and(eq(dreams.id, id), eq(dreams.userId, userId)));
    }
  }

  // Restored entries are entries: they belong in the search index like any
  // other. Local embedding models only — see queueLocalEmbeddings.
  await queueLocalEmbeddings(userId, keys, restored);

  return { ...plan, restoredNights, restoredDreams: restored.length };
}
