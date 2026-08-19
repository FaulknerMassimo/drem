import { JobRefresh } from "@/components/job-refresh";
import { AddSignForm, SignScanForm } from "@/components/sign-forms";
import { SignList } from "@/components/sign-list";
import { loadDestinations } from "@/lib/ai/config";
import { openJobCount } from "@/lib/ai/jobs";
import { sessionOrRedirect } from "@/lib/auth/session";
import { addDays, today } from "@/lib/journal/dates";
import { journalTotals } from "@/lib/journal/stats";
import { isSignSort, rankSigns, SIGN_SORTS } from "@/lib/semantic/correlation";
import { listSigns } from "@/lib/semantic/signs";
import { readCsrfToken } from "@/lib/security/csrf-server";

export const dynamic = "force-dynamic";

const SORT_LABELS: Record<(typeof SIGN_SORTS)[number], string> = {
  lucidity: "Most lucid",
  frequency: "Most frequent",
  recent: "Most recent",
};

export default async function SignsPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; dismissed?: string }>;
}) {
  const session = await sessionOrRedirect();
  const { sort: rawSort, dismissed } = await searchParams;

  const sort = isSignSort(rawSort) ? rawSort : "lucidity";
  const includeDismissed = dismissed === "1";

  const totals = await journalTotals(session.userId);
  const [signs, destinations, pending, csrfToken] = await Promise.all([
    // The baseline is the archive's own lucid rate: a sign is only interesting
    // if carrying it beats how often this dreamer goes lucid anyway.
    listSigns(session.userId, session.keys, {
      includeDismissed,
      baseline: totals.lucidRate,
    }),
    loadDestinations(session.userId, session.keys),
    openJobCount(session.userId, "detect_dream_signs"),
    readCsrfToken(),
  ]);

  const ranked = rankSigns(signs, sort);
  const returnTo = `/signs${includeDismissed ? "?dismissed=1" : ""}`;
  const end = today();
  const start = addDays(end, -89);

  return (
    <div className="space-y-8">
      <JobRefresh active={pending > 0} />

      <div>
        <h1 className="text-2xl font-semibold">Dream signs</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-400">
          The cues that keep coming back. Recognising one from inside a dream is
          what triggers a reality check, so the useful question is not how often
          a cue appears but whether appearing changes the odds — every ratio here
          is against your own lucid rate of{" "}
          {Math.round(totals.lucidRate * 100)}%.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-sm">
        <div className="flex items-center gap-3">
          {SIGN_SORTS.map((option) => (
            <a
              key={option}
              href={`/signs?sort=${option}${includeDismissed ? "&dismissed=1" : ""}`}
              className={option === sort ? "text-ink-100" : "text-ink-400 hover:text-ink-200"}
            >
              {SORT_LABELS[option]}
            </a>
          ))}
        </div>
        <a
          href={`/signs?sort=${sort}${includeDismissed ? "" : "&dismissed=1"}`}
          className="text-ink-400 hover:text-ink-200"
        >
          {includeDismissed ? "Hide dismissed" : "Show dismissed"}
        </a>
      </div>

      <SignList
        signs={ranked}
        returnTo={returnTo}
        empty={
          <>
            Nothing yet. Scan a stretch of nights below, or add a cue you already
            know you have.
          </>
        }
      />

      <SignScanForm
        destination={destinations.signs}
        pending={pending > 0}
        defaultStart={start}
        defaultEnd={end}
        csrfToken={csrfToken}
      />

      <AddSignForm csrfToken={csrfToken} />
    </div>
  );
}
