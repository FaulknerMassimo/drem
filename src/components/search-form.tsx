"use client";

import { useActionState } from "react";
import { DestinationBadge } from "@/components/destination-badge";
import { ScoredDreamList } from "@/components/dream-list";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { searchAction } from "@/lib/semantic/actions";
import type { SearchFormState } from "@/lib/semantic/form-state";
import type { Destination } from "@/lib/ai/types";
import { CSRF_FIELD } from "@/lib/security/constants";

/**
 * Meaning-based search over the archive.
 *
 * A form post rather than a query string, unlike every other filter in the app.
 * Filters are structural and worth having in a linkable URL; a search phrase is
 * content, and the URL is the one part of a request that survives in history,
 * referrers and logs.
 */
export function SearchForm({
  destination,
  indexed,
  csrfToken,
}: {
  destination: Destination;
  /** Entries currently in the index; zero means there is nothing to search. */
  indexed: number;
  csrfToken: string;
}) {
  const [state, formAction] = useActionState<SearchFormState, FormData>(searchAction, {});

  return (
    <div className="space-y-6">
      <form action={formAction} className="space-y-3">
        <input type="hidden" name={CSRF_FIELD} value={csrfToken} />

        <label className="label" htmlFor="q">
          What are you looking for?
        </label>
        <div className="flex flex-wrap gap-3">
          <input
            id="q"
            name="q"
            type="search"
            className="field flex-1"
            defaultValue={state.query ?? ""}
            placeholder="being chased through a building that keeps changing"
            autoComplete="off"
            required
          />
          <SubmitButton pendingLabel="Searching…" className="btn btn-primary">
            Search
          </SubmitButton>
        </div>
        <p className="text-xs text-ink-400">
          Not a word match — the phrase is compared against what each entry was
          about, so an entry that never used your words can still come back.
        </p>

        <DestinationBadge destination={destination} what="this search phrase" />
        {destination.leavesMachine && destination.configured && (
          <label className="flex items-start gap-3 text-sm text-ink-200">
            <input
              type="checkbox"
              name="acknowledge"
              value="1"
              required
              className="mt-0.5 size-4 accent-warn-500"
            />
            <span>I understand this phrase will be sent to {destination.host}.</span>
          </label>
        )}

        <FormError message={state.error} />
      </form>

      {state.searched && (
        <section className="space-y-3">
          <h2 className="font-medium">
            {state.hits?.length ? `${state.hits.length} close match${state.hits.length === 1 ? "" : "es"}` : "Nothing came close"}
          </h2>
          {state.hits && state.hits.length > 0 ? (
            <ScoredDreamList hits={state.hits} />
          ) : (
            <p className="card text-sm text-ink-400">
              {indexed === 0
                ? "Nothing is indexed yet, so there is nothing to compare against."
                : "No entry in the index was close enough to be worth showing. Try describing the dream rather than naming it."}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
