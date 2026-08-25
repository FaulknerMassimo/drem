/**
 * OpenAI-compatible adapter.
 *
 * Used for OpenAI itself, OpenRouter, LM Studio, vLLM, and anything else that
 * speaks `/v1/chat/completions`. The base URL is the whole story: localhost
 * stays on the machine, anything else is a remote call, and the destination
 * badge uses that rather than the kind name.
 */
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ConnectionTest,
  EmbedRequest,
  EmbedResponse,
  ProviderConfig,
} from "../types";
import { ProviderError } from "./errors";
import { readVector } from "./vectors";
import {
  CHAT_TIMEOUT_MS,
  EMBED_TIMEOUT_MS,
  joinUrl,
  requestJson,
  TEST_TIMEOUT_MS,
} from "./http";

export async function openaiChat(
  config: ProviderConfig,
  request: ChatRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = CHAT_TIMEOUT_MS,
): Promise<ChatResponse> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: serialiseOpenAiMessages(request),
    temperature: request.temperature,
    max_tokens: request.maxTokens,
  };
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    body.tool_choice = "auto";
  }
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
  const toolCalls = readOpenAiToolCalls(message.tool_calls);
  if (!text && toolCalls.length === 0) throw new ProviderError("The provider returned an empty completion");

  const usage = asRecord(record.usage);
  return {
    text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
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

/**
 * `/v1/embeddings`, which every OpenAI-compatible server implements — LM Studio
 * and vLLM included, so a local embedding model can sit behind this adapter
 * just as well as OpenAI's own.
 *
 * The reply is ordered by an explicit `index` rather than array position, and
 * is re-sorted on that: a provider that returns them out of order would
 * otherwise weld each dream's meaning to the next dream's row.
 */
export async function openaiEmbed(
  config: ProviderConfig,
  request: EmbedRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = EMBED_TIMEOUT_MS,
): Promise<EmbedResponse> {
  const payload = await requestJson(
    joinUrl(config.baseUrl, "/embeddings"),
    {
      method: "POST",
      headers: openaiHeaders(config),
      body: JSON.stringify({ model: request.model, input: request.inputs }),
    },
    fetchImpl,
    timeoutMs,
  );

  const record = asRecord(payload);
  const data = Array.isArray(record.data) ? record.data : [];
  if (data.length !== request.inputs.length) {
    throw new ProviderError(
      `The provider returned ${data.length} embeddings for ${request.inputs.length} inputs`,
    );
  }

  const vectors = new Array<number[] | undefined>(data.length);
  for (let position = 0; position < data.length; position++) {
    const entry = asRecord(data[position]);
    const index = typeof entry.index === "number" ? entry.index : position;
    if (index < 0 || index >= vectors.length || vectors[index]) {
      throw new ProviderError("The provider returned embeddings out of order");
    }
    vectors[index] = readVector(entry.embedding);
  }

  const usage = asRecord(record.usage);
  return {
    vectors: vectors as number[][],
    inputTokens: numberOrUndefined(usage.prompt_tokens),
  };
}

function serialiseOpenAiMessages(request: ChatRequest): unknown[] {
  const lastUser = lastUserIndex(request.messages);
  return request.messages.map((message, index) => {
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      };
    }
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    }
    if (index !== lastUser || !request.images?.length) {
      return { role: message.role, content: message.content };
    }
    return {
      role: message.role,
      content: [
        { type: "text", text: message.content },
        ...request.images.map((image) => ({
          type: "image_url",
          image_url: {
            url: `data:${image.mimeType};base64,${image.bytes.toString("base64")}`,
          },
        })),
      ],
    };
  });
}

function readOpenAiToolCalls(value: unknown): import("../types").ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    const record = asRecord(entry);
    const fn = asRecord(record.function);
    if (typeof fn.name !== "string" || !fn.name) return [];
    let args: unknown = fn.arguments;
    if (typeof fn.arguments === "string") {
      try {
        args = JSON.parse(fn.arguments);
      } catch {
        args = null;
      }
    }
    return [{
      id: typeof record.id === "string" && record.id ? record.id : `call_${index}`,
      name: fn.name,
      arguments: args,
    }];
  });
}

function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return -1;
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
