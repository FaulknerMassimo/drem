import { describe, expect, it } from "vitest";
import { readChatEvents, summariseToolArguments, type ChatWireEvent } from "./chat-events";

function body(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<ChatWireEvent[]> {
  const events: ChatWireEvent[] = [];
  for await (const event of readChatEvents(body(chunks))) events.push(event);
  return events;
}

describe("reading the chat stream", () => {
  it("holds a line until it is whole", async () => {
    const events = await collect([
      'data: {"type":"text","del',
      'ta":"a corridor"}\n\ndata: {"type":"done","threadId":null,',
      '"stopped":false,"provider":"Ollama","model":"qwen3"}\n\n',
    ]);

    expect(events).toEqual([
      { type: "text", delta: "a corridor" },
      { type: "done", threadId: null, stopped: false, provider: "Ollama", model: "qwen3" },
    ]);
  });

  it("skips a frame it cannot read rather than ending the answer", async () => {
    const events = await collect([
      "data: {oops\n\n",
      ": a comment\n\n",
      'data: {"type":"text","delta":"still here"}\n\n',
    ]);

    expect(events).toEqual([{ type: "text", delta: "still here" }]);
  });
});

describe("summarising a tool call", () => {
  it("names what was asked for, in words rather than JSON", () => {
    expect(
      summariseToolArguments({ from: "2026-08-01", to: "2026-08-26", lucid_only: true }),
    ).toBe("from: 2026-08-01 · to: 2026-08-26 · lucid only: yes");
  });

  it("counts a list instead of spelling out ids nobody can read", () => {
    expect(summariseToolArguments({ ids: ["a", "b", "c"] })).toBe("ids: 3");
  });

  it("bounds a search phrase lifted out of a dream", () => {
    const summary = summariseToolArguments({ query: "the cathedral ".repeat(40) });
    expect(summary.length).toBeLessThanOrEqual(140);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("says nothing for a tool that takes no arguments", () => {
    expect(summariseToolArguments({})).toBe("");
    expect(summariseToolArguments(null)).toBe("");
  });
});
