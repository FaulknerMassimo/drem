import { CsrfField } from "@/components/csrf-field";
import { JobRefresh } from "@/components/job-refresh";
import { ReportForm } from "@/components/report-form";
import { loadDestinations } from "@/lib/ai/config";
import { listReports } from "@/lib/ai/insights";
import { pendingReportCount } from "@/lib/ai/jobs";
import { sessionOrRedirect } from "@/lib/auth/session";
import { addDays, formatDate, today } from "@/lib/journal/dates";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const session = await sessionOrRedirect();
  const [destinations, reports, pending] = await Promise.all([
    loadDestinations(session.userId, session.keys),
    listReports(session.userId, session.keys),
    pendingReportCount(session.userId),
  ]);

  const end = today();
  const start = addDays(end, -29);

  return (
    <div className="space-y-8">
      <JobRefresh active={pending > 0} />
      <div>
        <h1 className="text-2xl font-semibold">Period reports</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-400">
          A rollup across a stretch of nights: recurring signs, lucidity
          patterns, and a couple of practice suggestions. Extraction on the
          individual entries, if you have it, is included as context.
        </p>
      </div>

      <ReportForm
        destination={destinations.report}
        pending={pending > 0}
        defaultStart={start}
        defaultEnd={end}
      >
        <CsrfField />
      </ReportForm>

      <section className="space-y-4">
        <h2 className="font-medium">Previous reports</h2>
        {reports.length === 0 ? (
          <p className="text-sm text-ink-400">None yet.</p>
        ) : (
          reports.map((report) => (
            <article key={report.id} className="card space-y-3">
              <header className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-medium">
                  {report.periodStart && report.periodEnd
                    ? `${formatDate(report.periodStart)} – ${formatDate(report.periodEnd)}`
                    : "Period report"}
                </h3>
                <p className="text-xs text-ink-400">
                  {report.provider} · {report.model} · {report.promptVersion}
                </p>
              </header>
              <div className="whitespace-pre-wrap leading-relaxed text-ink-100">
                {report.content}
              </div>
            </article>
          ))
        )}
      </section>
    </div>
  );
}
