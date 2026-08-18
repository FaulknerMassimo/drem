"use client";

import { useActionState } from "react";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { saveNightAction } from "@/lib/journal/actions";
import type { IsoDate } from "@/lib/journal/dates";
import type { JournalFormState } from "@/lib/journal/form-state";
import { RATING_LABELS, TECHNIQUES, TECHNIQUE_LABELS } from "@/lib/journal/labels";
import type { NightRecord } from "@/lib/journal/nights";

/**
 * The night's own record: when you slept, what you tried, and whether anything
 * came back. Saving this with nothing recalled is a real entry, not a blank —
 * it is what lets the heatmap and the technique statistics tell the difference
 * between a bad night and a night you never wrote down.
 */
export function NightForm({
  date,
  night,
  hasDreams,
  children,
}: {
  date: IsoDate;
  night: NightRecord | null;
  hasDreams: boolean;
  children: React.ReactNode;
}) {
  const [state, formAction] = useActionState<JournalFormState, FormData>(
    saveNightAction,
    {},
  );
  const selected = new Set(night?.techniques ?? []);

  return (
    <form action={formAction} className="card space-y-5">
      {children}
      <input type="hidden" name="date" value={date} />

      <FormError message={state.error} />

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="bedTime">
            Went to bed
          </label>
          <input
            id="bedTime"
            name="bedTime"
            type="time"
            defaultValue={night?.bedTime ?? ""}
            className="field"
          />
        </div>
        <div>
          <label className="label" htmlFor="wakeTime">
            Woke
          </label>
          <input
            id="wakeTime"
            name="wakeTime"
            type="time"
            defaultValue={night?.wakeTime ?? ""}
            className="field"
          />
        </div>
        <div>
          <label className="label" htmlFor="wbtbTime">
            Woke for WBTB
          </label>
          <input
            id="wbtbTime"
            name="wbtbTime"
            type="time"
            defaultValue={night?.wbtbTime ?? ""}
            className="field"
          />
        </div>
      </div>

      <div>
        <label className="label" htmlFor="sleepQuality">
          Sleep quality
        </label>
        <select
          id="sleepQuality"
          name="sleepQuality"
          defaultValue={night?.sleepQuality ?? ""}
          className="field sm:max-w-xs"
        >
          <option value="">Not recorded</option>
          {Object.entries(RATING_LABELS).map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
      </div>

      <fieldset>
        <legend className="label">Techniques tried</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {TECHNIQUES.map((technique) => (
            <label
              key={technique}
              className="flex items-center gap-3 rounded-lg border border-ink-700 px-3 py-2 text-sm text-ink-200"
            >
              <input
                type="checkbox"
                name="techniques"
                value={technique}
                defaultChecked={selected.has(technique)}
                className="size-4 accent-lucid-500"
              />
              {TECHNIQUE_LABELS[technique]}
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label className="label" htmlFor="notes">
          Notes about the night
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={4}
          defaultValue={night?.notes ?? ""}
          placeholder="Anything that might explain how the night went — late meal, alarm at 4, unusual stress."
          className="field"
        />
      </div>

      <label className="flex items-start gap-3 rounded-lg border border-ink-700 p-3">
        <input
          type="checkbox"
          name="noRecall"
          defaultChecked={night?.noRecall ?? false}
          disabled={hasDreams}
          className="mt-0.5 size-4 accent-lucid-500"
        />
        <span>
          <span className="block text-sm text-ink-200">I remembered nothing</span>
          <span className="block text-xs text-ink-400">
            {hasDreams
              ? "Not available: this night already has an entry on it."
              : "Records the night as journalled with no recall, which is not the same as a night you skipped."}
          </span>
        </span>
      </label>

      <div className="flex flex-wrap gap-3">
        <SubmitButton pendingLabel="Saving…" className="btn btn-primary">
          Save night
        </SubmitButton>
      </div>
    </form>
  );
}
