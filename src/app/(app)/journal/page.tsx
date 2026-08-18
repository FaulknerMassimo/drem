import { DreamList } from "@/components/dream-list";
import { JournalFilterBar } from "@/components/journal-filters";
import { sessionOrRedirect } from "@/lib/auth/session";
import { nightDateFor } from "@/lib/journal/dates";
import { listDreams } from "@/lib/journal/dreams";
import { listTagCounts } from "@/lib/journal/tags";
import { filtersToQuery, parseFilters } from "@/lib/journal/validation";

export const dynamic = "force-dynamic";

export default async function JournalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await sessionOrRedirect();
  const raw = await searchParams;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.set(key, value);
    else if (Array.isArray(value) && value[0]) params.set(key, value[0]);
  }

  const filters = parseFilters(params);
  const [page, tags] = await Promise.all([
    listDreams(session.userId, session.keys, filters),
    listTagCounts(session.userId, session.keys),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Journal</h1>
          <p className="mt-1 text-sm text-ink-400">
            {page.total} entr{page.total === 1 ? "y" : "ies"}
            {filters.tag && ` tagged #${filters.tag}`}
          </p>
        </div>
        <a href={`/dream/new?date=${nightDateFor()}`} className="btn btn-primary">
          New entry
        </a>
      </div>

      <JournalFilterBar filters={filters} tags={tags} />

      <DreamList
        dreams={page.items}
        empty={
          page.total === 0 && !filters.tag && !filters.from && !filters.to
            ? "Nothing written yet."
            : "No entries match those filters."
        }
      />

      {page.pageCount > 1 && (
        <nav className="flex items-center justify-between text-sm" aria-label="Pages">
          {page.page > 1 ? (
            <a
              href={`/journal${filtersToQuery(filters, { page: page.page - 1 })}`}
              className="text-ink-300 hover:text-ink-100"
            >
              ← Newer
            </a>
          ) : (
            <span />
          )}
          <span className="text-ink-400">
            Page {page.page} of {page.pageCount}
          </span>
          {page.page < page.pageCount ? (
            <a
              href={`/journal${filtersToQuery(filters, { page: page.page + 1 })}`}
              className="text-ink-300 hover:text-ink-100"
            >
              Older →
            </a>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
}
