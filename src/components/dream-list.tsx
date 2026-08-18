import type { DreamSummary } from "@/lib/journal/dreams";
import { describeDate } from "@/lib/journal/dates";
import { LUCIDITY_LABELS, SOURCE_LABELS } from "@/lib/journal/labels";

/** Small inline markers. Text, not colour alone, so they survive a screenshot. */
function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "lucid" | "warn";
}) {
  const tones = {
    neutral: "border-ink-700 text-ink-400",
    lucid: "border-lucid-500/50 text-lucid-300",
    warn: "border-warn-500/50 text-warn-500",
  } as const;
  return (
    <span className={`rounded-md border px-1.5 py-0.5 text-xs ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function DreamRow({ dream }: { dream: DreamSummary }) {
  return (
    <li className="border-b border-ink-800 last:border-0">
      <a href={`/dream/${dream.id}`} className="block px-1 py-4 hover:bg-ink-900/60">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-sm text-ink-400 tabular-nums">
            {describeDate(dream.dreamDate)}
          </span>
          <h3 className="font-medium text-ink-100">
            {dream.title ?? <span className="text-ink-300">Untitled</span>}
          </h3>
        </div>

        {dream.preview && (
          <p className="mt-1.5 text-sm text-ink-300">{dream.preview}</p>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {dream.isLucid && (
            <Badge tone="lucid">{LUCIDITY_LABELS[dream.lucidity] ?? "Lucid"}</Badge>
          )}
          {dream.isNightmare && <Badge tone="warn">Nightmare</Badge>}
          {dream.isFragment && <Badge>Fragment</Badge>}
          {dream.isDraft && <Badge tone="warn">Draft</Badge>}
          {dream.source !== "typed" && (
            <Badge>{SOURCE_LABELS[dream.source] ?? dream.source}</Badge>
          )}
          {dream.tags.map((tag) => (
            <Badge key={tag}>#{tag}</Badge>
          ))}
          <span className="text-xs text-ink-400">{dream.wordCount} words</span>
        </div>
      </a>
    </li>
  );
}

export function DreamList({
  dreams,
  empty,
}: {
  dreams: readonly DreamSummary[];
  empty: React.ReactNode;
}) {
  if (dreams.length === 0) {
    return <div className="card text-sm text-ink-400">{empty}</div>;
  }
  return (
    <ul className="card divide-y-0 py-0">
      {dreams.map((dream) => (
        <DreamRow key={dream.id} dream={dream} />
      ))}
    </ul>
  );
}
