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
  ChatStreamEvent,
  ConnectionTest,
  EmbedRequest,
  EmbedResponse,
  ProviderConfig,
  ToolCall,
} from "../types";
import { ProviderError } from "./errors";
import { readVector } from "./vectors";
import {
  chatStreamBudget,
  EMBED_TIMEOUT_MS,
  joinUrl,
  requestJson,
  SSE_DONE,
  sseData,
  streamLines,
  TEST_TIMEOUT_MS,
  type StreamBudget,
} from "./http";

/**
 * A completion, as Server-Sent Events.
 *
 * Retried once without `stream_options` on a 400. Token counts are only
 * reported on a stream if that field is sent, and it is part of the OpenAI
 * spec — but "OpenAI-compatible" covers a long tail of servers that reject
 * fields they do not implement, and losing the whole conversation to a
 * rejected usage flag would be a poor trade for a number shown under the
 * answer. A 400 arrives as the response status, before any event, so the retry
 * cannot replay half an answer.
 */
export async function* openaiChatStream(
  config: ProviderConfig,
  request: ChatRequest,
  fetchImpl: typeof fetch = fetch,
  budget: StreamBudget = chatStreamBudget(),
): AsyncGenerator<ChatStreamEvent> {
  try {
    yield* openaiStream(config, request, fetchImpl, budget, true);
  } catch (error) {
    if (!(error instanceof ProviderError) || error.status !== 400) throw error;
    yield* openaiStream(config, request, fetchImpl, budget, false);
  }
}

async function* openaiStream(
  config: ProviderConfig,
  request: ChatRequest,
  fetchImpl: typeof fetch,
  budget: StreamBudget,
  withUsage: boolean,
): AsyncGenerator<ChatStreamEvent> {
  const partial = new Map<number, { id?: string; name?: string; arguments: string }>();
  let sawText = false;
  let usage: ChatStreamEvent | null = null;

  for await (const line of streamLines(
    joinUrl(config.baseUrl, "/chat/completions"),
    {
      method: "POST",
      headers: openaiHeaders(config),
      body: JSON.stringify(openaiBody(request, withUsage)),
    },
    fetchImpl,
    budget,
  )) {
    const data = sseData(line);
    if (data === null) continue;
    if (data === SSE_DONE) break;

    const record = asRecord(data);
    const delta = asRecord(asRecord(firstChoice(record)).delta);
    /*
     * Reasoning has no agreed field name. `reasoning_content` is what the
     * DeepSeek-style servers emit and what vLLM and LM Studio copied;
     * `reasoning` is OpenRouter's. Both are read because the alternative is a
     * chat that looks frozen for a minute against a reasoning model.
     */
    const thinking = firstString(delta.reasoning_content, delta.reasoning);
    if (thinking) yield { type: "thinking", delta: thinking };
    if (typeof delta.content === "string" && delta.content) {
      sawText = true;
      yield { type: "text", delta: delta.content };
    }
    collectOpenAiToolDeltas(partial, delta.tool_calls);

    const reported = asRecord(record.usage);
    if (reported.prompt_tokens !== undefined || reported.completion_tokens !== undefined) {
      usage = {
        type: "usage",
        inputTokens: numberOrUndefined(reported.prompt_tokens),
        outputTokens: numberOrUndefined(reported.completion_tokens),
      };
    }
  }

  const calls = assembleOpenAiToolCalls(partial);
  if (calls.length > 0) yield { type: "tool_calls", calls };
  if (!sawText && calls.length === 0) {
    throw new ProviderError("The provider returned an empty completion");
  }
  if (usage) yield usage;
}

function firstChoice(record: Record<string, unknown>): unknown {
  const choices = Array.isArray(record.choices) ? record.choices : [];
  return choices[0];
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/**
 * Tool calls stream as fragments keyed by `index`: the name arrives once, the
 * arguments arrive as pieces of a JSON string that is only parseable once the
 * last piece has landed.
 */
function collectOpenAiToolDeltas(
  partial: Map<number, { id?: string; name?: string; arguments: string }>,
  value: unknown,
): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    const record = asRecord(entry);
    const index = typeof record.index === "number" ? record.index : partial.size;
    const slot = partial.get(index) ?? { arguments: "" };
    if (typeof record.id === "string" && record.id) slot.id = record.id;
    const fn = asRecord(record.function);
    if (typeof fn.name === "string" && fn.name) slot.name = fn.name;
    if (typeof fn.arguments === "string") slot.arguments += fn.arguments;
    partial.set(index, slot);
  }
}

function assembleOpenAiToolCalls(
  partial: Map<number, { id?: string; name?: string; arguments: string }>,
): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const [index, slot] of [...partial.entries()].sort(([a], [b]) => a - b)) {
    if (!slot.name) continue;
    let args: unknown = {};
    if (slot.arguments.trim()) {
      try {
        args = JSON.parse(slot.arguments);
      } catch {
        args = null;
      }
    }
    calls.push({ id: slot.id || `call_${index}`, name: slot.name, arguments: args });
  }
  return calls;
}

function openaiBody(request: ChatRequest, withUsage: boolean): Record<string, unknown> {
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
  body.stream = true;
  if (withUsage) body.stream_options = { include_usage: true };
  return body;
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

function readOpenAiToolCalls(value: unknown): ToolCall[] {
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
