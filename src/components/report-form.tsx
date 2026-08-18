"use client";

import { useActionState } from "react";
import { DestinationBadge } from "@/components/destination-badge";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { requestReportAction } from "@/lib/ai/actions";
import type { InsightFormState } from "@/lib/ai/form-state";
import { INSIGHT_KIND_HINTS } from "@/lib/ai/labels";
import type { Destination } from "@/lib/ai/types";
import type { IsoDate } from "@/lib/journal/dates";

export function ReportForm({
  destination,
  pending,
  defaultStart,
  defaultEnd,
  children,
}: {
  destination: Destination;
  pending: boolean;
  defaultStart: IsoDate;
  defaultEnd: IsoDate;
  children: React.ReactNode;
}) {
  const [state, formAction] = useActionState<InsightFormState, FormData>(
    requestReportAction,
    {},
  );

  return (
    <form action={formAction} className="card space-y-4">
      {children}
      <h2 className="font-medium">Generate a period report</h2>
      <p className="text-sm text-ink-400">{INSIGHT_KIND_HINTS.report}</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="periodStart">
            From
          </label>
          <input
            id="periodStart"
            name="periodStart"
            type="date"
            required
            defaultValue={defaultStart}
            className="field"
          />
        </div>
        <div>
          <label className="label" htmlFor="periodEnd">
            To
          </label>
          <input
            id="periodEnd"
            name="periodEnd"
            type="date"
            required
            defaultValue={defaultEnd}
            className="field"
          />
        </div>
      </div>

      <DestinationBadge destination={destination} />
      <FormError message={state.error} />

      {pending ? (
        <p className="text-sm text-ink-400">Generating report…</p>
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
              <span>I understand these dreams will be sent to {destination.host}.</span>
            </label>
          )}
          <SubmitButton pendingLabel="Queuing…">Generate report</SubmitButton>
        </>
      )}
    </form>
  );
}
