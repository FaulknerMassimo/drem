import { IndexStatus } from "@/components/index-status";
import { JobRefresh } from "@/components/job-refresh";
import { SearchForm } from "@/components/search-form";
import { loadAiConfig } from "@/lib/ai/config";
import { destinationFor } from "@/lib/ai/destination";
import { jobQueueSummary } from "@/lib/ai/jobs";
import { Why } from "@/components/why";
import { sessionOrRedirect } from "@/lib/auth/session";
import { indexCoverage } from "@/lib/semantic/embeddings";
import { currentEmbeddingModel } from "@/lib/semantic/search";
import { modelFromKey } from "@/lib/semantic/text";
import { readCsrfToken } from "@/lib/security/csrf-server";

export const dynamic = "force-dynamic";

export default async function SearchPage() {
  const session = await sessionOrRedirect();
  const config = await loadAiConfig(session.userId, session.keys);
  const model = currentEmbeddingModel(config);

  const [coverage, queue, csrfToken] = await Promise.all([
    model
      ? indexCoverage(session.userId, model)
      : Promise.resolve({ embeddable: 0, indexed: 0, outstanding: 0 }),
    jobQueueSummary(session.userId, "embed_dream"),
    readCsrfToken(),
  ]);

  return (
    <div className="space-y-8">
      <JobRefresh active={queue.open > 0} />

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Search</h1>
        <p className="max-w-2xl text-sm text-ink-400">
          Searches by meaning rather than by word — an entry that never used
          your words can still come back.
        </p>
        <Why label="Why not a word search?">
          <p>
            The journal is encrypted, so nothing can search it for a word. Each
            entry is turned into a vector once and your phrase is compared
            against those, and the comparison happens here rather than in the
            database.
          </p>
        </Why>
      </div>

      <SearchForm
        destination={destinationFor(config, "embedding")}
        indexed={coverage.indexed}
        csrfToken={csrfToken}
      />

      <IndexStatus
        coverage={coverage}
        destination={destinationFor(config, "embedding")}
        model={model ? modelFromKey(model) : null}
        queue={queue}
        csrfToken={csrfToken}
      />
    </div>
  );
}
