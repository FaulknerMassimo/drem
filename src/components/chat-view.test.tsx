import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Conversation } from "@/lib/ai/conversations";
import type { ChatModelOption, Destination } from "@/lib/ai/types";

vi.mock("@/lib/ai/conversation-actions", () => ({
  listProviderModelsAction: async () => ({}),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined }),
}));

import { ChatView } from "./chat-view";
import { AssistantTurn } from "./chat-turn";

const local: Destination = {
  role: "chat",
  configured: true,
  leavesMachine: false,
  providerId: "ollama",
  providerName: "Ollama",
  providerKind: "ollama",
  model: "qwen3:8b",
  host: "127.0.0.1",
  label: "Ollama · qwen3:8b · 127.0.0.1 — stays on this machine",
};

const options: ChatModelOption[] = [
  {
    providerId: "ollama",
    providerName: "Ollama",
    providerKind: "ollama",
    host: "127.0.0.1",
    leavesMachine: false,
    models: ["qwen3:8b"],
  },
  {
    providerId: "cloud",
    providerName: "Somebody Else's Computer",
    providerKind: "openai",
    host: "api.example.com",
    leavesMachine: true,
    models: ["gpt-4o"],
  },
];

const conversation: Conversation = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Recurring corridors",
  createdAt: new Date("2026-08-20T07:00:00Z"),
  updatedAt: new Date("2026-08-20T07:05:00Z"),
  messages: [
    {
      id: "m1",
      role: "user",
      content: "What keeps recurring?",
      provider: null,
      model: null,
      inputTokens: null,
      outputTokens: null,
      createdAt: new Date("2026-08-20T07:00:00Z"),
    },
    {
      id: "m2",
      role: "assistant",
      content: "**Corridors**, mostly.",
      provider: "Ollama",
      model: "qwen3:8b",
      inputTokens: 20,
      outputTokens: 4,
      createdAt: new Date("2026-08-20T07:01:00Z"),
    },
  ],
};

function render(over: Partial<Parameters<typeof ChatView>[0]> = {}) {
  return renderToStaticMarkup(
    <ChatView
      conversations={[{ id: conversation.id, title: conversation.title, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt }]}
      conversation={conversation}
      destination={local}
      options={options}
      csrfToken="token"
      {...over}
    />,
  );
}

describe("the chat screen", () => {
  it("renders a stored transcript as the markdown the model wrote", () => {
    const markup = render();
    expect(markup).toContain("What keeps recurring?");
    expect(markup).toContain("<strong");
    expect(markup).toContain("Corridors");
    expect(markup).not.toContain("**Corridors**");
  });

  it("shows the conversation's own name, not the line that opened it", () => {
    const markup = render();
    expect(markup).toContain("Recurring corridors");
    expect(markup).not.toContain(">What keeps recurring?</h1>");
  });

  it("names the local model and its host above the box, without a checkbox", () => {
    const markup = render();
    expect(markup).toContain("qwen3:8b");
    expect(markup).toContain("this machine");
    expect(markup).not.toContain('type="checkbox"');
  });

  it("offers openers instead of an empty page on a new conversation", () => {
    const markup = render({ conversation: null, conversations: [] });
    expect(markup).toContain("Talk with your journal");
    expect(markup).toContain("How is my recall holding up?");
  });

  it("says a message cannot be sent when no model is assigned", () => {
    const markup = render({
      conversation: null,
      destination: { ...local, configured: false, providerId: "", model: "" },
    });
    expect(markup).toContain("No model is assigned for chat");
  });
});

describe("an assistant turn as it happens", () => {
  it("shows the tool that is running, and what it was asked for", () => {
    const markup = renderToStaticMarkup(
      <AssistantTurn
        streaming
        segments={[
          { kind: "thinking", text: "which entries cover August" },
          { kind: "tool", id: "call_1", name: "list_dreams", summary: "from: 2026-08-01" },
        ]}
      />,
    );
    expect(markup).toContain("Listing dreams");
    expect(markup).toContain("from: 2026-08-01");
  });

  it("reads a finished tool in the past tense, with how long it took", () => {
    const markup = renderToStaticMarkup(
      <AssistantTurn
        segments={[{ kind: "tool", id: "call_1", name: "read_dreams", summary: "ids: 2", ok: true, ms: 1_400 }]}
      />,
    );
    expect(markup).toContain("Read dreams");
    expect(markup).toContain("1.4s");
  });

  it("falls back to a legible name for a tool it has never heard of", () => {
    const markup = renderToStaticMarkup(
      <AssistantTurn segments={[{ kind: "tool", id: "c", name: "read_moon_phase", summary: "" }]} />,
    );
    expect(markup).toContain("read moon phase");
  });
});
