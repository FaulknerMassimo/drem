import { ScoredDreamList } from "@/components/dream-list";
import type { SearchHit } from "@/lib/semantic/search";

/**
 * The entries nearest this one in meaning.
 *
 * No button and no confirmation, because there is nothing to send: the vectors
 * were computed when the entries were written, and this is arithmetic over
 * numbers already on disk. That is also why it can sit on every entry rather
 * than behind an opt-in the way the insights do.
 *
 * Renders nothing at all when there is nothing to say — an empty "Dreams like
 * this" panel on every page would just be furniture.
 */
export function SimilarDreams({ hits }: { hits: readonly SearchHit[] }) {
  if (hits.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">Dreams like this</h2>
      <ScoredDreamList hits={hits} />
    </section>
  );
}
