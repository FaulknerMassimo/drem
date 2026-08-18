import { notFound } from "next/navigation";
import { CsrfField } from "@/components/csrf-field";
import { sessionOrRedirect } from "@/lib/auth/session";
import { deleteDreamAction } from "@/lib/journal/actions";
import { describeDate } from "@/lib/journal/dates";
import { getDream } from "@/lib/journal/dreams";

export const dynamic = "force-dynamic";

export default async function DeleteDreamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await sessionOrRedirect();
  const dream = await getDream(session.userId, session.keys, id);
  if (!dream) notFound();

  return (
    <div className="mx-auto max-w-lg space-y-5">
      <h1 className="text-2xl font-semibold">Delete this entry?</h1>
      <p className="text-ink-300">
        {dream.title ? `“${dream.title}”` : "The untitled entry"} from{" "}
        {describeDate(dream.dreamDate)}, {dream.wordCount} words. There is no undo and
        no copy anywhere else.
      </p>
      <p className="text-sm text-ink-400">
        The night itself stays on record, so your heatmap keeps showing that you
        journalled.
      </p>

      <form action={deleteDreamAction} className="flex flex-wrap gap-3">
        <CsrfField />
        <input type="hidden" name="id" value={dream.id} />
        <input type="hidden" name="returnTo" value={`/night/${dream.dreamDate}`} />
        <button type="submit" className="btn bg-danger-500 text-white hover:opacity-90">
          Delete permanently
        </button>
        <a href={`/dream/${dream.id}`} className="btn btn-ghost">
          Keep it
        </a>
      </form>
    </div>
  );
}
