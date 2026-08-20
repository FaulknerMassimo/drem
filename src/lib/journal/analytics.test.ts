import { describe, expect, it } from "vitest";
import {
  MIN_CONFIDENT_TECHNIQUE_NIGHTS,
  buildSeries,
  bucketStarts,
  defaultGranularity,
  rangeTotals,
  techniqueEffectiveness,
  type AnalyticsDream,
  type AnalyticsNight,
} from "./analytics";
import type { Technique } from "./labels";

function night(date: string, techniques: Technique[] = []): AnalyticsNight {
  return { date, techniques };
}

function dream(date: string, overrides: Partial<AnalyticsDream> = {}): AnalyticsDream {
  return {
    date,
    isLucid: false,
    vividness: null,
    control: null,
    recallClarity: null,
    ...overrides,
  };
}

const year = { from: "2026-01-01", to: "2026-12-31" };

describe("bucketStarts", () => {
  it("enumerates every month in the range, including empty ones", () => {
    const starts = bucketStarts(year, "month");
    expect(starts).toHaveLength(12);
    expect(starts[0]).toBe("2026-01-01");
    expect(starts[11]).toBe("2026-12-01");
  });

  it("starts a monthly range at the first of the month the range opens in", () => {
    expect(bucketStarts({ from: "2026-03-17", to: "2026-05-02" }, "month")).toEqual([
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
    ]);
  });

  it("starts a weekly range on the week's first day, not on the range's", () => {
    // 2026-08-19 is a Wednesday; the Monday of that week is the 17th.
    expect(bucketStarts({ from: "2026-08-19", to: "2026-08-31" }, "week")).toEqual([
      "2026-08-17",
      "2026-08-24",
      "2026-08-31",
    ]);
  });

  it("returns nothing for an inverted range rather than looping", () => {
    expect(bucketStarts({ from: "2026-12-31", to: "2026-01-01" }, "month")).toEqual([]);
  });
});

describe("defaultGranularity", () => {
  it("uses weeks for a short range, where months would be three points", () => {
    expect(defaultGranularity({ from: "2026-07-01", to: "2026-08-19" })).toBe("week");
  });

  it("uses months for a year", () => {
    expect(defaultGranularity(year)).toBe("month");
  });
});

describe("buildSeries", () => {
  it("leaves a month with nothing journalled without a rate, not at zero", () => {
    const series = buildSeries(
      year,
      [night("2026-01-05")],
      [dream("2026-01-05")],
      { granularity: "month" },
    );

    expect(series.buckets[0]!.lucidRate).toBe(0);
    // February was not journalled at all: that is a gap, not a failure.
    expect(series.buckets[1]!.nights).toBe(0);
    expect(series.buckets[1]!.lucidRate).toBeNull();
    expect(series.buckets[1]!.recallRate).toBeNull();
  });

  it("divides by nights journalled, so a night with no recall counts against the rate", () => {
    const series = buildSeries(
      year,
      [night("2026-01-05"), night("2026-01-06"), night("2026-01-07"), night("2026-01-08")],
      [dream("2026-01-05", { isLucid: true })],
      { granularity: "month" },
    );

    const january = series.buckets[0]!;
    expect(january.nights).toBe(4);
    expect(january.recalledNights).toBe(1);
    expect(january.lucidNights).toBe(1);
    expect(january.lucidRate).toBe(0.25);
    expect(january.recallRate).toBe(0.25);
  });

  it("counts a night once however many dreams it holds", () => {
    const series = buildSeries(
      year,
      [night("2026-01-05")],
      [
        dream("2026-01-05", { isLucid: true }),
        dream("2026-01-05", { isLucid: true }),
        dream("2026-01-05"),
      ],
      { granularity: "month" },
    );

    expect(series.buckets[0]!.lucidNights).toBe(1);
    expect(series.buckets[0]!.dreams).toBe(3);
    expect(series.buckets[0]!.lucidRate).toBe(1);
  });

  it("ignores rows outside the range instead of piling them into the end buckets", () => {
    const series = buildSeries(
      { from: "2026-06-01", to: "2026-06-30" },
      [night("2026-05-30"), night("2026-06-10"), night("2026-07-02")],
      [dream("2026-05-30"), dream("2026-07-02")],
      { granularity: "month" },
    );

    expect(series.buckets).toHaveLength(1);
    expect(series.buckets[0]!.nights).toBe(1);
    expect(series.buckets[0]!.dreams).toBe(0);
  });

  it("averages only the dreams that carried a rating", () => {
    const series = buildSeries(
      year,
      [night("2026-01-05")],
      [
        dream("2026-01-05", { vividness: 5 }),
        dream("2026-01-05", { vividness: 3 }),
        dream("2026-01-05"), // unrated: must not drag the mean towards zero
      ],
      { granularity: "month" },
    );

    expect(series.buckets[0]!.vividness).toBe(4);
    expect(series.buckets[0]!.ratedVividness).toBe(2);
    expect(series.buckets[0]!.control).toBeNull();
  });
});

describe("rangeTotals", () => {
  it("weights the vividness mean by ratings, not by dreams", () => {
    const series = buildSeries(
      year,
      [night("2026-01-05"), night("2026-02-05")],
      [
        // January: one rated dream at 5, plus two unrated ones.
        dream("2026-01-05", { vividness: 5 }),
        dream("2026-01-05"),
        dream("2026-01-05"),
        // February: one rated dream at 1.
        dream("2026-02-05", { vividness: 1 }),
      ],
      { granularity: "month" },
    );

    // Both months hold exactly one rating, so the answer is 3 — weighting by
    // dream count would have pulled it towards January's 5.
    expect(rangeTotals(series).vividness).toBe(3);
  });

  it("has no rate at all when nothing was journalled", () => {
    const totals = rangeTotals(buildSeries(year, [], [], { granularity: "month" }));
    expect(totals.nights).toBe(0);
    expect(totals.lucidRate).toBeNull();
    expect(totals.vividness).toBeNull();
  });
});

describe("techniqueEffectiveness", () => {
  function nightsPractising(technique: Technique, count: number, lucid: number) {
    const nights: AnalyticsNight[] = [];
    const dreams: AnalyticsDream[] = [];
    for (let index = 0; index < count; index += 1) {
      const date = `2026-03-${String(index + 1).padStart(2, "0")}`;
      nights.push(night(date, [technique]));
      if (index < lucid) dreams.push(dream(date, { isLucid: true }));
    }
    return { nights, dreams };
  }

  it("counts a practised night that produced no recall against the technique", () => {
    const { nights, dreams } = nightsPractising("wbtb", 4, 1);
    const report = techniqueEffectiveness(nights, dreams);
    const wbtb = report.techniques.find((entry) => entry.technique === "wbtb")!;

    expect(wbtb.nights).toBe(4);
    expect(wbtb.recalledNights).toBe(1);
    // 1 in 4, not 1 in 1: the three forgotten nights are three nights it did
    // not work, not three nights that do not count.
    expect(wbtb.correlation.lucidRate).toBe(0.25);
  });

  it("files a night with no technique recorded under 'none', so there is a control group", () => {
    const report = techniqueEffectiveness(
      [night("2026-03-01"), night("2026-03-02", ["none"])],
      [],
    );

    expect(report.techniques).toHaveLength(1);
    expect(report.techniques[0]!.technique).toBe("none");
    expect(report.techniques[0]!.nights).toBe(2);
  });

  it("credits every technique logged on one night, and says so", () => {
    const report = techniqueEffectiveness(
      [night("2026-03-01", ["mild", "wbtb"])],
      [dream("2026-03-01", { isLucid: true })],
    );

    expect(report.overlapping).toBe(true);
    expect(report.techniques.map((entry) => entry.technique).sort()).toEqual(["mild", "wbtb"]);
    for (const entry of report.techniques) expect(entry.lucidNights).toBe(1);
  });

  it("measures against the archive's own lucid rate over nights journalled", () => {
    const report = techniqueEffectiveness(
      [
        night("2026-03-01", ["mild"]),
        night("2026-03-02", ["mild"]),
        night("2026-03-03"),
        night("2026-03-04"),
      ],
      [dream("2026-03-01", { isLucid: true })],
    );

    expect(report.nights).toBe(4);
    expect(report.baseline).toBe(0.25);
    const mild = report.techniques.find((entry) => entry.technique === "mild")!;
    expect(mild.correlation.lucidRate).toBe(0.5);
    expect(mild.correlation.lift).toBe(2);
  });

  it("refuses to call a handful of nights a result", () => {
    const { nights, dreams } = nightsPractising("wild", MIN_CONFIDENT_TECHNIQUE_NIGHTS - 1, 5);
    const wild = techniqueEffectiveness(nights, dreams).techniques[0]!;
    expect(wild.correlation.confident).toBe(false);
  });

  it("ranks a measured technique above a spectacular but untested one", () => {
    const measured = nightsPractising("mild", MIN_CONFIDENT_TECHNIQUE_NIGHTS, 4);
    const untested = {
      nights: [night("2026-04-01", ["wild"]), night("2026-04-02", ["wild"])],
      dreams: [
        dream("2026-04-01", { isLucid: true }),
        dream("2026-04-02", { isLucid: true }),
      ],
    };

    const report = techniqueEffectiveness(
      [...measured.nights, ...untested.nights],
      [...measured.dreams, ...untested.dreams],
    );

    // WILD is at 100% and MILD at 40%, but two nights is not a finding.
    expect(report.techniques[0]!.technique).toBe("mild");
    expect(report.techniques[1]!.technique).toBe("wild");
  });

  it("has no opinion about an empty archive", () => {
    const report = techniqueEffectiveness([], []);
    expect(report.baseline).toBe(0);
    expect(report.techniques).toEqual([]);
    expect(report.overlapping).toBe(false);
  });
});
