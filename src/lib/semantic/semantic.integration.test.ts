/**
 * The semantic layer, end to end against a real Postgres.
 *
 * The unit suites cover the vector arithmetic, the correlation and the scan
 * parser in isolation. What can only be proved here is that the encrypted path
 * holds together: that a vector round-trips and is welded to its row, that the
 * plaintext vector column stays empty unless the operator asked for it, that
 * search finds an entry it never read a word of, and that a dream-sign scan
 * turns a model's reply into rows that say what actually happened.
 *
 * Requires: npm run dev:up
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  dreamSignOccurrences,
  dreamSigns,
  dreams,
  embeddings,
  insights,
  jobs,
  nights,
  settings,
  users,
} from "@/db/schema";
import { saveAiConfig } from "@/lib/ai/config";
import { enqueueEmbedDreams, enqueueSignScan } from "@/lib/ai/jobs";
import { emptyRoles } from "@/lib/ai/schema";
import { processNextJob } from "@/lib/ai/worker";
import { createInitialAccount } from "@/lib/auth/accounts";
import { __clearKeyStore, putKeys } from "@/lib/auth/key-store";
import { DecryptionError } from "@/lib/crypto/aead";
import type { UserKeys } from "@/lib/crypto/envelope";
import { createDream, updateDream } from "@/lib/journal/dreams";
import type { DreamInput } from "@/lib/journal/validation";
import { queueLocalEmbeddings } from "./queue";
import {
  dreamsNeedingEmbedding,
  getVector,
  indexCoverage,
  loadCandidates,
  saveEmbedding,
} from "./embeddings";
import { currentEmbeddingModel, semanticSearch, similarDreams } from "./search";
import {
  addManualSign,
  dreamIdsForSign,
  knownSignLabels,
  listSigns,
  mergeScanResults,
  setSignActive,
  signFingerprint,
  signsForDreams,
} from "./signs";
import type { ProposedSign } from "./signs-parse";
import { embeddingModelKey } from "./text";

const EMAIL = "dreamer@example.com";
const PASSWORD = "a sufficiently long passphrase";
const CANARY = "zarquon-flying-over-the-cathedral-of-bees";

const MODEL = "embeddinggemma";
const MODEL_KEY = embeddingModelKey(MODEL);

let userId: string;
let keys: UserKeys;

async function wipeAll() {
  await db.execute(
    sql`truncate table ${users}, ${nights}, ${dreams}, ${embeddings}, ${dreamSigns}, ${insights}, ${jobs}, ${settings} restart identity cascade`,
  );
}

async function wipeJournal() {
  await db.execute(
    sql`truncate table ${nights}, ${dreams}, ${embeddings}, ${dreamSigns}, ${insights}, ${jobs} restart identity cascade`,
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

async function assignSemanticModels() {
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
      embedding: { providerId: "ollama", model: MODEL },
      signs: { providerId: "ollama", model: "llama3.2" },
    },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A stand-in embedding model.
 *
 * Deterministic and one-dimension-per-keyword, so "expected to rank first"
 * means something checkable rather than "whatever the model felt like".
 */
const AXES = ["corridor", "ocean", "flying"] as const;

function fakeVector(text: string): number[] {
  const lower = text.toLowerCase();
  const vector = AXES.map((axis) => (lower.includes(axis) ? 1 : 0));
  // Never all-zero: a zero vector matches nothing, which would hide a bug in
  // the ranking behind an empty result.
  return vector.some(Boolean) ? vector : [0.1, 0.1, 0.1];
}

function stubEmbeddingProvider() {
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toContain("/api/embed");
    const body = JSON.parse(String(init?.body));
    return jsonResponse({ embeddings: body.input.map(fakeVector) });
  });
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
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
  await wipeJournal();
  await db.update(settings).set({ aiConfigEnc: null }).where(eq(settings.userId, userId));
  __clearKeyStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __clearKeyStore();
});

describe("storing a vector", () => {
  it("round-trips it through the database", async () => {
    const dreamId = await createDream(userId, keys, dreamInput({ body: "a corridor" }));
    await saveEmbedding(userId, keys, dreamId, MODEL_KEY, [0.5, -0.25, 0.125]);

    const stored = await getVector(userId, keys, dreamId, MODEL_KEY);
    expect(stored).toEqual([0.5, -0.25, 0.125]);
  });

  it("never writes the vector where the database can read it", async () => {
    const dreamId = await createDream(userId, keys, dreamInput({ body: "a corridor" }));
    await saveEmbedding(userId, keys, dreamId, MODEL_KEY, [0.5, -0.25, 0.125]);

    const [row] = await db.select().from(embeddings).where(eq(embeddings.dreamId, dreamId));
    expect(row?.vector).toBeNull();
    expect(row?.vectorEnc).not.toBeNull();
    expect(row?.dim).toBe(3);
  });

  it("welds the ciphertext to the row it belongs to", async () => {
    const first = await createDream(userId, keys, dreamInput({ body: "a corridor" }));
    const second = await createDream(userId, keys, dreamInput({ body: "the ocean" }));
    await saveEmbedding(userId, keys, first, MODEL_KEY, [1, 0, 0]);
    await saveEmbedding(userId, keys, second, MODEL_KEY, [0, 1, 0]);

    const [a, b] = await db.select().from(embeddings).orderBy(embeddings.dreamId);
    // Swapping two vectors between rows must be detected, not silently accepted.
    await db.update(embeddings).set({ vectorEnc: b!.vectorEnc }).where(eq(embeddings.id, a!.id));

    await expect(getVector(userId, keys, a!.dreamId, MODEL_KEY)).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it("replaces the vector in place rather than accumulating rows", async () => {
    const dreamId = await createDream(userId, keys, dreamInput({ body: "a corridor" }));
    await saveEmbedding(userId, keys, dreamId, MODEL_KEY, [1, 0, 0]);
    await saveEmbedding(userId, keys, dreamId, MODEL_KEY, [0, 1, 0]);

    const rows = await db.select().from(embeddings).where(eq(embeddings.dreamId, dreamId));
    expect(rows).toHaveLength(1);
    // The rewrite must stay decryptable: the row keeps its id, so the AAD that
    // the new ciphertext is bound to is still the one it will be read under.
    expect(await getVector(userId, keys, dreamId, MODEL_KEY)).toEqual([0, 1, 0]);
  });

  it("keeps two models' vectors apart, because they are not comparable", async () => {
    const dreamId = await createDream(userId, keys, dreamInput({ body: "a corridor" }));
    await saveEmbedding(userId, keys, dreamId, MODEL_KEY, [1, 0, 0]);
    await saveEmbedding(userId, keys, dreamId, embeddingModelKey("nomic-embed-text"), [0, 1]);

    expect(await getVector(userId, keys, dreamId, MODEL_KEY)).toEqual([1, 0, 0]);
    expect(await loadCandidates(userId, keys, MODEL_KEY)).toHaveLength(1);
  });
});

describe("knowing what still needs indexing", () => {
  it("lists entries that have never been embedded", async () => {
    const dreamId = await createDream(userId, keys, dreamInput({ body: "a corridor" }));
    expect(await dreamsNeedingEmbedding(userId, MODEL_KEY)).toEqual([dreamId]);

    await saveEmbedding(userId, keys, dreamId, MODEL_KEY, [1, 0, 0]);
    expect(await dreamsNeedingEmbedding(userId, MODEL_KEY)).toEqual([]);
  });

  it("marks an entry stale again once it is edited", async () => {
    const dreamId = await createDream(userId, keys, dreamInput({ body: "a corridor" }));
    await saveEmbedding(userId, keys, dreamId, MODEL_KEY, [1, 0, 0]);

    await updateDream(userId, keys, dreamId, dreamInput({ body: "the ocean instead" }));
    expect(await dreamsNeedingEmbedding(userId, MODEL_KEY)).toEqual([dreamId]);
  });

  it("ignores an entry with no words to embed", async () => {
    // A night with no recall has a row but nothing to say.
    await createDream(userId, keys, dreamInput({ title: "Untitled", body: null }));
    const coverage = await indexCoverage(userId, MODEL_KEY);
    expect(coverage.embeddable).toBe(1);
  });

  it("counts coverage so a half-built index cannot pass for a whole one", async () => {
    const first = await createDream(userId, keys, dreamInput({ body: "a corridor" }));
    await createDream(userId, keys, dreamInput({ body: "the ocean" }));
    await saveEmbedding(userId, keys, first, MODEL_KEY, [1, 0, 0]);

    expect(await indexCoverage(userId, MODEL_KEY)).toEqual({
      embeddable: 2,
      indexed: 1,
      outstanding: 1,
    });
  });
});

describe("searching by meaning", () => {
  it("finds the entry that is about the thing, not the one that says the word", async () => {
    await assignSemanticModels();
    const corridor = await createDream(
      userId,
      keys,
      dreamInput({ body: "endless corridor, doors that never open" }),
    );
    const ocean = await createDream(userId, keys, dreamInput({ body: "swimming in the ocean" }));
    await saveEmbedding(userId, keys, corridor, MODEL_KEY, fakeVector("corridor"));
    await saveEmbedding(userId, keys, ocean, MODEL_KEY, fakeVector("ocean"));

    stubEmbeddingProvider();
    const config = await (await import("@/lib/ai/config")).loadAiConfig(userId, keys);
    const result = await semanticSearch(userId, keys, config, "a corridor that goes on");

    expect(result.hits.map((hit) => hit.dream.id)).toEqual([corridor]);
    expect(result.hits[0]!.score).toBeCloseTo(1);
  });

  it("says nothing came close rather than returning the least unrelated entry", async () => {
    await assignSemanticModels();
    const ocean = await createDream(userId, keys, dreamInput({ body: "swimming in the ocean" }));
    await saveEmbedding(userId, keys, ocean, MODEL_KEY, fakeVector("ocean"));

    stubEmbeddingProvider();
    const config = await (await import("@/lib/ai/config")).loadAiConfig(userId, keys);
    const result = await semanticSearch(userId, keys, config, "a corridor");

    expect(result.hits).toEqual([]);
  });

  it("reports where the phrase was sent before it went", async () => {
    await assignSemanticModels();
    stubEmbeddingProvider();
    const config = await (await import("@/lib/ai/config")).loadAiConfig(userId, keys);
    const result = await semanticSearch(userId, keys, config, "anything");

    expect(result.destination.leavesMachine).toBe(false);
    expect(result.destination.model).toBe(MODEL);
  });

  it("finds neighbours of an entry without calling a model at all", async () => {
    await assignSemanticModels();
    const first = await createDream(userId, keys, dreamInput({ body: "a corridor" }));
    const second = await createDream(userId, keys, dreamInput({ body: "another corridor" }));
    await createDream(userId, keys, dreamInput({ body: "the ocean" }));
    await saveEmbedding(userId, keys, first, MODEL_KEY, fakeVector("corridor"));
    await saveEmbedding(userId, keys, second, MODEL_KEY, fakeVector("corridor"));

    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const config = await (await import("@/lib/ai/config")).loadAiConfig(userId, keys);
    const similar = await similarDreams(userId, keys, config, first);

    expect(similar.map((hit) => hit.dream.id)).toEqual([second]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("has no index to search when no embedding model is assigned", async () => {
    const config = await (await import("@/lib/ai/config")).loadAiConfig(userId, keys);
    expect(currentEmbeddingModel(config)).toBeNull();
    expect(await similarDreams(userId, keys, config, "whatever")).toEqual([]);
  });
});

describe("the embedding job", () => {
  it("runs through the worker and writes an encrypted vector", async () => {
    await assignSemanticModels();
    const dreamId = await createDream(
      userId,
      keys,
      dreamInput({ title: "The corridor", body: `I walked through ${CANARY}` }),
    );
    putKeys("worker", userId, keys, 60_000);

    const fetchImpl = stubEmbeddingProvider();
    await enqueueEmbedDreams(userId, [dreamId]);
    expect(await processNextJob()).toBe("done");

    expect(await getVector(userId, keys, dreamId, MODEL_KEY)).not.toBeNull();

    // The job row carries an identifier, never the entry.
    const [job] = await db.select().from(jobs).where(eq(jobs.kind, "embed_dream"));
    expect(JSON.stringify(job?.payload)).not.toContain(CANARY);
    expect(job?.status).toBe("succeeded");

    // And what did leave the process was the entry, once, to the assigned model.
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe(MODEL);
    expect(body.input[0]).toContain("The corridor");
  });

  it("leaves the job pending rather than failing when the journal is locked", async () => {
    await assignSemanticModels();
    const dreamId = await createDream(userId, keys, dreamInput({ body: "a corridor" }));
    await enqueueEmbedDreams(userId, [dreamId]);
    __clearKeyStore();

    expect(await processNextJob()).toBe("locked");
    const [job] = await db.select().from(jobs).where(eq(jobs.kind, "embed_dream"));
    expect(job?.status).toBe("pending");
    expect(job?.attempts).toBe(0);
  });

  it("does not queue the same entry twice", async () => {
    const dreamId = await createDream(userId, keys, dreamInput({ body: "a corridor" }));
    expect(await enqueueEmbedDreams(userId, [dreamId, dreamId])).toBe(1);
    expect(await enqueueEmbedDreams(userId, [dreamId])).toBe(0);
  });
});

describe("indexing as you write", () => {
  async function assignEmbedding(baseUrl: string) {
    await saveAiConfig(userId, keys, {
      providers: [
        { id: "p", kind: "openai", name: "Somewhere", baseUrl, enabled: true },
      ],
      roles: { ...emptyRoles(), embedding: { providerId: "p", model: MODEL } },
    });
  }

  it("queues an entry when the embedding model is on this machine", async () => {
    await assignEmbedding("http://127.0.0.1:1234/v1");
    const dreamId = await createDream(userId, keys, dreamInput({ body: "a corridor" }));
    await queueLocalEmbeddings(userId, keys, [dreamId]);

    const queued = await db.select().from(jobs).where(eq(jobs.kind, "embed_dream"));
    expect(queued).toHaveLength(1);
  });

  it("queues nothing when the embedding model is remote", async () => {
    // The rule the badge exists for: writing an entry must never be what sends
    // it to a third party. A remote index is asked for on the search page,
    // where the destination is named and acknowledged.
    await assignEmbedding("https://api.openai.com/v1");
    const dreamId = await createDream(userId, keys, dreamInput({ body: "a corridor" }));
    await queueLocalEmbeddings(userId, keys, [dreamId]);

    expect(await db.select().from(jobs).where(eq(jobs.kind, "embed_dream"))).toEqual([]);
  });

  it("queues nothing when no embedding model is assigned", async () => {
    const dreamId = await createDream(userId, keys, dreamInput({ body: "a corridor" }));
    await queueLocalEmbeddings(userId, keys, [dreamId]);
    expect(await db.select().from(jobs).where(eq(jobs.kind, "embed_dream"))).toEqual([]);
  });
});

describe("dream signs", () => {
  const BASELINE = 0.25;

  async function seedNights(): Promise<string[]> {
    const ids: string[] = [];
    for (const [index, lucid] of [true, false, true, false].entries()) {
      ids.push(
        await createDream(
          userId,
          keys,
          dreamInput({
            nightDate: `2026-08-0${index + 1}`,
            body: `entry ${index}`,
            lucidity: lucid ? 4 : 0,
          }),
        ),
      );
    }
    return ids;
  }

  function proposal(overrides: Partial<ProposedSign> = {}): ProposedSign {
    return {
      label: `${CANARY} door`,
      category: "anomaly",
      entries: [0, 1, 2],
      confidence: 0.8,
      ...overrides,
    };
  }

  it("stores the label encrypted and finds it by fingerprint", async () => {
    const ids = await seedNights();
    await mergeScanResults(userId, keys, [proposal()], ids);

    const [row] = await db
      .select()
      .from(dreamSigns)
      .where(eq(dreamSigns.labelBidx, signFingerprint(keys, `${CANARY} door`)));
    expect(row).toBeDefined();
    expect(row!.labelEnc.toString("utf8")).not.toContain(CANARY);

    const signs = await listSigns(userId, keys, { baseline: BASELINE });
    expect(signs.map((sign) => sign.label)).toEqual([`${CANARY} door`]);
  });

  it("counts appearances and how many of them were lucid", async () => {
    const ids = await seedNights();
    // Entries 0 and 2 are lucid, entry 1 is not.
    await mergeScanResults(userId, keys, [proposal({ entries: [0, 1, 2] })], ids);

    const [sign] = await listSigns(userId, keys, { baseline: BASELINE });
    expect(sign!.correlation.occurrences).toBe(3);
    expect(sign!.correlation.lucidOccurrences).toBe(2);
    expect(sign!.correlation.lift).toBeCloseTo(2 / 3 / BASELINE);
  });

  it("keeps the counts honest after an entry is deleted", async () => {
    const ids = await seedNights();
    await mergeScanResults(userId, keys, [proposal({ entries: [0, 1, 2] })], ids);
    await db.delete(dreams).where(eq(dreams.id, ids[0]!));

    const [sign] = await listSigns(userId, keys, { baseline: BASELINE });
    expect(sign!.correlation.occurrences).toBe(2);
    expect(sign!.correlation.lucidOccurrences).toBe(1);
  });

  it("re-derives occurrences on a rescan instead of only ever adding", async () => {
    const ids = await seedNights();
    await mergeScanResults(userId, keys, [proposal({ entries: [0, 1, 2] })], ids);
    await mergeScanResults(userId, keys, [proposal({ entries: [0] })], ids);

    // One occurrence left, which is below the threshold the parser enforces —
    // but merge is given whatever it is given, and must reflect it exactly.
    expect(await dreamIdsForSign(userId, (await listSigns(userId, keys, { baseline: BASELINE }))[0]!.id))
      .toEqual([ids[0]]);
  });

  it("does not resurrect a sign that was dismissed", async () => {
    const ids = await seedNights();
    await mergeScanResults(userId, keys, [proposal()], ids);
    const [sign] = await listSigns(userId, keys, { baseline: BASELINE });
    await setSignActive(userId, sign!.id, false);

    await mergeScanResults(userId, keys, [proposal()], ids);

    expect(await listSigns(userId, keys, { baseline: BASELINE })).toEqual([]);
    const dismissed = await listSigns(userId, keys, {
      baseline: BASELINE,
      includeDismissed: true,
    });
    expect(dismissed).toHaveLength(1);
    expect(dismissed[0]!.isActive).toBe(false);
  });

  it("keeps a hand-made sign hand-made, and fills its counts in from the archive", async () => {
    const ids = await seedNights();
    const signId = await addManualSign(userId, keys, "my old school", "place");
    await mergeScanResults(
      userId,
      keys,
      [proposal({ label: "My Old School", entries: [0, 2] })],
      ids,
    );

    const [sign] = await listSigns(userId, keys, { baseline: BASELINE });
    expect(sign!.id).toBe(signId);
    expect(sign!.isAuto).toBe(false);
    expect(sign!.label).toBe("my old school");
    expect(sign!.correlation.occurrences).toBe(2);
  });

  it("drops an automatic sign that no longer occurs anywhere", async () => {
    const ids = await seedNights();
    await mergeScanResults(userId, keys, [proposal()], ids);
    await mergeScanResults(userId, keys, [], ids);
    expect(await listSigns(userId, keys, { baseline: BASELINE })).toEqual([]);
  });

  it("keeps a hand-made sign that has not turned up yet", async () => {
    const ids = await seedNights();
    await addManualSign(userId, keys, "my old school", "place");
    await mergeScanResults(userId, keys, [], ids);

    const signs = await listSigns(userId, keys, { baseline: BASELINE });
    expect(signs).toHaveLength(1);
    expect(signs[0]!.correlation.occurrences).toBe(0);
  });

  it("attaches signs to the entries they appeared in", async () => {
    const ids = await seedNights();
    await mergeScanResults(userId, keys, [proposal({ entries: [0, 2] })], ids);

    const byDream = await signsForDreams(userId, keys, ids);
    expect(byDream.get(ids[0]!)?.map((sign) => sign.label)).toEqual([`${CANARY} door`]);
    expect(byDream.get(ids[1]!)).toBeUndefined();
  });

  it("offers known labels to the next scan so a cue does not fork into spellings", async () => {
    await addManualSign(userId, keys, "my old school", "place");
    expect(await knownSignLabels(userId, keys)).toEqual(["my old school"]);
  });
});

describe("the dream-sign scan job", () => {
  it("turns a model's reply into signs, occurrences and counts", async () => {
    await assignSemanticModels();
    const ids: string[] = [];
    for (const [index, lucid] of [true, false, true].entries()) {
      ids.push(
        await createDream(
          userId,
          keys,
          dreamInput({
            nightDate: `2026-08-0${index + 1}`,
            body: `${CANARY} appeared again, night ${index}`,
            lucidity: lucid ? 4 : 0,
          }),
        ),
      );
    }
    putKeys("worker", userId, keys, 60_000);

    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain("/api/chat");
      return jsonResponse({
        message: {
          content: JSON.stringify({
            signs: [
              { label: "a door that is not there", category: "anomaly", entries: [1, 2, 3], confidence: 0.9 },
            ],
          }),
        },
      });
    });
    vi.stubGlobal("fetch", fetchImpl);

    await enqueueSignScan(userId, "2026-08-01", "2026-08-31");
    expect(await processNextJob()).toBe("done");

    const signs = await listSigns(userId, keys, { baseline: 0.25 });
    expect(signs).toHaveLength(1);
    expect(signs[0]!.label).toBe("a door that is not there");
    expect(signs[0]!.correlation.occurrences).toBe(3);
    expect(signs[0]!.correlation.lucidOccurrences).toBe(2);

    // The job row carries dates, never the entries it scanned.
    const [job] = await db.select().from(jobs).where(eq(jobs.kind, "detect_dream_signs"));
    expect(JSON.stringify(job?.payload)).not.toContain(CANARY);
  });

  it("skips a period too thin to have a pattern in it", async () => {
    await assignSemanticModels();
    await createDream(userId, keys, dreamInput({ nightDate: "2026-08-01", body: "one entry" }));
    putKeys("worker", userId, keys, 60_000);

    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    await enqueueSignScan(userId, "2026-08-01", "2026-08-31");
    expect(await processNextJob()).toBe("done");

    const [job] = await db.select().from(jobs).where(eq(jobs.kind, "detect_dream_signs"));
    expect(job?.status).toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("runs one scan at a time, so two do not race on the same rows", async () => {
    const first = await enqueueSignScan(userId, "2026-08-01", "2026-08-31");
    const second = await enqueueSignScan(userId, "2026-07-01", "2026-07-31");
    expect(second).toBe(first);
  });

  it("leaves no occurrence pointing at an entry outside the window it scanned", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      ids.push(
        await createDream(
          userId,
          keys,
          dreamInput({ nightDate: `2026-08-0${index + 1}`, body: `night ${index}` }),
        ),
      );
    }
    // The reply names an entry the scan was never given. Clamping it would file
    // a real sign against an unrelated dream.
    await mergeScanResults(
      userId,
      keys,
      [{ label: "impossible", category: "anomaly", entries: [0, 99], confidence: 1 }],
      ids,
    );

    const rows = await db
      .select()
      .from(dreamSignOccurrences)
      .innerJoin(dreamSigns, eq(dreamSigns.id, dreamSignOccurrences.signId))
      .where(and(eq(dreamSigns.userId, userId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dream_sign_occurrences.dreamId).toBe(ids[0]);
  });
});
