"use client";

import { useActionState } from "react";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { confirmImportAction, parseImportAction } from "@/lib/capture/actions";
import type { ImportFormState } from "@/lib/capture/form-state";
import { CSRF_FIELD } from "@/lib/security/constants";

export function FileImportForm({ csrfToken }: { csrfToken: string }) {
  const [parsed, parseAction] = useActionState<ImportFormState, FormData>(parseImportAction, {});
  const [confirmed, confirmAction] = useActionState<ImportFormState, FormData>(
    confirmImportAction,
    {},
  );

  if (confirmed.created) {
    return (
      <div className="card space-y-3">
        <p role="status" className="text-sm text-ok-500">
          Imported {confirmed.created} {confirmed.created === 1 ? "entry" : "entries"} as drafts.
        </p>
        <a href="/drafts" className="btn btn-primary">
          Write them up
        </a>
      </div>
    );
  }

  if (parsed.entries && parsed.entries.length > 0) {
    return (
      <form action={confirmAction} className="card space-y-4">
        <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
        <input type="hidden" name="entries" value={JSON.stringify(parsed.entries)} />
        <div>
          <h2 className="font-medium">Confirm import</h2>
          <p className="mt-1 text-sm text-ink-400">
            {parsed.entries.length} {parsed.entries.length === 1 ? "entry" : "entries"}
            {parsed.format ? ` from ${parsed.format}` : ""}
            {parsed.skipped ? ` · ${parsed.skipped} skipped` : ""}. Saved as drafts
            until you fill in the details.
          </p>
        </div>
        <ol className="max-h-80 space-y-2 overflow-y-auto text-sm">
          {parsed.entries.slice(0, 20).map((entry, index) => (
            <li key={`${entry.nightDate}-${index}`} className="rounded-lg border border-ink-800 p-3">
              <p className="text-xs text-ink-400">{entry.nightDate}</p>
              <p className="font-medium">{entry.title ?? "Untitled"}</p>
              <p className="mt-1 line-clamp-2 text-ink-300">{entry.body}</p>
            </li>
          ))}
        </ol>
        {parsed.entries.length > 20 && (
          <p className="text-xs text-ink-400">Showing the first 20.</p>
        )}
        <FormError message={confirmed.error} />
        <div className="flex flex-wrap gap-2">
          <SubmitButton pendingLabel="Importing…">Import as drafts</SubmitButton>
        </div>
      </form>
    );
  }

  return (
    <form action={parseAction} className="card space-y-4">
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <div>
        <h2 className="font-medium">Import a file</h2>
        <p className="mt-1 text-sm text-ink-400">
          JSON, Markdown or CSV. You will see a preview before anything is written.
        </p>
      </div>
      <div>
        <label className="label" htmlFor="import-file">
          File
        </label>
        <input
          id="import-file"
          name="file"
          type="file"
          accept=".json,.md,.markdown,.csv,application/json,text/markdown,text/csv"
          required
          className="field file:mr-3 file:rounded-md file:border-0 file:bg-ink-800 file:px-3 file:py-1.5 file:text-sm file:text-ink-100"
        />
      </div>
      <FormError message={parsed.error} />
      <SubmitButton pendingLabel="Reading…">Preview</SubmitButton>
    </form>
  );
}
