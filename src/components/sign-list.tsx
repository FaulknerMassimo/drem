import { CsrfField } from "@/components/csrf-field";
import { setSignActiveAction } from "@/lib/semantic/actions";
import { describeLift, MIN_CONFIDENT_OCCURRENCES } from "@/lib/semantic/correlation";
import { SIGN_CATEGORY_LABELS } from "@/lib/semantic/labels";
import type { RankedSign } from "@/lib/semantic/signs";
import { formatDate } from "@/lib/journal/dates";

/**
 * A sign, its frequency, and whether carrying it changes the odds of lucidity.
 *
 * The lucid ratio is the number worth acting on, so it is the one given room —
 * but only once there are enough occurrences behind it. Below that the row says
 * so in words rather than printing a ratio nobody should believe: "100% lucid"
 * off a single dream is exactly the misreading that sends someone to spend a
 * month reality-checking the wrong cue.
 */
function SignRow({ sign, returnTo }: { sign: RankedSign; returnTo: string }) {
  const lift = describeLift(sign.correlation);

  return (
    <li className="border-b border-ink-800 py-4 last:border-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <a
            href={`/signs/${sign.id}`}
            className="font-medium text-ink-100 hover:text-lucid-300"
          >
            {sign.label}
          </a>
          <p className="mt-0.5 text-xs text-ink-400">
            {SIGN_CATEGORY_LABELS[sign.category]}
            {!sign.isAuto && " · added by hand"}
            {sign.lastSeenAt && ` · last seen ${formatDate(sign.lastSeenAt)}`}
          </p>
        </div>

        <div className="flex items-center gap-4 text-sm">
          <span className="tabular-nums text-ink-300">
            {sign.correlation.occurrences} dream
            {sign.correlation.occurrences === 1 ? "" : "s"}
          </span>
          <span
            className={`tabular-nums ${lift && sign.correlation.lift! > 1.25 ? "text-lucid-300" : "text-ink-300"}`}
          >
            {sign.correlation.lucidOccurrences} lucid
          </span>
          <form action={setSignActiveAction}>
            <CsrfField />
            <input type="hidden" name="signId" value={sign.id} />
            <input type="hidden" name="isActive" value={sign.isActive ? "0" : "1"} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <button type="submit" className="text-xs text-ink-400 hover:text-ink-200">
              {sign.isActive ? "Dismiss" : "Restore"}
            </button>
          </form>
        </div>
      </div>

      <p className="mt-1.5 text-sm">
        {lift ? (
          <span className="text-ink-200">{lift}</span>
        ) : (
          <span className="text-ink-400">
            Too few appearances to tell — {MIN_CONFIDENT_OCCURRENCES} is where the
            ratio starts meaning anything.
          </span>
        )}
      </p>
    </li>
  );
}

export function SignList({
  signs,
  returnTo,
  empty,
}: {
  signs: readonly RankedSign[];
  returnTo: string;
  empty: React.ReactNode;
}) {
  if (signs.length === 0) {
    return <div className="card text-sm text-ink-400">{empty}</div>;
  }
  return (
    <ul className="card py-0">
      {signs.map((sign) => (
        <SignRow key={sign.id} sign={sign} returnTo={returnTo} />
      ))}
    </ul>
  );
}
