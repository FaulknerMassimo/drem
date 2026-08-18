"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { captureAction } from "@/lib/journal/actions";
import { nightDateFor } from "@/lib/journal/dates";
import type { JournalFormState } from "@/lib/journal/form-state";

/**
 * Capture mode.
 *
 * One field, deep red on black, and nothing else on the screen. The constraint
 * this is designed against is that a dream survives about ninety seconds after
 * waking, and every decision the interface asks for — which night, is it lucid,
 * what to call it — spends some of that. All of it is deferred to the draft
 * queue; the only job here is getting words into storage before they are gone.
 */

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="night-button" disabled={pending}>
      {pending ? "Saving…" : "Save and keep going"}
    </button>
  );
}

export function CaptureForm({
  serverNightDate,
  children,
}: {
  serverNightDate: string;
  children: React.ReactNode;
}) {
  const [state, formAction] = useActionState<JournalFormState, FormData>(
    captureAction,
    {},
  );

  /*
   * The browser knows the local wall clock and the server may not, so the date
   * is decided here — but it starts as the server's answer, so the form works
   * before hydration and with JavaScript off. The action refuses a value more
   * than a day away from its own, so this cannot be used to backdate an entry.
   */
  const [nightDate, setNightDate] = useState(serverNightDate);
  useEffect(() => setNightDate(nightDateFor(new Date())), []);

  const [saved, setSaved] = useState(0);
  useEffect(() => {
    if (state.savedAt) setSaved((count) => count + 1);
  }, [state.savedAt]);

  return (
    <form action={formAction} className="flex min-h-dvh flex-col gap-4 p-4">
      {children}
      <input type="hidden" name="nightDate" value={nightDate} />

      <textarea
        // Remounting on each save clears the field and returns the cursor to
        // it, so the next fragment can be typed without touching anything.
        key={state.savedAt ?? 0}
        name="body"
        autoFocus
        rows={10}
        spellCheck={false}
        autoComplete="off"
        placeholder="what happened…"
        className="night-field flex-1 text-2xl leading-relaxed"
      />

      {state.error && (
        <p role="alert" className="text-base">
          {state.error}
        </p>
      )}

      <SaveButton />

      <div className="flex items-center justify-between text-sm">
        <span style={{ color: "var(--color-night-dim)" }}>
          {saved > 0
            ? `${saved} saved — night of ${nightDate}`
            : `night of ${nightDate}`}
        </span>
        <a href="/" style={{ color: "var(--color-night-dim)" }}>
          done
        </a>
      </div>
    </form>
  );
}
