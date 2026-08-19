"use client";

import { useActionState } from "react";
import { DestinationBadge } from "@/components/destination-badge";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { discardStackAction, readStackAction, skipStackAction } from "@/lib/capture/actions";
import type { CaptureFormState } from "@/lib/capture/form-state";
import type { Destination } from "@/lib/ai/types";
import { CSRF_FIELD } from "@/lib/security/constants";

/**
 * Sends one photographed stack to be read.
 *
 * Deliberately here rather than inside the upload form. Uploading used to
 * queue a reading as a side effect, which meant a photographed page went to
 * whatever model Settings held without the host ever being named on screen —
 * the one thing the rest of the app refuses to do. It also meant the reading
 * started before the writer had finished photographing, which is the wrong
 * moment: every page of the stack is copied, so the job cannot start until
 * the stack is complete.
 *
 * Living on the page rather than in the uploader's local state is what makes
 * it survive: pages photographed and then navigated away from are still here,
 * still unsent, and still say so.
 */
export function StackReadForm({
  stackId,
  pages,
  destination,
  splitDestination,
  csrfToken,
}: {
  stackId: string;
  pages: number;
  destination: Destination;
  splitDestination: Destination;
  csrfToken: string;
}) {
  const [readState, readAction] = useActionState<CaptureFormState, FormData>(readStackAction, {});
  const [skipState, skipAction] = useActionState<CaptureFormState, FormData>(skipStackAction, {});
  const what = pages === 1 ? "this page" : `these ${pages} pages`;
  const remote = [destination, splitDestination].filter(
    (item) => item.configured && item.leavesMachine,
  );
  const remoteHosts = [...new Set(remote.map((item) => item.host))];

  return (
    <div className="card space-y-3">
      <p className="text-sm text-ink-200">
        {pages === 1 ? "1 page" : `${pages} pages`} photographed, not read yet.
        {pages > 1 &&
          (splitDestination.configured
            ? " They are copied one page at a time, then split into dreams, so a dream that carries over a page break stays one entry."
            : " They are copied one page at a time and joined in order.")}
      </p>

      <form action={readAction} className="space-y-3">
        <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
        <input type="hidden" name="stackId" value={stackId} />
        <DestinationBadge destination={destination} what={what} />
        {splitDestination.configured && (
          <DestinationBadge
            destination={splitDestination}
            what={pages === 1 ? "the copied page" : "the joined copies"}
          />
        )}
        {remote.length > 0 && (
          <label className="flex items-start gap-3 text-sm text-ink-200">
            <input
              type="checkbox"
              name="acknowledge"
              value="1"
              className="mt-0.5 size-4 accent-warn-500"
            />
            <span>
              I understand {what} will be sent to {remoteHosts.join(" and ")}.
            </span>
          </label>
        )}
        <FormError message={readState.error} />
        <FormError message={skipState.error} />
        <div className="flex flex-wrap gap-2">
          <SubmitButton className="btn btn-primary" pendingLabel="Sending…">
            {pages === 1 ? "Read this page" : `Read these ${pages} pages`}
          </SubmitButton>
          <SubmitButton className="btn btn-ghost" pendingLabel="Filing…" formAction={skipAction}>
            Type them myself
          </SubmitButton>
        </div>
      </form>

      <form action={discardStackAction}>
        <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
        <input type="hidden" name="stackId" value={stackId} />
        <button type="submit" className="text-sm text-danger-500 hover:underline">
          Discard {pages === 1 ? "it" : "them"}
        </button>
      </form>
    </div>
  );
}
