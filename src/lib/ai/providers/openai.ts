/**
 * OpenAI-compatible adapter.
 *
 * Used for OpenAI itself, OpenRouter, LM Studio, vLLM, and anything else that
 * speaks `/v1/chat/completions`. The base URL is the whole story: localhost
 * stays on the machine, anything else is a remote call, and the destination
 * badge uses that rather than the kind name.
 */
import type { ChatRequest, ChatResponse, ConnectionTest, ProviderConfig } from "../types";
import { ProviderError } from "./errors";
import { CHAT_TIMEOUT_MS, joinUrl, requestJson, TEST_TIMEOUT_MS } from "./http";

export async function openaiChat(
  config: ProviderConfig,
  request: ChatRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = CHAT_TIMEOUT_MS,
): Promise<ChatResponse> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    temperature: request.temperature,
    max_tokens: request.maxTokens,
  };
  if (request.json) body.response_format = { type: "json_object" };

  const payload = await requestJson(
    joinUrl(config.baseUrl, "/chat/completions"),
    {
      method: "POST",
      headers: openaiHeaders(config),
      body: JSON.stringify(body),
    },
    fetchImpl,
    timeoutMs,
  );

  const record = asRecord(payload);
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = asRecord(choices[0]);
  const message = asRecord(first.message);
  const text = typeof message.content === "string" ? message.content : "";
  if (!text) throw new ProviderError("The provider returned an empty completion");

  const usage = asRecord(record.usage);
  return {
    text,
    inputTokens: numberOrUndefined(usage.prompt_tokens),
    outputTokens: numberOrUndefined(usage.completion_tokens),
  };
}

export async function openaiTest(
  config: ProviderConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectionTest> {
  const payload = await requestJson(
    joinUrl(config.baseUrl, "/models"),
    { method: "GET", headers: openaiHeaders(config) },
    fetchImpl,
    TEST_TIMEOUT_MS,
  );
  const models = readOpenAiModels(payload);
  const count = models.length;
  return {
    ok: true,
    message:
      count === 0
        ? "Reached the endpoint, but it listed no models."
        : `Reached the endpoint. ${count} model${count === 1 ? "" : "s"} listed.`,
    models,
  };
}

function openaiHeaders(config: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  return headers;
}

function readOpenAiModels(payload: unknown): string[] {
  const record = asRecord(payload);
  if (!Array.isArray(record.data)) return [];
  const names: string[] = [];
  for (const entry of record.data) {
    const id = asRecord(entry).id;
    if (typeof id === "string" && id) names.push(id);
  }
  return names;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
