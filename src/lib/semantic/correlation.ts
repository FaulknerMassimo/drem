/**
 * How much a dream sign is worth paying attention to.
 *
 * The number that matters for lucid-dreaming practice is not how often a cue
 * appears, it is whether appearing changes the odds of noticing you are
 * dreaming. That is the lucid rate *among dreams carrying the sign*, against
 * the lucid rate of the archive as a whole.
 *
 * Pure, and unit-tested, because this is the part a reader will actually act
 * on: a sign presented as "4× more lucid" off a single dream would send someone
 * to spend a month doing reality checks on the wrong cue.
 */

/**
 * Below this, a ratio is noise.
 *
 * One lucid dream out of one occurrence is a 100% lucid rate and means nothing.
 * Four is still a small sample — it is not a significance test — but it is the
 * point at which the number stops being an artefact of a single night.
 */
export const MIN_CONFIDENT_OCCURRENCES = 4;

export interface SignTally {
  occurrences: number;
  lucidOccurrences: number;
}

export interface SignCorrelation extends SignTally {
  /** Share of the dreams carrying this sign that were lucid, 0–1. */
  lucidRate: number;
  /** The archive's own lucid rate, for comparison. */
  baseline: number;
  /**
   * Lucid rate divided by baseline. 2 means twice as likely as usual.
   * Null when the baseline is zero — nothing is a multiple of nothing.
   */
  lift: number | null;
  /** False when there are too few occurrences for the ratio to mean anything. */
  confident: boolean;
}

/**
 * `minOccurrences` is a parameter rather than a constant because the same
 * maths answers the same question for induction techniques, where the floor is
 * higher — four nights of MILD is a coin flip, four appearances of a recurring
 * character is a pattern. See `journal/analytics.ts`.
 */
export function correlateSign(
  tally: SignTally,
  baseline: number,
  minOccurrences: number = MIN_CONFIDENT_OCCURRENCES,
): SignCorrelation {
  const lucidRate = tally.occurrences === 0 ? 0 : tally.lucidOccurrences / tally.occurrences;
  return {
    ...tally,
    lucidRate,
    baseline,
    lift: baseline > 0 ? lucidRate / baseline : null,
    confident: tally.occurrences >= minOccurrences,
  };
}

export const SIGN_SORTS = ["lucidity", "frequency", "recent"] as const;
export type SignSort = (typeof SIGN_SORTS)[number];

export function isSignSort(value: unknown): value is SignSort {
  return typeof value === "string" && (SIGN_SORTS as readonly string[]).includes(value);
}

export interface RankableSign {
  label: string;
  correlation: SignCorrelation;
  lastSeenAt: string | null;
}

/**
 * Orders signs for display.
 *
 * Under "lucidity", signs with too few occurrences to trust sort *below* every
 * confident one however extreme their ratio. Letting a one-in-one sign take the
 * top row is exactly the misreading `confident` exists to prevent, and sorting
 * is where that misreading would actually happen.
 */
export function rankSigns<T extends RankableSign>(signs: readonly T[], sort: SignSort): T[] {
  const ordered = [...signs];
  ordered.sort((a, b) => {
    if (sort === "frequency") {
      return (
        b.correlation.occurrences - a.correlation.occurrences ||
        a.label.localeCompare(b.label)
      );
    }
    if (sort === "recent") {
      return (
        (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "") ||
        b.correlation.occurrences - a.correlation.occurrences
      );
    }
    if (a.correlation.confident !== b.correlation.confident) {
      return a.correlation.confident ? -1 : 1;
    }
    return (
      b.correlation.lucidRate - a.correlation.lucidRate ||
      b.correlation.occurrences - a.correlation.occurrences ||
      a.label.localeCompare(b.label)
    );
  });
  return ordered;
}

/**
 * One phrase for what the ratio says, or null when it says nothing.
 *
 * Returns null rather than a hedged sentence for thin samples: the UI shows
 * "too few to tell" in its own words, and a number wrapped in caveats still
 * reads as a number.
 */
export function describeLift(correlation: SignCorrelation): string | null {
  if (!correlation.confident || correlation.lift === null) return null;
  if (correlation.baseline === 0) return null;

  const ratio = correlation.lift;
  if (ratio >= 1.25) return `${format(ratio)}× more often lucid than usual`;
  if (ratio <= 0.8 && ratio > 0) return `${format(1 / ratio)}× less often lucid than usual`;
  if (ratio === 0) return "never lucid so far";
  return "about as lucid as usual";
}

function format(ratio: number): string {
  return ratio >= 10 ? String(Math.round(ratio)) : ratio.toFixed(1);
}
