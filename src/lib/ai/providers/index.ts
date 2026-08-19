/**
 * Dispatches a chat, embedding or connection-test call to the matching adapter.
 *
 * The only place provider kind is switched on. Callers pass a provider config
 * that already has its URL and key resolved; this module does not read the
 * environment or the database.
 */
import { anthropicChat, anthropicEmbed, anthropicTest } from "./anthropic";
import { explainImageRejection } from "./errors";
import { ollamaChat, ollamaEmbed, ollamaTest } from "./ollama";
import { openaiChat, openaiEmbed, openaiTest } from "./openai";
import type {
  ChatRequest,
  ChatResponse,
  ConnectionTest,
  EmbedRequest,
  EmbedResponse,
  ProviderConfig,
} from "../types";

export async function providerChat(
  config: ProviderConfig,
  request: ChatRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs?: number,
): Promise<ChatResponse> {
  try {
    if (config.kind === "ollama") return await ollamaChat(config, request, fetchImpl, timeoutMs);
    if (config.kind === "openai") return await openaiChat(config, request, fetchImpl, timeoutMs);
    return await anthropicChat(config, request, fetchImpl, timeoutMs);
  } catch (error) {
    // `await` above rather than a bare return, so the rejection lands here.
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
