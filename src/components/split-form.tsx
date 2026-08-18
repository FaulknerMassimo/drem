"use client";

import { useActionState } from "react";
import { DestinationBadge } from "@/components/destination-badge";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { confirmDreamSplitAction, proposeDreamSplitAction } from "@/lib/capture/actions";
import type { SplitFormState } from "@/lib/capture/form-state";
import type { Destination } from "@/lib/ai/types";
import { CSRF_FIELD } from "@/lib/security/constants";

export function SplitForm({
  dreamId,
  destination,
  csrfToken,
}: {
  dreamId: string;
  destination: Destination;
  csrfToken: string;
}) {
  const [proposeState, proposeAction] = useActionState<SplitFormState, FormData>(
    proposeDreamSplitAction,
    {},
  );
  const [confirmState, confirmAction] = useActionState<SplitFormState, FormData>(
    confirmDreamSplitAction,
    {},
  );

  const proposal = proposeState.proposal;

  return (
    <section className="card space-y-4">
      <h2 className="font-medium">Several dreams in this log?</h2>
      <p className="text-sm text-ink-400">
        If this entry is a whole night dumped into one field, a model can
        propose the seams. You edit and confirm; the first piece stays on this
        entry and the rest become new ones on the same night.
      </p>

      {proposal && proposal.length > 0 ? (
        <form action={confirmAction} className="space-y-4">
          <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
          <input type="hidden" name="dreamId" value={dreamId} />
          <input type="hidden" name="count" value={String(proposal.length)} />
          {proposal.map((part, index) => (
            <div key={index} className="space-y-2 rounded-lg border border-ink-800 p-4">
              <label className="label" htmlFor={`split-title-${index}`}>
                Title {index + 1}
              </label>
              <input
                id={`split-title-${index}`}
                name={`title-${index}`}
                defaultValue={part.title ?? ""}
                className="field"
              />
              <label className="label" htmlFor={`split-body-${index}`}>
                Dream {index + 1}
              </label>
              <textarea
                id={`split-body-${index}`}
                name={`body-${index}`}
                rows={8}
                defaultValue={part.body}
                className="field"
                required
              />
              <label className="flex items-center gap-2 text-sm text-ink-200">
                <input
                  type="checkbox"
                  name={`fragment-${index}`}
                  defaultChecked={part.isFragment}
                  className="size-4 accent-lucid-500"
                />
                Fragment
              </label>
            </div>
          ))}
          <FormError message={confirmState.error} />
          <SubmitButton pendingLabel="Saving…">
            Save as {proposal.length} {proposal.length === 1 ? "entry" : "entries"}
          </SubmitButton>
        </form>
      ) : (
        <form action={proposeAction} className="space-y-3">
          <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
          <input type="hidden" name="dreamId" value={dreamId} />
          <DestinationBadge destination={destination} what="this log" />
          {destination.leavesMachine && destination.configured && (
            <label className="flex items-start gap-3 text-sm text-ink-200">
              <input
                type="checkbox"
                name="acknowledge"
                value="1"
                required
                className="mt-0.5 size-4 accent-warn-500"
              />
              <span>I understand this log will be sent to {destination.host}.</span>
            </label>
          )}
          <FormError message={proposeState.error} />
          <SubmitButton className="btn btn-ghost" pendingLabel="Reading…">
            Propose a split
          </SubmitButton>
        </form>
      )}
    </section>
  );
}
