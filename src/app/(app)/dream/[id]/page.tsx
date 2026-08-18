import { notFound } from "next/navigation";
import { AttachmentGallery } from "@/components/attachment-gallery";
import { InsightPanel } from "@/components/insight-panel";
import { SplitForm } from "@/components/split-form";
import { sessionOrRedirect } from "@/lib/auth/session";
import { loadDestinations } from "@/lib/ai/config";
import { insightsForDream } from "@/lib/ai/insights";
import { pendingDreamJobs } from "@/lib/ai/jobs";
import { listAttachmentsForDream } from "@/lib/capture/attachments";
import { describeDate } from "@/lib/journal/dates";
import { getDream } from "@/lib/journal/dreams";
import { readCsrfToken } from "@/lib/security/csrf-server";
import {
  LUCIDITY_LABELS,
  RATING_LABELS,
  SOURCE_LABELS,
  VALENCE_LABELS,
} from "@/lib/journal/labels";

export const dynamic = "force-dynamic";

function Detail({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-xs text-ink-400">{label}</dt>
      <dd className="text-sm text-ink-200">{value}</dd>
    </div>
  );
}

export default async function DreamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await sessionOrRedirect();
  const dream = await getDream(session.userId, session.keys, id);
  if (!dream) notFound();

  const [insights, pending, destinations, attached, csrfToken] = await Promise.all([
    insightsForDream(session.userId, session.keys, dream.id),
    pendingDreamJobs(session.userId, dream.id),
    loadDestinations(session.userId, session.keys),
    listAttachmentsForDream(session.userId, session.keys, dream.id),
    readCsrfToken(),
  ]);

  return (
    <article className="space-y-6">
      <header className="space-y-2">
        <p className="text-sm text-ink-400">
          <a href={`/night/${dream.dreamDate}`} className="hover:text-ink-200">
            {describeDate(dream.dreamDate)}
          </a>
        </p>
        <h1 className="text-2xl font-semibold">
          {dream.title ?? <span className="text-ink-300">Untitled</span>}
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {dream.isDraft && (
            <span className="rounded-md border border-warn-500/50 px-1.5 py-0.5 text-warn-500">
              Draft — metadata not filled in
            </span>
          )}
          {dream.isLucid && (
            <span className="rounded-md border border-lucid-500/50 px-1.5 py-0.5 text-lucid-300">
              {LUCIDITY_LABELS[dream.lucidity]}
            </span>
          )}
          {dream.isNightmare && (
            <span className="rounded-md border border-warn-500/50 px-1.5 py-0.5 text-warn-500">
              Nightmare
            </span>
          )}
          {dream.isRecurring && (
            <span className="rounded-md border border-ink-700 px-1.5 py-0.5 text-ink-400">
              Recurring
            </span>
          )}
          {dream.isFragment && (
            <span className="rounded-md border border-ink-700 px-1.5 py-0.5 text-ink-400">
              Fragment
            </span>
          )}
        </div>
      </header>

      {dream.body ? (
        // The text is stored exactly as written, including its paragraph breaks,
        // and rendered as text rather than markup — nothing a dream contains
        // should ever be interpreted as anything.
        <div className="card whitespace-pre-wrap leading-relaxed text-ink-100">
          {dream.body}
        </div>
      ) : (
        <div className="card text-sm text-ink-400">No text was written for this entry.</div>
      )}

      {dream.tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {dream.tags.map((tag) => (
            <a
              key={tag}
              href={`/journal?tag=${encodeURIComponent(tag)}`}
              className="rounded-md border border-ink-700 px-2 py-0.5 text-xs text-ink-300 hover:text-ink-100"
            >
              #{tag}
            </a>
          ))}
        </div>
      )}

      <dl className="card grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Detail label="Vividness" value={dream.vividness ? RATING_LABELS[dream.vividness]! : null} />
        <Detail label="Control" value={dream.control ? RATING_LABELS[dream.control]! : null} />
        <Detail
          label="Recall clarity"
          value={dream.recallClarity ? RATING_LABELS[dream.recallClarity]! : null}
        />
        <Detail
          label="Emotional tone"
          value={
            dream.emotionalValence === null
              ? null
              : (VALENCE_LABELS[dream.emotionalValence] ?? null)
          }
        />
        <Detail label="Words" value={String(dream.wordCount)} />
        <Detail label="Captured" value={SOURCE_LABELS[dream.source] ?? dream.source} />
      </dl>

      <div className="flex flex-wrap gap-3">
        <a href={`/dream/${dream.id}/edit`} className="btn btn-primary">
          {dream.isDraft ? "Write it up" : "Edit"}
        </a>
        <a href={`/night/${dream.dreamDate}`} className="btn btn-ghost">
          The whole night
        </a>
        <a
          href={`/dream/${dream.id}/delete`}
          className="btn text-danger-500 hover:bg-ink-800"
        >
          Delete
        </a>
      </div>

      <AttachmentGallery attachments={attached} />

      {dream.body?.trim() && (
        <SplitForm
          dreamId={dream.id}
          destination={destinations.split}
          csrfToken={csrfToken}
        />
      )}

      <InsightPanel
        dreamId={dream.id}
        hasBody={Boolean(dream.body?.trim())}
        insights={insights}
        pending={pending}
        destinations={{
          extraction: destinations.extraction,
          lucidity: destinations.lucidity,
          symbolic: destinations.symbolic,
        }}
      />
    </article>
  );
}
