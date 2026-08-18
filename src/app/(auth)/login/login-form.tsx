"use client";

import { useActionState } from "react";
import { loginAction, type FormState } from "@/lib/auth/actions";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";

export function LoginForm({ children }: { children: React.ReactNode }) {
  const [state, formAction] = useActionState<FormState, FormData>(loginAction, {});

  return (
    <form action={formAction} className="card space-y-4">
      {children}
      <h2 className="text-lg font-medium">Unlock your journal</h2>

      <FormError message={state.error} />

      <div>
        <label className="label" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          className="field"
        />
      </div>

      <div>
        <label className="label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="field"
        />
      </div>

      <SubmitButton pendingLabel="Unlocking…">Unlock</SubmitButton>
    </form>
  );
}
