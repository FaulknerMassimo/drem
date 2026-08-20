import "server-only";
import { and, count, eq, gte, lte, max, min, sql } from "drizzle-orm";
import { db } from "@/db";
import { dreams, nights } from "@/db/schema";
import type { AnalyticsDream, AnalyticsNight } from "./analytics";
import { yearOf, type IsoDate } from "./dates";
import type { DayActivity } from "./heatmap";
import type { Technique } from "./labels";

/**
 * The queries behind the heatmap and the streaks.
 *
 * Every column read here is structural — dates, counts, word totals — so the
 * whole activity view is assembled without decrypting a single entry. That is
 * why the heatmap can render before anything is unwrapped, and why word counts
 * are stored in the clear in the first place.
 */

export async function activityBetween(
  userId: string,
  from: IsoDate | null = null,
  to: IsoDate | null = null,
): Promise<DayActivity[]> {
  const nightWhere = [eq(nights.userId, userId)];
  if (from) nightWhere.push(gte(nights.date, from));
  if (to) nightWhere.push(lte(nights.date, to));

  const dreamWhere = [eq(dreams.userId, userId)];
  if (from) dreamWhere.push(gte(dreams.dreamDate, from));
  if (to) dreamWhere.push(lte(dreams.dreamDate, to));

  const [nightRows, dreamRows] = await Promise.all([
    db.select({ date: nights.date }).from(nights).where(and(...nightWhere)),
    db
      .select({
        date: dreams.dreamDate,
        dreamCount: sql<number>`count(*)::int`,
        lucidCount: sql<number>`coalesce(sum(case when ${dreams.isLucid} then 1 else 0 end), 0)::int`,
        wordCount: sql<number>`coalesce(sum(${dreams.wordCount}), 0)::int`,
      })
      .from(dreams)
      .where(and(...dreamWhere))
      .groupBy(dreams.dreamDate),
  ]);

  const byDate = new Map<IsoDate, DayActivity>();
  for (const row of nightRows) {
    byDate.set(row.date, {
      date: row.date,
      journalled: true,
      dreamCount: 0,
      lucidCount: 0,
      wordCount: 0,
    });
  }
  for (const row of dreamRows) {
    // A dream always implies its night was journalled, even for rows that
    // arrived by import without one.
    const day = byDate.get(row.date) ?? {
      date: row.date,
      journalled: true,
      dreamCount: 0,
      lucidCount: 0,
      wordCount: 0,
    };
    byDate.set(row.date, {
      ...day,
      dreamCount: Number(row.dreamCount),
      lucidCount: Number(row.lucidCount),
      wordCount: Number(row.wordCount),
    });
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The rows the analytics page is built from.
 *
 * Structural columns only — dates, the technique array, the flags and the 1–5
 * ratings. No `Enc` column is read and no key is touched, so the whole page
 * renders without a single dream being decrypted. Worth keeping that way: it is
 * the screen most likely to be left open on a second monitor.
 */
export async function analyticsRows(
  userId: string,
  from: IsoDate,
  to: IsoDate,
): Promise<{ nights: AnalyticsNight[]; dreams: AnalyticsDream[] }> {
  const [nightRows, dreamRows] = await Promise.all([
    db
      .select({ date: nights.date, techniques: nights.techniques })
      .from(nights)
      .where(and(eq(nights.userId, userId), gte(nights.date, from), lte(nights.date, to))),
    db
      .select({
        date: dreams.dreamDate,
        isLucid: dreams.isLucid,
        vividness: dreams.vividness,
        control: dreams.control,
        recallClarity: dreams.recallClarity,
      })
      .from(dreams)
      .where(
        and(eq(dreams.userId, userId), gte(dreams.dreamDate, from), lte(dreams.dreamDate, to)),
      ),
  ]);

  return {
    nights: nightRows.map((row) => ({
      date: row.date,
      techniques: (row.techniques ?? []) as Technique[],
    })),
    dreams: dreamRows,
  };
}

export function activityForYear(userId: string, year: number): Promise<DayActivity[]> {
  return activityBetween(userId, `${year}-01-01`, `${year}-12-31`);
}

/**
 * The years the year picker should offer.
 *
 * Always includes the current year, so a brand new journal has something to
 * show rather than an empty dropdown.
 */
export async function journalledYears(userId: string, now = new Date()): Promise<number[]> {
  const [range] = await db
    .select({
      earliestNight: min(nights.date),
      latestNight: max(nights.date),
    })
    .from(nights)
    .where(eq(nights.userId, userId));

  const [dreamRange] = await db
    .select({
      earliest: min(dreams.dreamDate),
      latest: max(dreams.dreamDate),
    })
    .from(dreams)
    .where(eq(dreams.userId, userId));

  const currentYear = now.getFullYear();
  const candidates = [
    range?.earliestNight,
    range?.latestNight,
    dreamRange?.earliest,
    dreamRange?.latest,
  ].filter((value): value is string => Boolean(value));

  const years = candidates.map(yearOf);
  const earliest = Math.min(currentYear, ...years);
  const latest = Math.max(currentYear, ...years);

  const all: number[] = [];
  for (let year = latest; year >= earliest; year -= 1) all.push(year);
  return all;
}

export interface JournalTotals {
  nights: number;
  dreams: number;
  lucidDreams: number;
  /** Share of recalled nights that contained a lucid dream, 0–1. */
  lucidRate: number;
  words: number;
}

export async function journalTotals(userId: string): Promise<JournalTotals> {
  const [nightRow] = await db
    .select({ total: count() })
    .from(nights)
    .where(eq(nights.userId, userId));

  const [dreamRow] = await db
    .select({
      total: sql<number>`count(*)::int`,
      lucid: sql<number>`coalesce(sum(case when ${dreams.isLucid} then 1 else 0 end), 0)::int`,
      words: sql<number>`coalesce(sum(${dreams.wordCount}), 0)::int`,
      nightsWithDreams: sql<number>`count(distinct ${dreams.dreamDate})::int`,
      lucidNights: sql<number>`count(distinct case when ${dreams.isLucid} then ${dreams.dreamDate} end)::int`,
    })
    .from(dreams)
    .where(eq(dreams.userId, userId));

  const recalledNights = Number(dreamRow?.nightsWithDreams ?? 0);
  const lucidNights = Number(dreamRow?.lucidNights ?? 0);

  return {
    nights: Number(nightRow?.total ?? 0),
    dreams: Number(dreamRow?.total ?? 0),
    lucidDreams: Number(dreamRow?.lucid ?? 0),
    lucidRate: recalledNights === 0 ? 0 : lucidNights / recalledNights,
    words: Number(dreamRow?.words ?? 0),
  };
}
