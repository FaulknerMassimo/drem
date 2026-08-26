/**
 * Journal chat, from the POST the browser makes to the rows it leaves behind.
 *
 * The unit suites cover the wire formats and the agent loop; what can only be
 * proved here is the whole turn: the gate, the streamed events in the order the
 * screen consumes them, the encrypted transcript at the end, and the refusals
 * that must happen before a single word reaches a model.
 *
 * Requires: npm run dev:up
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { chatMessages, chatThreads, insights, jobs, nights, settings, users } from "@/db/schema";
import { saveAiConfig } from "@/lib/ai/config";
import { listConversations } from "@/lib/ai/conversations";
import { emptyRoles } from "@/lib/ai/schema";
import type { ChatWireEvent } from "@/lib/ai/chat-events";
import { createInitialAccount } from "@/lib/auth/accounts";
import { __clearKeyStore } from "@/lib/auth/key-store";
import type { UserKeys } from "@/lib/crypto/envelope";
import { createDream } from "@/lib/journal/dreams";

const EMAIL = "chatter@example.com";
const PASSWORD = "a sufficiently long passphrase";
const CANARY = "zarquon-flying-over-the-cathedral-of-bees";

let userId: string;
let keys: UserKeys;

/*
 * The three things a route handler gets from the request that a test process
 * has no way to stand up: the session (whose keys live in one server's memory),
 * the CSRF cookie, and the request headers. Everything below them is real.
 */
vi.mock("@/lib/auth/session", () => ({
  currentSession: async () => (unlocked ? { userId, keys } : null),
}));
vi.mock("@/lib/security/csrf-server", () => ({
  assertCsrfHeader: async () => {
    if (!verified) throw new Error("Rejected: CSRF token missing or mismatched");
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest" }),
}));

let unlocked = true;
let verified = true;

const { POST } = await import("./route");

async function wipeAll() {
  await db.execute(
    sql`truncate table ${users}, ${nights}, ${insights}, ${jobs}, ${settings} restart identity cascade`,
  );
}

async function assign(model: { providerId: string; model: string }, remote = false) {
  await saveAiConfig(userId, keys, {
    providers: [
      {
        id: "ollama",
        kind: "ollama",
        name: "Ollama",
        baseUrl: "http://127.0.0.1:11434",
        enabled: true,
      },
      {
        id: "cloud",
        kind: "openai",
        name: "Somebody Else's Computer",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-test",
        enabled: true,
      },
    ],
    roles: { ...emptyRoles(), chat: remote ? null : model },
  });
}

function ask(body: Record<string, unknown>): Request {
  return new Request("http://localhost:43818/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ndjson(...lines: unknown[]): Response {
  return new Response(lines.map((line) => JSON.stringify(line)).join("\n"));
}

/** The naming call is the one carrying the title instructions, not the tools. */
function isTitleRequest(init?: RequestInit): boolean {
  const body = JSON.parse(String(init?.body));
  return body.messages.some((message: { content: string }) =>
    message.content.includes("You name conversations"),
  );
}

function json(content: string): Response {
  return new Response(JSON.stringify({ message: { content } }), {
    headers: { "content-type": "application/json" },
  });
}

async function read(response: Response): Promise<ChatWireEvent[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)) as ChatWireEvent);
}

beforeAll(async () => {
  await wipeAll();
  const account = await createInitialAccount(EMAIL, PASSWORD);
  userId = account.userId;
  keys = account.keys;
});

afterAll(async () => {
  __clearKeyStore();
  await wipeAll();
});

beforeEach(async () => {
  await db.execute(sql`truncate table ${nights}, ${chatThreads} restart identity cascade`);
  await db.update(settings).set({ aiConfigEnc: null }).where(eq(settings.userId, userId));
  unlocked = true;
  verified = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a streamed turn", () => {
  it("reports the destination, each tool, then the answer, and saves the transcript", async () => {
    const dreamId = await createDream(userId, keys, {
      nightDate: "2026-08-17",
      title: "The cathedral",
      body: `I dreamt of ${CANARY}`,
      lucidity: 0,
      vividness: null,
      control: null,
      recallClarity: null,
      emotionalValence: null,
      isNightmare: false,
      isRecurring: false,
      isFragment: false,
      isDraft: false,
      tags: [],
    });
    await assign({ providerId: "ollama", model: "llama3.2" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (isTitleRequest(init)) return json("The cathedral, again");
        const sent = JSON.parse(String(init?.body));
        const answered = sent.messages.some((message: { role: string }) => message.role === "tool");
        if (!answered) {
          return ndjson(
            {
              message: {
                content: "",
                tool_calls: [{ function: { name: "read_dreams", arguments: { ids: [dreamId] } } }],
              },
            },
            { done: true },
          );
        }
        return ndjson(
          { message: { content: "The cathedral " } },
          { message: { content: "keeps coming back." } },
          { done: true, prompt_eval_count: 20, eval_count: 5 },
        );
      }),
    );

    const response = await POST(ask({ message: "What recurs?" }));
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = await read(response);
    expect(events[0]).toMatchObject({ type: "start", destination: { model: "llama3.2" } });
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "tool_start",
      "tool_end",
      "text",
      "text",
      "done",
      "title",
    ]);

    const tool = events[1];
    expect(tool?.type === "tool_start" && tool.name).toBe("read_dreams");
    expect(tool?.type === "tool_start" && tool.summary).toBe("ids: 1");
    const done = events.find((event) => event.type === "done");
    expect(done?.stopped).toBe(false);
    expect(done?.outputTokens).toBe(5);

    const stored = await db.select().from(chatMessages);
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      expect(Buffer.from(row.contentEnc).toString("utf8")).not.toContain(CANARY);
      expect(Buffer.from(row.contentEnc).toString("utf8")).not.toContain("cathedral");
    }
  });

  it("puts the first words on screen before the model has finished writing", async () => {
    // The whole point of the rewrite. Proving it needs a provider that is still
    // answering when the assertion runs, which is what the gate below is for.
    await assign({ providerId: "ollama", model: "llama3.2" });
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (isTitleRequest(init)) return json("The first half");
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              const line = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`);
              controller.enqueue(line({ message: { content: "The first " } }));
              await gate;
              controller.enqueue(line({ message: { content: "half." } }));
              controller.enqueue(line({ done: true }));
              controller.close();
            },
          }),
        );
      }),
    );

    const response = await POST(ask({ message: "What recurs?" }));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes('"type":"text"')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      seen += decoder.decode(chunk.value, { stream: true });
    }

    expect(seen).toContain("The first ");
    expect(seen).not.toContain("half.");
    expect(await db.select().from(chatMessages)).toHaveLength(0);

    release();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      seen += decoder.decode(chunk.value, { stream: true });
    }
    expect(seen).toContain("half.");
    expect(await db.select().from(chatMessages)).toHaveLength(2);
  });

  it("adopts the model chosen on the screen, so Settings agrees with it", async () => {
    await assign({ providerId: "ollama", model: "llama3.2" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
        isTitleRequest(init) ? json("A short answer") : ndjson({ message: { content: "Yes." } }, { done: true }),
      ),
    );

    const response = await POST(
      ask({ message: "anything?", providerId: "ollama", model: "qwen3:8b" }),
    );
    const events = await read(response);
    expect(events[0]).toMatchObject({ type: "start", destination: { model: "qwen3:8b" } });

    const [row] = await db
      .select({ config: settings.aiConfigEnc })
      .from(settings)
      .where(eq(settings.userId, userId));
    expect(row?.config).not.toBeNull();
    const { loadAiConfig } = await import("@/lib/ai/config");
    expect((await loadAiConfig(userId, keys)).roles.chat).toEqual({
      providerId: "ollama",
      model: "qwen3:8b",
    });
  });
});

describe("naming a conversation", () => {
  it("replaces the opening line with a title once the first answer is written", async () => {
    // The sidebar was a column of openings: every thread began with the first
    // sixty characters of the question that started it.
    await assign({ providerId: "ollama", model: "llama3.2" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
        isTitleRequest(init)
          ? json("Recurring flooded school")
          : ndjson({ message: { content: "The water recurs." } }, { done: true }),
      ),
    );

    const events = await read(
      await POST(ask({ message: "What do you make of the dream where I was back in the school?" })),
    );
    const named = events.at(-1);
    expect(named?.type === "title" && named.title).toBe("Recurring flooded school");

    const [thread] = await listConversations(userId, keys);
    expect(thread?.title).toBe("Recurring flooded school");
  });

  it("keeps the opening line when the model cannot name it", async () => {
    await assign({ providerId: "ollama", model: "llama3.2" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
        isTitleRequest(init)
          ? new Response("no", { status: 500 })
          : ndjson({ message: { content: "The water recurs." } }, { done: true }),
      ),
    );

    const events = await read(await POST(ask({ message: "What recurs?" })));
    expect(events.at(-1)?.type).toBe("done");

    const [thread] = await listConversations(userId, keys);
    expect(thread?.title).toBe("What recurs?");
  });

  it("names a conversation once, and not again on its second message", async () => {
    await assign({ providerId: "ollama", model: "llama3.2" });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      isTitleRequest(init)
        ? json("Recurring flooded school")
        : ndjson({ message: { content: "Yes." } }, { done: true }),
    );
    vi.stubGlobal("fetch", fetchImpl);

    const first = await read(await POST(ask({ message: "What recurs?" })));
    const opened = first.at(-1);
    const threadId = opened?.type === "title" ? opened.threadId : null;
    expect(threadId).not.toBeNull();

    fetchImpl.mockClear();
    const second = await read(await POST(ask({ threadId: threadId!, message: "And in July?" })));
    expect(second.map((event) => event.type)).not.toContain("title");
    expect(fetchImpl.mock.calls.filter((call) => isTitleRequest(call[1]))).toHaveLength(0);

    const [thread] = await listConversations(userId, keys);
    expect(thread?.title).toBe("Recurring flooded school");
  });

  it("does not name a conversation the reader stopped", async () => {
    // Stop means stop working, and a stopped exchange is a poor thing to name.
    await assign({ providerId: "ollama", model: "llama3.2" });
    const stop = new AbortController();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (isTitleRequest(init)) return json("Should never be asked for");
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`${JSON.stringify({ message: { content: "Half an " } })}\n`));
            init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
          },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchImpl);

    const request = new Request("http://localhost:43818/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Tell me about last week" }),
      signal: stop.signal,
    });
    const response = await POST(request);
    setTimeout(() => stop.abort(), 20);
    const events = await read(response);

    const done = events.find((event) => event.type === "done");
    expect(done?.stopped).toBe(true);
    expect(fetchImpl.mock.calls.filter((call) => isTitleRequest(call[1]))).toHaveLength(0);
    const [thread] = await listConversations(userId, keys);
    expect(thread?.title).toBe("Tell me about last week");
  });
});

describe("what has to happen before a model is reached", () => {
  it("refuses a request that cannot prove it came from this app", async () => {
    verified = false;
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const response = await POST(ask({ message: "hello" }));
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a locked session", async () => {
    unlocked = false;
    const response = await POST(ask({ message: "hello" }));
    expect(response.status).toBe(401);
  });

  it("refuses to send anywhere when no model is assigned", async () => {
    await assign({ providerId: "ollama", model: "llama3.2" }, true);
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const response = await POST(ask({ message: "hello" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "No model is assigned for chat. Pick one above, or in Settings.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an unacknowledged destination that leaves this machine", async () => {
    // The badge is on screen, but the check is here: a crafted POST is exactly
    // what a client-side gate would not stop.
    await assign({ providerId: "ollama", model: "llama3.2" });
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const response = await POST(
      ask({ message: "hello", providerId: "cloud", model: "gpt-4o" }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("api.example.com");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends to a remote destination once it has been acknowledged", async () => {
    await assign({ providerId: "ollama", model: "llama3.2" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
        isTitleRequest(init)
          ? json("A remote hello")
          : new Response('data: {"choices":[{"delta":{"content":"Hello."}}]}\n\ndata: [DONE]\n\n'),
      ),
    );

    const response = await POST(
      ask({ message: "hello", providerId: "cloud", model: "gpt-4o", acknowledge: true }),
    );
    const events = await read(response);
    expect(events[0]).toMatchObject({
      type: "start",
      destination: { host: "api.example.com", leavesMachine: true },
    });
    expect(events.at(-1)?.type).toBe("done");
  });
});
