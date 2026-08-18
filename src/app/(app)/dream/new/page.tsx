import { CsrfField } from "@/components/csrf-field";
import { DreamForm } from "@/components/dream-form";
import { sessionOrRedirect } from "@/lib/auth/session";
import { isIsoDate, nightDateFor } from "@/lib/journal/dates";
import { listTagCounts } from "@/lib/journal/tags";

export const dynamic = "force-dynamic";

export default async function NewDreamPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const session = await sessionOrRedirect();
  const { date } = await searchParams;
  const tags = await listTagCounts(session.userId, session.keys);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">New entry</h1>
      <DreamForm
        defaultDate={date && isIsoDate(date) ? date : nightDateFor()}
        knownTags={tags.slice(0, 15).map((tag) => tag.name)}
      >
        <CsrfField />
      </DreamForm>
    </div>
  );
}
