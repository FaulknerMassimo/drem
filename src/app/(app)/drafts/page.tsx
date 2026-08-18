import { DreamList } from "@/components/dream-list";
import { sessionOrRedirect } from "@/lib/auth/session";
import { listDrafts } from "@/lib/journal/dreams";

export const dynamic = "force-dynamic";

/**
 * The queue captures land in.
 *
 * Capture mode deliberately asks nothing at 4am, which means everything it
 * saves arrives here missing its date confirmation, its lucidity rating and its
 * tags. This is where that gets filled in, in daylight.
 */
export default async function DraftsPage() {
  const session = await sessionOrRedirect();
  const drafts = await listDrafts(session.userId, session.keys);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Drafts</h1>
          <p className="mt-1 text-sm text-ink-400">
            {drafts.length === 0
              ? "Nothing waiting."
              : `${drafts.length} capture${drafts.length === 1 ? "" : "s"} to write up`}
          </p>
        </div>
        <a href="/capture" className="btn btn-ghost">
          Capture
        </a>
      </div>

      <DreamList
        dreams={drafts}
        empty={
          <>
            Anything saved from{" "}
            <a href="/capture" className="text-lucid-300 hover:text-lucid-400">
              capture mode
            </a>{" "}
            shows up here until you fill in the details.
          </>
        }
      />
    </div>
  );
}
