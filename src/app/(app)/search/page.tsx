import { IndexStatus } from "@/components/index-status";
import { JobRefresh } from "@/components/job-refresh";
import { SearchForm } from "@/components/search-form";
import { loadAiConfig } from "@/lib/ai/config";
import { destinationFor } from "@/lib/ai/destination";
import { openJobCount } from "@/lib/ai/jobs";
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

  const [coverage, pending, csrfToken] = await Promise.all([
    model
      ? indexCoverage(session.userId, model)
      : Promise.resolve({ embeddable: 0, indexed: 0, outstanding: 0 }),
    openJobCount(session.userId, "embed_dream"),
    readCsrfToken(),
  ]);

  return (
    <div className="space-y-8">
      <JobRefresh active={pending > 0} />

      <div>
        <h1 className="text-2xl font-semibold">Search</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-400">
          The journal is encrypted, so nothing can search it for a word. This
          searches by meaning instead: each entry is turned into a vector once,
          and a phrase is compared against those. The comparison happens here,
          not in the database.
        </p>
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
        pending={pending}
        csrfToken={csrfToken}
      />
    </div>
  );
}
