export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-lg border border-danger-500/40 bg-danger-500/10 px-3 py-2 text-sm text-ink-100"
    >
      {message}
    </p>
  );
}
