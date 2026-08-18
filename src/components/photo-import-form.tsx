"use client";

import { useActionState } from "react";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { uploadPhotosAction } from "@/lib/capture/actions";
import type { CaptureFormState } from "@/lib/capture/form-state";
import { CSRF_FIELD } from "@/lib/security/constants";

export function PhotoImportForm({ csrfToken }: { csrfToken: string }) {
  const [state, action] = useActionState<CaptureFormState, FormData>(uploadPhotosAction, {});

  return (
    <form action={action} className="card space-y-4">
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <div>
        <h2 className="font-medium">Photograph a page</h2>
        <p className="mt-1 text-sm text-ink-400">
          One page per photo, or several at once. Nothing is saved as a dream
          until you confirm the reading.
        </p>
      </div>
      <div>
        <label className="label" htmlFor="photos">
          Photos
        </label>
        <input
          id="photos"
          name="files"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          capture="environment"
          multiple
          required
          className="field file:mr-3 file:rounded-md file:border-0 file:bg-ink-800 file:px-3 file:py-1.5 file:text-sm file:text-ink-100"
        />
      </div>
      <FormError message={state.error} />
      <SubmitButton pendingLabel="Uploading…">Upload pages</SubmitButton>
    </form>
  );
}
