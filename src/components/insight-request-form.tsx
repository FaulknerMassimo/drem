"use client";

import { useActionState } from "react";
import { DestinationBadge } from "@/components/destination-badge";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { requestInsightAction } from "@/lib/ai/actions";
import type { InsightFormState } from "@/lib/ai/form-state";
import { INSIGHT_KIND_HINTS, INSIGHT_KIND_LABELS } from "@/lib/ai/labels";
import type { Destination } from "@/lib/ai/types";
import type { DreamInsightKind } from "@/lib/ai/types";

export function InsightRequestForm({
  dreamId,
  kind,
  destination,
  pending,
  hasExisting,
  children,
}: {
  dreamId: string;
  kind: DreamInsightKind;
  destination: Destination;
  pending: boolean;
  hasExisting: boolean;
  children: React.ReactNode;
}) {
  const [state, formAction] = useActionState<InsightFormState, FormData>(
    requestInsightAction,
    {},
  );

  const label = INSIGHT_KIND_LABELS[kind];

  return (
    <form action={formAction} className="space-y-3">
      {children}
      <input type="hidden" name="dreamId" value={dreamId} />
      <input type="hidden" name="kind" value={kind} />

      <DestinationBadge destination={destination} />
      <FormError message={state.error} />

      {pending ? (
        <p className="text-sm text-ink-400">Generating {label.toLowerCase()}…</p>
      ) : (
        <>
          {destination.leavesMachine && destination.configured && (
            <label className="flex items-start gap-3 text-sm text-ink-200">
              <input
                type="checkbox"
                name="acknowledge"
                value="1"
                required
                className="mt-0.5 size-4 accent-warn-500"
              />
              <span>
                I understand this dream will be sent to {destination.host}.
              </span>
            </label>
          )}
          <SubmitButton
            className="btn btn-ghost"
            pendingLabel="Queuing…"
          >
            {hasExisting ? `Regenerate ${label.toLowerCase()}` : `Generate ${label.toLowerCase()}`}
          </SubmitButton>
        </>
      )}
      <p className="text-xs text-ink-400">{INSIGHT_KIND_HINTS[kind]}</p>
    </form>
  );
}
