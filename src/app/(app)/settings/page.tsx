import { sessionOrRedirect } from "@/lib/auth/session";
import { loadAiConfig, loadPublicAiConfig } from "@/lib/ai/config";
import { localModels } from "@/lib/ai/models";
import { SettingsForm } from "@/components/settings-form";
import { Why } from "@/components/why";
import { readCsrfToken } from "@/lib/security/csrf-server";

export const dynamic = "force-dynamic";

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
