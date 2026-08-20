/**
 * What the archive says about the practice.
 *
 * Three questions the dashboard cannot answer, because each needs a shape over
 * time rather than a total: is the lucid rate moving, is a technique doing
 * anything, and are the entries getting richer or thinner.
 *
 * Pure, and built entirely from *structural* columns — dates, flags, the 1–5
 * ratings — so the whole analytics page renders without a single field being
 * decrypted. That is not an optimisation. It means the one screen designed to
 * be stared at for a while never holds dream text in the first place.
 *
 * Two rules run through all of it:
 *
 *   - **A bucket with nothing in it has no rate, not a rate of zero.** A month
 *     you did not journal is a gap in the line; drawing it at 0% says you tried
 *     and failed, which is a different and untrue statement.
 *   - **A thin sample gets no ratio at all.** Same reasoning as
 *     `semantic/correlation.ts`, whose maths this reuses rather than
 *     re-deriving: a number is acted on, and "100% lucid" off two nights sends
 *     someone to practise the wrong thing for a month.
 */
import {
  addDays,
  addMonths,
  daysBetween,
  startOfMonth,
  startOfWeek,
  type IsoDate,
} from "./dates";
import { DEFAULT_FIRST_DAY_OF_WEEK, type HeatmapRange } from "./heatmap";
import { TECHNIQUES, type Technique } from "./labels";
import { correlateSign, type SignCorrelation } from "@/lib/semantic/correlation";

/** A night, as the analytics need it: no notes, no text, nothing decrypted. */
export interface AnalyticsNight {
  date: IsoDate;
  techniques: readonly Technique[];
}

/** A dream, likewise: the ratings and the flags, never the entry. */
export interface AnalyticsDream {
  date: IsoDate;
  isLucid: boolean;
  vividness: number | null;
  control: number | null;
  recallClarity: number | null;
}

export const GRANULARITIES = ["week", "month"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

export function isGranularity(value: unknown): value is Granularity {
  return typeof value === "string" && (GRANULARITIES as readonly string[]).includes(value);
}

/**
 * Below this many days, a monthly view is three points and a straight line
 * between them, which is not a trend — it is two months of noise drawn
 * confidently. Weeks are noisier per point but there are enough of them to see
 * whether the noise has a direction.
 */
const WEEKLY_BELOW_DAYS = 120;

export function defaultGranularity(range: HeatmapRange): Granularity {
  return daysBetween(range.from, range.to) < WEEKLY_BELOW_DAYS ? "week" : "month";
}

export interface Bucket {
  /** First day of the bucket, and its identity. */
  start: IsoDate;
  /** Last day of the bucket. May run past the range's end; the counts do not. */
  end: IsoDate;
  /** Nights journalled at all — the denominator for everything below. */
  nights: number;
  /** Nights that produced at least one dream. */
  recalledNights: number;
  lucidNights: number;
  dreams: number;
  /** Lucid nights over nights journalled. Null when nothing was journalled. */
  lucidRate: number | null;
  /** Recalled nights over nights journalled. Null when nothing was journalled. */
  recallRate: number | null;
  /** Means over the dreams that carried a rating; null when none did. */
  vividness: number | null;
  control: number | null;
  recallClarity: number | null;
  /**
   * How many dreams carried a vividness rating. Ratings are optional, so this
   * is not `dreams`, and using `dreams` to weight the mean would over-count
   * every bucket in proportion to how much of it went unrated.
   */
  ratedVividness: number;
}

export interface Series {
  granularity: Granularity;
  buckets: Bucket[];
}

/**
 * Every bucket boundary in the range, including the ones with no data.
 *
 * Enumerating rather than grouping is the whole point: a month nobody
 * journalled has to appear as an empty bucket, because a chart that quietly
 * closes the gap draws a continuous habit out of an interrupted one.
 */
export function bucketStarts(
  range: HeatmapRange,
  granularity: Granularity,
  firstDayOfWeek: number = DEFAULT_FIRST_DAY_OF_WEEK,
): IsoDate[] {
  const step = (start: IsoDate) =>
    granularity === "month" ? addMonths(start, 1) : addDays(start, 7);

  const starts: IsoDate[] = [];
  let cursor =
    granularity === "month"
      ? startOfMonth(range.from)
      : startOfWeek(range.from, firstDayOfWeek);

  // Guarded rather than `while (true)`: a caller handing in an inverted range
  // should get an empty series, never a hang.
  while (cursor <= range.to && starts.length < 1000) {
    starts.push(cursor);
    cursor = step(cursor);
  }
  return starts;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Rolls nights and dreams up into evenly spaced buckets.
 *
 * Rows outside the range are ignored rather than clamped into the end buckets,
 * which would inflate the first and last points of every chart.
 */
export function buildSeries(
  range: HeatmapRange,
  nights: readonly AnalyticsNight[],
  dreams: readonly AnalyticsDream[],
  options: { granularity?: Granularity; firstDayOfWeek?: number } = {},
): Series {
  const granularity = options.granularity ?? defaultGranularity(range);
  const firstDayOfWeek = options.firstDayOfWeek ?? DEFAULT_FIRST_DAY_OF_WEEK;
  const starts = bucketStarts(range, granularity, firstDayOfWeek);

  const inRange = (date: IsoDate) => date >= range.from && date <= range.to;

  // Which bucket a day falls in, by binary-search-free lookup: the starts are
  // sorted, so the last start not after the day is the one.
  const indexOf = (date: IsoDate): number => {
    let found = -1;
    for (let index = 0; index < starts.length; index += 1) {
      if (starts[index]! <= date) found = index;
      else break;
    }
    return found;
  };

  const lucidDates = new Set(dreams.filter((dream) => dream.isLucid).map((dream) => dream.date));
  const recalledDates = new Set(dreams.map((dream) => dream.date));

  const buckets: Bucket[] = starts.map((start, index) => ({
    start,
    end: addDays(starts[index + 1] ?? nextAfter(start, granularity), -1),
    nights: 0,
    recalledNights: 0,
    lucidNights: 0,
    dreams: 0,
    lucidRate: null,
    recallRate: null,
    vividness: null,
    control: null,
    recallClarity: null,
    ratedVividness: 0,
  }));

  for (const night of nights) {
    if (!inRange(night.date)) continue;
    const bucket = buckets[indexOf(night.date)];
    if (!bucket) continue;
    bucket.nights += 1;
    if (recalledDates.has(night.date)) bucket.recalledNights += 1;
    if (lucidDates.has(night.date)) bucket.lucidNights += 1;
  }

  const ratings = buckets.map(() => ({
    vividness: [] as number[],
    control: [] as number[],
    recallClarity: [] as number[],
  }));

  for (const dream of dreams) {
    if (!inRange(dream.date)) continue;
    const index = indexOf(dream.date);
    const bucket = buckets[index];
    const rating = ratings[index];
    if (!bucket || !rating) continue;
    bucket.dreams += 1;
    if (dream.vividness !== null) rating.vividness.push(dream.vividness);
    if (dream.control !== null) rating.control.push(dream.control);
    if (dream.recallClarity !== null) rating.recallClarity.push(dream.recallClarity);
  }

  for (const [index, bucket] of buckets.entries()) {
    const rating = ratings[index]!;
    bucket.vividness = mean(rating.vividness);
    bucket.control = mean(rating.control);
    bucket.recallClarity = mean(rating.recallClarity);
    bucket.ratedVividness = rating.vividness.length;
    if (bucket.nights > 0) {
      bucket.lucidRate = bucket.lucidNights / bucket.nights;
      bucket.recallRate = bucket.recalledNights / bucket.nights;
    }
  }

  return { granularity, buckets };
}

function nextAfter(start: IsoDate, granularity: Granularity): IsoDate {
  return granularity === "month" ? addMonths(start, 1) : addDays(start, 7);
}

// ---------------------------------------------------------------------------
// Techniques
// ---------------------------------------------------------------------------

/**
 * Ten nights, not four.
 *
 * A dream sign is an observation — it either appeared or it did not — so four
 * appearances already say something. A technique is a fortnight of deliberate
 * effort, and its base rate is low enough that four attempts distinguish
 * nothing from anything. This is still not a significance test; it is the point
 * below which the app refuses to put a ratio on screen at all.
 */
export const MIN_CONFIDENT_TECHNIQUE_NIGHTS = 10;

export interface TechniqueStat {
  technique: Technique;
  /** Nights this technique was logged on. */
  nights: number;
  lucidNights: number;
  recalledNights: number;
  correlation: SignCorrelation;
}

export interface TechniqueReport {
  /** Lucid nights over all nights journalled — what a technique is measured against. */
  baseline: number;
  /** Nights journalled in the range, the baseline's denominator. */
  nights: number;
  /** Only techniques actually practised, best first. */
  techniques: TechniqueStat[];
  /** True when several techniques were logged on the same night, somewhere in the range. */
  overlapping: boolean;
}

/**
 * The denominator here is nights *practised*, not nights recalled — which is
 * deliberately different from the dashboard's headline "lucid rate", and the
 * two will not match.
 *
 * The headline answers "when I remember a night, how often was it lucid", which
 * is about the archive. This answers "when I did WBTB, how often did it work",
 * and a night of WBTB you remembered nothing from is a night WBTB did not work.
 * Excusing those nights would flatter every technique in proportion to how
 * badly it wrecked recall.
 */
export function techniqueEffectiveness(
  nights: readonly AnalyticsNight[],
  dreams: readonly AnalyticsDream[],
): TechniqueReport {
  const lucidDates = new Set(dreams.filter((dream) => dream.isLucid).map((dream) => dream.date));
  const recalledDates = new Set(dreams.map((dream) => dream.date));

  const tally = new Map<Technique, { nights: number; lucid: number; recalled: number }>();
  let overlapping = false;

  for (const night of nights) {
    /*
     * An empty list and an explicit "none" are folded together. Most nights are
     * logged without touching the technique field, so keeping them apart would
     * leave the control group permanently empty — and the row people read this
     * table for is "versus doing nothing".
     */
    const listed = night.techniques.length === 0 ? (["none"] as const) : night.techniques;
    const applied = [...new Set(listed)];
    if (applied.length > 1) overlapping = true;

    for (const technique of applied) {
      const entry = tally.get(technique) ?? { nights: 0, lucid: 0, recalled: 0 };
      entry.nights += 1;
      if (lucidDates.has(night.date)) entry.lucid += 1;
      if (recalledDates.has(night.date)) entry.recalled += 1;
      tally.set(technique, entry);
    }
  }

  const total = nights.length;
  const lucidNights = nights.filter((night) => lucidDates.has(night.date)).length;
  const baseline = total === 0 ? 0 : lucidNights / total;

  const techniques: TechniqueStat[] = [...tally.entries()].map(([technique, entry]) => ({
    technique,
    nights: entry.nights,
    lucidNights: entry.lucid,
    recalledNights: entry.recalled,
    correlation: correlateSign(
      { occurrences: entry.nights, lucidOccurrences: entry.lucid },
      baseline,
      MIN_CONFIDENT_TECHNIQUE_NIGHTS,
    ),
  }));

  // Same rule as the dream-sign list: nothing too thin to trust may outrank
  // something measured, however good its ratio looks.
  techniques.sort((a, b) => {
    if (a.correlation.confident !== b.correlation.confident) {
      return a.correlation.confident ? -1 : 1;
    }
    return (
      b.correlation.lucidRate - a.correlation.lucidRate ||
      b.nights - a.nights ||
      TECHNIQUES.indexOf(a.technique) - TECHNIQUES.indexOf(b.technique)
    );
  });

  return { baseline, nights: total, techniques, overlapping };
}

// ---------------------------------------------------------------------------
// Totals over a range
// ---------------------------------------------------------------------------

export interface RangeTotals {
  nights: number;
  recalledNights: number;
  lucidNights: number;
  dreams: number;
  /** Lucid nights over nights journalled. Null when nothing was journalled. */
  lucidRate: number | null;
  recallRate: number | null;
  vividness: number | null;
}

export function rangeTotals(series: Series): RangeTotals {
  const totals = series.buckets.reduce(
    (accumulator, bucket) => ({
      nights: accumulator.nights + bucket.nights,
      recalledNights: accumulator.recalledNights + bucket.recalledNights,
      lucidNights: accumulator.lucidNights + bucket.lucidNights,
      dreams: accumulator.dreams + bucket.dreams,
    }),
    { nights: 0, recalledNights: 0, lucidNights: 0, dreams: 0 },
  );

  /*
   * The mean of the buckets' means would weight a week with one rated dream
   * the same as a week with twelve, so this re-weights by how many ratings each
   * bucket actually held.
   */
  const rated = series.buckets.filter((bucket) => bucket.vividness !== null);
  const weight = rated.reduce((total, bucket) => total + bucket.ratedVividness, 0);
  const vividness =
    weight === 0
      ? null
      : rated.reduce(
          (total, bucket) => total + bucket.vividness! * bucket.ratedVividness,
          0,
        ) / weight;

  return {
    ...totals,
    lucidRate: totals.nights === 0 ? null : totals.lucidNights / totals.nights,
    recallRate: totals.nights === 0 ? null : totals.recalledNights / totals.nights,
    vividness,
  };
}
