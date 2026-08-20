"use client";

import { useActionState } from "react";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { restoreArchiveAction } from "@/lib/backup/actions";
import type { RestoreFormState } from "@/lib/backup/form-state";
import { CSRF_FIELD } from "@/lib/security/constants";

/**
 * Taking a backup, and putting one back.
 *
 * The export form posts natively to `/api/backup/export` rather than through a
 * Server Action, because its answer is a file — see the route for why. It is
 * therefore an ordinary uncontrolled form and works with scripting off; the
 * only thing this component adds is the matching-passphrase check, which the
 * route repeats server-side.
 */
export function ExportForm({
  csrfToken,
  minPassphraseLength,
}: {
  csrfToken: string;
  /*
   * Passed in rather than imported. `crypto/archive` reaches Argon2 through
   * `kdf.ts`, and a client component importing it drags a native binding into
   * the browser bundle — the same reason `journal/labels.ts` exists apart from
   * the schema.
   */
  minPassphraseLength: number;
}) {
  return (
    <form
      action="/api/backup/export"
      method="post"
      className="card space-y-4"
      // The browser's own check, so a typo is caught before a file nobody can
      // open has been written.
      onSubmit={(event) => {
        const form = event.currentTarget;
        const passphrase = form.elements.namedItem("passphrase") as HTMLInputElement;
        const confirmation = form.elements.namedItem("passphraseConfirm") as HTMLInputElement;
        confirmation.setCustomValidity(
          passphrase.value === confirmation.value ? "" : "Those two do not match.",
        );
        if (!form.reportValidity()) event.preventDefault();
      }}
    >
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <div>
        <h2 className="font-medium">Take a backup</h2>
        <p className="mt-1 text-sm text-ink-400">
          Every night and every dream, in one encrypted file. Attachments are not
          included — those are files on disk, and are backed up by copying{" "}
          <code className="text-ink-300">UPLOAD_DIR</code>.
        </p>
      </div>

      <div className="rounded-xl border border-warn-500/40 bg-warn-500/10 px-4 py-3 text-sm">
        <p className="font-medium text-ink-100">
          This file is protected by its passphrase alone.
        </p>
        <p className="mt-1 text-ink-300">
          Not by your password, and not by <code>MASTER_KEY</code> — that is what
          makes it a backup rather than a second copy of the same problem. Anyone
          who gets the file can attack it offline with nothing else, so choose
          several words, and store it somewhere other than your database backups.
          There is no way to recover it if you forget it.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="export-passphrase">
            Passphrase
          </label>
          <input
            id="export-passphrase"
            name="passphrase"
            type="password"
            required
            minLength={minPassphraseLength}
            autoComplete="new-password"
            className="field"
          />
        </div>
        <div>
          <label className="label" htmlFor="export-passphrase-confirm">
            And again
          </label>
          <input
            id="export-passphrase-confirm"
            name="passphraseConfirm"
            type="password"
            required
            minLength={minPassphraseLength}
            autoComplete="new-password"
            className="field"
          />
        </div>
      </div>

      <button type="submit" className="btn btn-primary">
        Download archive
      </button>
    </form>
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function RestoreForm({ csrfToken }: { csrfToken: string }) {
  const [state, formAction] = useActionState<RestoreFormState, FormData>(
    restoreArchiveAction,
    {},
  );

  if (state.result) {
    const { result } = state;
    return (
      <div className="card space-y-3">
        <h2 className="font-medium">Restored</h2>
        <p role="status" className="text-sm text-ok-500">
          {plural(result.restoredDreams, "dream", "dreams")} and{" "}
          {plural(result.restoredNights, "night", "nights")} written.
        </p>
        {(result.duplicateDreams > 0 || result.existingNights > 0) && (
          <p className="text-sm text-ink-400">
            {plural(result.duplicateDreams, "entry was", "entries were")} already in
            the journal, and {plural(result.existingNights, "night", "nights")} already
            had a record — those were left alone.
          </p>
        )}
        <a href="/journal" className="btn btn-primary">
          Open the journal
        </a>
      </div>
    );
  }

  return (
    <form action={formAction} className="card space-y-4">
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <div>
        <h2 className="font-medium">Restore a backup</h2>
        <p className="mt-1 text-sm text-ink-400">
          Merges into what is already here. Nothing is deleted, a night you have
          already written keeps what it says now, and an entry the journal
          already holds is not added twice — so running this on top of a live
          journal is safe, and running it twice changes nothing the second time.
        </p>
      </div>

      <div>
        <label className="label" htmlFor="restore-file">
          Archive
        </label>
        <input
          id="restore-file"
          name="file"
          type="file"
          accept=".dremarchive,application/octet-stream"
          required
          className="field file:mr-3 file:rounded-md file:border-0 file:bg-ink-800 file:px-3 file:py-1.5 file:text-sm file:text-ink-100"
        />
      </div>

      <div>
        <label className="label" htmlFor="restore-passphrase">
          Its passphrase
        </label>
        <input
          id="restore-passphrase"
          name="passphrase"
          type="password"
          required
          autoComplete="off"
          className="field"
        />
      </div>

      <FormError message={state.error} />
      <SubmitButton pendingLabel="Restoring…">Restore</SubmitButton>
    </form>
  );
}
