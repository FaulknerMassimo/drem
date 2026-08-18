import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gte, inArray, lte, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { dreamTags, dreams, nights, tags } from "@/db/schema";
import {
  decryptStringOptional,
  encryptOptional,
  type Aad,
} from "@/lib/crypto/aead";
import type { UserKeys } from "@/lib/crypto/envelope";
import type { IsoDate } from "./dates";
import { clearNoRecall, ensureNight } from "./nights";
import { pruneOrphanedTags, setDreamTags, tagFingerprint, tagsForDreams } from "./tags";
import type { DreamInput, JournalFilters } from "./validation";
import { countWords, excerpt } from "./words";

/** How many dreams a page of the journal list holds. */
export const PAGE_SIZE = 25;

export type DreamSource = (typeof dreams.$inferSelect)["source"];

export interface DreamRecord {
  id: string;
  nightId: string;
  dreamDate: IsoDate;
  title: string | null;
  body: string | null;
  isLucid: boolean;
  lucidity: number;
  vividness: number | null;
  control: number | null;
  recallClarity: number | null;
  emotionalValence: number | null;
  isNightmare: boolean;
  isRecurring: boolean;
  isFragment: boolean;
  isDraft: boolean;
  wordCount: number;
  source: DreamSource;
  createdAt: Date;
  updatedAt: Date;
  tags: string[];
}

/** What a list row needs: never the full body, only a preview of it. */
export interface DreamSummary {
  id: string;
  dreamDate: IsoDate;
  title: string | null;
  preview: string;
  isLucid: boolean;
  lucidity: number;
  isNightmare: boolean;
  isFragment: boolean;
  isDraft: boolean;
  wordCount: number;
  source: DreamSource;
  tags: string[];
}

function titleAad(id: string): Aad {
  return { table: "dreams", column: "title_enc", id };
}

function bodyAad(id: string): Aad {
  return { table: "dreams", column: "body_enc", id };
}

function decodeDream(
  keys: UserKeys,
  row: typeof dreams.$inferSelect,
  tagNames: string[] = [],
): DreamRecord {
  return {
    id: row.id,
    nightId: row.nightId,
    dreamDate: row.dreamDate,
    title: decryptStringOptional(keys.field, row.titleEnc, titleAad(row.id)),
    body: decryptStringOptional(keys.field, row.bodyEnc, bodyAad(row.id)),
    isLucid: row.isLucid,
    lucidity: row.lucidity,
    vividness: row.vividness,
    control: row.control,
    recallClarity: row.recallClarity,
    emotionalValence: row.emotionalValence,
    isNightmare: row.isNightmare,
    isRecurring: row.isRecurring,
    isFragment: row.isFragment,
    isDraft: row.isDraft,
    wordCount: row.wordCount,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    tags: tagNames,
  };
}

function summarise(record: DreamRecord): DreamSummary {
  return {
    id: record.id,
    dreamDate: record.dreamDate,
    title: record.title,
    preview: excerpt(record.body ?? ""),
    isLucid: record.isLucid,
    lucidity: record.lucidity,
    isNightmare: record.isNightmare,
    isFragment: record.isFragment,
    isDraft: record.isDraft,
    wordCount: record.wordCount,
    source: record.source,
    tags: record.tags,
  };
}

/**
 * The scalar columns a dream is written with.
 *
 * `isLucid` is derived rather than submitted: two independent controls for "was
 * it lucid" and "how lucid" drift apart the moment someone changes one and not
 * the other, and every query that filters on lucidity would then disagree with
 * the entry it is showing.
 */
function scalarsFrom(input: DreamInput) {
  return {
    isLucid: input.lucidity > 0,
    lucidity: input.lucidity,
    vividness: input.vividness,
    control: input.control,
    recallClarity: input.recallClarity,
    emotionalValence: input.emotionalValence,
    isNightmare: input.isNightmare,
    isRecurring: input.isRecurring,
    isFragment: input.isFragment,
  };
}

export async function getDream(
  userId: string,
  keys: UserKeys,
  dreamId: string,
): Promise<DreamRecord | null> {
  const [row] = await db
    .select()
    .from(dreams)
    .where(and(eq(dreams.userId, userId), eq(dreams.id, dreamId)))
    .limit(1);
  if (!row) return null;

  const tagsByDream = await tagsForDreams(userId, keys, [row.id]);
  return decodeDream(keys, row, tagsByDream.get(row.id) ?? []);
}

export async function createDream(
  userId: string,
  keys: UserKeys,
  input: DreamInput,
  source: DreamSource = "typed",
): Promise<string> {
  const id = randomUUID();

  await db.transaction(async (tx) => {
    const nightId = await ensureNight(tx, userId, input.nightDate);

    await tx.insert(dreams).values({
      id,
      userId,
      nightId,
      dreamDate: input.nightDate,
      titleEnc: encryptOptional(keys.field, input.title, titleAad(id)),
      bodyEnc: encryptOptional(keys.field, input.body, bodyAad(id)),
      ...scalarsFrom(input),
      isDraft: input.isDraft,
      wordCount: countWords(input.body ?? ""),
      source,
    });

    await setDreamTags(tx, userId, keys, id, input.tags);
    // A night now has a dream on it, so it cannot also claim no recall.
    await clearNoRecall(tx, userId, nightId);
  });

  return id;
}

/**
 * Updates a dream in place.
 *
 * The row keeps its id, which is what lets the ciphertext be rewritten under
 * the same AAD. Saving through the full editor also clears the draft flag: a
 * draft is precisely an entry whose metadata has not been filled in yet, and
 * this is that being done.
 */
export async function updateDream(
  userId: string,
  keys: UserKeys,
  dreamId: string,
  input: DreamInput,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: dreams.id })
      .from(dreams)
      .where(and(eq(dreams.userId, userId), eq(dreams.id, dreamId)))
      .limit(1);
    if (!existing) return false;

    // The date may have moved, which moves the dream to a different night.
    const nightId = await ensureNight(tx, userId, input.nightDate);

    await tx
      .update(dreams)
      .set({
        nightId,
        dreamDate: input.nightDate,
        titleEnc: encryptOptional(keys.field, input.title, titleAad(dreamId)),
        bodyEnc: encryptOptional(keys.field, input.body, bodyAad(dreamId)),
        ...scalarsFrom(input),
        isDraft: input.isDraft,
        wordCount: countWords(input.body ?? ""),
        updatedAt: new Date(),
      })
      .where(and(eq(dreams.id, dreamId), eq(dreams.userId, userId)));

    await setDreamTags(tx, userId, keys, dreamId, input.tags);
    await pruneOrphanedTags(tx, userId);
    await clearNoRecall(tx, userId, nightId);
    return true;
  });
}

export async function deleteDream(userId: string, dreamId: string): Promise<boolean> {
  const { purgeBlobsForDreams } = await import("@/lib/capture/attachments");
  await purgeBlobsForDreams(userId, [dreamId]);
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(dreams)
      .where(and(eq(dreams.id, dreamId), eq(dreams.userId, userId)))
      .returning({ id: dreams.id });
    if (deleted.length === 0) return false;
    // The night stays: it was still journalled, and pretending otherwise would
    // put a hole in the heatmap where an honest "no recall" belongs.
    await pruneOrphanedTags(tx, userId);
    return true;
  });
}

/**
 * A dream captured half-asleep: body only, everything else deferred.
 *
 * Nothing here can fail on a missing field, because the one thing that matters
 * at 4am is that the text lands somewhere durable before it evaporates.
 */
export async function captureDream(
  userId: string,
  keys: UserKeys,
  nightDate: IsoDate,
  body: string,
): Promise<string> {
  return createDream(
    userId,
    keys,
    {
      nightDate,
      title: null,
      body,
      lucidity: 0,
      vividness: null,
      control: null,
      recallClarity: null,
      emotionalValence: null,
      isNightmare: false,
      isRecurring: false,
      isFragment: false,
      isDraft: true,
      tags: [],
    },
    "quick_capture",
  );
}

export async function dreamsForNight(
  userId: string,
  keys: UserKeys,
  date: IsoDate,
): Promise<DreamRecord[]> {
  const rows = await db
    .select()
    .from(dreams)
    .where(and(eq(dreams.userId, userId), eq(dreams.dreamDate, date)))
    .orderBy(asc(dreams.createdAt));

  const tagsByDream = await tagsForDreams(userId, keys, rows.map((row) => row.id));
  return rows.map((row) => decodeDream(keys, row, tagsByDream.get(row.id) ?? []));
}

/**
 * Entries in a closed date range, oldest first.
 *
 * Used by period reports. Drafts with no body are still returned — the caller
 * decides whether they are worth sending to a model.
 */
export async function dreamsInRange(
  userId: string,
  keys: UserKeys,
  from: IsoDate,
  to: IsoDate,
): Promise<DreamRecord[]> {
  const rows = await db
    .select()
    .from(dreams)
    .where(
      and(
        eq(dreams.userId, userId),
        gte(dreams.dreamDate, from),
        lte(dreams.dreamDate, to),
      ),
    )
    .orderBy(asc(dreams.dreamDate), asc(dreams.createdAt));

  const tagsByDream = await tagsForDreams(userId, keys, rows.map((row) => row.id));
  return rows.map((row) => decodeDream(keys, row, tagsByDream.get(row.id) ?? []));
}

export interface DreamPage {
  items: DreamSummary[];
  total: number;
  page: number;
  pageCount: number;
}

/**
 * Builds the WHERE clause for a filtered listing.
 *
 * Every filter is over structural metadata — dates, flags, tag fingerprints —
 * so the database does the work without ever seeing dream text. Filtering on
 * the words themselves is not possible here by construction; that is what the
 * semantic layer in phase 5 is for.
 */
function filterConditions(userId: string, keys: UserKeys, filters: JournalFilters): SQL[] {
  const conditions: SQL[] = [eq(dreams.userId, userId)];

  if (filters.from) conditions.push(gte(dreams.dreamDate, filters.from));
  if (filters.to) conditions.push(lte(dreams.dreamDate, filters.to));
  if (filters.lucidOnly) conditions.push(eq(dreams.isLucid, true));
  if (filters.nightmaresOnly) conditions.push(eq(dreams.isNightmare, true));
  if (!filters.includeFragments) conditions.push(eq(dreams.isFragment, false));

  if (filters.tag) {
    conditions.push(
      inArray(
        dreams.id,
        db
          .select({ id: dreamTags.dreamId })
          .from(dreamTags)
          .innerJoin(tags, eq(tags.id, dreamTags.tagId))
          .where(
            and(eq(tags.userId, userId), eq(tags.nameBidx, tagFingerprint(keys, filters.tag))),
          ),
      ),
    );
  }

  return conditions;
}

function orderFor(sort: JournalFilters["sort"]) {
  if (sort === "oldest") return [asc(dreams.dreamDate), asc(dreams.createdAt)];
  if (sort === "longest") return [desc(dreams.wordCount), desc(dreams.dreamDate)];
  return [desc(dreams.dreamDate), desc(dreams.createdAt)];
}

export async function listDreams(
  userId: string,
  keys: UserKeys,
  filters: JournalFilters,
): Promise<DreamPage> {
  const where = and(...filterConditions(userId, keys, filters));

  const [totals] = await db.select({ total: count() }).from(dreams).where(where);
  const total = Number(totals?.total ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);

  const rows = await db
    .select()
    .from(dreams)
    .where(where)
    .orderBy(...orderFor(filters.sort))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);

  const tagsByDream = await tagsForDreams(userId, keys, rows.map((row) => row.id));
  return {
    items: rows.map((row) => summarise(decodeDream(keys, row, tagsByDream.get(row.id) ?? []))),
    total,
    page,
    pageCount,
  };
}

/** The queue of things captured in the night and not yet written up. */
export async function listDrafts(userId: string, keys: UserKeys): Promise<DreamSummary[]> {
  const rows = await db
    .select()
    .from(dreams)
    .where(and(eq(dreams.userId, userId), eq(dreams.isDraft, true)))
    .orderBy(desc(dreams.createdAt));

  const tagsByDream = await tagsForDreams(userId, keys, rows.map((row) => row.id));
  return rows.map((row) => summarise(decodeDream(keys, row, tagsByDream.get(row.id) ?? [])));
}

export async function countDrafts(userId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(dreams)
    .where(and(eq(dreams.userId, userId), eq(dreams.isDraft, true)));
  return Number(row?.total ?? 0);
}

export async function recentDreams(
  userId: string,
  keys: UserKeys,
  limit = 5,
): Promise<DreamSummary[]> {
  const rows = await db
    .select()
    .from(dreams)
    .where(eq(dreams.userId, userId))
    .orderBy(desc(dreams.dreamDate), desc(dreams.createdAt))
    .limit(limit);

  const tagsByDream = await tagsForDreams(userId, keys, rows.map((row) => row.id));
  return rows.map((row) => summarise(decodeDream(keys, row, tagsByDream.get(row.id) ?? [])));
}

/** Dates that have a night row but no dream: journalled, nothing recalled. */
export async function countNights(userId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(nights)
    .where(eq(nights.userId, userId));
  return Number(row?.total ?? 0);
}
