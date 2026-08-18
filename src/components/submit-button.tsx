"use client";

import { useFormStatus } from "react-dom";

/**
 * Disables itself while the action is in flight. This matters more than usual
 * here: an Argon2id derivation takes about half a second, which is long enough
 * for an impatient double-click to fire two logins.
 */
export function SubmitButton({
  children,
  pendingLabel,
}: {
  children: React.ReactNode;
  pendingLabel: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary w-full" disabled={pending}>
      {pending ? pendingLabel : children}
    </button>
  );
}
