import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "./providers/errors";
import { ollamaChat, ollamaTest } from "./providers/ollama";
import { openaiChat } from "./providers/openai";
import { anthropicChat } from "./providers/anthropic";
import { providerChat, providerTest } from "./providers";
import type { ChatRequest, ProviderConfig } from "./types";

const chat: ChatRequest = {
  model: "test-model",
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: "secret dream text" },
  ],
  maxTokens: 128,
  temperature: 0.2,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Ollama adapter", () => {
  const config: ProviderConfig = {
    id: "ollama",
    kind: "ollama",
    name: "Ollama",
    baseUrl: "http://127.0.0.1:11434",
    enabled: true,
  };

  it("posts to /api/chat with streaming off", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://127.0.0.1:11434/api/chat");
      const body = JSON.parse(String(init?.body));
      expect(body.stream).toBe(false);
      expect(body.model).toBe("test-model");
      expect(body.format).toBeUndefined();
      return jsonResponse({
        message: { content: "a reading" },
        prompt_eval_count: 10,
        eval_count: 4,
      });
    });

    const result = await ollamaChat(config, chat, fetchImpl as unknown as typeof fetch);
    expect(result.text).toBe("a reading");
    expect(result.inputTokens).toBe(10);
  });

  it("names the real cause when a reasoning model runs out of budget", async () => {
    // Thinking is charged to the same budget as the answer, so a large prompt
    // can end with nothing in `content`. "Empty completion" would send the
    // operator to look at the connection instead of at the budget.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        message: { content: "", thinking: "a long private chain of reasoning" },
        done_reason: "length",
      }),
    );
    await expect(
      ollamaChat(config, chat, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/whole token budget/);
  });

  it("does not quote the reasoning, which is derived from the dream", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        message: { content: "", thinking: "secret dream text, reconsidered" },
        done_reason: "length",
      }),
    );
    await expect(
      ollamaChat(config, chat, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("secret dream text"),
      }),
    );
  });

  it("asks for JSON when extraction needs it", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.format).toBe("json");
      return jsonResponse({ message: { content: "{}" } });
    });
    await ollamaChat(config, { ...chat, json: true }, fetchImpl as unknown as typeof fetch);
  });

  it("switches reasoning off when the caller asks, and stays quiet otherwise", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ message: { content: "{}" } });
    });
    await ollamaChat(config, { ...chat, think: false }, fetchImpl as unknown as typeof fetch);
    await ollamaChat(config, chat, fetchImpl as unknown as typeof fetch);
    expect(bodies[0]?.think).toBe(false);
    // Unset means the model's own default, which is not ours to overrule.
    expect(bodies[1]).not.toHaveProperty("think");
  });

  it("sends a JSON schema as the format, in place of bare json mode", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ message: { content: "{}" } });
    });
    const schema = { type: "object", required: ["body"] };
    await ollamaChat(
      config,
      { ...chat, json: true, jsonSchema: schema },
      fetchImpl as unknown as typeof fetch,
    );
    await ollamaChat(config, { ...chat, json: true }, fetchImpl as unknown as typeof fetch);
    expect(bodies[0]?.format).toEqual(schema);
    expect(bodies[1]?.format).toBe("json");
  });

  it("attaches images to the last user message as raw base64", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const user = body.messages.find((message: { role: string }) => message.role === "user");
      expect(user.images).toEqual([Buffer.from("page").toString("base64")]);
      expect(user.content).toBe("secret dream text");
      return jsonResponse({ message: { content: "{}" } });
    });
    await ollamaChat(
      config,
      {
        ...chat,
        images: [{ mimeType: "image/jpeg", bytes: Buffer.from("page") }],
      },
      fetchImpl as unknown as typeof fetch,
    );
  });

  it("lists models from /api/tags without sending a prompt", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("http://127.0.0.1:11434/api/tags");
      return jsonResponse({ models: [{ name: "llama3.2:latest" }] });
    });
    const result = await ollamaTest(config, fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(["llama3.2:latest"]);
  });

  it("round-trips native tool calls and results", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (bodies.length === 1) {
        return jsonResponse({
          message: {
            content: "",
            tool_calls: [{ function: { name: "read_dreams", arguments: { ids: ["one"] } } }],
          },
        });
      }
      return jsonResponse({ message: { content: "Grounded answer" } });
    });
    const tools = [{ name: "read_dreams", description: "Read dreams", parameters: { type: "object" } }];
    const first = await ollamaChat(config, { ...chat, tools }, fetchImpl as unknown as typeof fetch);
    expect(first.toolCalls).toEqual([
      { id: "ollama_call_0", name: "read_dreams", arguments: { ids: ["one"] } },
    ]);
    await ollamaChat(config, {
      ...chat,
      tools,
      messages: [
        ...chat.messages,
        { role: "assistant", content: "", toolCalls: first.toolCalls },
        { role: "tool", content: "[]", toolCallId: "ollama_call_0", toolName: "read_dreams" },
      ],
    }, fetchImpl as unknown as typeof fetch);
    expect(bodies[0]?.tools).toEqual(expect.any(Array));
    expect((bodies[1]?.messages as Array<Record<string, unknown>>).at(-1)).toMatchObject({
      role: "tool",
      tool_name: "read_dreams",
      content: "[]",
    });
  });
});

describe("OpenAI-compatible adapter", () => {
  const config: ProviderConfig = {
    id: "openai",
    kind: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-secret",
    enabled: true,
  };

  it("sends the bearer token and does not put the prompt in an error", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.openai.com/v1/chat/completions");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer sk-secret");
      return new Response("prompt was: secret dream text", { status: 401 });
    });

    await expect(
      openaiChat(config, chat, fetchImpl as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(ProviderError);

    try {
      await openaiChat(config, chat, fetchImpl as unknown as typeof fetch);
    } catch (error) {
      expect((error as Error).message).toBe("The provider returned HTTP 401");
      expect((error as Error).message).not.toContain("secret");
      expect((error as Error).message).not.toContain("sk-secret");
    }
  });

  it("reads a tool call when a completion has no text", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tool_choice).toBe("auto");
      expect(body.tools[0].function.name).toBe("get_journal_overview");
      return jsonResponse({
        choices: [{ message: {
          content: null,
          tool_calls: [{
            id: "call_abc",
            type: "function",
            function: { name: "get_journal_overview", arguments: "{}" },
          }],
        } }],
      });
    });
    const result = await openaiChat(config, {
      ...chat,
      tools: [{ name: "get_journal_overview", description: "Overview", parameters: { type: "object" } }],
    }, fetchImpl as unknown as typeof fetch);
    expect(result.toolCalls).toEqual([
      { id: "call_abc", name: "get_journal_overview", arguments: {} },
    ]);
  });
});

describe("Anthropic adapter", () => {
  const config: ProviderConfig = {
    id: "anthropic",
    kind: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-ant-secret",
    enabled: true,
  };

  it("lifts the system prompt out of the message list", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("sk-ant-secret");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      const body = JSON.parse(String(init?.body));
      expect(body.system).toBe("Be brief.");
      expect(body.messages).toEqual([{ role: "user", content: "secret dream text" }]);
      return jsonResponse({
        content: [{ type: "text", text: "a reading" }],
        usage: { input_tokens: 8, output_tokens: 3 },
      });
    });

    const result = await anthropicChat(config, chat, fetchImpl as unknown as typeof fetch);
    expect(result.text).toBe("a reading");
    expect(result.outputTokens).toBe(3);
  });

  it("uses Anthropic tool_use and tool_result content blocks", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (bodies.length === 1) {
        return jsonResponse({
          content: [{ type: "tool_use", id: "toolu_1", name: "list_tags", input: {} }],
          usage: {},
        });
      }
      return jsonResponse({ content: [{ type: "text", text: "Tags considered" }], usage: {} });
    });
    const tools = [{ name: "list_tags", description: "List tags", parameters: { type: "object" } }];
    const first = await anthropicChat(config, { ...chat, tools }, fetchImpl as unknown as typeof fetch);
    expect(first.toolCalls).toEqual([{ id: "toolu_1", name: "list_tags", arguments: {} }]);
    await anthropicChat(config, {
      ...chat,
      tools,
      messages: [
        ...chat.messages,
        { role: "assistant", content: "", toolCalls: first.toolCalls },
        { role: "tool", content: "[]", toolCallId: "toolu_1", toolName: "list_tags" },
      ],
    }, fetchImpl as unknown as typeof fetch);
    expect((bodies[0]?.tools as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: "list_tags",
      input_schema: { type: "object" },
    });
    expect((bodies[1]?.messages as Array<Record<string, unknown>>).at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "[]" }],
    });
  });
});

describe("connection test failures", () => {
  it("returns ok: false rather than throwing, with no URL in the message if the host is unparseable", async () => {
    const result = await providerTest(
      {
        id: "ollama",
        kind: "ollama",
        name: "Ollama",
        baseUrl: "http://127.0.0.1:9",
        enabled: true,
      },
      async () => {
        throw new Error("fetch failed: http://127.0.0.1:9/api/tags with key=oops");
      },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Could not reach 127.0.0.1:9");
    expect(result.message).not.toContain("oops");
    expect(result.message).not.toContain("/api/tags");
  });
});

describe("a text-only model sent an image", () => {
  const config: ProviderConfig = {
    id: "ollama",
    kind: "ollama",
    name: "Ollama",
    baseUrl: "http://127.0.0.1:11434",
    enabled: true,
  };

  const withImage: ChatRequest = {
    ...chat,
    model: "llama3.2:latest",
    images: [{ mimeType: "image/jpeg", bytes: Buffer.from("page") }],
  };

  it("names the model and points at Settings instead of reporting HTTP 400", async () => {
    // What Ollama actually answers a text-only model with. The body says why,
    // but the body is the one thing the HTTP layer will not read -- providers
    // echo the prompt inside their errors -- so the reason has to be inferred
    // from the fact that we attached an image at all.
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: "Multimodal data provided, but model does not support multimodal requests." },
        400,
      ),
    );

    await expect(
      providerChat(config, withImage, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/llama3\.2:latest cannot read images.*Settings/s);
  });

  it("never quotes the provider's error body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "secret dream text" }, 400));

    const error = await providerChat(
      config,
      withImage,
      fetchImpl as unknown as typeof fetch,
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).not.toContain("secret dream text");
  });

  it("leaves a 400 on a text-only request alone", async () => {
    // A 400 with no image attached means something else entirely; rewriting it
    // as a vision problem would send the operator to the wrong screen.
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "bad request" }, 400));

    await expect(
      providerChat(config, chat, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(ProviderError);
    await expect(
      providerChat(config, chat, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow("The provider returned HTTP 400");
  });

  it("leaves a connection failure alone even when an image was attached", async () => {
    // The photograph is not why the host is down.
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(
      providerChat(config, withImage, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow("Could not reach 127.0.0.1:11434");
  });
});

describe("a model slower than its budget", () => {
  const config: ProviderConfig = {
    id: "ollama",
    kind: "ollama",
    name: "Ollama",
    baseUrl: "http://127.0.0.1:11434",
    enabled: true,
  };

  it("says the host did not finish, and names the budget", async () => {
    // The socket was accepted; the model was just slow. Reporting this as
    // "Timed out waiting for 127.0.0.1:11434" sends the operator to check the
    // connection rather than the model they assigned.
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    });

    const error = await ollamaChat(
      config,
      chat,
      fetchImpl as unknown as typeof fetch,
      180_000,
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect((error as Error).message).toBe(
      "127.0.0.1:11434 did not finish answering after 180s",
    );
  });
});
