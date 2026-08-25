import { CsrfField } from "@/components/csrf-field";
import { JobRefresh } from "@/components/job-refresh";
import { ReportForm } from "@/components/report-form";
import { loadDestinations } from "@/lib/ai/config";
import { listReports } from "@/lib/ai/insights";
import { latestJobState } from "@/lib/ai/jobs";
import { sessionOrRedirect } from "@/lib/auth/session";
import { addDays, formatDate, today } from "@/lib/journal/dates";
import { JobStatus } from "@/components/job-status";
import { ModelProse } from "@/components/model-prose";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const session = await sessionOrRedirect();
  const [destinations, reports, jobState] = await Promise.all([
    loadDestinations(session.userId, session.keys),
    listReports(session.userId, session.keys),
    latestJobState(session.userId, "period_report"),
  ]);
  const pending = jobState?.status === "pending" || jobState?.status === "running";

  const end = today();
  const start = addDays(end, -29);

  return (
    <div className="space-y-8">
      <JobRefresh active={pending} />
      <div>
        <h1 className="text-2xl font-semibold">Period reports</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-400">
          A rollup across a stretch of nights: recurring signs, lucidity
          patterns, and a couple of practice suggestions.
        </p>
      </div>

      <JobStatus state={jobState} label="the report" />

      <ReportForm
        destination={destinations.report}
        pending={pending}
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
              <ModelProse text={report.content} />
            </article>
          ))
        )}
      </section>
    </div>
  );
}
