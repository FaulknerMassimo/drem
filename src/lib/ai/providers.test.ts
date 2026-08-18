import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "./providers/errors";
import { ollamaChat, ollamaTest } from "./providers/ollama";
import { openaiChat } from "./providers/openai";
import { anthropicChat } from "./providers/anthropic";
import { providerTest } from "./providers";
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

  it("asks for JSON when extraction needs it", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.format).toBe("json");
      return jsonResponse({ message: { content: "{}" } });
    });
    await ollamaChat(config, { ...chat, json: true }, fetchImpl as unknown as typeof fetch);
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
