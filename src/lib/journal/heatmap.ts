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
  /** Outside the year being shown, or still in the future. */
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

export interface Heatmap {
  year: number;
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

/**
 * Fixed word-count thresholds rather than quantiles over the year's own data.
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
 * Lays a year out as GitHub-style week columns.
 *
 * The grid is padded to whole weeks at both ends, so the first and last columns
 * usually contain days from the neighbouring years; those are rendered as
 * blanks rather than dropped, which keeps every row a true weekday.
 */
export function buildHeatmap(
  year: number,
  activity: readonly DayActivity[],
  options: { firstDayOfWeek?: number; today?: IsoDate } = {},
): Heatmap {
  const firstDayOfWeek = options.firstDayOfWeek ?? 1;
  const todayDate = options.today ?? "9999-12-31";

  const byDate = new Map(activity.map((day) => [day.date, day]));
  const jan1: IsoDate = `${year}-01-01`;
  const dec31: IsoDate = `${year}-12-31`;
  const gridStart = startOfWeek(jan1, firstDayOfWeek);
  const gridEnd = addDays(startOfWeek(dec31, firstDayOfWeek), 6);

  const weeks: HeatmapCell[][] = [];
  const months: HeatmapMonth[] = [];
  const totals = { journalled: 0, recalled: 0, lucid: 0, dreams: 0, words: 0 };
  let seenMonth = "";

  for (let offset = 0; offset <= daysBetween(gridStart, gridEnd); offset += 1) {
    const date = addDays(gridStart, offset);
    const column = Math.floor(offset / 7);
    weeks[column] ??= [];

    if (date < jan1 || date > dec31) {
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

    // The label belongs to the column holding the month's first day, so a month
    // starting mid-week is not labelled a column early.
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

  return { year, weeks, months, firstDayOfWeek, totals };
}

/** Weekday row labels in the order the grid renders them. */
export function weekdayLabels(firstDayOfWeek: number): string[] {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return Array.from({ length: 7 }, (_, row) => names[(firstDayOfWeek + row) % 7]!);
}
