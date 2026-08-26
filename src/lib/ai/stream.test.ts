import { describe, expect, it, vi } from "vitest";
import { ProviderError, StreamStoppedError } from "./providers/errors";
import { streamLines, type StreamBudget } from "./providers/http";
import { anthropicChatStream } from "./providers/anthropic";
import { ollamaChatStream } from "./providers/ollama";
import { openaiChatStream } from "./providers/openai";
import type { ChatRequest, ChatStreamEvent, ProviderConfig } from "./types";

const chat: ChatRequest = {
  model: "test-model",
  messages: [{ role: "user", content: "what recurs?" }],
  maxTokens: 128,
  temperature: 0.4,
};

/** Chunk boundaries are the point: they rarely line up with lines on the wire. */
function streamed(chunks: string[], init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    init,
  );
}

async function collect(events: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const seen: ChatStreamEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

function text(events: ChatStreamEvent[]): string {
  return events
    .filter((event) => event.type === "text")
    .map((event) => event.delta)
    .join("");
}

describe("Ollama streaming", () => {
  const config: ProviderConfig = {
    id: "ollama",
    kind: "ollama",
    name: "Ollama",
    baseUrl: "http://127.0.0.1:11434",
    enabled: true,
  };

  it("reassembles a line that a chunk boundary cut in half", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://127.0.0.1:11434/api/chat");
      expect(JSON.parse(String(init?.body)).stream).toBe(true);
      return streamed([
        '{"message":{"content":"a cor',
        'ridor"}}\n{"message":{"content":" again"}}\n',
        '{"done":true,"prompt_eval_count":9,"eval_count":3}\n',
      ]);
    });

    const events = await collect(
      ollamaChatStream(config, chat, fetchImpl as unknown as typeof fetch),
    );
    expect(text(events)).toBe("a corridor again");
    expect(events.at(-1)).toEqual({ type: "usage", inputTokens: 9, outputTokens: 3 });
  });

  it("separates the model's working from its answer", async () => {
    const fetchImpl = vi.fn(async () =>
      streamed([
        '{"message":{"thinking":"they asked about "}}\n',
        '{"message":{"thinking":"corridors"}}\n',
        '{"message":{"content":"Corridors recur."}}\n{"done":true}\n',
      ]),
    );

    const events = await collect(
      ollamaChatStream(config, chat, fetchImpl as unknown as typeof fetch),
    );
    expect(events.filter((event) => event.type === "thinking").map((event) => event.delta)).toEqual([
      "they asked about ",
      "corridors",
    ]);
    expect(text(events)).toBe("Corridors recur.");
  });

  it("gives every tool call an id of its own across lines", async () => {
    const fetchImpl = vi.fn(async () =>
      streamed([
        '{"message":{"tool_calls":[{"function":{"name":"list_dreams","arguments":{"page":1}}}]}}\n',
        '{"message":{"tool_calls":[{"function":{"name":"list_tags","arguments":{}}}]}}\n',
        '{"done":true}\n',
      ]),
    );

    const events = await collect(
      ollamaChatStream(config, chat, fetchImpl as unknown as typeof fetch),
    );
    const calls = events.find((event) => event.type === "tool_calls");
    expect(calls?.type === "tool_calls" && calls.calls).toEqual([
      { id: "ollama_call_0", name: "list_dreams", arguments: { page: 1 } },
      { id: "ollama_call_1", name: "list_tags", arguments: {} },
    ]);
  });

  it("names the budget rather than the connection when a reasoning model runs dry", async () => {
    const fetchImpl = vi.fn(async () =>
      streamed(['{"message":{"thinking":"…"}}\n{"done":true,"done_reason":"length"}\n']),
    );

    await expect(
      collect(ollamaChatStream(config, chat, fetchImpl as unknown as typeof fetch)),
    ).rejects.toThrow(/whole token budget/u);
  });
});

describe("OpenAI-compatible streaming", () => {
  const config: ProviderConfig = {
    id: "openai",
    kind: "openai",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "sk-test",
    enabled: true,
  };

  it("reads deltas, reasoning and usage out of the event frames", async () => {
    const fetchImpl = vi.fn(async () =>
      streamed([
        'data: {"choices":[{"delta":{"reasoning_content":"weighing it"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Two "}}]}\n\ndata: {"choices":[{"delta":{"content":"nights."}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":6}}\n\ndata: [DONE]\n\n',
      ]),
    );

    const events = await collect(
      openaiChatStream(config, chat, fetchImpl as unknown as typeof fetch),
    );
    expect(text(events)).toBe("Two nights.");
    expect(events[0]).toEqual({ type: "thinking", delta: "weighing it" });
    expect(events.at(-1)).toEqual({ type: "usage", inputTokens: 40, outputTokens: 6 });
  });

  it("assembles a tool call whose arguments arrived as fragments", async () => {
    const fetchImpl = vi.fn(async () =>
      streamed([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read_dreams","arguments":"{\\"ids\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"[\\"one\\"]}"}}]}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    const events = await collect(
      openaiChatStream(config, chat, fetchImpl as unknown as typeof fetch),
    );
    const calls = events.find((event) => event.type === "tool_calls");
    expect(calls?.type === "tool_calls" && calls.calls).toEqual([
      { id: "call_a", name: "read_dreams", arguments: { ids: ["one"] } },
    ]);
  });

  it("drops the usage flag and retries when a server rejects it", async () => {
    // "OpenAI-compatible" is a long tail of servers that 400 on a field they do
    // not implement, and a token count is not worth losing the conversation to.
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) return new Response("nope", { status: 400 });
      return streamed(['data: {"choices":[{"delta":{"content":"fine"}}]}\n\ndata: [DONE]\n\n']);
    });

    const events = await collect(
      openaiChatStream(config, chat, fetchImpl as unknown as typeof fetch),
    );
    expect(text(events)).toBe("fine");
    expect(JSON.parse(bodies[0]!).stream_options).toEqual({ include_usage: true });
    expect(JSON.parse(bodies[1]!).stream_options).toBeUndefined();
    expect(JSON.parse(bodies[1]!).stream).toBe(true);
  });
});

describe("Anthropic streaming", () => {
  const config: ProviderConfig = {
    id: "anthropic",
    kind: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-ant",
    enabled: true,
  };

  it("follows numbered blocks for text, thinking and a tool call", async () => {
    const fetchImpl = vi.fn(async () =>
      streamed([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":31}}}\n\n',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"checking"}}\n\n',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_night"}}\n\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"date\\":"}}\n\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"2026-08-01\\"}"}}\n\n',
        'data: {"type":"content_block_stop","index":1}\n\n',
        'data: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"You flew."}}\n\n',
        'data: {"type":"message_delta","usage":{"output_tokens":11}}\n\ndata: {"type":"message_stop"}\n\n',
      ]),
    );

    const events = await collect(
      anthropicChatStream(config, chat, fetchImpl as unknown as typeof fetch),
    );
    expect(events[0]).toEqual({ type: "thinking", delta: "checking" });
    expect(text(events)).toBe("You flew.");
    const calls = events.find((event) => event.type === "tool_calls");
    expect(calls?.type === "tool_calls" && calls.calls).toEqual([
      { id: "toolu_1", name: "read_night", arguments: { date: "2026-08-01" } },
    ]);
    expect(events.at(-1)).toEqual({ type: "usage", inputTokens: 31, outputTokens: 11 });
  });

  it("reports a mid-stream error by type, never by its message", async () => {
    // Provider error text on this API quotes the request back at you.
    const fetchImpl = vi.fn(async () =>
      streamed([
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I dreamt of"}}\n\n',
        'data: {"type":"error","error":{"message":"overloaded: I dreamt of the cathedral"}}\n\n',
      ]),
    );

    await expect(
      collect(anthropicChatStream(config, chat, fetchImpl as unknown as typeof fetch)),
    ).rejects.toThrow(/^Anthropic reported an error part-way through the answer$/u);
  });
});

describe("stream budgets", () => {
  const budget = (over: Partial<StreamBudget> = {}): StreamBudget => ({
    firstByteMs: 30,
    idleMs: 30,
    totalMs: 5_000,
    ...over,
  });

  function silence(): Response {
    return new Response(new ReadableStream<Uint8Array>({ start() {} }));
  }

  async function drain(events: AsyncGenerator<string>): Promise<string[]> {
    const lines: string[] = [];
    for await (const line of events) lines.push(line);
    return lines;
  }

  it("names the host and the budget when a model never starts", async () => {
    const fetchImpl = vi.fn(async () => silence());
    await expect(
      drain(
        streamLines(
          "http://127.0.0.1:11434/api/chat",
          {},
          fetchImpl as unknown as typeof fetch,
          budget(),
        ),
      ),
    ).rejects.toThrow(/127\.0\.0\.1:11434 did not start answering within 0s/u);
  });

  it("goes on waiting while tokens are still arriving", async () => {
    // The point of the whole exercise: a slow answer is not a failed one, and a
    // total ceiling cannot tell those apart.
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              for (let line = 0; line < 6; line += 1) {
                await new Promise((resolve) => setTimeout(resolve, 20));
                controller.enqueue(encoder.encode(`line ${line}\n`));
              }
              controller.close();
            },
          }),
        ),
    );

    const lines = await drain(
      streamLines("http://x/api/chat", {}, fetchImpl as unknown as typeof fetch, budget()),
    );
    expect(lines).toHaveLength(6);
  });

  it("treats the reader's own stop as a stop, not as a provider failure", async () => {
    const stop = new AbortController();
    const fetchImpl = vi.fn(async () => silence());
    setTimeout(() => stop.abort(), 5);

    await expect(
      drain(
        streamLines(
          "http://x/api/chat",
          {},
          fetchImpl as unknown as typeof fetch,
          budget({ firstByteMs: 5_000, signal: stop.signal }),
        ),
      ),
    ).rejects.toBeInstanceOf(StreamStoppedError);
  });

  it("never reads an error body, which is where prompts get echoed", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("model refused: I dreamt of the cathedral", { status: 429 }),
    );

    const failure = drain(
      streamLines("http://x/api/chat", {}, fetchImpl as unknown as typeof fetch, budget()),
    );
    await expect(failure).rejects.toThrow(/^The provider returned HTTP 429$/u);
    await expect(failure).rejects.toBeInstanceOf(ProviderError);
  });
});
