import { sessionOrRedirect } from "@/lib/auth/session";
import { loadPublicAiConfig } from "@/lib/ai/config";
import { SettingsForm } from "@/components/settings-form";
import { readCsrfToken } from "@/lib/security/csrf-server";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await sessionOrRedirect();
  const config = await loadPublicAiConfig(session.userId, session.keys);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-400">
          Assign a model to each role before generating anything. Capture roles
          cover photographed pages and splitting a log that contains several
          dreams; semantic roles cover search and the dream-sign scan. Every
          request names its destination first, so nothing leaves this machine
          without you seeing where it is going.
        </p>
      </div>
      <SettingsForm initial={config} csrfToken={await readCsrfToken()} />
    </div>
  );
}
