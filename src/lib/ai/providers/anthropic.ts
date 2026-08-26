/**
 * Anthropic Messages API adapter.
 *
 * The system prompt is a top-level field here, not a message, so it is split
 * out of the chat request rather than sent as `role: "system"`.
 *
 * Buffered and streamed calls share one request body, so a change to how a
 * request is built cannot apply to only one of them.
 */
import type {
  ChatImage,
  ChatMessage,
  ChatRequest,
  ChatStreamEvent,
  ConnectionTest,
  ProviderConfig,
  ToolCall,
} from "../types";
import { ProviderError } from "./errors";
import {
  chatStreamBudget,
  joinUrl,
  requestJson,
  sseData,
  streamLines,
  TEST_TIMEOUT_MS,
  type StreamBudget,
} from "./http";

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

/**
 * A completion, as Server-Sent Events.
 *
 * The Messages API streams *blocks* rather than a single delta channel: text,
 * reasoning and each tool call are separate numbered blocks, opened by a
 * `content_block_start`, filled by deltas, and closed. A tool call's arguments
 * arrive as `partial_json` fragments, which are only parseable once its block
 * closes — which is why tool calls are collected here and emitted whole.
 */
export async function* anthropicChatStream(
  config: ProviderConfig,
  request: ChatRequest,
  fetchImpl: typeof fetch = fetch,
  budget: StreamBudget = chatStreamBudget(),
): AsyncGenerator<ChatStreamEvent> {
  const blocks = new Map<number, { name: string; id: string; json: string }>();
  const calls: ToolCall[] = [];
  let sawText = false;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  for await (const line of streamLines(
    joinUrl(config.baseUrl, "/v1/messages"),
    {
      method: "POST",
      headers: anthropicHeaders(config),
      body: JSON.stringify(anthropicBody(request)),
    },
    fetchImpl,
    budget,
  )) {
    const event = asRecord(sseData(line));
    const index = typeof event.index === "number" ? event.index : -1;

    if (event.type === "message_start") {
      const usage = asRecord(asRecord(event.message).usage);
      inputTokens = numberOrUndefined(usage.input_tokens) ?? inputTokens;
      continue;
    }
    if (event.type === "content_block_start") {
      const block = asRecord(event.content_block);
      if (block.type === "tool_use" && typeof block.name === "string") {
        blocks.set(index, {
          name: block.name,
          id: typeof block.id === "string" ? block.id : `call_${index}`,
          json: "",
        });
      }
      continue;
    }
    if (event.type === "content_block_delta") {
      const delta = asRecord(event.delta);
      if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
        sawText = true;
        yield { type: "text", delta: delta.text };
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
        yield { type: "thinking", delta: delta.thinking };
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const block = blocks.get(index);
        if (block) block.json += delta.partial_json;
      }
      continue;
    }
    if (event.type === "content_block_stop") {
      const block = blocks.get(index);
      if (block) {
        blocks.delete(index);
        calls.push({ id: block.id, name: block.name, arguments: parseToolInput(block.json) });
      }
      continue;
    }
    if (event.type === "message_delta") {
      const usage = asRecord(event.usage);
      outputTokens = numberOrUndefined(usage.output_tokens) ?? outputTokens;
      continue;
    }
    /*
     * An `error` event carries a message from the provider, and provider
     * messages on this API quote the request back. It is reported by type
     * only, for the same reason `requestJson` never reads an error body.
     */
    if (event.type === "error") {
      throw new ProviderError("Anthropic reported an error part-way through the answer");
    }
  }

  if (calls.length > 0) yield { type: "tool_calls", calls };
  if (!sawText && calls.length === 0) {
    throw new ProviderError("Anthropic returned an empty completion");
  }
  yield { type: "usage", inputTokens, outputTokens };
}

function anthropicBody(request: ChatRequest): Record<string, unknown> {
  const { system, messages } = splitSystem(request.messages);
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens,
    temperature: request.temperature,
    messages: serialiseAnthropicMessages(messages, request.images),
  };
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }
  if (system) body.system = system;
  body.stream = true;
  return body;
}

/** An unparseable argument becomes null, which every tool then rejects. */
function parseToolInput(json: string): unknown {
  if (!json.trim()) return {};
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
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
  const serialised: unknown[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && message.toolCalls?.length) {
      serialised.push({
        role: "assistant",
        content: [
          ...(message.content ? [{ type: "text", text: message.content }] : []),
          ...message.toolCalls.map((call) => ({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.arguments,
          })),
        ],
      });
      continue;
    }
    if (message.role === "tool") {
      const results: unknown[] = [];
      let cursor = index;
      while (messages[cursor]?.role === "tool") {
        const result = messages[cursor]!;
        results.push({
          type: "tool_result",
          tool_use_id: result.toolCallId,
          content: result.content,
        });
        cursor += 1;
      }
      serialised.push({ role: "user", content: results });
      index = cursor - 1;
      continue;
    }
    if (index !== lastUser || !images?.length) {
      serialised.push({ role: message.role, content: message.content });
      continue;
    }
    serialised.push({
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
    });
  }
  return serialised;
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

function readAnthropicToolCalls(content: unknown): ToolCall[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const record = asRecord(block);
    if (record.type !== "tool_use" || typeof record.id !== "string" || typeof record.name !== "string") {
      return [];
    }
    return [{ id: record.id, name: record.name, arguments: record.input ?? {} }];
  });
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
