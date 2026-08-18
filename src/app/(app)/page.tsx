import { Heatmap } from "@/components/heatmap";
import { DreamList } from "@/components/dream-list";
import { StreakCards } from "@/components/streak-cards";
import { sessionOrRedirect } from "@/lib/auth/session";
import { nightDateFor, today } from "@/lib/journal/dates";
import { countDrafts, recentDreams } from "@/lib/journal/dreams";
import {
  activityBetween,
  activityForYear,
  journalTotals,
  journalledYears,
} from "@/lib/journal/stats";
import { computeStreaks } from "@/lib/journal/streaks";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>;
}) {
  const session = await sessionOrRedirect();
  const { year: requestedYear } = await searchParams;

  const now = new Date();
  const todayDate = today(now);
  const years = await journalledYears(session.userId, now);
  const parsedYear = Number.parseInt(requestedYear ?? "", 10);
  const year = years.includes(parsedYear) ? parsedYear : (years[0] ?? now.getFullYear());

  // Streaks are computed over the whole archive, not the shown year: a run that
  // started in December does not end because the year did.
  const [yearActivity, allActivity, totals, recent, drafts] = await Promise.all([
    activityForYear(session.userId, year),
    activityBetween(session.userId),
    journalTotals(session.userId),
    recentDreams(session.userId, session.keys, 5),
    countDrafts(session.userId),
  ]);

  const streaks = computeStreaks(allActivity, todayDate);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Your journal</h1>
        <div className="flex gap-3">
          <a href={`/dream/new?date=${nightDateFor(now)}`} className="btn btn-primary">
            New entry
          </a>
          <a href="/capture" className="btn btn-ghost">
            Capture
          </a>
        </div>
      </div>

      {drafts > 0 && (
        <a
          href="/drafts"
          className="block rounded-xl border border-warn-500/40 bg-warn-500/10 px-4 py-3 text-sm"
        >
          {drafts} capture{drafts === 1 ? "" : "s"} waiting to be written up →
        </a>
      )}

      <StreakCards streaks={streaks} totals={totals} />

      <Heatmap year={year} activity={yearActivity} today={todayDate} years={years} />

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="font-medium">Recent</h2>
          <a href="/journal" className="text-sm text-ink-400 hover:text-ink-200">
            All entries →
          </a>
        </div>
        <DreamList
          dreams={recent}
          empty={
            <>
              Nothing yet. Write up this morning, or{" "}
              <a href="/capture" className="text-lucid-300 hover:text-lucid-400">
                capture something
              </a>{" "}
              in the night.
            </>
          }
        />
      </section>
    </div>
  );
}
