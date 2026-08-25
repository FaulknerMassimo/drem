/**
 * The reasoning behind a screen, one click away rather than in the way.
 *
 * Several pages here opened with three or four paragraphs explaining why the
 * thing they do works the way it does — the encryption, the backup's single
 * factor, what a dream sign ratio is measured against. All of it is worth
 * having and none of it is worth reading on the two hundredth visit, so the
 * page keeps one line and hands the rest to this.
 */
export function Why({
  label = "Why?",
  children,
}: {
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group max-w-2xl">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-ink-400 hover:text-ink-200">
        <span aria-hidden className="transition-transform group-open:rotate-90">
          ›
        </span>
        {label}
      </summary>
      <div className="mt-2 space-y-2 border-l border-ink-800 pl-3 text-sm text-ink-400">
        {children}
      </div>
    </details>
  );
}
