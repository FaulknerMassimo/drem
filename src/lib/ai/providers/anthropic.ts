/**
 * Anthropic Messages API adapter.
 *
 * The system prompt is a top-level field here, not a message, so it is split
 * out of the chat request rather than sent as `role: "system"`.
 */
import type { ChatImage, ChatMessage, ChatRequest, ChatResponse, ConnectionTest, ProviderConfig } from "../types";
import { ProviderError } from "./errors";
import { CHAT_TIMEOUT_MS, joinUrl, requestJson, TEST_TIMEOUT_MS } from "./http";

const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Anthropic has no embeddings endpoint — it recommends a third party for that.
 *
 * Failing loudly here is the point: silently falling back to some other
 * provider would send the journal somewhere the user never assigned.
 */
export async function anthropicEmbed(): Promise<never> {
  throw new ProviderError(
    "Anthropic does not offer an embeddings API. Assign Ollama or an OpenAI-compatible endpoint to the embedding role.",
  );
}

export async function anthropicChat(
  config: ProviderConfig,
  request: ChatRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = CHAT_TIMEOUT_MS,
): Promise<ChatResponse> {
  const { system, messages } = splitSystem(request.messages);
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens,
    temperature: request.temperature,
    messages: serialiseAnthropicMessages(messages, request.images),
  };
  if (system) body.system = system;

  const payload = await requestJson(
    joinUrl(config.baseUrl, "/v1/messages"),
    {
      method: "POST",
      headers: anthropicHeaders(config),
      body: JSON.stringify(body),
    },
    fetchImpl,
    timeoutMs,
  );

  const record = asRecord(payload);
  const text = readAnthropicText(record.content);
  if (!text) throw new ProviderError("Anthropic returned an empty completion");

  const usage = asRecord(record.usage);
  return {
    text,
    inputTokens: numberOrUndefined(usage.input_tokens),
    outputTokens: numberOrUndefined(usage.output_tokens),
  };
}

export async function anthropicTest(
  config: ProviderConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectionTest> {
  const payload = await requestJson(
    joinUrl(config.baseUrl, "/v1/models"),
    { method: "GET", headers: anthropicHeaders(config) },
    fetchImpl,
    TEST_TIMEOUT_MS,
  );
  const models = readAnthropicModels(payload);
  const count = models.length;
  return {
    ok: true,
    message:
      count === 0
        ? "Reached Anthropic, but it listed no models."
        : `Reached Anthropic. ${count} model${count === 1 ? "" : "s"} listed.`,
    models,
  };
}

function serialiseAnthropicMessages(
  messages: ChatMessage[],
  images: ChatImage[] | undefined,
): unknown[] {
  const lastUser = lastUserIndex(messages);
  return messages.map((message, index) => {
    if (index !== lastUser || !images?.length) {
      return { role: message.role, content: message.content };
    }
    return {
      role: message.role,
      content: [
        ...images.map((image) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: image.mimeType,
            data: image.bytes.toString("base64"),
          },
        })),
        { type: "text", text: message.content },
      ],
    };
  });
}

function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return -1;
}

function splitSystem(messages: ChatMessage[]): { system: string; messages: ChatMessage[] } {
  const systemParts: string[] = [];
  const rest: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") systemParts.push(message.content);
    else rest.push(message);
  }
  return { system: systemParts.join("\n\n"), messages: rest };
}

function anthropicHeaders(config: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  };
  if (config.apiKey) headers["x-api-key"] = config.apiKey;
  return headers;
}

function readAnthropicText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  return parts.join("");
}

function readAnthropicModels(payload: unknown): string[] {
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
