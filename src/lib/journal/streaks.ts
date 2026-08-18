/**
 * Recall and lucidity streaks.
 *
 * The streak is the feedback loop the habit runs on, so its edge cases have to
 * be right: a streak is not broken by today being unwritten (the morning may
 * simply not have happened yet), but it is broken by yesterday being unwritten.
 *
 * Pure functions; the queries live in `stats.ts`.
 */
import { addDays, type IsoDate } from "./dates";
import type { DayActivity } from "./heatmap";

export interface Streak {
  /** Length of the run ending today or yesterday; 0 when it has lapsed. */
  current: number;
  longest: number;
  /** The most recent qualifying day, or null when there has never been one. */
  lastDate: IsoDate | null;
  /** True when today has not qualified yet but yesterday did — the run is live but at risk. */
  atRisk: boolean;
}

export interface Streaks {
  recall: Streak;
  lucid: Streak;
}

function streakOver(days: readonly IsoDate[], todayDate: IsoDate): Streak {
  if (days.length === 0) {
    return { current: 0, longest: 0, lastDate: null, atRisk: false };
  }

  const sorted = [...new Set(days)].sort();
  const last = sorted[sorted.length - 1]!;

  let longest = 1;
  let run = 1;
  for (let index = 1; index < sorted.length; index += 1) {
    run = sorted[index] === addDays(sorted[index - 1]!, 1) ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  // Walk back from whichever of today/yesterday actually qualified. Anything
  // older than yesterday means the run has already lapsed.
  const yesterday = addDays(todayDate, -1);
  let cursor = sorted.includes(todayDate)
    ? todayDate
    : sorted.includes(yesterday)
      ? yesterday
      : null;

  let current = 0;
  const present = new Set(sorted);
  while (cursor && present.has(cursor)) {
    current += 1;
    cursor = addDays(cursor, -1);
  }

  return {
    current,
    longest,
    lastDate: last,
    atRisk: current > 0 && !present.has(todayDate),
  };
}

export function computeStreaks(
  activity: readonly DayActivity[],
  todayDate: IsoDate,
): Streaks {
  return {
    recall: streakOver(
      activity.filter((day) => day.dreamCount > 0).map((day) => day.date),
      todayDate,
    ),
    lucid: streakOver(
      activity.filter((day) => day.lucidCount > 0).map((day) => day.date),
      todayDate,
    ),
  };
}
