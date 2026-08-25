import { Meter, TrendChart, type TrendPoint } from "@/components/charts";
import { sessionOrRedirect } from "@/lib/auth/session";
import {
  MIN_CONFIDENT_TECHNIQUE_NIGHTS,
  buildSeries,
  defaultGranularity,
  isGranularity,
  rangeTotals,
  techniqueEffectiveness,
  type Bucket,
  type Granularity,
} from "@/lib/journal/analytics";
import { formatDate, formatDayMonth, formatMonth, today } from "@/lib/journal/dates";
import { calendarYear, trailingYear, type HeatmapRange } from "@/lib/journal/heatmap";
import { TECHNIQUE_LABELS } from "@/lib/journal/labels";
import { analyticsRows, journalledYears } from "@/lib/journal/stats";
import { describeLift } from "@/lib/semantic/correlation";

export const dynamic = "force-dynamic";

/**
 * What the archive says about the practice.
 *
 * Everything here is computed from structural columns, so this page never
 * decrypts a dream — see `analyticsRows()`. The charts are deliberately plain:
 * the numbers on this screen are the ones someone changes their practice on,
 * and a chart that flatters a thin sample is worse than no chart.
 */

function percent(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

function rating(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}

function nightsLabel(count: number): string {
  return `${count} night${count === 1 ? "" : "s"}`;
}

/**
 * Labels every nth bucket, so about a dozen survive.
 *
 * Fifty-two weekly ticks is a grey smear at this width; the heatmap's month
 * row solves the same problem the same way.
 */
function labelEvery(count: number): number {
  return Math.max(1, Math.ceil(count / 12));
}

function bucketLabel(bucket: Bucket, granularity: Granularity): string {
  return granularity === "month" ? formatMonth(bucket.start) : formatDayMonth(bucket.start);
}

function bucketSpan(bucket: Bucket, granularity: Granularity): string {
  return granularity === "month"
    ? formatMonth(bucket.start)
    : `${formatDate(bucket.start)} – ${formatDate(bucket.end)}`;
}

function rateSeries(
  buckets: readonly Bucket[],
  granularity: Granularity,
  pick: (bucket: Bucket) => { value: number | null; describe: string },
): TrendPoint[] {
  const step = labelEvery(buckets.length);
  return buckets.map((bucket, index) => {
    const { value, describe } = pick(bucket);
    return {
      key: bucket.start,
      label: index % step === 0 ? bucketLabel(bucket, granularity) : "",
      value,
      title: `${bucketSpan(bucket, granularity)} — ${describe}`,
    };
  });
}

const RATE_TICKS = [0, 0.25, 0.5, 0.75, 1];
const RATING_TICKS = [1, 2, 3, 4, 5];

function Card({ title, value, hint }: { title: string; value: string; hint: string }) {
  return (
    <div className="card">
      <h3 className="text-sm font-medium text-ink-300">{title}</h3>
      <p className="mt-2 text-3xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-sm text-ink-400">{hint}</p>
    </div>
  );
}

function PeriodLink({
  href,
  current,
  children,
}: {
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

/** Rebuilds this page's own query string, keeping whichever choice is not being changed. */
function query(year: number | null, granularity: Granularity | null): string {
  const params = new URLSearchParams();
  if (year !== null) params.set("year", String(year));
  if (granularity !== null) params.set("bucket", granularity);
  const search = params.toString();
  return search ? `/stats?${search}` : "/stats";
}

export default async function StatsPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; bucket?: string }>;
}) {
  const session = await sessionOrRedirect();
  const { year: requestedYear, bucket: requestedBucket } = await searchParams;

  const now = new Date();
  const todayDate = today(now);
  const years = await journalledYears(session.userId, now);

  const parsedYear = Number.parseInt(requestedYear ?? "", 10);
  const selectedYear = years.includes(parsedYear) ? parsedYear : null;
  const range: HeatmapRange =
    selectedYear === null ? trailingYear(todayDate) : calendarYear(selectedYear);

  // The automatic choice is right almost always; the override exists because a
  // year of weekly points is occasionally what you want to squint at.
  const granularity: Granularity = isGranularity(requestedBucket)
    ? requestedBucket
    : defaultGranularity(range);

  const { nights, dreams } = await analyticsRows(session.userId, range.from, range.to);
  const series = buildSeries(range, nights, dreams, { granularity });
  const totals = rangeTotals(series);
  const report = techniqueEffectiveness(nights, dreams);

  const periodName = selectedYear === null ? "the last 12 months" : String(selectedYear);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Statistics</h1>
          <p className="mt-2 max-w-2xl text-sm text-ink-400">
            {nightsLabel(totals.nights)} journalled in {periodName}. Every rate
            below divides by nights journalled, so a night you remembered nothing
            from counts — that is the number practice has to move.
          </p>
        </div>
        <nav className="flex flex-wrap gap-1" aria-label="Period">
          <PeriodLink href={query(null, null)} current={selectedYear === null}>
            Last 12 months
          </PeriodLink>
          {years.map((candidate) => (
            <PeriodLink
              key={candidate}
              href={query(candidate, null)}
              current={candidate === selectedYear}
            >
              {candidate}
            </PeriodLink>
          ))}
        </nav>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card
          title="Lucid rate"
          value={percent(totals.lucidRate)}
          hint={`${totals.lucidNights} of ${nightsLabel(totals.nights)}`}
        />
        <Card
          title="Recall rate"
          value={percent(totals.recallRate)}
          hint={`${totals.recalledNights} nights with a dream`}
        />
        <Card
          title="Dreams"
          value={String(totals.dreams)}
          hint={`across ${nightsLabel(totals.recalledNights)}`}
        />
        <Card
          title="Vividness"
          value={rating(totals.vividness)}
          hint="mean of the entries you rated"
        />
      </div>

      <section className="card space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="font-medium">Lucid rate over time</h2>
            <p className="mt-1 text-sm text-ink-400">
              Share of journalled nights holding at least one lucid dream.
            </p>
          </div>
          <nav className="flex gap-1" aria-label="Interval">
            <PeriodLink href={query(selectedYear, "week")} current={granularity === "week"}>
              Weekly
            </PeriodLink>
            <PeriodLink href={query(selectedYear, "month")} current={granularity === "month"}>
              Monthly
            </PeriodLink>
          </nav>
        </div>
        <TrendChart
          points={rateSeries(series.buckets, granularity, (bucket) => ({
            value: bucket.lucidRate,
            describe:
              bucket.nights === 0
                ? "nothing journalled"
                : `${bucket.lucidNights} lucid of ${nightsLabel(bucket.nights)}`,
          }))}
          ticks={RATE_TICKS}
          formatTick={(value) => `${Math.round(value * 100)}%`}
          label={`Lucid rate per ${granularity} across ${periodName}`}
        />
      </section>

      <section className="card space-y-4">
        <div>
          <h2 className="font-medium">Recall over time</h2>
          <p className="mt-1 text-sm text-ink-400">
            Share of journalled nights that produced a dream at all. This is the
            one the habit moves first.
          </p>
        </div>
        <TrendChart
          points={rateSeries(series.buckets, granularity, (bucket) => ({
            value: bucket.recallRate,
            describe:
              bucket.nights === 0
                ? "nothing journalled"
                : `${bucket.recalledNights} recalled of ${nightsLabel(bucket.nights)}`,
          }))}
          ticks={RATE_TICKS}
          formatTick={(value) => `${Math.round(value * 100)}%`}
          label={`Recall rate per ${granularity} across ${periodName}`}
          colour="var(--color-recall-4)"
        />
      </section>

      <section className="card space-y-4">
        <div>
          <h2 className="font-medium">How the dreams felt</h2>
          <p className="mt-1 text-sm text-ink-400">
            Means of the 1–5 ratings, over the entries that carried one. Entries
            you left unrated are absent rather than counted as zero.
          </p>
        </div>
        <div className="grid gap-6">
          {(
            [
              ["Vividness", (bucket: Bucket) => bucket.vividness],
              ["Control", (bucket: Bucket) => bucket.control],
              ["Recall clarity", (bucket: Bucket) => bucket.recallClarity],
            ] as const
          ).map(([name, pick]) => (
            <div key={name} className="space-y-2">
              <h3 className="text-sm font-medium text-ink-300">{name}</h3>
              <TrendChart
                points={rateSeries(series.buckets, granularity, (bucket) => {
                  const value = pick(bucket);
                  return {
                    value,
                    describe: value === null ? "nothing rated" : `${name} ${value.toFixed(1)}`,
                  };
                })}
                min={1}
                max={5}
                ticks={RATING_TICKS}
                formatTick={(value) => String(value)}
                label={`Mean ${name.toLowerCase()} per ${granularity} across ${periodName}`}
                colour="var(--color-lucid-300)"
                short
              />
            </div>
          ))}
        </div>
      </section>

      <section className="card space-y-4">
        <div>
          <h2 className="font-medium">Techniques</h2>
          <p className="mt-1 text-sm text-ink-400">
            Lucid nights as a share of the nights each technique was logged on,
            against your own overall rate of {percent(report.baseline)} — the
            line marked on every bar.
            {report.overlapping &&
              " Some nights list more than one technique; those nights count towards each of them, so this cannot tell you which one did the work."}
          </p>
        </div>

        {report.techniques.length === 0 ? (
          <p className="text-sm text-ink-400">
            No nights journalled in this period yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-lg border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-400">
                  <th scope="col" className="pb-2 pr-4 font-medium">
                    Technique
                  </th>
                  <th scope="col" className="pb-2 pr-4 text-right font-medium">
                    Nights
                  </th>
                  <th scope="col" className="pb-2 pr-4 text-right font-medium">
                    Lucid
                  </th>
                  <th scope="col" className="pb-2 pr-4 font-medium">
                    Rate
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.techniques.map((entry) => {
                  const lift = describeLift(entry.correlation);
                  return (
                    <tr key={entry.technique} className="border-t border-ink-800 align-middle">
                      <th scope="row" className="py-3 pr-4 text-left font-normal text-ink-100">
                        {TECHNIQUE_LABELS[entry.technique]}
                        {entry.technique === "none" && (
                          <span className="ml-2 text-xs text-ink-400">
                            — nights with nothing logged
                          </span>
                        )}
                      </th>
                      <td className="py-3 pr-4 text-right tabular-nums text-ink-300">
                        {entry.nights}
                      </td>
                      <td className="py-3 pr-4 text-right tabular-nums text-ink-300">
                        {entry.lucidNights}
                      </td>
                      <td className="w-1/2 py-3 pr-4">
                        <div className="flex items-center gap-3">
                          <Meter
                            value={entry.correlation.lucidRate}
                            baseline={report.baseline}
                            muted={!entry.correlation.confident}
                          />
                          <span className="w-10 shrink-0 text-right tabular-nums text-ink-200">
                            {percent(entry.correlation.lucidRate)}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-ink-400">
                          {entry.correlation.confident
                            ? (lift ?? "about as lucid as usual")
                            : `too few nights to tell — ${MIN_CONFIDENT_TECHNIQUE_NIGHTS} is where the ratio starts meaning anything`}
                        </p>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
