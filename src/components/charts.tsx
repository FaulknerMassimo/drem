/**
 * The two chart shapes the analytics page needs, drawn as inline SVG.
 *
 * No charting library. Not on principle about dependencies, but because every
 * one of them wants to render on the client, and these charts are built from
 * data the server already has in a server component — pulling in a library
 * would ship a runtime and a hydration boundary to draw about forty line
 * segments. Inline SVG also inherits the theme's own colours and needs no CSP
 * exception.
 *
 * The one rule the geometry has to get right is that a missing value is a
 * *gap*, not a zero. `linePath` breaks the line rather than dipping it to the
 * floor, because a month nobody journalled and a month of nothing but blank
 * nights are different facts and must not draw the same.
 */

export interface ChartScale {
  width: number;
  height: number;
  min: number;
  max: number;
  count: number;
}

/** Points span the full width; a lone point sits in the middle rather than at 0. */
export function pointX(index: number, scale: ChartScale): number {
  if (scale.count <= 1) return scale.width / 2;
  return (index / (scale.count - 1)) * scale.width;
}

/** SVG's y grows downwards, so the maximum is at zero. Values are clamped. */
export function pointY(value: number, scale: ChartScale): number {
  const span = scale.max - scale.min || 1;
  const ratio = Math.min(1, Math.max(0, (value - scale.min) / span));
  return scale.height - ratio * scale.height;
}

/**
 * The `d` attribute for a series, with gaps where the data is missing.
 *
 * A run of one — a value with nothing either side of it — is emitted as a
 * zero-length segment. Under `stroke-linecap="round"` that draws as a dot, so
 * an isolated month is visible instead of silently absent, which is the case
 * that would otherwise look identical to having no data at all.
 */
export function linePath(values: readonly (number | null)[], scale: ChartScale): string {
  const segments: string[] = [];
  let run: string[] = [];

  const flush = () => {
    if (run.length === 1) segments.push(`M${run[0]}L${run[0]}`);
    else if (run.length > 1) segments.push(`M${run.join("L")}`);
    run = [];
  };

  values.forEach((value, index) => {
    if (value === null) {
      flush();
      return;
    }
    run.push(`${round(pointX(index, scale))},${round(pointY(value, scale))}`);
  });
  flush();

  return segments.join("");
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

const WIDTH = 640;
const HEIGHT = 150;

/**
 * A shorter plot for a chart that is one of several stacked together.
 *
 * The `viewBox` fixes the aspect ratio, so a chart in a narrow column is drawn
 * short as well as narrow: three of these side by side came out 47 pixels tall
 * with axis labels scaled down to about three, which reads as a broken
 * sparkline rather than a trend. They are full width now, and shorter on
 * purpose so three of them still fit on a screen.
 */
const SHORT_HEIGHT = 96;

export interface TrendPoint {
  /** Bucket start; the React key and the tooltip's anchor. */
  key: string;
  /** X tick text, or "" for a point whose label would collide with its neighbour. */
  label: string;
  value: number | null;
  /** Full sentence for the hover, including the counts the ratio came from. */
  title: string;
}

/**
 * One series over time.
 *
 * Deliberately not interactive beyond native `<title>` tooltips: a crosshair
 * and a legend would need client JavaScript, and the thing worth seeing here is
 * the slope, which is legible without either.
 */
export function TrendChart({
  points,
  min = 0,
  max = 1,
  ticks,
  formatTick,
  label,
  colour = "var(--color-lucid-400)",
  short = false,
}: {
  points: readonly TrendPoint[];
  min?: number;
  max?: number;
  ticks: readonly number[];
  formatTick: (value: number) => string;
  /** Read out in place of the drawing, which a screen reader cannot use. */
  label: string;
  colour?: string;
  /** Draws at a shallower height, for a chart stacked with others. */
  short?: boolean;
}) {
  const height = short ? SHORT_HEIGHT : HEIGHT;
  const scale: ChartScale = { width: WIDTH, height, min, max, count: points.length };
  const values = points.map((point) => point.value);
  const path = linePath(values, scale);
  const drawn = points.filter((point) => point.value !== null);

  if (drawn.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-ink-400">
        Nothing journalled in this period yet.
      </p>
    );
  }

  return (
    <figure className="space-y-1">
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        // Scales to the card's width while keeping strokes proportional.
        className="h-auto w-full overflow-visible"
        role="img"
        aria-label={label}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={0}
              x2={WIDTH}
              y1={pointY(tick, scale)}
              y2={pointY(tick, scale)}
              stroke="var(--color-ink-800)"
              strokeWidth={1}
            />
            <text
              x={-6}
              y={pointY(tick, scale)}
              dominantBaseline="middle"
              textAnchor="end"
              fill="var(--color-ink-400)"
              fontSize={11}
            >
              {formatTick(tick)}
            </text>
          </g>
        ))}

        <path
          d={path}
          fill="none"
          stroke={colour}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/*
          A hit target per bucket rather than per drawn point: hovering the gap
          where a month should be is exactly when you want to be told there is
          nothing there.
        */}
        {points.map((point, index) => (
          <g key={point.key}>
            <circle
              cx={pointX(index, scale)}
              cy={point.value === null ? height : pointY(point.value, scale)}
              r={point.value === null ? 0 : 2.5}
              fill={colour}
            />
            <rect
              x={pointX(index, scale) - WIDTH / Math.max(points.length, 1) / 2}
              y={0}
              width={WIDTH / Math.max(points.length, 1)}
              height={height}
              fill="transparent"
            >
              <title>{point.title}</title>
            </rect>
          </g>
        ))}
      </svg>

      {/*
        Only the labelled points are rendered, each placed on its own column and
        allowed to run over the empty ones after it. Giving every point a cell
        and truncating instead would leave "17 Aug" as "1 …" at weekly
        granularity, where a column is about eighteen pixels wide — the same
        problem the heatmap's month row solves the same way.
      */}
      <div
        className="grid text-[10px] text-ink-400"
        style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}
        aria-hidden
      >
        {points.map((point, index) =>
          point.label ? (
            <span
              key={point.key}
              className="whitespace-nowrap"
              style={{ gridColumnStart: index + 1 }}
            >
              {point.label}
            </span>
          ) : null,
        )}
      </div>
    </figure>
  );
}

/**
 * A rate as a bar, against the archive's own rate marked on the same track.
 *
 * The marker is the point of it: 30% means nothing on its own, and everything
 * next to a baseline of 12%.
 */
export function Meter({
  value,
  baseline,
  muted = false,
}: {
  value: number;
  baseline: number;
  /** Drawn faintly when the sample is too thin to be worth reading. */
  muted?: boolean;
}) {
  const percent = Math.min(100, Math.max(0, value * 100));
  const marker = Math.min(100, Math.max(0, baseline * 100));

  return (
    <div className="relative h-2 w-full overflow-hidden rounded-full bg-ink-850">
      <div
        className={muted ? "h-full rounded-full bg-ink-600" : "h-full rounded-full bg-lucid-500"}
        style={{ width: `${percent}%` }}
      />
      <span
        className="absolute top-0 h-full w-px bg-ink-300"
        style={{ left: `${marker}%` }}
        aria-hidden
      />
    </div>
  );
}
