import { notFound } from "next/navigation";
import { CsrfField } from "@/components/csrf-field";
import { sessionOrRedirect } from "@/lib/auth/session";
import { describeDate, isIsoDate } from "@/lib/journal/dates";
import { deleteNightAction } from "@/lib/journal/actions";
import { countDreamsOnNight } from "@/lib/journal/nights";

export const dynamic = "force-dynamic";

/**
 * A confirmation page rather than a dialog.
 *
 * Deletion is the one action here that cannot be undone — there is no trash and
 * no backup of a decrypted entry — so it gets its own screen, which also means
 * it works with JavaScript disabled instead of relying on a `confirm()`.
 */
export default async function DeleteNightPage({
  params,
}: {
  params: Promise<{ date: string }>;
}) {
  const { date } = await params;
  if (!isIsoDate(date)) notFound();

  const session = await sessionOrRedirect();
  const dreamCount = await countDreamsOnNight(session.userId, date);

  return (
    <div className="mx-auto max-w-lg space-y-5">
      <h1 className="text-2xl font-semibold">Delete {describeDate(date)}?</h1>
      <p className="text-ink-300">
        This removes the night&rsquo;s record
        {dreamCount > 0 && (
          <>
            {" "}
            and the <strong>{dreamCount}</strong> entr
            {dreamCount === 1 ? "y" : "ies"} written on it
          </>
        )}
        . It cannot be undone.
      </p>

      <form action={deleteNightAction} className="flex flex-wrap gap-3">
        <CsrfField />
        <input type="hidden" name="date" value={date} />
        <button type="submit" className="btn bg-danger-500 text-white hover:opacity-90">
          Delete permanently
        </button>
        <a href={`/night/${date}`} className="btn btn-ghost">
          Keep it
        </a>
      </form>
    </div>
  );
}
