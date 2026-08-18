"use client";

import { useActionState } from "react";
import { setupAction, type FormState } from "@/lib/auth/actions";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";

export function SetupForm({
  minPasswordLength,
  children,
}: {
  minPasswordLength: number;
  children: React.ReactNode;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(setupAction, {});

  return (
    <form action={formAction} className="card space-y-4">
      {children}
      <div>
        <h2 className="text-lg font-medium">Create your journal</h2>
        <p className="mt-1 text-sm text-ink-400">
          This instance holds one account. Your password encrypts everything you
          write, and cannot be reset — there is no recovery path by design.
        </p>
      </div>

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
          className="field"
          placeholder="you@example.com"
        />
        <p className="mt-1 text-xs text-ink-400">
          Used to label your authenticator app. Nothing is ever sent to it.
        </p>
      </div>

      <div>
        <label className="label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={minPasswordLength}
          className="field"
        />
        <p className="mt-1 text-xs text-ink-400">
          At least {minPasswordLength} characters. A passphrase of several words
          beats a short complicated string.
        </p>
      </div>

      <div>
        <label className="label" htmlFor="confirmPassword">
          Confirm password
        </label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={minPasswordLength}
          className="field"
        />
      </div>

      <SubmitButton pendingLabel="Deriving keys…">Create journal</SubmitButton>
    </form>
  );
}

