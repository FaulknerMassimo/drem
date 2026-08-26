import { describe, expect, it, vi } from "vitest";
import { cleanTitle, proposeConversationTitle } from "./conversation-title";
import { emptyRoles } from "./schema";
import type { AiConfig } from "./types";

const config: AiConfig = {
  providers: [
    {
      id: "ollama",
      kind: "ollama",
      name: "Ollama",
      baseUrl: "http://127.0.0.1:11434",
      enabled: true,
    },
  ],
  roles: { ...emptyRoles(), chat: { providerId: "ollama", model: "qwen3:8b" } },
};

const exchange = {
  question: "What do you make of the dream where I was back in the flooded school?",
  answer: "The school and the water have both turned up several times this month.",
};

describe("what a model's reply leaves usable", () => {
  it("takes a bare title as it is", () => {
    expect(cleanTitle("Recurring flooded school")).toBe("Recurring flooded school");
  });

  it("drops the preamble models put in front of it", () => {
    expect(cleanTitle('Sure! Here is a title:\n\n"Flooded school, again"')).toBe(
      "Flooded school, again",
    );
  });

  it("drops working that arrived in the answer channel", () => {
    expect(cleanTitle("<think>they asked about a school</think>\nThe flooded school")).toBe(
      "The flooded school",
    );
  });

  it("strips the decoration and the full stop", () => {
    expect(cleanTitle("**Water and school corridors.**")).toBe("Water and school corridors");
    expect(cleanTitle("Title: Flooded classrooms")).toBe("Flooded classrooms");
  });

  it("refuses a sentence rather than cutting one down", () => {
    // A trimmed sentence is exactly the kind of title this replaces, so the
    // fallback is the better answer here.
    expect(
      cleanTitle(
        "This conversation is about a recurring dream of a flooded school and what the water might mean to the dreamer.",
      ),
    ).toBeNull();
  });

  it("refuses an empty reply", () => {
    expect(cleanTitle("   \n  ")).toBeNull();
  });
});

describe("asking for a title", () => {
  it("spends a small budget with reasoning off, and never streams", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ message: { content: "The flooded school" } }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const named = await proposeConversationTitle(config, null, exchange);
    expect(named?.title).toBe("The flooded school");
    expect(named?.destination.model).toBe("qwen3:8b");

    const sent = bodies[0]!;
    expect(sent.stream).toBe(false);
    expect(sent.think).toBe(false);
    expect((sent.options as { num_predict: number }).num_predict).toBeLessThanOrEqual(32);
    vi.unstubAllGlobals();
  });

  it("sends the model chosen for the turn, not the one in the config", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ message: { content: "Water again" } }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const named = await proposeConversationTitle(
      config,
      { providerId: "ollama", model: "llama3.2" },
      exchange,
    );
    expect(named?.destination.model).toBe("llama3.2");
    vi.unstubAllGlobals();
  });

  it("comes back with nothing when the model wrote a sentence instead", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            message: {
              content:
                "This conversation covers a recurring dream about a flooded school building and what the water might represent.",
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );

    expect(await proposeConversationTitle(config, null, exchange)).toBeNull();
    vi.unstubAllGlobals();
  });
});
