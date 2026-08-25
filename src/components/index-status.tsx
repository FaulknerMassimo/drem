"use client";

import { useActionState } from "react";
import { DestinationBadge } from "@/components/destination-badge";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { indexJournalAction } from "@/lib/semantic/actions";
import type { IndexFormState } from "@/lib/semantic/form-state";
import type { QueueSummary } from "@/lib/ai/jobs";
import type { Destination } from "@/lib/ai/types";
import type { IndexCoverage } from "@/lib/semantic/embeddings";
import { CSRF_FIELD } from "@/lib/security/constants";

/**
 * How much of the journal search can actually see.
 *
 * Shown even when everything is indexed, because the failure mode of a semantic
 * index is silent: a search that misses half the archive returns results, just
 * not the right ones, and there is no way to tell from the results themselves.
 */
export function IndexStatus({
  coverage,
  destination,
  model,
  queue,
  csrfToken,
}: {
  coverage: IndexCoverage;
  destination: Destination;
  /** The embedding model the index was built with, if one is assigned. */
  model: string | null;
  /** Embedding jobs still in the queue, and the ones that gave up. */
  queue: QueueSummary;
  csrfToken: string;
}) {
  const [state, formAction] = useActionState<IndexFormState, FormData>(
    indexJournalAction,
    {},
  );

  if (!destination.configured) {
    return (
      <div className="card space-y-3">
        <h2 className="font-medium">Index</h2>
        <DestinationBadge destination={destination} what="each entry" />
        <p className="text-sm text-ink-400">
          Search works by comparing entries as vectors, which needs an embedding
          model. Assign one under Semantic roles in{" "}
          <a href="/settings" className="text-lucid-300 hover:text-lucid-400">
            Settings
          </a>
          {" "}— <span className="font-mono text-xs">embeddinggemma</span> in Ollama
          is a good default and keeps everything on this machine.
        </p>
      </div>
    );
  }

  const complete = coverage.outstanding === 0;

  return (
    <div className="card space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium">Index</h2>
        {model && <p className="font-mono text-xs text-ink-400">{model}</p>}
      </div>

      <p className="text-sm text-ink-200">
        {coverage.indexed} of {coverage.embeddable} written entr
        {coverage.embeddable === 1 ? "y is" : "ies are"} indexed
        {queue.open > 0 && ` · ${queue.open} in the queue`}.
      </p>

      {/* An index that stops filling in is the failure this card exists to
          make visible: search still answers, just over less of the journal. */}
      {queue.failed > 0 && (
        <p
          role="alert"
          className="rounded-lg border border-danger-500/40 bg-danger-500/10 px-3 py-2 text-sm text-ink-100"
        >
          {queue.failed} {queue.failed === 1 ? "entry" : "entries"} could not be
          indexed{queue.lastError ? `: ${queue.lastError}` : ""}. Those entries
          will not come back in a search until it succeeds.
        </p>
      )}

      {!complete && (
        <div className="h-1.5 overflow-hidden rounded-full bg-ink-800">
          <div
            className="h-full rounded-full bg-lucid-500"
            style={{
              width: `${coverage.embeddable === 0 ? 0 : Math.round((coverage.indexed / coverage.embeddable) * 100)}%`,
            }}
          />
        </div>
      )}

      <form action={formAction} className="space-y-3">
        <input type="hidden" name={CSRF_FIELD} value={csrfToken} />

        {destination.leavesMachine && (
          <>
            <DestinationBadge destination={destination} what="every unindexed entry" />
            <label className="flex items-start gap-3 text-sm text-ink-200">
              <input
                type="checkbox"
                name="acknowledge"
                value="1"
                required
                className="mt-0.5 size-4 accent-warn-500"
              />
              <span>
                I understand {coverage.outstanding} entr
                {coverage.outstanding === 1 ? "y" : "ies"} will be sent to{" "}
                {destination.host}.
              </span>
            </label>
          </>
        )}

        <FormError message={state.error} />
        {state.queued !== undefined && state.queued > 0 && (
          <p role="status" className="text-sm text-ok-500">
            Queued {state.queued} entr{state.queued === 1 ? "y" : "ies"}.
          </p>
        )}

        <SubmitButton className="btn btn-ghost" pendingLabel="Queuing…">
          {complete ? "Re-check the index" : `Index ${coverage.outstanding} entr${coverage.outstanding === 1 ? "y" : "ies"}`}
        </SubmitButton>
      </form>

      {!destination.leavesMachine && (
        <p className="text-xs text-ink-400">
          New entries are indexed as you write them, because this model is on
          this machine. This is only needed for entries written before the model
          was assigned — or imported.
        </p>
      )}
      {destination.leavesMachine && (
        <p className="text-xs text-ink-400">
          Entries are not indexed automatically while the embedding model is
          remote: that would send every dream you write to {destination.host}{" "}
          without asking.
        </p>
      )}
    </div>
  );
}
