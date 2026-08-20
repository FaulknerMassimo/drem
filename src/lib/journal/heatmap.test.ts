import { describe, expect, it } from "vitest";
import {
  buildHeatmap,
  calendarYear,
  trailingYear,
  weekdayLabels,
  type DayActivity,
} from "./heatmap";

function day(date: string, overrides: Partial<DayActivity> = {}): DayActivity {
  return {
    date,
    journalled: true,
    dreamCount: 0,
    lucidCount: 0,
    wordCount: 0,
    ...overrides,
  };
}

/** Finds a cell by date across the whole grid. */
function cell(grid: ReturnType<typeof buildHeatmap>, date: string) {
  return grid.weeks.flat().find((candidate) => candidate.date === date);
}

describe("buildHeatmap", () => {
  it("covers every day of the range in whole weeks", () => {
    const grid = buildHeatmap(calendarYear(2026), [], { today: "2026-12-31" });
    expect(grid.weeks.every((week) => week.length === 7)).toBe(true);
    const inYear = grid.weeks.flat().filter((c) => c.date.startsWith("2026"));
    expect(inYear).toHaveLength(365);
  });

  it("covers every day of a leap year", () => {
    const grid = buildHeatmap(calendarYear(2028), [], { today: "2028-12-31" });
    const inYear = grid.weeks.flat().filter((c) => c.date.startsWith("2028"));
    expect(inYear).toHaveLength(366);
  });

  it("pads the edges with blanks rather than shifting the weekday rows", () => {
    const grid = buildHeatmap(calendarYear(2026), [], { firstDayOfWeek: 1, today: "2026-12-31" });
    // 1 January 2026 is a Thursday, so the first column holds three days of 2025.
    const first = grid.weeks[0]!;
    expect(first.slice(0, 3).every((c) => c.state === "empty")).toBe(true);
    expect(first[3]!.date).toBe("2026-01-01");
  });

  it("keeps each weekday on its own row", () => {
    const grid = buildHeatmap(calendarYear(2026), [], { firstDayOfWeek: 1, today: "2026-12-31" });
    // Row 0 is Monday when the week starts on Monday.
    for (const week of grid.weeks) {
      expect(new Date(`${week[0]!.date}T00:00:00Z`).getUTCDay()).toBe(1);
    }
  });

  it("distinguishes a night not journalled from one journalled without recall", () => {
    const grid = buildHeatmap(
      calendarYear(2026),
      [day("2026-08-17", { journalled: true, dreamCount: 0 })],
      { today: "2026-12-31" },
    );
    // The distinction the whole grid exists for.
    expect(cell(grid, "2026-08-17")!.state).toBe("logged");
    expect(cell(grid, "2026-08-18")!.state).toBe("missed");
  });

  it("does not count days that have not happened yet as missed", () => {
    const grid = buildHeatmap(calendarYear(2026), [], { today: "2026-08-17" });
    expect(cell(grid, "2026-08-17")!.state).toBe("missed");
    expect(cell(grid, "2026-08-18")!.state).toBe("empty");
  });

  it("marks a night with any lucid dream as lucid", () => {
    const grid = buildHeatmap(
      calendarYear(2026),
      [day("2026-08-17", { dreamCount: 3, lucidCount: 1, wordCount: 400 })],
      { today: "2026-12-31" },
    );
    expect(cell(grid, "2026-08-17")!.state).toBe("lucid");
  });

  it("scales intensity by how much was written", () => {
    const grid = buildHeatmap(
      calendarYear(2026),
      [
        day("2026-03-01", { dreamCount: 1, wordCount: 20 }),
        day("2026-03-02", { dreamCount: 1, wordCount: 120 }),
        day("2026-03-03", { dreamCount: 1, wordCount: 400 }),
        day("2026-03-04", { dreamCount: 1, wordCount: 5000 }),
      ],
      { today: "2026-12-31" },
    );
    expect(cell(grid, "2026-03-01")!.level).toBe(1);
    expect(cell(grid, "2026-03-02")!.level).toBe(2);
    expect(cell(grid, "2026-03-03")!.level).toBe(3);
    expect(cell(grid, "2026-03-04")!.level).toBe(4);
  });

  it("labels each month against the column its first day falls in", () => {
    const grid = buildHeatmap(calendarYear(2026), [], { firstDayOfWeek: 1, today: "2026-12-31" });
    expect(grid.months).toHaveLength(12);
    expect(grid.months[0]).toEqual({ label: "2026-01-01", column: 0 });
    const february = grid.months[1]!;
    expect(cell(grid, "2026-02-01")).toBeDefined();
    expect(grid.weeks[february.column]!.some((c) => c.date === "2026-02-01")).toBe(true);
  });

  it("ignores activity from other years when totalling", () => {
    const grid = buildHeatmap(
      calendarYear(2026),
      [
        day("2025-12-31", { dreamCount: 1, wordCount: 100 }),
        day("2026-01-01", { dreamCount: 2, lucidCount: 1, wordCount: 300 }),
      ],
      { today: "2026-12-31" },
    );
    expect(grid.totals).toEqual({
      journalled: 1,
      recalled: 1,
      lucid: 1,
      dreams: 2,
      words: 300,
    });
  });

  it("orders weekday labels from the configured first day", () => {
    expect(weekdayLabels(1)[0]).toBe("Mon");
    expect(weekdayLabels(0)[0]).toBe("Sun");
    expect(weekdayLabels(1)).toHaveLength(7);
  });
});

describe("trailingYear", () => {
  it("ends today and starts on a week boundary a year earlier", () => {
    const range = trailingYear("2026-08-19", 1);
    expect(range.to).toBe("2026-08-19");
    // 17 August 2026 is a Monday, so the window starts 52 weeks before it.
    expect(range.from).toBe("2025-08-18");
  });

  it("fills the grid whatever the date, which is the point of it", () => {
    // Early January is where a calendar year has nothing to show.
    const grid = buildHeatmap(trailingYear("2026-01-03"), [], { today: "2026-01-03" });
    expect(grid.weeks).toHaveLength(53);
    const drawn = grid.weeks.flat().filter((c) => c.state !== "empty");
    // 52 whole weeks, plus the part of this one that has happened: 3 January
    // 2026 is a Saturday, so six days of the last column are drawn.
    expect(drawn).toHaveLength(52 * 7 + 6);
    expect(drawn.at(-1)!.date).toBe("2026-01-03");
    // Only the tail of the final column is blank — nothing else.
    const blank = grid.weeks.flat().filter((c) => c.state === "empty");
    expect(blank).toHaveLength(1);
  });

  it("carries activity across the year boundary it straddles", () => {
    const grid = buildHeatmap(
      trailingYear("2026-02-01"),
      [
        day("2025-11-20", { dreamCount: 1, wordCount: 100 }),
        day("2026-01-15", { dreamCount: 1, lucidCount: 1, wordCount: 100 }),
      ],
      { today: "2026-02-01" },
    );
    expect(cell(grid, "2025-11-20")!.state).toBe("recalled");
    expect(cell(grid, "2026-01-15")!.state).toBe("lucid");
    expect(grid.totals.recalled).toBe(2);
  });

  it("does not label a first month too narrow to write in", () => {
    // The window opens on 18 August, leaving August two columns.
    const grid = buildHeatmap(trailingYear("2026-08-19"), [], { today: "2026-08-19" });
    expect(grid.months[0]!.label.slice(0, 7)).toBe("2025-09");
    expect(grid.months.every((month) => month.column >= 0)).toBe(true);
  });
});
