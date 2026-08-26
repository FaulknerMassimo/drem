/**
 * AI insights, end to end against a real Postgres.
 *
 * The unit suites cover adapters, prompts and the destination badge in
 * isolation. What can only be proved here is that the encrypted write path
 * holds together: config and insights round-trip, jobs carry identifiers
 * rather than dream text, and a stolen dump still yields nothing.
 *
 * Requires: npm run dev:up
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { chatMessages, chatThreads, insights, jobs, nights, settings, users } from "@/db/schema";
import { loadAiConfig, saveAiConfig } from "@/lib/ai/config";
import { runConversationAgent } from "@/lib/ai/conversation-agent";
import { getConversation, saveConversationExchange } from "@/lib/ai/conversations";
import { emptyRoles } from "@/lib/ai/schema";
import { insightsForDream, latestInsightForDream, saveInsight } from "@/lib/ai/insights";
import { enqueueDreamInsight, parseDreamPayload } from "@/lib/ai/jobs";
import { processNextJob } from "@/lib/ai/worker";
import { __clearKeyStore, peekKeysForUser, putKeys } from "@/lib/auth/key-store";
import { createInitialAccount } from "@/lib/auth/accounts";
import type { UserKeys } from "@/lib/crypto/envelope";
import { createDream } from "@/lib/journal/dreams";
import type { DreamInput } from "@/lib/journal/validation";

const EMAIL = "dreamer@example.com";
const PASSWORD = "a sufficiently long passphrase";
const CANARY = "zarquon-flying-over-the-cathedral-of-bees";

let userId: string;
let keys: UserKeys;

async function wipeAll() {
  await db.execute(
    sql`truncate table ${users}, ${nights}, ${insights}, ${jobs}, ${settings} restart identity cascade`,
  );
}

function dreamInput(overrides: Partial<DreamInput> = {}): DreamInput {
  return {
    nightDate: "2026-08-17",
    title: null,
    body: null,
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
    ...overrides,
  };
}

async function assignLocalModel() {
  await saveAiConfig(userId, keys, {
    providers: [
      {
        id: "ollama",
        kind: "ollama",
        name: "Ollama",
        baseUrl: "http://127.0.0.1:11434",
        enabled: true,
      },
    ],
    roles: {
      ...emptyRoles(),
      extraction: { providerId: "ollama", model: "llama3.2" },
      lucidity: { providerId: "ollama", model: "llama3.2" },
      chat: { providerId: "ollama", model: "llama3.2" },
    },
  });
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
  await db.execute(sql`truncate table ${nights}, ${insights}, ${jobs}, ${chatThreads} restart identity cascade`);
  await db.update(settings).set({ aiConfigEnc: null }).where(eq(settings.userId, userId));
  __clearKeyStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __clearKeyStore();
});

describe("encrypted config and insights", () => {
  it("round-trips an insight bound to its row", async () => {
    const dreamId = await createDream(userId, keys, dreamInput({ body: "a corridor" }));
    await saveInsight(userId, keys, {
      dreamId,
      kind: "extraction",
      provider: "Ollama",
      model: "llama3.2",
      promptVersion: "extraction.v1",
      content: JSON.stringify({ summary: "a corridor", people: [] }),
    });

    const stored = await latestInsightForDream(userId, keys, dreamId, "extraction");
    expect(stored?.content).toContain("a corridor");
    expect(stored?.promptVersion).toBe("extraction.v1");
  });

  it("keeps API keys out of the settings row as plaintext", async () => {
    await saveAiConfig(userId, keys, {
      providers: [
        {
          id: "openai",
          kind: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiKey: `sk-${CANARY}`,
          enabled: true,
        },
      ],
      roles: emptyRoles(),
    });

    const [row] = await db.select().from(settings).where(eq(settings.userId, userId));
    const asText = Buffer.from(row!.aiConfigEnc!).toString("utf8");
    expect(asText).not.toContain(CANARY);
    expect(asText).not.toContain("sk-");
  });
});

describe("journal chat", () => {
  /** Ollama streams one JSON object per line; the last one carries the counts. */
  function ndjson(...lines: unknown[]): Response {
    return new Response(lines.map((line) => JSON.stringify(line)).join("\n"), {
      headers: { "content-type": "application/x-ndjson" },
    });
  }

  it("uses a read-only dream tool and stores only an encrypted final transcript", async () => {
    const dreamId = await createDream(
      userId,
      keys,
      dreamInput({ title: "The cathedral", body: `I dreamt of ${CANARY}` }),
    );
    await assignLocalModel();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.stream).toBe(true);
      const toolResult = body.messages.find((message: { role: string }) => message.role === "tool");
      if (!toolResult) {
        expect(body.tools.some((tool: { function: { name: string } }) => tool.function.name === "read_dreams")).toBe(true);
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
      expect(toolResult.content).toContain(CANARY);
      return ndjson(
        { message: { content: "A grounded " } },
        { message: { content: "answer." } },
        { done: true, prompt_eval_count: 12, eval_count: 4 },
      );
    });
    vi.stubGlobal("fetch", fetchImpl);

    const config = await loadAiConfig(userId, keys);
    const answer = await runConversationAgent(
      config,
      { userId, keys },
      [],
      `What happened in ${CANARY}?`,
    );
    expect(answer.text).toBe("A grounded answer.");
    expect(answer.toolCalls).toBe(1);
    expect(answer.outputTokens).toBe(4);

    const threadId = await saveConversationExchange(userId, keys, null, {
      user: `What happened in ${CANARY}?`,
      assistant: answer.text,
      provider: answer.destination.providerName,
      model: answer.destination.model,
    });
    expect((await getConversation(userId, keys, threadId))?.messages).toHaveLength(2);

    const stored = await db.select().from(chatMessages);
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      expect(Buffer.from(row.contentEnc).toString("utf8")).not.toContain(CANARY);
    }
  });

  it("keeps the prose a model writes before it reaches for a tool", async () => {
    // The old loop returned the last round only, so a model that said what it
    // was about to look up had that sentence vanish from the saved transcript.
    await assignLocalModel();
    let round = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        round += 1;
        if (round === 1) {
          return ndjson(
            { message: { content: "Let me check your lucid nights." } },
            {
              message: {
                content: "",
                tool_calls: [{ function: { name: "get_journal_overview", arguments: {} } }],
              },
            },
            { done: true },
          );
        }
        return ndjson({ message: { content: "You had two." } }, { done: true });
      }),
    );

    const answer = await runConversationAgent(
      await loadAiConfig(userId, keys),
      { userId, keys },
      [],
      "How many lucid nights?",
    );
    expect(answer.text).toBe("Let me check your lucid nights.\n\nYou had two.");
  });

  it("keeps what was written when the reader stops the answer", async () => {
    await assignLocalModel();
    const stop = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        // A stream that never ends on its own, so only the stop can end it.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(`${JSON.stringify({ message: { content: "Half an " } })}\n`),
            );
            init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
          },
        });
        return new Response(body);
      }),
    );

    const running = runConversationAgent(
      await loadAiConfig(userId, keys),
      { userId, keys },
      [],
      "Tell me about last week",
      { signal: stop.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop.abort();

    const answer = await running;
    expect(answer.stopped).toBe(true);
    expect(answer.text).toBe("Half an");
  });
});

describe("the job queue", () => {
  it("queues only the dream id, never the body", async () => {
    const dreamId = await createDream(
      userId,
      keys,
      dreamInput({ body: `I dreamt of ${CANARY}` }),
    );
    await enqueueDreamInsight(userId, dreamId, "extraction");

    const [job] = await db.select().from(jobs);
    expect(parseDreamPayload(job!.payload).dreamId).toBe(dreamId);
    expect(JSON.stringify(job!.payload)).not.toContain(CANARY);
    expect(JSON.stringify(job!.payload)).not.toContain("dreamt");
  });

  it("does not enqueue a second open job for the same dream and kind", async () => {
    const dreamId = await createDream(userId, keys, dreamInput({ body: "a corridor" }));
    const first = await enqueueDreamInsight(userId, dreamId, "extraction");
    const second = await enqueueDreamInsight(userId, dreamId, "extraction");
    expect(second).toBe(first);
    expect(await db.select().from(jobs)).toHaveLength(1);
  });

  it("waits rather than failing when no session is unlocked", async () => {
    const dreamId = await createDream(userId, keys, dreamInput({ body: "a corridor" }));
    await assignLocalModel();
    await enqueueDreamInsight(userId, dreamId, "extraction");

    expect(await processNextJob()).toBe("locked");
    const [job] = await db.select().from(jobs);
    expect(job?.status).toBe("pending");
    expect(job?.attempts).toBe(0);
  });
});

describe("the worker", () => {
  it("decrypts the dream, calls the adapter, and stores an encrypted insight", async () => {
    const dreamId = await createDream(
      userId,
      keys,
      dreamInput({ title: "The cathedral", body: `I dreamt of ${CANARY}` }),
    );
    await assignLocalModel();
    putKeys("worker", userId, keys, 60_000);
    expect(peekKeysForUser(userId)).not.toBeNull();

    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("/api/chat");
      const body = JSON.parse(String(init?.body));
      expect(body.messages.some((message: { content: string }) => message.content.includes(CANARY))).toBe(
        true,
      );
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              summary: "Flying",
              people: [],
              places: ["cathedral"],
              objects: [],
              actions: ["flying"],
              emotions: [],
              anomalies: [],
              themes: [],
              dreamSigns: ["flying"],
            }),
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchImpl);

    await enqueueDreamInsight(userId, dreamId, "extraction");
    expect(await processNextJob()).toBe("done");

    const stored = await latestInsightForDream(userId, keys, dreamId, "extraction");
    expect(stored?.content).toContain("cathedral");
    expect(JSON.parse(stored!.content).dreamSigns).toEqual(["flying"]);

    const [row] = await db.select().from(insights);
    expect(Buffer.from(row!.contentEnc).toString("utf8")).not.toContain("cathedral");
    expect(Buffer.from(row!.contentEnc).toString("utf8")).not.toContain(CANARY);
  });

  it("skips an empty entry rather than sending it", async () => {
    const dreamId = await createDream(userId, keys, dreamInput({ title: "blank" }));
    await assignLocalModel();
    putKeys("worker", userId, keys, 60_000);
    vi.stubGlobal("fetch", vi.fn());

    await enqueueDreamInsight(userId, dreamId, "extraction");
    expect(await processNextJob()).toBe("done");

    const [job] = await db.select().from(jobs);
    expect(job?.status).toBe("skipped");
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
    expect(await insightsForDream(userId, keys, dreamId)).toEqual({});
  });

  it("keeps a provider failure out of last_error beyond a status code", async () => {
    const dreamId = await createDream(userId, keys, dreamInput({ body: `about ${CANARY}` }));
    await assignLocalModel();
    putKeys("worker", userId, keys, 60_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(`prompt was ${CANARY}`, { status: 500 })),
    );

    await enqueueDreamInsight(userId, dreamId, "extraction");
    expect(await processNextJob()).toBe("done");

    const [job] = await db.select().from(jobs);
    expect(job?.status).toBe("pending");
    expect(job?.lastError).toBe("The provider returned HTTP 500");
    expect(job?.lastError).not.toContain(CANARY);
  });
});
