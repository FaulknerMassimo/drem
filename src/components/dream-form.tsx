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

interface ScaleOption {
  /** Empty means "not recorded", which is not the same as a rating of zero. */
  value: number | "";
  /** What the button says — a digit where a word would not fit. */
  text: string;
  /** The full meaning, for a screen reader and a hover. */
  title: string;
}

/**
 * One rating, as a row of buttons rather than a dropdown.
 *
 * Six of these stacked as full-width selects filled the screen below the dream
 * and turned writing up a night into a form. As rows they cost one line each
 * and one click each, which is the difference between rating a dream and
 * skipping it — and a rating skipped is a gap in every chart on the
 * statistics page.
 */
function Scale({
  name,
  label,
  hint,
  value,
  options,
}: {
  name: string;
  label: string;
  hint?: string;
  value: number | null;
  options: readonly ScaleOption[];
}) {
  return (
    <fieldset className="grid gap-1.5 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:items-center sm:gap-4">
      <legend className="sr-only">{label}</legend>
      <span aria-hidden className="text-sm text-ink-300">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="inline-flex divide-x divide-ink-700 overflow-hidden rounded-lg border border-ink-700">
          {options.map((option) => (
            <label key={String(option.value)} className="cursor-pointer">
              <input
                type="radio"
                name={name}
                value={option.value}
                defaultChecked={(value ?? "") === option.value}
                aria-label={`${label}: ${option.title}`}
                className="peer sr-only"
              />
              <span
                title={option.title}
                className={`block px-3 py-1.5 text-sm text-ink-400 transition-colors hover:bg-ink-800 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-lucid-400 ${
                  // "Not recorded" is a real state but not an achievement:
                  // in the accent colour it read as an answer, and every
                  // unrated dream lit up five purple buttons down the page.
                  option.value === ""
                    ? "peer-checked:bg-ink-700 peer-checked:text-ink-200"
                    : "peer-checked:bg-lucid-500 peer-checked:text-white"
                }`}
              >
                {option.text}
              </span>
            </label>
          ))}
        </div>
        {hint && <span className="text-xs text-ink-400">{hint}</span>}
      </div>
    </fieldset>
  );
}

/** "Not recorded", then 1–5. A blank rating is absent, never a zero. */
const RATING_OPTIONS: readonly ScaleOption[] = [
  { value: "", text: "–", title: "Not recorded" },
  ...[1, 2, 3, 4, 5].map((n) => ({
    value: n,
    text: String(n),
    title: RATING_LABELS[n]!,
  })),
];

const LUCIDITY_OPTIONS: readonly ScaleOption[] = [0, 1, 2, 3, 4, 5].map((n) => ({
  value: n,
  text: String(n),
  title: LUCIDITY_LABELS[n]!,
}));

/*
 * Written out in order rather than read off the record.
 *
 * `VALENCE_LABELS` is keyed from -2 to 2, and JavaScript orders a plain
 * object's integer-like keys ascending before its remaining keys in insertion
 * order — so iterating it put the tone scale on screen as Neutral, Pleasant,
 * Blissful, Nightmarish, Unpleasant. A scale has an order and this is it.
 */
const VALENCE_ORDER = [-2, -1, 0, 1, 2] as const;

const VALENCE_OPTIONS: readonly ScaleOption[] = [
  { value: "", text: "–", title: "Not recorded" },
  ...VALENCE_ORDER.map((n) => ({
    value: n,
    text: VALENCE_LABELS[n]!,
    title: VALENCE_LABELS[n]!,
  })),
];

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
    <label
      title={hint}
      className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-ink-700 px-3 py-1.5 text-sm text-ink-200 hover:bg-ink-800 has-checked:border-lucid-500 has-checked:bg-lucid-500/10"
    >
      <input
        type="checkbox"
        name={name}
        defaultChecked={checked}
        className="size-4 accent-lucid-500"
      />
      {label}
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

      <div className="card space-y-3">
        <Scale
          name="lucidity"
          label="Lucidity"
          hint="Anything above 0 counts the night as lucid"
          value={dream?.lucidity ?? 0}
          options={LUCIDITY_OPTIONS}
        />
        <Scale
          name="vividness"
          label="Vividness"
          value={dream?.vividness ?? null}
          options={RATING_OPTIONS}
        />
        <Scale
          name="control"
          label="Control"
          value={dream?.control ?? null}
          options={RATING_OPTIONS}
        />
        <Scale
          name="recallClarity"
          label="Recall clarity"
          value={dream?.recallClarity ?? null}
          options={RATING_OPTIONS}
        />
        <Scale
          name="emotionalValence"
          label="Emotional tone"
          value={dream?.emotionalValence ?? null}
          options={VALENCE_OPTIONS}
        />

        <fieldset className="grid gap-1.5 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:items-center sm:gap-4">
          <legend className="sr-only">Flags</legend>
          <span aria-hidden className="text-sm text-ink-300">
            This dream was
          </span>
          <div className="flex flex-wrap gap-2">
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
        </fieldset>
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
