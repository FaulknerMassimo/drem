import {
  buildHeatmap,
  weekdayLabels,
  type DayActivity,
  type HeatmapCell,
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

export function Heatmap({
  year,
  activity,
  today,
  firstDayOfWeek = 1,
  years,
}: {
  year: number;
  activity: readonly DayActivity[];
  today: string;
  firstDayOfWeek?: number;
  years: readonly number[];
}) {
  const grid = buildHeatmap(year, activity, { firstDayOfWeek, today });
  const rowLabels = weekdayLabels(firstDayOfWeek);

  return (
    <section className="card space-y-4" aria-labelledby="heatmap-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 id="heatmap-heading" className="font-medium">
            {year}
          </h2>
          <p className="mt-1 text-sm text-ink-400">
            {grid.totals.recalled} night{grid.totals.recalled === 1 ? "" : "s"} recalled
            {" · "}
            {grid.totals.lucid} lucid
            {" · "}
            {grid.totals.dreams} dream{grid.totals.dreams === 1 ? "" : "s"}
          </p>
        </div>

        {/* Plain links, so the year survives a reload and can be bookmarked. */}
        <nav className="flex flex-wrap gap-1" aria-label="Year">
          {years.map((candidate) => (
            <a
              key={candidate}
              href={`/?year=${candidate}`}
              aria-current={candidate === year ? "page" : undefined}
              className={
                candidate === year
                  ? "rounded-md bg-ink-800 px-2 py-1 text-sm text-ink-100"
                  : "rounded-md px-2 py-1 text-sm text-ink-400 hover:text-ink-200"
              }
            >
              {candidate}
            </a>
          ))}
        </nav>
      </div>

      <div className="overflow-x-auto pb-1">
        <div className="inline-flex gap-2">
          <div
            className="grid shrink-0 pt-[18px] text-[10px] text-ink-400"
            style={{ gridTemplateRows: "repeat(7, 11px)", rowGap: "3px" }}
            aria-hidden
          >
            {rowLabels.map((label, row) => (
              // Every other row only: seven labels at this size is a smear.
              <span key={label} className="leading-[11px]">
                {row % 2 === 1 ? label : ""}
              </span>
            ))}
          </div>

          <div>
            <div
              className="grid text-[10px] text-ink-400"
              style={{
                gridTemplateColumns: `repeat(${grid.weeks.length}, 11px)`,
                columnGap: "3px",
                height: "18px",
              }}
              aria-hidden
            >
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
