/**
 * What models a provider can be pointed at, without sending anything anywhere.
 *
 * Two screens ask this: Settings, to assign a role, and journal chat, to change
 * model without leaving the conversation. Both follow the same rule about who
 * gets asked, which is why it lives here rather than in either page.
 */
import "server-only";
import { hostOf, leavesMachine } from "./destination";
import { providerTest } from "./providers";
import { resolveRoles } from "./schema";
import type { AiConfig, ChatModelOption } from "./types";

/**
 * Bounded well below `TEST_TIMEOUT_MS`, because this one is not a test the
 * operator asked for and must never be what a page is waiting on: a model
 * server that is down refuses the connection at once, but one that is wedged
 * accepts it and says nothing, and ten seconds of that on the way to a screen
 * is worse than no list. Coming back empty is not an error — the model can
 * still be typed in, and Test connection still reports properly.
 */
const MODEL_LIST_BUDGET_MS = 2_500;

/**
 * The models each *local* provider actually has installed.
 *
 * Only local providers are asked, and only because they are local: listing a
 * remote provider's models means an unprompted request to somebody else's
 * server on every visit to the page. Those keep the explicit button, which is
 * the same rule the embedding role already follows.
 */
export async function localModels(config: AiConfig): Promise<Record<string, string[]>> {
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

/**
 * The picker's options: every enabled provider, and what it can be pointed at.
 *
 * A remote provider comes back with an empty list rather than being left out —
 * it is still choosable, either by asking it for its models (a button, so the
 * request is one the reader made) or by typing a model name. Models already
 * assigned to a role are included whether or not the provider was asked, so
 * the model that is in use is always in the list it is being chosen from.
 */
export async function chatModelOptions(config: AiConfig): Promise<ChatModelOption[]> {
  const listed = await localModels(config);
  const assigned = new Map<string, Set<string>>();
  for (const assignment of Object.values(resolveRoles(config))) {
    if (!assignment) continue;
    const models = assigned.get(assignment.providerId) ?? new Set<string>();
    models.add(assignment.model);
    assigned.set(assignment.providerId, models);
  }

  return config.providers
    .filter((provider) => provider.enabled)
    .map((provider) => ({
      providerId: provider.id,
      providerName: provider.name,
      providerKind: provider.kind,
      host: hostOf(provider.baseUrl),
      leavesMachine: leavesMachine(provider.kind, provider.baseUrl),
      models: [
        ...new Set([...(listed[provider.id] ?? []), ...(assigned.get(provider.id) ?? [])]),
      ].sort((a, b) => a.localeCompare(b)),
    }));
}
