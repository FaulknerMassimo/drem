/**
 * Completes a chat request for one configured role.
 *
 * Looks up the assignment, refuses to guess a model if none is set, and hands
 * the call to the matching adapter. The destination is returned alongside the
 * completion so the worker can record *where* the dream went without having to
 * reconstruct it.
 */
import "server-only";
import { destinationFor } from "./destination";
import { providerChat } from "./providers";
import { REPORT_TIMEOUT_MS } from "./providers/http";
import { resolveRoles } from "./schema";
import type { AiConfig, ChatMessage, ChatResponse, Destination, InsightRole } from "./types";

export class RoleNotConfiguredError extends Error {
  constructor(role: InsightRole) {
    super(`No model is assigned for ${role}.`);
    this.name = "RoleNotConfiguredError";
  }
}

const MAX_TOKENS: Record<InsightRole, number> = {
  extraction: 2048,
  lucidity: 2048,
  symbolic: 2048,
  report: 4096,
};

const TEMPERATURE: Record<InsightRole, number> = {
  extraction: 0.1,
  lucidity: 0.5,
  symbolic: 0.6,
  report: 0.4,
};

export async function completeRole(
  config: AiConfig,
  role: InsightRole,
  messages: ChatMessage[],
  options: { json?: boolean } = {},
): Promise<{ response: ChatResponse; destination: Destination }> {
  const destination = destinationFor(config, role);
  if (!destination.configured) throw new RoleNotConfiguredError(role);

  const assignment = resolveRoles(config)[role];
  const provider = config.providers.find((candidate) => candidate.id === assignment?.providerId);
  if (!provider || !assignment) throw new RoleNotConfiguredError(role);

  const timeoutMs = role === "report" ? REPORT_TIMEOUT_MS : undefined;
  const response = await providerChat(
    provider,
    {
      model: assignment.model,
      messages,
      maxTokens: MAX_TOKENS[role],
      temperature: TEMPERATURE[role],
      json: options.json,
    },
    globalThis.fetch,
    timeoutMs,
  );

  return { response, destination };
}
