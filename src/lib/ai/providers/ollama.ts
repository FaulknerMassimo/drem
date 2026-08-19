/**
 * Ollama adapter.
 *
 * Talks to the native `/api/chat` and `/api/tags` endpoints rather than the
 * OpenAI-compatible shim, so a stock Ollama install works without extra flags.
 * `format: "json"` is what extraction uses to keep the model on-schema.
 */
import type {
  ChatRequest,
  ChatResponse,
  ConnectionTest,
  EmbedRequest,
  EmbedResponse,
  ProviderConfig,
} from "../types";
import { ProviderError } from "./errors";
import { readVectors } from "./vectors";
import {
  CHAT_TIMEOUT_MS,
  EMBED_TIMEOUT_MS,
  joinUrl,
  requestJson,
  TEST_TIMEOUT_MS,
} from "./http";

export async function ollamaChat(
  config: ProviderConfig,
  request: ChatRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = CHAT_TIMEOUT_MS,
): Promise<ChatResponse> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: serialiseOllamaMessages(request),
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
  if (!text) throw new ProviderError(emptyCompletionReason(record, message));

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

/**
 * Why a reply came back with nothing in it.
 *
 * Reasoning models put their working in `thinking` and it counts against the
 * same token budget as the answer, so a large prompt can consume the whole
 * budget before a single character of `content` is emitted. "Ollama returned an
 * empty completion" sends the operator looking at the connection; the real fix
 * is a bigger budget or a model that does not think.
 *
 * The reasoning itself is never quoted — it is derived from the dream, and this
 * message is persisted on the job.
 */
function emptyCompletionReason(
  record: Record<string, unknown>,
  message: Record<string, unknown>,
): string {
  const thought = typeof message.thinking === "string" && message.thinking.length > 0;
  const truncated = record.done_reason === "length";
  if (thought || truncated) {
    return "The model used its whole token budget before answering. Try a model that does not think, or a shorter period.";
  }
  return "Ollama returned an empty completion";
}

function serialiseOllamaMessages(request: ChatRequest): unknown[] {
  const lastUser = lastUserIndex(request.messages);
  return request.messages.map((message, index) => {
    const out: Record<string, unknown> = { role: message.role, content: message.content };
    if (index === lastUser && request.images?.length) {
      out.images = request.images.map((image) => image.bytes.toString("base64"));
    }
    return out;
  });
}

function lastUserIndex(messages: ChatRequest["messages"]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return -1;
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

/**
 * Native `/api/embed`, which takes a batch and returns one vector per input.
 *
 * The older `/api/embeddings` endpoint accepted a single `prompt` and is what
 * most examples still show; it is not used here because a backfill of several
 * hundred entries would then be several hundred round-trips.
 */
export async function ollamaEmbed(
  config: ProviderConfig,
  request: EmbedRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = EMBED_TIMEOUT_MS,
): Promise<EmbedResponse> {
  const payload = await requestJson(
    joinUrl(config.baseUrl, "/api/embed"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: request.model, input: request.inputs }),
    },
    fetchImpl,
    timeoutMs,
  );

  const record = asRecord(payload);
  const vectors = readVectors(record.embeddings, request.inputs.length);
  return { vectors, inputTokens: numberOrUndefined(record.prompt_eval_count) };
}
