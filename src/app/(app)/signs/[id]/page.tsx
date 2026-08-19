import { notFound } from "next/navigation";
import { CsrfField } from "@/components/csrf-field";
import { DreamList } from "@/components/dream-list";
import { sessionOrRedirect } from "@/lib/auth/session";
import { formatDate } from "@/lib/journal/dates";
import { dreamSummaries } from "@/lib/journal/dreams";
import { journalTotals } from "@/lib/journal/stats";
import { deleteSignAction, setSignActiveAction } from "@/lib/semantic/actions";
import { describeLift, MIN_CONFIDENT_OCCURRENCES } from "@/lib/semantic/correlation";
import { SIGN_CATEGORY_HINTS, SIGN_CATEGORY_LABELS } from "@/lib/semantic/labels";
import { dreamIdsForSign, getSign } from "@/lib/semantic/signs";

export const dynamic = "force-dynamic";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card">
      <h2 className="text-sm font-medium text-ink-300">{label}</h2>
      <p className="mt-2 text-3xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-sm text-ink-400">{hint}</p>}
    </div>
  );
}

export default async function SignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await sessionOrRedirect();

  const totals = await journalTotals(session.userId);
  const sign = await getSign(session.userId, session.keys, id, totals.lucidRate);
  if (!sign) notFound();

  const dreamIds = await dreamIdsForSign(session.userId, sign.id);
  const dreams = await dreamSummaries(session.userId, session.keys, dreamIds);
  const lift = describeLift(sign.correlation);

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="text-sm text-ink-400">
          <a href="/signs" className="hover:text-ink-200">
            Dream signs
          </a>
        </p>
        <h1 className="text-2xl font-semibold">{sign.label}</h1>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-md border border-ink-700 px-1.5 py-0.5 text-ink-300">
            {SIGN_CATEGORY_LABELS[sign.category]}
          </span>
          {!sign.isAuto && (
            <span className="rounded-md border border-ink-700 px-1.5 py-0.5 text-ink-400">
              Added by hand
            </span>
          )}
          {!sign.isActive && (
            <span className="rounded-md border border-warn-500/50 px-1.5 py-0.5 text-warn-500">
              Dismissed — will not be proposed again
            </span>
          )}
        </div>
        <p className="text-sm text-ink-400">{SIGN_CATEGORY_HINTS[sign.category]}</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Appearances"
          value={String(sign.correlation.occurrences)}
          hint={sign.lastSeenAt ? `last on ${formatDate(sign.lastSeenAt)}` : undefined}
        />
        <Stat
          label="Lucid with it"
          value={`${Math.round(sign.correlation.lucidRate * 100)}%`}
          hint={`${sign.correlation.lucidOccurrences} of ${sign.correlation.occurrences}`}
        />
        <Stat
          label="Against baseline"
          value={
            sign.correlation.confident && sign.correlation.lift !== null
              ? `${sign.correlation.lift.toFixed(1)}×`
              : "—"
          }
          hint={
            lift ??
            `needs ${MIN_CONFIDENT_OCCURRENCES} appearances before the ratio means anything`
          }
        />
      </div>

      <div className="flex flex-wrap gap-3">
        <form action={setSignActiveAction}>
          <CsrfField />
          <input type="hidden" name="signId" value={sign.id} />
          <input type="hidden" name="isActive" value={sign.isActive ? "0" : "1"} />
          <input type="hidden" name="returnTo" value={`/signs/${sign.id}`} />
          <button type="submit" className="btn btn-ghost">
            {sign.isActive ? "Dismiss this sign" : "Restore this sign"}
          </button>
        </form>
        {/* Deleting differs from dismissing: a dismissed sign stays on file so
            the next scan does not propose it again, whereas a deleted one is
            free to come back. Deleting is for a label that was simply wrong. */}
        <form action={deleteSignAction}>
          <CsrfField />
          <input type="hidden" name="signId" value={sign.id} />
          <button type="submit" className="btn text-danger-500 hover:bg-ink-800">
            Delete
          </button>
        </form>
      </div>

      <section className="space-y-3">
        <h2 className="font-medium">Where it appeared</h2>
        <DreamList
          dreams={dreams}
          empty="No entries carry this sign yet. The next scan will look for it."
        />
      </section>
    </div>
  );
}
