import { sessionOrRedirect } from "@/lib/auth/session";
import { loadAiConfig, loadPublicAiConfig } from "@/lib/ai/config";
import { leavesMachine } from "@/lib/ai/destination";
import { providerTest } from "@/lib/ai/providers";
import { SettingsForm } from "@/components/settings-form";
import { Why } from "@/components/why";
import { readCsrfToken } from "@/lib/security/csrf-server";
import type { AiConfig } from "@/lib/ai/types";

export const dynamic = "force-dynamic";

/**
 * The models a provider on this machine actually has installed.
 *
 * Every role used to be a free-text box, so assigning one meant typing an
 * exact model tag from memory — and a typo did not fail here, it failed
 * fifteen minutes later inside a job, where nothing showed it. Asking the
 * provider what it has turns that into a list.
 *
 * Only local providers are asked, and only because they are local: listing a
 * remote provider's models means an unprompted request to somebody else's
 * server on every visit to this page. Those keep the explicit Test connection
 * button, which is the same rule the embedding role already follows.
 *
 * Bounded well below `TEST_TIMEOUT_MS`, because this one is not a test the
 * operator asked for and must never be what the page is waiting on: a model
 * server that is down refuses the connection at once, but one that is wedged
 * accepts it and says nothing, and ten seconds of that on the way to Settings
 * is worse than no list. Coming back empty is not an error — the roles fall
 * back to free text and Test connection still reports properly.
 */
const MODEL_LIST_BUDGET_MS = 2_500;

async function localModels(config: AiConfig): Promise<Record<string, string[]>> {
  const local = config.providers.filter(
    (provider) => provider.enabled && !leavesMachine(provider.kind, provider.baseUrl),
  );

  const results = await Promise.all(
    local.map(async (provider) => {
      const test = await Promise.race([
        providerTest(provider),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), MODEL_LIST_BUDGET_MS)),
      ]);
      return [provider.id, test?.ok ? test.models : []] as const;
    }),
  );
  return Object.fromEntries(results.filter(([, models]) => models.length > 0));
}

export default async function SettingsPage() {
  const session = await sessionOrRedirect();
  const config = await loadAiConfig(session.userId, session.keys);
  const [publicConfig, models, csrfToken] = await Promise.all([
    loadPublicAiConfig(session.userId, session.keys),
    localModels(config),
    readCsrfToken(),
  ]);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="max-w-2xl text-sm text-ink-400">
          Nothing uses a model until you assign one here.
        </p>
        <Why label="What the roles are">
          <p>
            Insight roles run on a single entry. Capture roles read a
            photographed page and carve a joined log into separate dreams.
            Semantic roles cover search and the dream-sign scan.
          </p>
          <p>
            Every request names its destination on screen before it is sent, so
            nothing leaves this machine without you seeing where it is going.
          </p>
        </Why>
      </div>
      <SettingsForm initial={publicConfig} initialModels={models} csrfToken={csrfToken} />
    </div>
  );
}
