import { Heatmap } from "@/components/heatmap";
import { DreamList } from "@/components/dream-list";
import { StreakCards } from "@/components/streak-cards";
import { sessionOrRedirect } from "@/lib/auth/session";
import { today } from "@/lib/journal/dates";
import { countDrafts, recentDreams } from "@/lib/journal/dreams";
import { calendarYear, trailingYear } from "@/lib/journal/heatmap";
import { activityBetween, journalTotals, journalledYears } from "@/lib/journal/stats";
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

  // No year asked for means the trailing window, which is the view worth
  // landing on: it ends today, so it is full whatever the date is.
  const parsedYear = Number.parseInt(requestedYear ?? "", 10);
  const selectedYear = years.includes(parsedYear) ? parsedYear : null;
  const range = selectedYear === null ? trailingYear(todayDate) : calendarYear(selectedYear);

  // Streaks are computed over the whole archive, not the shown range: a run
  // that started in December does not end because the year did.
  const [rangeActivity, allActivity, totals, recent, drafts] = await Promise.all([
    activityBetween(session.userId, range.from, range.to),
    activityBetween(session.userId),
    journalTotals(session.userId),
    recentDreams(session.userId, session.keys, 5),
    countDrafts(session.userId),
  ]);

  const streaks = computeStreaks(allActivity, todayDate);

  return (
    <div className="space-y-8">
      {/* No New entry / Capture buttons here: both live in the sidebar on
          every screen, and a second copy on the one screen you land on made
          the page look like that was the only place to start from. */}
      <h1 className="text-2xl font-semibold">Your journal</h1>

      {drafts > 0 && (
        <a
          href="/drafts"
          className="block rounded-xl border border-warn-500/40 bg-warn-500/10 px-4 py-3 text-sm"
        >
          {drafts} capture{drafts === 1 ? "" : "s"} waiting to be written up →
        </a>
      )}

      <StreakCards streaks={streaks} totals={totals} />

      <Heatmap
        range={range}
        activity={rangeActivity}
        today={todayDate}
        years={years}
        selectedYear={selectedYear}
      />

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
