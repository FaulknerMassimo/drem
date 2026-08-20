/**
 * The activity heatmap.
 *
 * The point of this grid is honesty about the recall habit, which means it has
 * to distinguish three states a naive "commits per day" heatmap collapses into
 * one: a night you never journalled, a night you journalled and remembered
 * nothing, and a night you recalled a dream. A grid that cannot tell "no dream"
 * from "did not write" flatters you on exactly the days you most need to see.
 *
 * Pure functions only — the queries live in `stats.ts`, so the grid logic can
 * be tested without a database.
 */
import { addDays, daysBetween, startOfWeek, type IsoDate } from "./dates";

/** One day's worth of journal activity, as read from the database. */
export interface DayActivity {
  date: IsoDate;
  /** A night row exists: the morning was journalled, whatever it recorded. */
  journalled: boolean;
  dreamCount: number;
  lucidCount: number;
  /** Total words across that night's dreams. */
  wordCount: number;
}

export type CellState =
  /** Outside the range being shown, or still in the future. */
  | "empty"
  /** Nothing was written at all. */
  | "missed"
  /** Journalled, but no dream recalled. */
  | "logged"
  /** At least one dream recalled. */
  | "recalled"
  /** At least one lucid dream. */
  | "lucid";

export interface HeatmapCell {
  date: IsoDate;
  state: CellState;
  /** 0 for states with no fill, otherwise 1–4. */
  level: number;
  dreamCount: number;
  lucidCount: number;
  wordCount: number;
}

export interface HeatmapMonth {
  label: IsoDate;
  /** Index of the first week column that belongs to this month. */
  column: number;
}

/** The span of days a grid covers, inclusive at both ends. */
export interface HeatmapRange {
  from: IsoDate;
  to: IsoDate;
}

export interface Heatmap {
  from: IsoDate;
  to: IsoDate;
  /** Columns of exactly 7 cells, top to bottom. */
  weeks: HeatmapCell[][];
  months: HeatmapMonth[];
  firstDayOfWeek: number;
  totals: {
    journalled: number;
    recalled: number;
    lucid: number;
    dreams: number;
    words: number;
  };
}

/** Monday, so a week reads as a week rather than as a weekend split in two. */
export const DEFAULT_FIRST_DAY_OF_WEEK = 1;

/** How many whole weeks the trailing view shows, today's week included. */
const TRAILING_WEEKS = 53;

/**
 * The trailing window: whole weeks ending with the one today falls in.
 *
 * This is what the dashboard opens on, because a calendar year is mostly empty
 * for most of the year — in January it is a grid of 51 blank columns, which
 * says nothing about the habit. A window that always ends today is always full,
 * so the shape you are looking at is the shape of the last year of practice
 * rather than an artefact of the date.
 */
export function trailingYear(
  today: IsoDate,
  firstDayOfWeek: number = DEFAULT_FIRST_DAY_OF_WEEK,
): HeatmapRange {
  const thisWeek = startOfWeek(today, firstDayOfWeek);
  return { from: addDays(thisWeek, -(TRAILING_WEEKS - 1) * 7), to: today };
}

/** One year end to end, for looking back at a year that is over. */
export function calendarYear(year: number): HeatmapRange {
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

/**
 * Fixed word-count thresholds rather than quantiles over the range's own data.
 *
 * Adaptive scales look better but lie: the same night would change colour
 * because you wrote a long entry three months later. A fixed scale means a
 * dark square always means the same thing.
 */
const LEVEL_THRESHOLDS = [80, 250, 600] as const;

function levelForWords(words: number): number {
  if (words <= 0) return 1;
  if (words < LEVEL_THRESHOLDS[0]) return 1;
  if (words < LEVEL_THRESHOLDS[1]) return 2;
  if (words < LEVEL_THRESHOLDS[2]) return 3;
  return 4;
}

function cellFor(date: IsoDate, activity: DayActivity | undefined, todayDate: IsoDate): HeatmapCell {
  const base = {
    date,
    dreamCount: activity?.dreamCount ?? 0,
    lucidCount: activity?.lucidCount ?? 0,
    wordCount: activity?.wordCount ?? 0,
  };

  if (!activity || (!activity.journalled && activity.dreamCount === 0)) {
    // A day that has not happened yet is not a missed day.
    return { ...base, state: date > todayDate ? "empty" : "missed", level: 0 };
  }
  if (activity.dreamCount === 0) return { ...base, state: "logged", level: 0 };
  return {
    ...base,
    state: activity.lucidCount > 0 ? "lucid" : "recalled",
    level: levelForWords(activity.wordCount),
  };
}

/**
 * The columns a month label needs before the next one — or the edge of the
 * grid — crowds it out.
 *
 * A trailing window is ragged at both ends: it starts mid-month and stops on
 * whatever day today is, so either end can own a column or two. That is not
 * enough width to write "Aug" in without it landing on "Sep" or hanging off
 * the right-hand edge. Calendar months are always at least four columns wide,
 * so this only ever drops the stubs a trailing window leaves.
 */
const MIN_LABEL_COLUMNS = 3;

function labelledMonths(months: readonly HeatmapMonth[], columns: number): HeatmapMonth[] {
  return months.filter((month, index) => {
    const nextColumn = months[index + 1]?.column ?? columns;
    return nextColumn - month.column >= MIN_LABEL_COLUMNS;
  });
}

/**
 * Lays a range of days out as GitHub-style week columns.
 *
 * The grid is padded to whole weeks at both ends, so the first and last columns
 * usually contain days from outside the range; those are rendered as blanks
 * rather than dropped, which keeps every row a true weekday.
 */
export function buildHeatmap(
  range: HeatmapRange,
  activity: readonly DayActivity[],
  options: { firstDayOfWeek?: number; today?: IsoDate } = {},
): Heatmap {
  const firstDayOfWeek = options.firstDayOfWeek ?? DEFAULT_FIRST_DAY_OF_WEEK;
  const todayDate = options.today ?? "9999-12-31";
  const { from, to } = range;

  const byDate = new Map(activity.map((day) => [day.date, day]));
  const gridStart = startOfWeek(from, firstDayOfWeek);
  const gridEnd = addDays(startOfWeek(to, firstDayOfWeek), 6);

  const weeks: HeatmapCell[][] = [];
  const months: HeatmapMonth[] = [];
  const totals = { journalled: 0, recalled: 0, lucid: 0, dreams: 0, words: 0 };
  let seenMonth = "";

  for (let offset = 0; offset <= daysBetween(gridStart, gridEnd); offset += 1) {
    const date = addDays(gridStart, offset);
    const column = Math.floor(offset / 7);
    weeks[column] ??= [];

    if (date < from || date > to) {
      weeks[column]!.push({
        date,
        state: "empty",
        level: 0,
        dreamCount: 0,
        lucidCount: 0,
        wordCount: 0,
      });
      continue;
    }

    const day = byDate.get(date);
    weeks[column]!.push(cellFor(date, day, todayDate));

    // The label belongs to the column holding the month's first day in range,
    // so a month starting mid-week is not labelled a column early.
    const month = date.slice(0, 7);
    if (month !== seenMonth) {
      months.push({ label: date, column });
      seenMonth = month;
    }

    if (day) {
      if (day.journalled) totals.journalled += 1;
      if (day.dreamCount > 0) totals.recalled += 1;
      if (day.lucidCount > 0) totals.lucid += 1;
      totals.dreams += day.dreamCount;
      totals.words += day.wordCount;
    }
  }

  return {
    from,
    to,
    weeks,
    months: labelledMonths(months, weeks.length),
    firstDayOfWeek,
    totals,
  };
}

/** Weekday row labels in the order the grid renders them. */
export function weekdayLabels(firstDayOfWeek: number): string[] {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return Array.from({ length: 7 }, (_, row) => names[(firstDayOfWeek + row) % 7]!);
}
