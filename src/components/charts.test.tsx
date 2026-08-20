/**
 * The chart geometry, and the handful of rendering facts that would be wrong
 * rather than broken.
 *
 * The one that matters is the gap: a bucket with no data must not be drawn on
 * the floor of the chart, because a month nobody journalled would then look
 * exactly like a month of trying and failing.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Meter, TrendChart, linePath, pointX, pointY, type ChartScale } from "./charts";

const scale: ChartScale = { width: 100, height: 50, min: 0, max: 1, count: 5 };

function point(key: string, value: number | null) {
  return { key, label: key, value, title: `${key}: ${value ?? "nothing"}` };
}

describe("chart geometry", () => {
  it("spreads points across the full width", () => {
    expect(pointX(0, scale)).toBe(0);
    expect(pointX(4, scale)).toBe(100);
    expect(pointX(2, scale)).toBe(50);
  });

  it("centres a lone point instead of pinning it to the left edge", () => {
    expect(pointX(0, { ...scale, count: 1 })).toBe(50);
  });

  it("puts the maximum at the top, because SVG's y grows downwards", () => {
    expect(pointY(1, scale)).toBe(0);
    expect(pointY(0, scale)).toBe(50);
    expect(pointY(0.5, scale)).toBe(25);
  });

  it("clamps a value outside the axis rather than drawing off the chart", () => {
    expect(pointY(2, scale)).toBe(0);
    expect(pointY(-1, scale)).toBe(50);
  });
});

describe("linePath", () => {
  it("draws one run as a single segment", () => {
    expect(linePath([0, 0.5, 1], { ...scale, count: 3 })).toBe("M0,50L50,25L100,0");
  });

  it("breaks the line at a gap rather than dipping through zero", () => {
    const path = linePath([1, null, 1], { ...scale, count: 3 });
    // Two separate moves: nothing is drawn across the hole.
    expect(path).toBe("M0,0L0,0M100,0L100,0");
    expect(path.split("M")).toHaveLength(3);
  });

  it("keeps an isolated value visible as a zero-length segment", () => {
    // Rendered with stroke-linecap="round", so this draws as a dot. Dropping it
    // would make a single journalled month indistinguishable from no data.
    expect(linePath([null, 0.5, null], { ...scale, count: 3 })).toBe("M50,25L50,25");
  });

  it("draws nothing at all when there is nothing to draw", () => {
    expect(linePath([null, null], { ...scale, count: 2 })).toBe("");
  });
});

describe("TrendChart", () => {
  const ticks = [0, 0.5, 1];
  const props = {
    ticks,
    formatTick: (value: number) => `${value * 100}%`,
    label: "Lucid rate per month",
  };

  it("says so plainly when every bucket is empty", () => {
    const markup = renderToStaticMarkup(
      <TrendChart {...props} points={[point("Jan", null), point("Feb", null)]} />,
    );
    expect(markup).toContain("Nothing journalled");
    expect(markup).not.toContain("<svg");
  });

  it("labels the drawing for a reader who cannot see it", () => {
    const markup = renderToStaticMarkup(
      <TrendChart {...props} points={[point("Jan", 0.2), point("Feb", 0.4)]} />,
    );
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Lucid rate per month"');
  });

  it("gives an empty bucket a hover that says it is empty", () => {
    const markup = renderToStaticMarkup(
      <TrendChart {...props} points={[point("Jan", 0.2), point("Feb", null)]} />,
    );
    expect(markup).toContain("Feb: nothing");
  });
});

describe("Meter", () => {
  it("marks the baseline on the same track as the bar", () => {
    const markup = renderToStaticMarkup(<Meter value={0.5} baseline={0.2} />);
    expect(markup).toContain("width:50%");
    expect(markup).toContain("left:20%");
  });

  it("draws a sample too thin to trust in a muted colour", () => {
    const muted = renderToStaticMarkup(<Meter value={1} baseline={0.2} muted />);
    expect(muted).toContain("bg-ink-600");
    expect(muted).not.toContain("bg-lucid-500");
  });
});
