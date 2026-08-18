import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DestinationBadge } from "./destination-badge";
import type { Destination } from "@/lib/ai/types";

function destination(overrides: Partial<Destination>): Destination {
  return {
    role: "extraction",
    configured: true,
    leavesMachine: false,
    providerId: "ollama",
    providerName: "Ollama",
    providerKind: "ollama",
    model: "llama3.2",
    host: "127.0.0.1",
    label: "Ollama · llama3.2 · 127.0.0.1 — stays on this machine",
    ...overrides,
  };
}

describe("destination badge", () => {
  it("names the local host and that the dream stays", () => {
    const html = renderToStaticMarkup(
      <DestinationBadge destination={destination({})} />,
    );
    expect(html).toContain("127.0.0.1");
    expect(html).toContain("llama3.2");
    expect(html).toContain("stays on this machine");
  });

  it("is louder when the dream will leave the machine", () => {
    const html = renderToStaticMarkup(
      <DestinationBadge
        destination={destination({
          leavesMachine: true,
          providerName: "Anthropic",
          host: "api.anthropic.com",
          model: "claude-sonnet-4-0",
        })}
      />,
    );
    expect(html).toContain("leaves this machine");
    expect(html).toContain("api.anthropic.com");
  });

  it("points at settings when no model is assigned", () => {
    const html = renderToStaticMarkup(
      <DestinationBadge destination={destination({ configured: false })} />,
    );
    expect(html).toContain("/settings");
    expect(html).toContain("No model assigned");
  });
});
