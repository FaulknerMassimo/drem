import { notFound } from "next/navigation";
import { CsrfField } from "@/components/csrf-field";
import { DreamList } from "@/components/dream-list";
import { NightForm } from "@/components/night-form";
import { sessionOrRedirect } from "@/lib/auth/session";
import { addDays, describeDate, isIsoDate, today } from "@/lib/journal/dates";
import { dreamsForNight } from "@/lib/journal/dreams";
import { getNight } from "@/lib/journal/nights";

export const dynamic = "force-dynamic";

/**
 * A single night: the unit the heatmap is made of.
 *
 * Reachable by date rather than by id, so every cell in the heatmap has a
 * destination whether or not anything was ever written there.
 */
export default async function NightPage({
  params,
}: {
  params: Promise<{ date: string }>;
}) {
  const { date } = await params;
  if (!isIsoDate(date)) notFound();

  const session = await sessionOrRedirect();
  const [night, dreams] = await Promise.all([
    getNight(session.userId, session.keys, date),
    dreamsForNight(session.userId, session.keys, date),
  ]);

  const todayDate = today();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{describeDate(date)}</h1>
          <p className="mt-1 text-sm text-ink-400">
            {dreams.length === 0
              ? night
                ? night.noRecall
                  ? "Journalled — nothing recalled"
                  : "Journalled — no entries yet"
                : "Not journalled"
              : `${dreams.length} entr${dreams.length === 1 ? "y" : "ies"}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <a href={`/dream/new?date=${date}`} className="btn btn-primary">
            Add dream
          </a>
        </div>
      </div>

      <nav className="flex items-center justify-between text-sm text-ink-400">
        <a href={`/night/${addDays(date, -1)}`} className="hover:text-ink-200">
          ← {describeDate(addDays(date, -1))}
        </a>
        {date < todayDate && (
          <a href={`/night/${addDays(date, 1)}`} className="hover:text-ink-200">
            {describeDate(addDays(date, 1))} →
          </a>
        )}
      </nav>

      <DreamList
        dreams={dreams.map((dream) => ({
          id: dream.id,
          dreamDate: dream.dreamDate,
          title: dream.title,
          preview: dream.body?.slice(0, 200) ?? "",
          isLucid: dream.isLucid,
          lucidity: dream.lucidity,
          isNightmare: dream.isNightmare,
          isFragment: dream.isFragment,
          isDraft: dream.isDraft,
          wordCount: dream.wordCount,
          source: dream.source,
          tags: dream.tags,
        }))}
        empty="No dreams recorded for this night."
      />

      <section className="space-y-3">
        <h2 className="font-medium">The night itself</h2>
        <NightForm date={date} night={night} hasDreams={dreams.length > 0}>
          <CsrfField />
        </NightForm>
      </section>

      {night && (
        <p className="text-sm">
          <a href={`/night/${date}/delete`} className="text-danger-500 hover:underline">
            Delete this night
          </a>
        </p>
      )}
    </div>
  );
}
