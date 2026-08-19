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
import {
  OCR_TIMEOUT_MS,
  REPORT_TIMEOUT_MS,
  SCAN_TIMEOUT_MS,
  SPLIT_TIMEOUT_MS,
} from "./providers/http";
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
  ocr: 0,
  split: 0.1,
  // A dream-sign scan is a clustering job over an archive, not a creative one.
  signs: 0.2,
};

/**
 * Whether a role's model may think before it answers.
 *
 * Only the roles where reasoning is pure cost are listed; the rest are left at
 * the model's own default, because working out what an entry means is exactly
 * what they are for. Transcribing a page is not one of those: the answer is on
 * the page, and on a local vision model at three tokens a second a few hundred
 * tokens of deliberation is minutes of a hot GPU spent before the first word of
 * the transcript, which is how a page ends up timing out mid-sentence. Splitting
 * a log is the same shape of job -- find the seams in text that is already
 * written -- against a tighter budget still.
 */
const THINKING: Partial<Record<ChatRole, boolean>> = {
  ocr: false,
  split: false,
};

/** Roles the default chat budget is too tight for. The rest fall back to it. */
const TIMEOUTS: Partial<Record<ChatRole, number>> = {
  signs: SCAN_TIMEOUT_MS,
  ocr: OCR_TIMEOUT_MS,
  report: REPORT_TIMEOUT_MS,
  split: SPLIT_TIMEOUT_MS,
};

/**
 * What a call may spend, when the role's own ceiling is the wrong shape for it.
 *
 * `MAX_TOKENS` and `TIMEOUTS` assume a role costs about the same every time.
 * Splitting a *stack* of photographed pages writes the joined log out again
 * inside JSON, so both halves scale with how many pages were copied. The
 * caller that knows the page count passes the budget rather than this module
 * guessing at it from the message array.
 */
export interface ChatBudget {
  maxTokens?: number;
  timeoutMs?: number;
}

export async function completeRole(
  config: AiConfig,
  role: ChatRole,
  messages: ChatMessage[],
  options: {
    json?: boolean;
    jsonSchema?: Record<string, unknown>;
    images?: ChatImage[];
    budget?: ChatBudget;
  } = {},
): Promise<{ response: ChatResponse; destination: Destination }> {
  const destination = destinationFor(config, role);
  if (!destination.configured) throw new RoleNotConfiguredError(role);

  const assignment = resolveRoles(config)[role];
  const provider = config.providers.find((candidate) => candidate.id === assignment?.providerId);
  if (!provider || !assignment) throw new RoleNotConfiguredError(role);

  const timeoutMs = options.budget?.timeoutMs ?? TIMEOUTS[role];
  const response = await providerChat(
    provider,
    {
      model: assignment.model,
      messages,
      maxTokens: options.budget?.maxTokens ?? MAX_TOKENS[role],
      temperature: TEMPERATURE[role],
      json: options.json,
      jsonSchema: options.jsonSchema,
      images: options.images,
      think: THINKING[role],
    },
    globalThis.fetch,
    timeoutMs,
  );

  return { response, destination };
}
