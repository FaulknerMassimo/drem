import { describe, expect, it, vi } from "vitest";
import { embedTexts, EMBED_BATCH_SIZE, normalise } from "./embed";
import { anthropicEmbed } from "./providers/anthropic";
import { ollamaEmbed } from "./providers/ollama";
import { openaiEmbed } from "./providers/openai";
import { emptyRoles } from "./schema";
import type { AiConfig, ProviderConfig } from "./types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ollama: ProviderConfig = {
  id: "ollama",
  kind: "ollama",
  name: "Ollama",
  baseUrl: "http://127.0.0.1:11434",
  enabled: true,
};

const openai: ProviderConfig = {
  id: "openai",
  kind: "openai",
  name: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-secret",
  enabled: true,
};

describe("Ollama embeddings", () => {
  it("posts the whole batch to /api/embed", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://127.0.0.1:11434/api/embed");
      const body = JSON.parse(String(init?.body));
      expect(body.input).toEqual(["one", "two"]);
      return jsonResponse({ embeddings: [[1, 0], [0, 1]], prompt_eval_count: 7 });
    });

    const result = await ollamaEmbed(
      ollama,
      { model: "embeddinggemma", inputs: ["one", "two"] },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.vectors).toEqual([[1, 0], [0, 1]]);
    expect(result.inputTokens).toBe(7);
  });

  it("refuses a reply with fewer vectors than inputs", async () => {
    // Zipping a short reply back onto the dreams by position would weld one
    // entry's meaning to another entry's row, and nothing downstream could tell.
    const fetchImpl = vi.fn(async () => jsonResponse({ embeddings: [[1, 0]] }));
    await expect(
      ollamaEmbed(
        ollama,
        { model: "embeddinggemma", inputs: ["one", "two"] },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/1 embeddings for 2 inputs/);
  });

  it("refuses a vector with a non-numeric component", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ embeddings: [[1, null]] }));
    await expect(
      ollamaEmbed(
        ollama,
        { model: "embeddinggemma", inputs: ["one"] },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/malformed embedding/);
  });
});

describe("OpenAI-compatible embeddings", () => {
  it("posts to /embeddings with the key attached", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.openai.com/v1/embeddings");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer sk-secret");
      return jsonResponse({
        data: [{ index: 0, embedding: [1, 0] }],
        usage: { prompt_tokens: 3 },
      });
    });

    const result = await openaiEmbed(
      openai,
      { model: "text-embedding-3-small", inputs: ["one"] },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.vectors).toEqual([[1, 0]]);
    expect(result.inputTokens).toBe(3);
  });

  it("re-sorts the reply by its declared index rather than trusting array order", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      }),
    );

    const result = await openaiEmbed(
      openai,
      { model: "text-embedding-3-small", inputs: ["first", "second"] },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.vectors).toEqual([[1, 0], [0, 1]]);
  });

  it("refuses a reply that indexes the same slot twice", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 0, embedding: [0, 1] },
        ],
      }),
    );
    await expect(
      openaiEmbed(
        openai,
        { model: "text-embedding-3-small", inputs: ["first", "second"] },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/out of order/);
  });
});

describe("Anthropic embeddings", () => {
  it("fails loudly rather than falling back to another provider", async () => {
    // Silently using something else would send the journal to a destination the
    // user never assigned, which is the one thing the badge exists to prevent.
    await expect(anthropicEmbed()).rejects.toThrow(/does not offer an embeddings API/);
  });
});

describe("embedTexts", () => {
  function config(model = "embeddinggemma"): AiConfig {
    return {
      providers: [ollama],
      roles: { ...emptyRoles(), embedding: { providerId: "ollama", model } },
    };
  }

  it("refuses to guess a model when the role is unassigned", async () => {
    await expect(
      embedTexts({ providers: [ollama], roles: emptyRoles() }, ["anything"]),
    ).rejects.toThrow(/No model is assigned for embedding/);
  });

  it("makes no request at all for an empty batch", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    const result = await embedTexts(config(), []);
    expect(result.vectors).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("splits a backfill into batches and keeps the order across them", async () => {
    const inputs = Array.from({ length: EMBED_BATCH_SIZE + 3 }, (_, i) => `entry ${i}`);
    let seen = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const embeddings = body.input.map((_: string, i: number) => [seen + i, 0]);
      seen += body.input.length;
      return jsonResponse({ embeddings });
    });
    vi.stubGlobal("fetch", fetchImpl);

    const result = await embedTexts(config(), inputs);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.vectors).toHaveLength(inputs.length);
    // Normalised, so every non-zero vector here is exactly [1, 0]; the first is
    // the zero vector and stays as it is.
    expect(result.vectors[1]).toEqual([1, 0]);
    vi.unstubAllGlobals();
  });

  it("normalises what it returns, so comparisons are a dot product", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ embeddings: [[3, 4]] }));
    vi.stubGlobal("fetch", fetchImpl);
    const result = await embedTexts(config(), ["one"]);
    expect(result.vectors[0]).toEqual([0.6, 0.8]);
    vi.unstubAllGlobals();
  });

  it("reports the destination so the caller can record where the text went", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ embeddings: [[1, 0]] }));
    vi.stubGlobal("fetch", fetchImpl);
    const result = await embedTexts(config("embeddinggemma:300m"), ["one"]);
    expect(result.model).toBe("embeddinggemma:300m");
    expect(result.destination.leavesMachine).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe("normalise", () => {
  it("scales to unit length", () => {
    expect(normalise([3, 4])).toEqual([0.6, 0.8]);
  });

  it("leaves a zero vector alone rather than dividing by zero", () => {
    expect(normalise([0, 0])).toEqual([0, 0]);
  });
});
