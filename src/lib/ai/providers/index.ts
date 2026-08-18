/**
 * Dispatches a chat or connection-test call to the matching adapter.
 *
 * The only place provider kind is switched on. Callers pass a provider config
 * that already has its URL and key resolved; this module does not read the
 * environment or the database.
 */
import { anthropicChat, anthropicTest } from "./anthropic";
import { ollamaChat, ollamaTest } from "./ollama";
import { openaiChat, openaiTest } from "./openai";
import type { ChatRequest, ChatResponse, ConnectionTest, ProviderConfig } from "../types";

export async function providerChat(
  config: ProviderConfig,
  request: ChatRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs?: number,
): Promise<ChatResponse> {
  if (config.kind === "ollama") return ollamaChat(config, request, fetchImpl, timeoutMs);
  if (config.kind === "openai") return openaiChat(config, request, fetchImpl, timeoutMs);
  return anthropicChat(config, request, fetchImpl, timeoutMs);
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
