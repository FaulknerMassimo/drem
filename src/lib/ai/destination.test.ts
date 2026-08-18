import { describe, expect, it } from "vitest";
import { destinationFor, destinationsFor, hostOf, leavesMachine } from "./destination";
import { defaultAiConfig } from "./schema";
import type { AiConfig } from "./types";

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  const base = defaultAiConfig("http://127.0.0.1:11434");
  return {
    ...base,
    ...overrides,
    providers: overrides.providers ?? base.providers,
    roles: overrides.roles ?? base.roles,
  };
}

describe("destination of a model call", () => {
  it("is unconfigured until a role is assigned", () => {
    const destination = destinationFor(config(), "extraction");
    expect(destination.configured).toBe(false);
    expect(destination.label).toBe("No model assigned");
  });

  it("treats Ollama on loopback as staying on this machine", () => {
    const destination = destinationFor(
      config({
        roles: {
          extraction: { providerId: "ollama", model: "llama3.2" },
          lucidity: null,
          symbolic: null,
          report: null,
        },
      }),
      "extraction",
    );
    expect(destination.configured).toBe(true);
    expect(destination.leavesMachine).toBe(false);
    expect(destination.host).toBe("127.0.0.1");
    expect(destination.label).toContain("stays on this machine");
    expect(destination.label).toContain("llama3.2");
  });

  it("treats host.docker.internal as this machine", () => {
    expect(leavesMachine("ollama", "http://host.docker.internal:11434")).toBe(false);
  });

  it("treats an OpenAI-compatible endpoint on localhost as local", () => {
    // LM Studio, vLLM, llama.cpp — same API, still this machine.
    expect(leavesMachine("openai", "http://127.0.0.1:1234/v1")).toBe(false);
  });

  it("treats a remote OpenAI-compatible host as leaving the machine", () => {
    expect(leavesMachine("openai", "https://openrouter.ai/api/v1")).toBe(true);
    expect(hostOf("https://api.openai.com/v1")).toBe("api.openai.com");
  });

  it("names Anthropic's host rather than hiding behind the kind", () => {
    const destination = destinationFor(
      config({
        providers: [
          {
            id: "anthropic",
            kind: "anthropic",
            name: "Anthropic",
            baseUrl: "https://api.anthropic.com",
            enabled: true,
          },
        ],
        roles: {
          extraction: null,
          lucidity: { providerId: "anthropic", model: "claude-sonnet-4-0" },
          symbolic: null,
          report: null,
        },
      }),
      "lucidity",
    );
    expect(destination.leavesMachine).toBe(true);
    expect(destination.host).toBe("api.anthropic.com");
    expect(destination.label).toContain("leaves this machine");
  });

  it("treats a disabled provider as unconfigured", () => {
    const destination = destinationFor(
      config({
        providers: [
          {
            id: "ollama",
            kind: "ollama",
            name: "Ollama",
            baseUrl: "http://127.0.0.1:11434",
            enabled: false,
          },
        ],
        roles: {
          extraction: { providerId: "ollama", model: "llama3.2" },
          lucidity: null,
          symbolic: null,
          report: null,
        },
      }),
      "extraction",
    );
    expect(destination.configured).toBe(false);
  });

  it("computes every role at once", () => {
    const all = destinationsFor(config());
    expect(all.extraction.configured).toBe(false);
    expect(all.report.role).toBe("report");
  });
});
