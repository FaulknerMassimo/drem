"use client";

import { useActionState, useState } from "react";
import { verifyTotpAction, type FormState } from "@/lib/auth/actions";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";

export function VerifyForm({ children }: { children: React.ReactNode }) {
  const [state, formAction] = useActionState<FormState, FormData>(verifyTotpAction, {});
  const [useRecovery, setUseRecovery] = useState(false);

  return (
    <form action={formAction} className="card space-y-4">
      {children}
      <input type="hidden" name="mode" value={useRecovery ? "recovery" : "totp"} />

      <h2 className="text-lg font-medium">
        {useRecovery ? "Use a recovery code" : "Enter your code"}
      </h2>
      <p className="text-sm text-ink-400">
        {useRecovery
          ? "Each recovery code works once. Dashes and case are ignored."
          : "The six-digit code from your authenticator app."}
      </p>

      <FormError message={state.error} />

      <div>
        <label className="label" htmlFor="token">
          {useRecovery ? "Recovery code" : "Code"}
        </label>
        <input
          id="token"
          name="token"
          // A recovery code is alphanumeric, so the numeric keypad hint only
          // applies to the six-digit case.
          inputMode={useRecovery ? "text" : "numeric"}
          autoComplete={useRecovery ? "off" : "one-time-code"}
          required
          autoFocus
          className="field font-mono tracking-widest"
          placeholder={useRecovery ? "XXXXX-XXXXX-XXXXX" : "000000"}
        />
      </div>

      <SubmitButton pendingLabel="Verifying…">Verify</SubmitButton>

      <button
        type="button"
        className="w-full text-sm text-ink-400 underline hover:text-ink-200"
        onClick={() => setUseRecovery((previous) => !previous)}
      >
        {useRecovery ? "Use my authenticator instead" : "I have lost my authenticator"}
      </button>
    </form>
  );
}
