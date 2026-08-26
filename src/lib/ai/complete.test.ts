import { describe, expect, it, vi } from "vitest";
import { completeRole } from "./chat";
import { withProgress, type ModelProgress } from "./progress";
import { jobStreamBudget, JOB_FIRST_TOKEN_TIMEOUT_MS, JOB_IDLE_TIMEOUT_MS } from "./providers/http";
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
  roles: { ...emptyRoles(), signs: { providerId: "ollama", model: "qwen3:8b" } },
};

const ask = [{ role: "user" as const, content: "what recurs?" }];

function ndjson(lines: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        controller.close();
      },
    }),
  );
}

describe("a queued role's finished answer", () => {
  it("assembles the pieces a stream arrived in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ndjson([
          { message: { content: "Water, " } },
          { message: { content: "and stairs." } },
          { done: true, prompt_eval_count: 900, eval_count: 12 },
        ]),
      ),
    );

    const { response } = await completeRole(config, "signs", ask);
    expect(response.text).toBe("Water, and stairs.");
    expect(response.inputTokens).toBe(900);
    expect(response.outputTokens).toBe(12);
    vi.unstubAllGlobals();
  });

  it("says how far along it is, in counts and never in words", async () => {
    // The whole point of the exercise: a screen has to be able to tell a model
    // that is working from one that has died, and the only thing it may learn
    // in order to do so is how much has arrived.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ndjson([
          { message: { thinking: "weighing the flooded school" } },
          { message: { content: "Water" } },
          { message: { content: " again." } },
          { done: true },
        ]),
      ),
    );

    const seen: ModelProgress[] = [];
    const { response } = await withProgress(
      (progress) => seen.push(progress),
      () => completeRole(config, "signs", ask),
    );

    expect(response.text).toBe("Water again.");
    expect(seen.map((step) => step.phase)).toEqual(["thinking", "writing", "writing"]);
    // Counts only, and rising: 27 characters of reasoning, then 5 of answer,
    // then 12.
    expect(seen.map((step) => step.characters)).toEqual([27, 5, 12]);
    expect(JSON.stringify(seen)).not.toContain("school");
    expect(JSON.stringify(seen)).not.toContain("Water");
    vi.unstubAllGlobals();
  });

  it("keeps the reasoning out of the answer it files", async () => {
    // Reasoning is derived from the journal and worth nothing once the answer
    // exists; the insight row must not end up holding it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ndjson([
          { message: { thinking: "the dreamer mentioned a cathedral" } },
          { message: { content: "Stairs." } },
          { done: true },
        ]),
      ),
    );

    const { response } = await completeRole(config, "signs", ask);
    expect(response.text).toBe("Stairs.");
    expect(JSON.stringify(response)).not.toContain("cathedral");
    vi.unstubAllGlobals();
  });
});

describe("what a queued call is held to", () => {
  it("waits on silence, not on how long the answer is", () => {
    const scan = jobStreamBudget(3_600_000);
    expect(scan.totalMs).toBe(3_600_000);
    expect(scan.firstByteMs).toBe(JOB_FIRST_TOKEN_TIMEOUT_MS);
    expect(scan.idleMs).toBe(JOB_IDLE_TIMEOUT_MS);
  });

  it("never waits longer than the caller allowed in total", () => {
    // Naming a conversation is thirty seconds' work or it is not worth doing;
    // it must not inherit the ten minutes a cold scan is allowed to sit there.
    const title = jobStreamBudget(30_000);
    expect(title.firstByteMs).toBe(30_000);
    expect(title.idleMs).toBe(30_000);
  });
});
