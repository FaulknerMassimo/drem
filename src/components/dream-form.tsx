"use client";

import { useActionState, useState } from "react";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import type { DreamRecord } from "@/lib/journal/dreams";
import type { IsoDate } from "@/lib/journal/dates";
import type { JournalFormState } from "@/lib/journal/form-state";
import { saveDreamAction } from "@/lib/journal/actions";
import {
  LUCIDITY_LABELS,
  RATING_LABELS,
  VALENCE_LABELS,
} from "@/lib/journal/labels";
import { countWords } from "@/lib/journal/words";

/**
 * The full entry editor.
 *
 * Every field except the dream itself is optional, and the form saves with only
 * a title or only a body. Metadata that is a chore to fill in stops being
 * filled in, and a journal with rich metadata on four entries is worth less
 * than one with a year of bodies.
 */

function Rating({
  name,
  label,
  value,
  options,
}: {
  name: string;
  label: string;
  value: number | null;
  options: Record<number, string>;
}) {
  return (
    <div>
      <label className="label" htmlFor={name}>
        {label}
      </label>
      <select id={name} name={name} defaultValue={value ?? ""} className="field">
        <option value="">Not recorded</option>
        {Object.entries(options).map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

function Toggle({
  name,
  label,
  hint,
  checked,
}: {
  name: string;
  label: string;
  hint: string;
  checked: boolean;
}) {
  return (
    <label className="flex items-start gap-3 rounded-lg border border-ink-700 p-3">
      <input
        type="checkbox"
        name={name}
        defaultChecked={checked}
        className="mt-0.5 size-4 accent-lucid-500"
      />
      <span>
        <span className="block text-sm text-ink-200">{label}</span>
        <span className="block text-xs text-ink-400">{hint}</span>
      </span>
    </label>
  );
}

export function DreamForm({
  dream,
  defaultDate,
  knownTags,
  children,
}: {
  dream?: DreamRecord | null;
  defaultDate: IsoDate;
  knownTags: readonly string[];
  children: React.ReactNode;
}) {
  const [state, formAction] = useActionState<JournalFormState, FormData>(
    saveDreamAction,
    {},
  );
  const [words, setWords] = useState(() => countWords(dream?.body ?? ""));

  return (
    <form action={formAction} className="space-y-6">
      {children}
      {dream && <input type="hidden" name="id" value={dream.id} />}

      <FormError message={state.error} />

      <div className="card space-y-4">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_11rem]">
          <div>
            <label className="label" htmlFor="title">
              Title
            </label>
            <input
              id="title"
              name="title"
              type="text"
              maxLength={200}
              defaultValue={dream?.title ?? ""}
              placeholder="A few words you will recognise it by"
              className="field"
            />
          </div>
          <div>
            <label className="label" htmlFor="nightDate">
              Night of
            </label>
            <input
              id="nightDate"
              name="nightDate"
              type="date"
              required
              defaultValue={dream?.dreamDate ?? defaultDate}
              className="field"
            />
          </div>
        </div>

        <div>
          <div className="flex items-baseline justify-between">
            <label className="label" htmlFor="body">
              The dream
            </label>
            <span className="mb-1.5 text-xs text-ink-400 tabular-nums">
              {words} word{words === 1 ? "" : "s"}
            </span>
          </div>
          <textarea
            id="body"
            name="body"
            rows={16}
            defaultValue={dream?.body ?? ""}
            onChange={(event) => setWords(countWords(event.target.value))}
            placeholder="Present tense, as it comes back. Do not tidy it up."
            className="field font-normal leading-relaxed"
          />
        </div>

        <div>
          <label className="label" htmlFor="tags">
            Tags
          </label>
          <input
            id="tags"
            name="tags"
            type="text"
            defaultValue={dream?.tags.join(", ") ?? ""}
            placeholder="flying, childhood home, water"
            className="field"
          />
          {knownTags.length > 0 && (
            <p className="mt-1.5 text-xs text-ink-400">
              Already used: {knownTags.join(" · ")}
            </p>
          )}
        </div>
      </div>

      <div className="card space-y-4">
        <h2 className="font-medium">Lucidity</h2>
        <div>
          <label className="label" htmlFor="lucidity">
            How aware were you?
          </label>
          <select
            id="lucidity"
            name="lucidity"
            defaultValue={String(dream?.lucidity ?? 0)}
            className="field"
          >
            {Object.entries(LUCIDITY_LABELS).map(([value, text]) => (
              <option key={value} value={value}>
                {value} — {text}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-ink-400">
            Anything above zero counts the night as lucid.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Rating
            name="vividness"
            label="Vividness"
            value={dream?.vividness ?? null}
            options={RATING_LABELS}
          />
          <Rating
            name="control"
            label="Control"
            value={dream?.control ?? null}
            options={RATING_LABELS}
          />
          <Rating
            name="recallClarity"
            label="Recall clarity"
            value={dream?.recallClarity ?? null}
            options={RATING_LABELS}
          />
        </div>

        <Rating
          name="emotionalValence"
          label="Emotional tone"
          value={dream?.emotionalValence ?? null}
          options={VALENCE_LABELS}
        />

        <div className="grid gap-3 sm:grid-cols-3">
          <Toggle
            name="isNightmare"
            label="Nightmare"
            hint="Distressing enough to matter"
            checked={dream?.isNightmare ?? false}
          />
          <Toggle
            name="isRecurring"
            label="Recurring"
            hint="You have had this one before"
            checked={dream?.isRecurring ?? false}
          />
          <Toggle
            name="isFragment"
            label="Fragment"
            hint="A scrap, not a full dream"
            checked={dream?.isFragment ?? false}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <SubmitButton pendingLabel="Saving…" className="btn btn-primary">
          {dream ? "Save changes" : "Save entry"}
        </SubmitButton>
        <a
          href={dream ? `/dream/${dream.id}` : `/night/${defaultDate}`}
          className="btn btn-ghost"
        >
          Cancel
        </a>
      </div>
    </form>
  );
}
