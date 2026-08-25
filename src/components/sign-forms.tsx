"use client";

import { useActionState } from "react";
import { DestinationBadge } from "@/components/destination-badge";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { addSignAction, scanSignsAction } from "@/lib/semantic/actions";
import type { SignFormState } from "@/lib/semantic/form-state";
import type { Destination } from "@/lib/ai/types";
import { SIGN_CATEGORIES, SIGN_CATEGORY_LABELS } from "@/lib/semantic/labels";
import { CSRF_FIELD } from "@/lib/security/constants";

/**
 * Asks a model to read across a stretch of the archive for recurring cues.
 *
 * The window is a date range rather than "everything", because a dream sign is
 * only useful while it is still current: a figure that dominated last spring
 * and has not appeared since is history, not a cue to watch for tonight.
 */
export function SignScanForm({
  destination,
  pending,
  defaultStart,
  defaultEnd,
  csrfToken,
}: {
  destination: Destination;
  pending: boolean;
  defaultStart: string;
  defaultEnd: string;
  csrfToken: string;
}) {
  const [state, formAction] = useActionState<SignFormState, FormData>(scanSignsAction, {});

  return (
    <form action={formAction} className="card space-y-4">
      <div>
        <h2 className="font-medium">Scan for signs</h2>
        <p className="mt-1 text-sm text-ink-400">
          Reads the entries in a period and proposes the cues that recur across
          them. Where an entry already has an extraction, that is what gets sent
          rather than the entry itself.
        </p>
      </div>

      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="periodStart">
            From
          </label>
          <input
            id="periodStart"
            name="periodStart"
            type="date"
            className="field"
            defaultValue={defaultStart}
            required
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
            className="field"
            defaultValue={defaultEnd}
            required
          />
        </div>
      </div>

      <DestinationBadge destination={destination} what="those entries" />
      <FormError message={state.error} />

      {/* See `report-form.tsx`: the page's `<JobStatus>` owns this sentence. */}
      {pending ? null : (
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
              <span>I understand those entries will be sent to {destination.host}.</span>
            </label>
          )}
          {state.queued && (
            <p role="status" className="text-sm text-ok-500">
              Queued. The signs below will update when it finishes.
            </p>
          )}
          <SubmitButton className="btn btn-ghost" pendingLabel="Queuing…">
            Scan this period
          </SubmitButton>
        </>
      )}
    </form>
  );
}

/**
 * Adds a sign by hand.
 *
 * Worth having next to the scan rather than instead of it: a dreamer often
 * already knows one of their cues, and a hand-made sign is picked up by the
 * next scan — its occurrences and lucidity ratio get filled in from the
 * archive without it ever having been the model's idea.
 */
export function AddSignForm({ csrfToken }: { csrfToken: string }) {
  const [state, formAction] = useActionState<SignFormState, FormData>(addSignAction, {});

  return (
    <form action={formAction} className="card space-y-4">
      <div>
        <h2 className="font-medium">Add one yourself</h2>
        <p className="mt-1 text-sm text-ink-400">
          A cue you already know you have. The next scan will count it across
          the archive.
        </p>
      </div>

      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />

      <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
        <div>
          <label className="label" htmlFor="label">
            Sign
          </label>
          <input
            id="label"
            name="label"
            className="field"
            placeholder="my old school"
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="category">
            Category
          </label>
          <select id="category" name="category" className="field" defaultValue="anomaly">
            {SIGN_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {SIGN_CATEGORY_LABELS[category]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <FormError message={state.error} />
      {state.added && (
        <p role="status" className="text-sm text-ok-500">
          Added.
        </p>
      )}
      <SubmitButton className="btn btn-ghost" pendingLabel="Adding…">
        Add sign
      </SubmitButton>
    </form>
  );
}
