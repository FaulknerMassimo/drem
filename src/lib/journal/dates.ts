/**
 * Calendar dates for the journal.
 *
 * A journal date is a calendar day, not an instant: the night of the 17th is
 * the night of the 17th whatever timezone the server happens to run in. Dates
 * are therefore stored as Postgres `date`, handled as `YYYY-MM-DD` strings
 * everywhere, and every arithmetic operation below goes through UTC components
 * so a local DST shift can never slide an entry into the previous day.
 *
 * The one place the local clock is authoritative is deciding what "today" and
 * "tonight" mean, which is a question about the person's wall clock.
 */

/** A calendar day in `YYYY-MM-DD` form. */
export type IsoDate = string;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) return false;
  // Round-tripping rejects 2026-02-31: Date would normalise it to 2026-03-03,
  // so a value that does not come back unchanged was never a real day.
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/** Reads the *local* calendar day off an instant. */
export function toIsoDate(instant: Date): IsoDate {
  const year = String(instant.getFullYear()).padStart(4, "0");
  const month = String(instant.getMonth() + 1).padStart(2, "0");
  const day = String(instant.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** UTC midnight of a calendar day. For arithmetic and formatting only. */
function utc(date: IsoDate): Date {
  return new Date(`${date}T00:00:00Z`);
}

export function addDays(date: IsoDate, delta: number): IsoDate {
  const shifted = utc(date);
  shifted.setUTCDate(shifted.getUTCDate() + delta);
  return shifted.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((utc(to).getTime() - utc(from).getTime()) / 86_400_000);
}

/** 0 = Sunday, matching `Date.getDay()`. */
export function weekday(date: IsoDate): number {
  return utc(date).getUTCDay();
}

export function startOfWeek(date: IsoDate, firstDayOfWeek: number): IsoDate {
  return addDays(date, -((weekday(date) - firstDayOfWeek + 7) % 7));
}

export function yearOf(date: IsoDate): number {
  return Number(date.slice(0, 4));
}

export function monthOf(date: IsoDate): number {
  return Number(date.slice(5, 7));
}

export function today(now: Date = new Date()): IsoDate {
  return toIsoDate(now);
}

/**
 * After this hour, a capture is filed against tomorrow's date.
 *
 * The trade-off: someone writing up last night's dream at 9pm gets it filed
 * under tonight. Late evening is far more often "about to sleep" than "writing
 * up yesterday", and the draft queue shows the date it chose so it can be
 * corrected — whereas a 4am capture landing on the wrong day would be silently
 * wrong every single time, which is the case that actually matters.
 */
export const EVENING_CUTOFF_HOUR = 20;

/** The date of the night currently in progress, from the local wall clock. */
export function nightDateFor(now: Date = new Date()): IsoDate {
  const date = toIsoDate(now);
  return now.getHours() >= EVENING_CUTOFF_HOUR ? addDays(date, 1) : date;
}

const FULL = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const DAY_MONTH = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

const MONTH = new Intl.DateTimeFormat("en-GB", {
  month: "short",
  timeZone: "UTC",
});

/** "Mon 17 Aug 2026". Formatted in UTC so the day never shifts under it. */
export function formatDate(date: IsoDate): string {
  return FULL.format(utc(date));
}

export function formatDayMonth(date: IsoDate): string {
  return DAY_MONTH.format(utc(date));
}

export function formatMonth(date: IsoDate): string {
  return MONTH.format(utc(date));
}

/** A friendlier label for the two dates that have names. */
export function describeDate(date: IsoDate, now: Date = new Date()): string {
  const reference = toIsoDate(now);
  if (date === reference) return "Today";
  if (date === addDays(reference, -1)) return "Yesterday";
  return formatDate(date);
}
