import { notFound } from "next/navigation";
import { CsrfField } from "@/components/csrf-field";
import { DreamForm } from "@/components/dream-form";
import { sessionOrRedirect } from "@/lib/auth/session";
import { getDream } from "@/lib/journal/dreams";
import { listTagCounts } from "@/lib/journal/tags";

export const dynamic = "force-dynamic";

export default async function EditDreamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await sessionOrRedirect();

  const [dream, tags] = await Promise.all([
    getDream(session.userId, session.keys, id),
    listTagCounts(session.userId, session.keys),
  ]);
  if (!dream) notFound();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">
        {dream.isDraft ? "Write up this capture" : "Edit entry"}
      </h1>
      {dream.isDraft && (
        <p className="text-sm text-ink-400">
          Saving fills in the details and takes it out of the draft queue.
        </p>
      )}
      <DreamForm
        dream={dream}
        defaultDate={dream.dreamDate}
        knownTags={tags.slice(0, 15).map((tag) => tag.name)}
      >
        <CsrfField />
      </DreamForm>
    </div>
  );
}
