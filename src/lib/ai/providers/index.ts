/**
 * Dispatches a completion, embedding or connection-test call to its adapter.
 *
 * The only place provider kind is switched on. Callers pass a provider config
 * that already has its URL and key resolved; this module does not read the
 * environment or the database.
 */
import { anthropicChatStream, anthropicEmbed, anthropicTest } from "./anthropic";
import { explainImageRejection } from "./errors";
import type { StreamBudget } from "./http";
import { ollamaChatStream, ollamaEmbed, ollamaTest } from "./ollama";
import { openaiChatStream, openaiEmbed, openaiTest } from "./openai";
import type {
  ChatRequest,
  ChatStreamEvent,
  ConnectionTest,
  EmbedRequest,
  EmbedResponse,
  ProviderConfig,
} from "../types";

/**
 * A completion, as the pieces of it arrive.
 *
 * The only shape there is: `completeRole` assembles these back into one answer
 * for the callers that want the finished text. A buffered request would be
 * simpler to read, and it is what the queued jobs used — but it can only be
 * held to a total wall-clock budget, which on a local model reading a whole
 * period measures how long the answer *is* rather than whether the machine is
 * still working, and throws away a good answer for being slow.
 */
export async function* providerChatStream(
  config: ProviderConfig,
  request: ChatRequest,
  fetchImpl: typeof fetch = fetch,
  budget?: StreamBudget,
): AsyncGenerator<ChatStreamEvent> {
  try {
    if (config.kind === "ollama") yield* ollamaChatStream(config, request, fetchImpl, budget);
    else if (config.kind === "openai") yield* openaiChatStream(config, request, fetchImpl, budget);
    else yield* anthropicChatStream(config, request, fetchImpl, budget);
  } catch (error) {
    throw explainImageRejection(request.model, Boolean(request.images?.length), error);
  }
}

export async function providerEmbed(
  config: ProviderConfig,
  request: EmbedRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs?: number,
): Promise<EmbedResponse> {
  if (config.kind === "ollama") return ollamaEmbed(config, request, fetchImpl, timeoutMs);
  if (config.kind === "openai") return openaiEmbed(config, request, fetchImpl, timeoutMs);
  return anthropicEmbed();
}

export async function providerTest(
  config: ProviderConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectionTest> {
  try {
    if (config.kind === "ollama") return await ollamaTest(config, fetchImpl);
    if (config.kind === "openai") return await openaiTest(config, fetchImpl);
    return await anthropicTest(config, fetchImpl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The connection test failed.";
    return { ok: false, message, models: [] };
  }
}
