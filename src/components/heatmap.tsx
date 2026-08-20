import {
  buildHeatmap,
  weekdayLabels,
  DEFAULT_FIRST_DAY_OF_WEEK,
  type DayActivity,
  type HeatmapCell,
  type HeatmapRange,
} from "@/lib/journal/heatmap";
import { formatDate, formatMonth } from "@/lib/journal/dates";

/**
 * The activity heatmap.
 *
 * A year of nights as a 7-row grid, one column per week. What makes it worth
 * building — as opposed to a streak counter — is that it shows the *shape* of
 * the habit: the fortnight that fell apart in March, the run that started in
 * June. That only works if it is honest about the difference between a night
 * you did not journal and a night you journalled with nothing to report.
 *
 * It shows a trailing year by default and a calendar year on request, because
 * those answer different questions: "how am I doing lately" wants a grid that
 * ends today, and "what did 2025 look like" wants one that lines up with a
 * year. Only the second one has a reason to be half empty.
 */

function cellClass(cell: HeatmapCell): string {
  switch (cell.state) {
    case "empty":
      return "hm-cell hm-empty";
    case "missed":
      return "hm-cell hm-missed";
    case "logged":
      return "hm-cell hm-logged";
    case "recalled":
      return `hm-cell hm-recalled-${cell.level}`;
    case "lucid":
      return `hm-cell hm-lucid-${cell.level}`;
  }
}

function describe(cell: HeatmapCell): string {
  const date = formatDate(cell.date);
  switch (cell.state) {
    case "empty":
      return date;
    case "missed":
      return `${date} — nothing journalled`;
    case "logged":
      return `${date} — journalled, no dream recalled`;
    default: {
      const dreams = `${cell.dreamCount} dream${cell.dreamCount === 1 ? "" : "s"}`;
      const lucid = cell.lucidCount > 0 ? `, ${cell.lucidCount} lucid` : "";
      return `${date} — ${dreams}${lucid}, ${cell.wordCount} words`;
    }
  }
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-400">
      <span className="flex items-center gap-1.5">
        <span className="hm-cell hm-missed" aria-hidden />
        Not journalled
      </span>
      <span className="flex items-center gap-1.5">
        <span className="hm-cell hm-logged" aria-hidden />
        No recall
      </span>
      <span className="flex items-center gap-1.5">
        Recalled
        {[1, 2, 3, 4].map((level) => (
          <span key={level} className={`hm-cell hm-recalled-${level}`} aria-hidden />
        ))}
      </span>
      <span className="flex items-center gap-1.5">
        Lucid
        {[1, 2, 3, 4].map((level) => (
          <span key={level} className={`hm-cell hm-lucid-${level}`} aria-hidden />
        ))}
      </span>
    </div>
  );
}

/** One entry in the view picker: the trailing window, or a year. */
function PeriodLink({ href, current, children }: {
  href: string;
  current: boolean;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      aria-current={current ? "page" : undefined}
      className={
        current
          ? "rounded-md bg-ink-800 px-2 py-1 text-sm text-ink-100"
          : "rounded-md px-2 py-1 text-sm text-ink-400 hover:text-ink-200"
      }
    >
      {children}
    </a>
  );
}

export function Heatmap({
  range,
  activity,
  today,
  firstDayOfWeek = DEFAULT_FIRST_DAY_OF_WEEK,
  years,
  selectedYear = null,
}: {
  range: HeatmapRange;
  activity: readonly DayActivity[];
  today: string;
  firstDayOfWeek?: number;
  years: readonly number[];
  /** The year being shown, or null for the trailing window. */
  selectedYear?: number | null;
}) {
  const grid = buildHeatmap(range, activity, { firstDayOfWeek, today });
  const rowLabels = weekdayLabels(firstDayOfWeek);

  return (
    <section className="card space-y-4" aria-labelledby="heatmap-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 id="heatmap-heading" className="font-medium">
            {selectedYear ?? "Last 12 months"}
          </h2>
          <p className="mt-1 text-sm text-ink-400">
            {grid.totals.recalled} night{grid.totals.recalled === 1 ? "" : "s"} recalled
            {" · "}
            {grid.totals.lucid} lucid
            {" · "}
            {grid.totals.dreams} dream{grid.totals.dreams === 1 ? "" : "s"}
          </p>
        </div>

        {/* Plain links, so the view survives a reload and can be bookmarked. */}
        <nav className="flex flex-wrap gap-1" aria-label="Period">
          <PeriodLink href="/" current={selectedYear === null}>
            Last 12 months
          </PeriodLink>
          {years.map((candidate) => (
            <PeriodLink
              key={candidate}
              href={`/?year=${candidate}`}
              current={candidate === selectedYear}
            >
              {candidate}
            </PeriodLink>
          ))}
        </nav>
      </div>

      <div className="overflow-x-auto pb-1">
        <div
          className="hm-chart"
          // The column count is what the grid divides its width by.
          style={{ "--hm-columns": grid.weeks.length } as React.CSSProperties}
        >
          <div className="hm-days text-[10px] leading-none text-ink-400" aria-hidden>
            {rowLabels.map((label, row) => (
              // Every other row only: seven labels at this size is a smear.
              <span key={label}>{row % 2 === 1 ? label : ""}</span>
            ))}
          </div>

          <div className="hm-plot">
            <div className="hm-months text-[10px] text-ink-400" aria-hidden>
              {grid.months.map((month) => (
                <span
                  key={month.label}
                  className="whitespace-nowrap"
                  style={{ gridColumnStart: month.column + 1 }}
                >
                  {formatMonth(month.label)}
                </span>
              ))}
            </div>

            <div className="hm-grid">
              {grid.weeks.flat().map((cell) =>
                cell.state === "empty" ? (
                  <span key={cell.date} className={cellClass(cell)} aria-hidden />
                ) : (
                  <a
                    key={cell.date}
                    href={`/night/${cell.date}`}
                    className={cellClass(cell)}
                    title={describe(cell)}
                    aria-label={describe(cell)}
                  />
                ),
              )}
            </div>
          </div>
        </div>
      </div>

      <Legend />
    </section>
  );
}
