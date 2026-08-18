import { describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  describeDate,
  isIsoDate,
  nightDateFor,
  startOfWeek,
  toIsoDate,
  weekday,
} from "./dates";

describe("isIsoDate", () => {
  it("accepts a real calendar day", () => {
    expect(isIsoDate("2026-08-17")).toBe(true);
  });

  it("rejects a day that does not exist", () => {
    expect(isIsoDate("2026-02-31")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
  });

  it("rejects anything that is not a bare date", () => {
    expect(isIsoDate("2026-8-17")).toBe(false);
    expect(isIsoDate("2026-08-17T03:00:00Z")).toBe(false);
    expect(isIsoDate(20260817)).toBe(false);
    expect(isIsoDate(null)).toBe(false);
  });
});

describe("date arithmetic", () => {
  it("crosses month and year boundaries", () => {
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("handles the leap day", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(daysBetween("2028-01-01", "2029-01-01")).toBe(366);
  });

  it("counts backwards as a negative difference", () => {
    expect(daysBetween("2026-08-17", "2026-08-10")).toBe(-7);
  });

  it("does not drift across a spring-forward boundary", () => {
    // 29 March 2026 is the European DST transition; a local-time implementation
    // would produce a 23-hour day here and round to the wrong date.
    expect(addDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30");
    expect(daysBetween("2026-03-01", "2026-04-01")).toBe(31);
  });

  it("reports weekdays with Sunday as zero", () => {
    expect(weekday("2026-08-16")).toBe(0);
    expect(weekday("2026-08-17")).toBe(1);
  });

  it("snaps to the start of the week the calendar is configured for", () => {
    expect(startOfWeek("2026-08-19", 1)).toBe("2026-08-17");
    expect(startOfWeek("2026-08-19", 0)).toBe("2026-08-16");
    expect(startOfWeek("2026-08-17", 1)).toBe("2026-08-17");
  });
});

describe("toIsoDate", () => {
  it("reads the local calendar day, not the UTC one", () => {
    // Constructed from local components, so this is the 17th locally whatever
    // the machine's timezone is — including where UTC would say the 16th.
    expect(toIsoDate(new Date(2026, 7, 17, 23, 30))).toBe("2026-08-17");
    expect(toIsoDate(new Date(2026, 7, 17, 0, 30))).toBe("2026-08-17");
  });
});

describe("nightDateFor", () => {
  it("files a 3am capture against the night that is ending", () => {
    expect(nightDateFor(new Date(2026, 7, 17, 3, 12))).toBe("2026-08-17");
  });

  it("files a morning entry against the same day", () => {
    expect(nightDateFor(new Date(2026, 7, 17, 8, 0))).toBe("2026-08-17");
  });

  it("files a late-evening capture against the night about to begin", () => {
    expect(nightDateFor(new Date(2026, 7, 17, 23, 45))).toBe("2026-08-18");
  });

  it("rolls over the year at the cutoff on new year's eve", () => {
    expect(nightDateFor(new Date(2026, 11, 31, 22, 0))).toBe("2027-01-01");
  });
});

describe("describeDate", () => {
  it("names the two days that have names", () => {
    const now = new Date(2026, 7, 17, 9, 0);
    expect(describeDate("2026-08-17", now)).toBe("Today");
    expect(describeDate("2026-08-16", now)).toBe("Yesterday");
    expect(describeDate("2026-08-15", now)).toBe("Sat, 15 Aug 2026");
  });
});
