import { describe, expect, it } from "vitest";
import {
  defaultAiConfig,
  mergeProviderSecrets,
  parseAiConfig,
  publicAiConfig,
  resolveRoles,
} from "./schema";

describe("AI config parsing", () => {
  it("defaults to a local Ollama provider with no roles assigned", () => {
    const config = defaultAiConfig("http://127.0.0.1:11434");
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0]).toMatchObject({ kind: "ollama", enabled: true });
    expect(config.roles.extraction).toBeNull();
  });

  it("fills newer roles when an older config blob omits them", () => {
    const parsed = parseAiConfig({
      providers: [{ id: "a", kind: "ollama", name: "Ollama", baseUrl: "", enabled: true }],
      roles: { extraction: null, lucidity: null, symbolic: null, report: null },
    });
    expect(parsed.roles.ocr).toBeNull();
    expect(parsed.roles.split).toBeNull();
    expect(parsed.roles.chat).toBeNull();
  });

  it("fills in a missing base URL from the kind default", () => {
    const parsed = parseAiConfig({
      providers: [{ id: "a", kind: "anthropic", name: "Claude", baseUrl: "", enabled: true }],
      roles: { extraction: null, lucidity: null, symbolic: null, report: null },
    });
    expect(parsed.providers[0]?.baseUrl).toBe("https://api.anthropic.com");
  });

  it("drops a blank API key so 'not set' stays distinct from whitespace", () => {
    const parsed = parseAiConfig({
      providers: [
        {
          id: "o",
          kind: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "   ",
          enabled: true,
        },
      ],
      roles: { extraction: null, lucidity: null, symbolic: null, report: null },
    });
    expect(parsed.providers[0]?.apiKey).toBeUndefined();
  });

  it("keeps a stored API key when the form submits an empty field", () => {
    const stored = parseAiConfig({
      providers: [
        {
          id: "o",
          kind: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-secret",
          enabled: true,
        },
      ],
      roles: { extraction: null, lucidity: null, symbolic: null, report: null },
    });
    const incoming = parseAiConfig({
      providers: [
        {
          id: "o",
          kind: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          enabled: true,
        },
      ],
      roles: stored.roles,
    });
    expect(mergeProviderSecrets(incoming, stored).providers[0]?.apiKey).toBe("sk-secret");
  });

  it("lets a newly typed key replace the stored one", () => {
    const stored = defaultAiConfig();
    stored.providers[0] = {
      ...stored.providers[0]!,
      kind: "openai",
      apiKey: "old",
    };
    const incoming = defaultAiConfig();
    incoming.providers[0] = { ...incoming.providers[0]!, kind: "openai", apiKey: "new" };
    expect(mergeProviderSecrets(incoming, stored).providers[0]?.apiKey).toBe("new");
  });

  it("strips the API key from the public view", () => {
    const config = defaultAiConfig();
    config.providers[0] = { ...config.providers[0]!, apiKey: "sk-secret" };
    const published = publicAiConfig(config);
    expect(published.providers[0]?.hasApiKey).toBe(true);
    expect("apiKey" in (published.providers[0] ?? {})).toBe(false);
  });

  it("clears a role that points at a missing or disabled provider", () => {
    const config = defaultAiConfig();
    config.roles.extraction = { providerId: "gone", model: "x" };
    config.roles.lucidity = { providerId: "ollama", model: "llama3.2" };
    config.providers[0]!.enabled = false;
    const roles = resolveRoles(config);
    expect(roles.extraction).toBeNull();
    expect(roles.lucidity).toBeNull();
  });

  it("refuses an unknown provider kind", () => {
    expect(() =>
      parseAiConfig({
        providers: [{ id: "x", kind: "whatever", name: "X", baseUrl: "", enabled: true }],
        roles: { extraction: null, lucidity: null, symbolic: null, report: null },
      }),
    ).toThrow();
  });
});
