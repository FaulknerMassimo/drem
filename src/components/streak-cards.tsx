import type { Streak, Streaks } from "@/lib/journal/streaks";
import type { JournalTotals } from "@/lib/journal/stats";

function nights(count: number): string {
  return `${count} night${count === 1 ? "" : "s"}`;
}

function StreakCard({
  title,
  streak,
  hint,
}: {
  title: string;
  streak: Streak;
  hint: string;
}) {
  return (
    <div className="card">
      <h3 className="text-sm font-medium text-ink-300">{title}</h3>
      <p className="mt-2 text-3xl font-semibold tabular-nums">{streak.current}</p>
      <p className="mt-1 text-sm text-ink-400">
        {streak.current === 0 ? hint : nights(streak.current)}
        {streak.atRisk && streak.current > 0 && (
          // Not a warning: this morning may simply not have happened yet.
          <span className="text-warn-500"> · not written up today</span>
        )}
      </p>
      <p className="mt-3 text-xs text-ink-400">Longest {nights(streak.longest)}</p>
    </div>
  );
}

export function StreakCards({
  streaks,
  totals,
}: {
  streaks: Streaks;
  totals: JournalTotals;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StreakCard
        title="Recall streak"
        streak={streaks.recall}
        hint="No run going — write up a dream to start one"
      />
      <StreakCard
        title="Lucid streak"
        streak={streaks.lucid}
        hint="No lucid nights in a row yet"
      />
      <div className="card">
        <h3 className="text-sm font-medium text-ink-300">Lucid rate</h3>
        <p className="mt-2 text-3xl font-semibold tabular-nums">
          {Math.round(totals.lucidRate * 100)}%
        </p>
        <p className="mt-1 text-sm text-ink-400">of nights you recalled</p>
        <p className="mt-3 text-xs text-ink-400">
          {totals.lucidDreams} lucid dream{totals.lucidDreams === 1 ? "" : "s"}
        </p>
      </div>
      <div className="card">
        <h3 className="text-sm font-medium text-ink-300">Journal</h3>
        <p className="mt-2 text-3xl font-semibold tabular-nums">{totals.dreams}</p>
        <p className="mt-1 text-sm text-ink-400">
          dream{totals.dreams === 1 ? "" : "s"} across {nights(totals.nights)}
        </p>
        <p className="mt-3 text-xs text-ink-400">
          {totals.words.toLocaleString("en-GB")} words written
        </p>
      </div>
    </div>
  );
}
