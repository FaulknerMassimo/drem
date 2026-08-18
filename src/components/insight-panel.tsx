import { CsrfField } from "@/components/csrf-field";
import { InsightRequestForm } from "@/components/insight-request-form";
import { JobRefresh } from "@/components/job-refresh";
import { parseExtraction, type Extraction } from "@/lib/ai/json";
import { INSIGHT_KIND_LABELS } from "@/lib/ai/labels";
import type { InsightRecord } from "@/lib/ai/insights";
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
  pending,
  destinations,
}: {
  dreamId: string;
  hasBody: boolean;
  insights: Partial<Record<InsightRole, InsightRecord>>;
  pending: DreamInsightKind[];
  destinations: Record<DreamInsightKind, Destination>;
}) {
  const pendingSet = new Set(pending);

  return (
    <section className="space-y-6">
      <JobRefresh active={pending.length > 0} />
      <h2 className="text-lg font-medium">Insights</h2>
      {!hasBody && (
        <p className="text-sm text-ink-400">
          Write the dream first. There is nothing here to send to a model.
        </p>
      )}
      {DREAM_KINDS.map((kind) => (
        <article key={kind} className="card space-y-4">
          <h3 className="font-medium">{INSIGHT_KIND_LABELS[kind]}</h3>
          {insights[kind] && <InsightBody kind={kind} insight={insights[kind]} />}
          {hasBody && (
            <InsightRequestForm
              dreamId={dreamId}
              kind={kind}
              destination={destinations[kind]}
              pending={pendingSet.has(kind)}
              hasExisting={Boolean(insights[kind])}
            >
              <CsrfField />
            </InsightRequestForm>
          )}
        </article>
      ))}
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
        <div className="whitespace-pre-wrap leading-relaxed text-ink-100">{insight.content}</div>
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
    return (
      <div className="whitespace-pre-wrap leading-relaxed text-ink-100">{content}</div>
    );
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
