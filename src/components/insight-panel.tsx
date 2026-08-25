import { CsrfField } from "@/components/csrf-field";
import { InsightRequestForm } from "@/components/insight-request-form";
import { JobRefresh } from "@/components/job-refresh";
import { JobStatus } from "@/components/job-status";
import { ModelProse } from "@/components/model-prose";
import { parseExtraction, type Extraction } from "@/lib/ai/json";
import { INSIGHT_KIND_LABELS } from "@/lib/ai/labels";
import type { InsightRecord } from "@/lib/ai/insights";
import type { JobState } from "@/lib/ai/jobs";
import type { Destination, DreamInsightKind, InsightRole } from "@/lib/ai/types";

const DREAM_KINDS: DreamInsightKind[] = ["extraction", "lucidity", "symbolic"];

const EXTRACTION_FIELDS: Array<[keyof Extraction, string]> = [
  ["people", "People"],
  ["places", "Places"],
  ["objects", "Objects"],
  ["actions", "Actions"],
  ["emotions", "Emotions"],
  ["anomalies", "Anomalies"],
  ["themes", "Themes"],
  ["dreamSigns", "Dream signs"],
];

export function InsightPanel({
  dreamId,
  hasBody,
  insights,
  jobStates,
  destinations,
}: {
  dreamId: string;
  hasBody: boolean;
  insights: Partial<Record<InsightRole, InsightRecord>>;
  /** The latest queue row per kind — including one that failed. */
  jobStates: Partial<Record<DreamInsightKind, JobState>>;
  destinations: Record<DreamInsightKind, Destination>;
}) {
  const isOpen = (kind: DreamInsightKind) => {
    const status = jobStates[kind]?.status;
    return status === "pending" || status === "running";
  };
  const anyOpen = DREAM_KINDS.some(isOpen);

  return (
    <section className="space-y-4">
      <JobRefresh active={anyOpen} />
      <h2 className="text-lg font-medium">Insights</h2>
      {!hasBody && (
        <p className="text-sm text-ink-400">
          Write the dream first. There is nothing here to send to a model.
        </p>
      )}
      <div className="grid gap-4">
        {DREAM_KINDS.map((kind) => (
          <article key={kind} className="card space-y-4">
            <h3 className="font-medium">{INSIGHT_KIND_LABELS[kind]}</h3>
            {insights[kind] && <InsightBody kind={kind} insight={insights[kind]} />}
            <JobStatus
              state={jobStates[kind]}
              label={INSIGHT_KIND_LABELS[kind].toLowerCase()}
            />
            {hasBody && (
              <InsightRequestForm
                dreamId={dreamId}
                kind={kind}
                destination={destinations[kind]}
                pending={isOpen(kind)}
                hasExisting={Boolean(insights[kind])}
              >
                <CsrfField />
              </InsightRequestForm>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function InsightBody({
  kind,
  insight,
}: {
  kind: DreamInsightKind;
  insight: InsightRecord;
}) {
  return (
    <div className="space-y-3">
      {kind === "extraction" ? (
        <ExtractionView content={insight.content} />
      ) : (
        <ModelProse text={insight.content} />
      )}
      <p className="text-xs text-ink-400">
        {insight.provider} · {insight.model} · {insight.promptVersion} ·{" "}
        {insight.createdAt.toISOString().slice(0, 10)}
      </p>
    </div>
  );
}

function ExtractionView({ content }: { content: string }) {
  let extraction: Extraction;
  try {
    extraction = parseExtraction(content);
  } catch {
    // A reply that was not the JSON the prompt asked for is still worth
    // showing, and is still a model's prose.
    return <ModelProse text={content} />;
  }

  return (
    <div className="space-y-3">
      {extraction.summary && <p className="text-ink-100">{extraction.summary}</p>}
      <dl className="grid gap-3 sm:grid-cols-2">
        {EXTRACTION_FIELDS.map(([key, label]) => {
          const values = extraction[key];
          if (!Array.isArray(values) || values.length === 0) return null;
          return (
            <div key={key}>
              <dt className="text-xs text-ink-400">{label}</dt>
              <dd className="text-sm text-ink-200">{values.join(" · ")}</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
