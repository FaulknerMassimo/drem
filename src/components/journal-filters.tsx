import type { TagCount } from "@/lib/journal/tags";
import {
  filtersToQuery,
  SORT_ORDERS,
  type JournalFilters,
} from "@/lib/journal/validation";

const SORT_LABELS: Record<(typeof SORT_ORDERS)[number], string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  longest: "Longest first",
};

/** True when the view is showing anything other than the whole journal. */
function isFiltered(filters: JournalFilters): boolean {
  return Boolean(
    filters.from ||
      filters.to ||
      filters.tag ||
      filters.lucidOnly ||
      filters.nightmaresOnly ||
      !filters.includeFragments ||
      filters.sort !== "newest",
  );
}

/**
 * Filters as a GET form, folded away until they are wanted.
 *
 * Submitting to the query string rather than posting means a filtered view is
 * linkable, survives a reload, and needs no CSRF token — a read cannot change
 * anything, so there is nothing to forge.
 *
 * The panel used to stand permanently open above the entries: two empty date
 * boxes, three unchecked boxes and an Apply button, every visit, pushing the
 * journal itself below them. It opens by itself whenever a filter is actually
 * in force, so a filtered view can never look like an unfiltered one. The tags
 * stay out here, because a tag is one click and is how the list is usually
 * narrowed.
 */
export function JournalFilterBar({
  filters,
  tags,
}: {
  filters: JournalFilters;
  tags: readonly TagCount[];
}) {
  const filtered = isFiltered(filters);

  return (
    <div className="space-y-3">
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tags.slice(0, 20).map((tag) => (
            <a
              key={tag.id}
              href={`/journal${filtersToQuery(filters, {
                tag: filters.tag === tag.name ? undefined : tag.name,
                page: 1,
              })}`}
              className={`rounded-md border px-2 py-0.5 text-xs ${
                filters.tag === tag.name
                  ? "border-lucid-500/60 text-lucid-300"
                  : "border-ink-700 text-ink-400 hover:text-ink-200"
              }`}
            >
              #{tag.name}
              <span className="ml-1 text-ink-600">{tag.dreamCount}</span>
            </a>
          ))}
        </div>
      )}

      <details open={filtered} className="group">
        <summary className="inline-flex cursor-pointer list-none items-center gap-2 text-sm text-ink-400 hover:text-ink-200">
          <span aria-hidden className="transition-transform group-open:rotate-90">
            ›
          </span>
          Filters
          {filtered && (
            <span className="rounded-md border border-lucid-500/50 px-1.5 py-0.5 text-xs text-lucid-300">
              on
            </span>
          )}
        </summary>

        <form method="get" action="/journal" className="card mt-3 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="label" htmlFor="from">
                From
              </label>
              <input
                id="from"
                name="from"
                type="date"
                defaultValue={filters.from ?? ""}
                className="field"
              />
            </div>
            <div>
              <label className="label" htmlFor="to">
                To
              </label>
              <input
                id="to"
                name="to"
                type="date"
                defaultValue={filters.to ?? ""}
                className="field"
              />
            </div>
            <div>
              <label className="label" htmlFor="tag">
                Tag
              </label>
              <input
                id="tag"
                name="tag"
                type="text"
                list="known-tags"
                defaultValue={filters.tag ?? ""}
                placeholder="Any"
                className="field"
              />
              <datalist id="known-tags">
                {tags.map((tag) => (
                  <option key={tag.id} value={tag.name} />
                ))}
              </datalist>
            </div>
            <div>
              <label className="label" htmlFor="sort">
                Sort
              </label>
              <select id="sort" name="sort" defaultValue={filters.sort} className="field">
                {SORT_ORDERS.map((order) => (
                  <option key={order} value={order}>
                    {SORT_LABELS[order]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-ink-200">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="lucid"
                value="1"
                defaultChecked={filters.lucidOnly}
                className="size-4 accent-lucid-500"
              />
              Lucid only
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="nightmares"
                value="1"
                defaultChecked={filters.nightmaresOnly}
                className="size-4 accent-lucid-500"
              />
              Nightmares only
            </label>
            {/* Named for what it excludes, so an unchecked box means "no filter" and
                the absent-checkbox default lines up with the default behaviour. */}
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="fragments"
                value="0"
                defaultChecked={!filters.includeFragments}
                className="size-4 accent-lucid-500"
              />
              Hide fragments
            </label>

            <div className="ml-auto flex gap-3">
              <button type="submit" className="btn btn-primary">
                Apply
              </button>
              <a href="/journal" className="btn btn-ghost">
                Clear
              </a>
            </div>
          </div>

        </form>
      </details>
    </div>
  );
}
