/**
 * Where a model call will actually go.
 *
 * Surfaced in the UI *before* any dream is sent, which is the whole point of
 * the badge: an injected script cannot hide a remote destination, and a
 * mis-aimed local config (OpenRouter sitting in the OpenAI slot) is visible
 * rather than silent. The computation is pure so the tests can pin the
 * localhost heuristic without standing up a provider.
 */
import { resolveRoles } from "./schema";
import type { AiConfig, Destination, InsightRole, ProviderKind } from "./types";

const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
  // From inside Docker this is the host running Ollama, i.e. still this machine.
  "host.docker.internal",
]);

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname || baseUrl;
  } catch {
    return baseUrl;
  }
}

/**
 * True when the request will leave the machine that is running drem.
 *
 * Kind is not enough: an OpenAI-compatible endpoint may be LM Studio on
 * localhost (stays) or OpenRouter (leaves). The hostname is the signal.
 */
export function leavesMachine(kind: ProviderKind, baseUrl: string): boolean {
  void kind;
  return !LOCAL_HOSTS.has(hostOf(baseUrl).toLowerCase());
}

export function destinationFor(config: AiConfig, role: InsightRole): Destination {
  const assignment = resolveRoles(config)[role];
  const empty: Destination = {
    role,
    configured: false,
    leavesMachine: false,
    providerId: "",
    providerName: "",
    providerKind: "ollama",
    model: "",
    host: "",
    label: "No model assigned",
  };
  if (!assignment) return empty;

  const provider = config.providers.find((candidate) => candidate.id === assignment.providerId);
  if (!provider || !provider.enabled) return empty;

  const host = hostOf(provider.baseUrl);
  const remote = leavesMachine(provider.kind, provider.baseUrl);
  const stay = remote ? "leaves this machine" : "stays on this machine";

  return {
    role,
    configured: true,
    leavesMachine: remote,
    providerId: provider.id,
    providerName: provider.name,
    providerKind: provider.kind,
    model: assignment.model,
    host,
    label: `${provider.name} · ${assignment.model} · ${host} — ${stay}`,
  };
}

export function destinationsFor(config: AiConfig): Record<InsightRole, Destination> {
  return {
    extraction: destinationFor(config, "extraction"),
    lucidity: destinationFor(config, "lucidity"),
    symbolic: destinationFor(config, "symbolic"),
    report: destinationFor(config, "report"),
  };
}
