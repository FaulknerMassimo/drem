import { describe, expect, it } from "vitest";
import {
  correlateSign,
  describeLift,
  MIN_CONFIDENT_OCCURRENCES,
  rankSigns,
  type RankableSign,
} from "./correlation";

function sign(
  label: string,
  occurrences: number,
  lucidOccurrences: number,
  baseline = 0.2,
  lastSeenAt: string | null = null,
): RankableSign {
  return {
    label,
    lastSeenAt,
    correlation: correlateSign({ occurrences, lucidOccurrences }, baseline),
  };
}

describe("correlateSign", () => {
  it("reports the lucid rate among the dreams carrying the sign", () => {
    const correlation = correlateSign({ occurrences: 8, lucidOccurrences: 4 }, 0.2);
    expect(correlation.lucidRate).toBe(0.5);
  });

  it("reports lift against the archive's own rate, not against zero", () => {
    // The whole question is whether this cue beats how often the dreamer goes
    // lucid anyway, so a 50% sign in a 25% archive is 2x, not "50%".
    const correlation = correlateSign({ occurrences: 8, lucidOccurrences: 4 }, 0.25);
    expect(correlation.lift).toBe(2);
  });

  it("has no lift to report when the dreamer has never gone lucid", () => {
    const correlation = correlateSign({ occurrences: 8, lucidOccurrences: 0 }, 0);
    expect(correlation.lift).toBeNull();
  });

  it("treats a sign with no occurrences as a zero rate, not a division by zero", () => {
    const correlation = correlateSign({ occurrences: 0, lucidOccurrences: 0 }, 0.2);
    expect(correlation.lucidRate).toBe(0);
    expect(correlation.confident).toBe(false);
  });

  it("is not confident until there are enough appearances", () => {
    expect(correlateSign({ occurrences: 1, lucidOccurrences: 1 }, 0.2).confident).toBe(false);
    expect(
      correlateSign(
        { occurrences: MIN_CONFIDENT_OCCURRENCES, lucidOccurrences: 1 },
        0.2,
      ).confident,
    ).toBe(true);
  });
});

describe("describeLift", () => {
  it("says nothing at all off a thin sample", () => {
    // One lucid dream out of one is a 100% lucid rate and means nothing; a
    // hedged sentence would still read as a number.
    expect(describeLift(correlateSign({ occurrences: 1, lucidOccurrences: 1 }, 0.2))).toBeNull();
  });

  it("names a real effect", () => {
    expect(describeLift(correlateSign({ occurrences: 10, lucidOccurrences: 5 }, 0.2))).toBe(
      "2.5× more often lucid than usual",
    );
  });

  it("names the effect in the other direction too", () => {
    expect(describeLift(correlateSign({ occurrences: 10, lucidOccurrences: 1 }, 0.4))).toBe(
      "4.0× less often lucid than usual",
    );
  });

  it("says so plainly when the sign changes nothing", () => {
    expect(describeLift(correlateSign({ occurrences: 10, lucidOccurrences: 2 }, 0.2))).toBe(
      "about as lucid as usual",
    );
  });

  it("does not claim a multiple when the sign has never been lucid", () => {
    expect(describeLift(correlateSign({ occurrences: 10, lucidOccurrences: 0 }, 0.2))).toBe(
      "never lucid so far",
    );
  });
});

describe("rankSigns", () => {
  it("keeps a thin sample below every trustworthy sign, however extreme", () => {
    // The one case that actually matters: a one-in-one sign scores 100% and
    // would otherwise take the top row away from a sign backed by evidence.
    const ranked = rankSigns([sign("fluke", 1, 1), sign("real", 10, 5)], "lucidity");
    expect(ranked.map((entry) => entry.label)).toEqual(["real", "fluke"]);
  });

  it("orders trustworthy signs by lucid rate", () => {
    const ranked = rankSigns([sign("weak", 10, 2), sign("strong", 10, 7)], "lucidity");
    expect(ranked.map((entry) => entry.label)).toEqual(["strong", "weak"]);
  });

  it("orders by appearances when asked for frequency", () => {
    const ranked = rankSigns([sign("rare", 4, 4), sign("common", 30, 1)], "frequency");
    expect(ranked.map((entry) => entry.label)).toEqual(["common", "rare"]);
  });

  it("orders by last appearance when asked for recency", () => {
    const ranked = rankSigns(
      [
        sign("old", 10, 5, 0.2, "2026-01-01"),
        sign("fresh", 10, 5, 0.2, "2026-08-01"),
        sign("never", 0, 0, 0.2, null),
      ],
      "recent",
    );
    expect(ranked.map((entry) => entry.label)).toEqual(["fresh", "old", "never"]);
  });

  it("does not mutate what it was given", () => {
    const signs = [sign("b", 10, 1), sign("a", 10, 9)];
    rankSigns(signs, "lucidity");
    expect(signs.map((entry) => entry.label)).toEqual(["b", "a"]);
  });
});
