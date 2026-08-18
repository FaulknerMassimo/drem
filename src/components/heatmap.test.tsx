/**
 * Rendering checks for the presentational components.
 *
 * These are not snapshot tests: they assert the handful of things that would be
 * silently wrong rather than obviously broken — that a lucid night is drawn
 * differently from a merely long one, that a night journalled without recall is
 * not drawn as a gap, and that every cell is reachable.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Heatmap } from "./heatmap";
import { DreamList } from "./dream-list";
import type { DayActivity } from "@/lib/journal/heatmap";
import type { DreamSummary } from "@/lib/journal/dreams";

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

function summary(overrides: Partial<DreamSummary> = {}): DreamSummary {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    dreamDate: "2026-08-17",
    title: "The cathedral",
    preview: "I was flying over it.",
    isLucid: false,
    lucidity: 0,
    isNightmare: false,
    isFragment: false,
    isDraft: false,
    wordCount: 5,
    source: "typed",
    tags: [],
    ...overrides,
  };
}

describe("Heatmap", () => {
  const activity = [
    day("2026-08-15", { dreamCount: 1, wordCount: 400 }),
    day("2026-08-16", { dreamCount: 0 }),
    day("2026-08-17", { dreamCount: 1, lucidCount: 1, wordCount: 400 }),
  ];

  const markup = renderToStaticMarkup(
    <Heatmap year={2026} activity={activity} today="2026-08-17" years={[2026, 2025]} />,
  );

  it("draws a lucid night in a different ramp from a recalled one", () => {
    // Same word count, so only the hue distinguishes them — which is the point.
    expect(markup).toContain("hm-recalled-3");
    expect(markup).toContain("hm-lucid-3");
  });

  it("draws a night journalled without recall as an outline, not a gap", () => {
    expect(markup).toContain("hm-logged");
  });

  it("links every day up to today to its night, and no further", () => {
    expect(markup).toContain('href="/night/2026-08-17"');
    expect(markup).toContain('href="/night/2026-03-04"');
    // A day that has not happened is not somewhere you can journal.
    expect(markup).not.toContain('href="/night/2026-08-18"');
    // 1 January to 17 August inclusive. More would mean a neighbouring year's
    // padding had leaked into the grid.
    expect(markup.match(/href="\/night\//g)).toHaveLength(229);
  });

  it("describes each cell in text, not colour alone", () => {
    expect(markup).toContain("1 dream, 1 lucid, 400 words");
    expect(markup).toContain("journalled, no dream recalled");
    expect(markup).toContain("nothing journalled");
  });

  it("offers the years it was given, marking the one in view", () => {
    expect(markup).toContain('href="/?year=2025"');
    expect(markup).toContain('aria-current="page"');
  });

  it("does not render days that have not happened as missed", () => {
    const future = renderToStaticMarkup(
      <Heatmap year={2026} activity={[]} today="2026-01-02" years={[2026]} />,
    );
    // Two days in, only those two can have been missed. Matched against the
    // anchor so the legend's own swatch is not counted.
    expect(future.match(/<a[^>]*hm-missed/g)).toHaveLength(2);
  });
});

describe("DreamList", () => {
  it("marks a lucid entry, a nightmare and a draft distinctly", () => {
    const markup = renderToStaticMarkup(
      <DreamList
        dreams={[
          summary({ isLucid: true, lucidity: 4 }),
          summary({ id: "b", isNightmare: true }),
          summary({ id: "c", isDraft: true }),
        ]}
        empty="nothing"
      />,
    );
    expect(markup).toContain("Stable and aware");
    expect(markup).toContain("Nightmare");
    expect(markup).toContain("Draft");
  });

  it("shows the empty state rather than an empty list", () => {
    const markup = renderToStaticMarkup(<DreamList dreams={[]} empty="Nothing written yet." />);
    expect(markup).toContain("Nothing written yet.");
    expect(markup).not.toContain("<li");
  });

  it("renders an untitled entry without inventing a title", () => {
    const markup = renderToStaticMarkup(
      <DreamList dreams={[summary({ title: null })]} empty="nothing" />,
    );
    expect(markup).toContain("Untitled");
  });
});
