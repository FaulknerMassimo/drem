import { describe, expect, it } from "vitest";
import { computeStreaks } from "./streaks";
import type { DayActivity } from "./heatmap";

function recalled(date: string, lucid = false): DayActivity {
  return {
    date,
    journalled: true,
    dreamCount: 1,
    lucidCount: lucid ? 1 : 0,
    wordCount: 100,
  };
}

describe("computeStreaks", () => {
  it("reports nothing for an empty journal", () => {
    const streaks = computeStreaks([], "2026-08-17");
    expect(streaks.recall).toEqual({
      current: 0,
      longest: 0,
      lastDate: null,
      atRisk: false,
    });
  });

  it("counts a run ending today", () => {
    const streaks = computeStreaks(
      ["2026-08-15", "2026-08-16", "2026-08-17"].map((d) => recalled(d)),
      "2026-08-17",
    );
    expect(streaks.recall.current).toBe(3);
    expect(streaks.recall.atRisk).toBe(false);
  });

  it("keeps a run alive on a morning not yet written up", () => {
    // Today's entry may simply not exist yet; the streak is at risk, not broken.
    const streaks = computeStreaks(
      ["2026-08-15", "2026-08-16"].map((d) => recalled(d)),
      "2026-08-17",
    );
    expect(streaks.recall.current).toBe(2);
    expect(streaks.recall.atRisk).toBe(true);
  });

  it("breaks a run once yesterday is missed too", () => {
    const streaks = computeStreaks(
      ["2026-08-14", "2026-08-15"].map((d) => recalled(d)),
      "2026-08-17",
    );
    expect(streaks.recall.current).toBe(0);
    expect(streaks.recall.longest).toBe(2);
    expect(streaks.recall.lastDate).toBe("2026-08-15");
  });

  it("remembers the longest run even after it lapses", () => {
    const streaks = computeStreaks(
      [
        "2026-01-01",
        "2026-01-02",
        "2026-01-03",
        "2026-01-04",
        "2026-08-16",
        "2026-08-17",
      ].map((d) => recalled(d)),
      "2026-08-17",
    );
    expect(streaks.recall.current).toBe(2);
    expect(streaks.recall.longest).toBe(4);
  });

  it("counts lucid nights separately from recalled ones", () => {
    const streaks = computeStreaks(
      [
        recalled("2026-08-15", true),
        recalled("2026-08-16"),
        recalled("2026-08-17", true),
      ],
      "2026-08-17",
    );
    expect(streaks.recall.current).toBe(3);
    expect(streaks.lucid.current).toBe(1);
    expect(streaks.lucid.longest).toBe(1);
  });

  it("does not count a night journalled without recall", () => {
    const streaks = computeStreaks(
      [
        recalled("2026-08-15"),
        { date: "2026-08-16", journalled: true, dreamCount: 0, lucidCount: 0, wordCount: 0 },
        recalled("2026-08-17"),
      ],
      "2026-08-17",
    );
    expect(streaks.recall.current).toBe(1);
    expect(streaks.recall.longest).toBe(1);
  });

  it("survives unsorted and duplicated input", () => {
    const streaks = computeStreaks(
      ["2026-08-17", "2026-08-15", "2026-08-16", "2026-08-16"].map((d) => recalled(d)),
      "2026-08-17",
    );
    expect(streaks.recall.current).toBe(3);
    expect(streaks.recall.longest).toBe(3);
  });

  it("counts a run that crosses a year boundary", () => {
    const streaks = computeStreaks(
      ["2025-12-30", "2025-12-31", "2026-01-01"].map((d) => recalled(d)),
      "2026-01-01",
    );
    expect(streaks.recall.current).toBe(3);
  });
});
