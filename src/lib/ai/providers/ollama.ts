/**
 * Ollama adapter.
 *
 * Talks to the native `/api/chat` and `/api/tags` endpoints rather than the
 * OpenAI-compatible shim, so a stock Ollama install works without extra flags.
 * `format: "json"` is what extraction uses to keep the model on-schema.
 */
import type { ChatRequest, ChatResponse, ConnectionTest, ProviderConfig } from "../types";
import { ProviderError } from "./errors";
import { CHAT_TIMEOUT_MS, joinUrl, requestJson, TEST_TIMEOUT_MS } from "./http";

export async function ollamaChat(
  config: ProviderConfig,
  request: ChatRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = CHAT_TIMEOUT_MS,
): Promise<ChatResponse> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: false,
    options: {
      temperature: request.temperature,
      num_predict: request.maxTokens,
    },
  };
  if (request.json) body.format = "json";

  const payload = await requestJson(
    joinUrl(config.baseUrl, "/api/chat"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    fetchImpl,
    timeoutMs,
  );

  const record = asRecord(payload);
  const message = asRecord(record.message);
  const text = typeof message.content === "string" ? message.content : "";
  if (!text) throw new ProviderError("Ollama returned an empty completion");

  return {
    text,
    inputTokens: numberOrUndefined(record.prompt_eval_count),
    outputTokens: numberOrUndefined(record.eval_count),
  };
}

export async function ollamaTest(
  config: ProviderConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectionTest> {
  const payload = await requestJson(
    joinUrl(config.baseUrl, "/api/tags"),
    { method: "GET" },
    fetchImpl,
    TEST_TIMEOUT_MS,
  );
  const models = readOllamaModels(payload);
  const count = models.length;
  return {
    ok: true,
    message:
      count === 0
        ? "Reached Ollama, but it has no models pulled."
        : `Reached Ollama. ${count} model${count === 1 ? "" : "s"} available.`,
    models,
  };
}

function readOllamaModels(payload: unknown): string[] {
  const record = asRecord(payload);
  if (!Array.isArray(record.models)) return [];
  const names: string[] = [];
  for (const entry of record.models) {
    const name = asRecord(entry).name;
    if (typeof name === "string" && name) names.push(name);
  }
  return names;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
