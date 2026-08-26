/**
 * Ollama adapter.
 *
 * Talks to the native `/api/chat` and `/api/tags` endpoints rather than the
 * OpenAI-compatible shim, so a stock Ollama install works without extra flags.
 * `format: "json"` is what extraction uses to keep the model on-schema.
 *
 * Every completion is read as a stream, whether the caller wants the pieces or
 * the finished answer, so there is one request body and one place a reply is
 * taken apart.
 */
import type {
  ChatRequest,
  ChatStreamEvent,
  ConnectionTest,
  EmbedRequest,
  EmbedResponse,
  ProviderConfig,
  ToolCall,
} from "../types";
import { ProviderError } from "./errors";
import { readVectors } from "./vectors";
import {
  chatStreamBudget,
  EMBED_TIMEOUT_MS,
  joinUrl,
  requestJson,
  streamLines,
  TEST_TIMEOUT_MS,
  type StreamBudget,
} from "./http";

/**
 * A completion, streamed.
 *
 * `/api/chat` answers with one JSON object per line rather than SSE, and each
 * line has the shape a buffered reply's `message` would: `content`, `thinking`
 * and `tool_calls` arrive in pieces, and the token counts ride on the final
 * line, where `done` is true.
 */
export async function* ollamaChatStream(
  config: ProviderConfig,
  request: ChatRequest,
  fetchImpl: typeof fetch = fetch,
  budget: StreamBudget = chatStreamBudget(),
): AsyncGenerator<ChatStreamEvent> {
  const calls: ToolCall[] = [];
  let sawContent = false;
  let thought = false;

  for await (const line of streamLines(
    joinUrl(config.baseUrl, "/api/chat"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ollamaBody(request)),
    },
    fetchImpl,
    budget,
  )) {
    const record = asRecord(parseLine(line));
    const message = asRecord(record.message);

    if (typeof message.thinking === "string" && message.thinking) {
      thought = true;
      yield { type: "thinking", delta: message.thinking };
    }
    if (typeof message.content === "string" && message.content) {
      sawContent = true;
      yield { type: "text", delta: message.content };
    }
    for (const call of readOllamaToolCalls(message.tool_calls, calls.length)) {
      calls.push(call);
    }

    if (record.done === true) {
      if (calls.length > 0) yield { type: "tool_calls", calls };
      if (!sawContent && calls.length === 0) {
        throw new ProviderError(emptyCompletionReason(record, thought));
      }
      yield {
        type: "usage",
        inputTokens: numberOrUndefined(record.prompt_eval_count),
        outputTokens: numberOrUndefined(record.eval_count),
      };
    }
  }
}

function ollamaBody(request: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: serialiseOllamaMessages(request),
    stream: true,
    options: {
      temperature: request.temperature,
      num_predict: request.maxTokens,
    },
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
  }
  /*
   * `format` takes either the string "json" or a JSON Schema, and the
   * difference is the difference between valid JSON and *usable* JSON: given
   * only "json", a vision model reading a page it found hard answered with an
   * object whose keys were its own invention, which parsed without error into
   * an empty transcript and was filed as a success. A schema is compiled into
   * the sampler's grammar, so the keys cannot drift.
   */
  if (request.jsonSchema) body.format = request.jsonSchema;
  else if (request.json) body.format = "json";
  /*
   * `think: false` needs no capability check: Ollama only demands the thinking
   * capability when the value is true, so switching reasoning *off* is accepted
   * by every model, including ones that never had it. `think: true` is the
   * asymmetric one -- it is a 400 on a model without the switch -- so a caller
   * that starts asking for reasoning has to check first.
   */
  if (request.think !== undefined) body.think = request.think;
  return body;
}

/** A malformed line is dropped rather than thrown on: the stream carries on. */
function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return {};
  }
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
function emptyCompletionReason(record: Record<string, unknown>, thought: boolean): string {
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
    if (message.role === "assistant" && message.toolCalls?.length) {
      out.tool_calls = message.toolCalls.map((call, callIndex) => ({
        type: "function",
        function: { index: callIndex, name: call.name, arguments: call.arguments },
      }));
    }
    if (message.role === "tool") out.tool_name = message.toolName;
    if (index === lastUser && request.images?.length) {
      out.images = request.images.map((image) => image.bytes.toString("base64"));
    }
    return out;
  });
}

/**
 * Ollama issues no id of its own, so one is minted from the call's position.
 * `offset` is how many calls this turn has already collected, which is what
 * keeps ids unique when the calls arrive over several streamed lines.
 */
function readOllamaToolCalls(value: unknown, offset: number): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    const fn = asRecord(asRecord(entry).function);
    if (typeof fn.name !== "string" || !fn.name) return [];
    let args: unknown = fn.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = null;
      }
    }
    return [{ id: `ollama_call_${offset + index}`, name: fn.name, arguments: args }];
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
