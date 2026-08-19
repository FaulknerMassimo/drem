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
import { REPORT_TIMEOUT_MS, SCAN_TIMEOUT_MS } from "./providers/http";
import { resolveRoles } from "./schema";
import type {
  AiConfig,
  ChatImage,
  ChatMessage,
  ChatResponse,
  ChatRole,
  Destination,
  ModelRole,
} from "./types";

export class RoleNotConfiguredError extends Error {
  constructor(role: ModelRole) {
    super(`No model is assigned for ${role}.`);
    this.name = "RoleNotConfiguredError";
  }
}

/** Keyed by ChatRole, not ModelRole: `embedding` returns vectors, not tokens. */
const MAX_TOKENS: Record<ChatRole, number> = {
  extraction: 2048,
  lucidity: 2048,
  symbolic: 2048,
  report: 4096,
  ocr: 4096,
  split: 4096,
  /*
   * The largest budget in the app, and it is not for a long answer: a scan
   * reads dozens of entries at once, and on a reasoning model the working is
   * charged to the same budget as the reply. At 4096 a sixty-entry scan came
   * back empty because the model was still thinking when it ran out.
   */
  signs: 16384,
};

const TEMPERATURE: Record<ChatRole, number> = {
  extraction: 0.1,
  lucidity: 0.5,
  symbolic: 0.6,
  report: 0.4,
  ocr: 0.1,
  split: 0.1,
  // A dream-sign scan is a clustering job over an archive, not a creative one.
  signs: 0.2,
};

export async function completeRole(
  config: AiConfig,
  role: ChatRole,
  messages: ChatMessage[],
  options: { json?: boolean; images?: ChatImage[] } = {},
): Promise<{ response: ChatResponse; destination: Destination }> {
  const destination = destinationFor(config, role);
  if (!destination.configured) throw new RoleNotConfiguredError(role);

  const assignment = resolveRoles(config)[role];
  const provider = config.providers.find((candidate) => candidate.id === assignment?.providerId);
  if (!provider || !assignment) throw new RoleNotConfiguredError(role);

  const timeoutMs =
    role === "signs"
      ? SCAN_TIMEOUT_MS
      : role === "report" || role === "ocr"
        ? REPORT_TIMEOUT_MS
        : undefined;
  const response = await providerChat(
    provider,
    {
      model: assignment.model,
      messages,
      maxTokens: MAX_TOKENS[role],
      temperature: TEMPERATURE[role],
      json: options.json,
      images: options.images,
    },
    globalThis.fetch,
    timeoutMs,
  );

  return { response, destination };
}
