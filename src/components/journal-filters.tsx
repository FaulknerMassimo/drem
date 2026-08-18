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

/**
 * Filters as a GET form.
 *
 * Submitting to the query string rather than posting means a filtered view is
 * linkable, survives a reload, and needs no CSRF token — a read cannot change
 * anything, so there is nothing to forge.
 */
export function JournalFilterBar({
  filters,
  tags,
}: {
  filters: JournalFilters;
  tags: readonly TagCount[];
}) {
  return (
    <form method="get" action="/journal" className="card space-y-4">
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

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-ink-800 pt-3">
          {tags.slice(0, 20).map((tag) => (
            <a
              key={tag.id}
              href={`/journal${filtersToQuery(filters, { tag: tag.name, page: 1 })}`}
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
    </form>
  );
}
