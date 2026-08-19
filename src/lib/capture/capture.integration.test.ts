/**
 * Capture: encrypted attachments, OCR/transcript storage, and split-into-entries.
 *
 * Requires: npm run dev:up
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { db } from "@/db";
import { attachments, dreams, jobs, nights, users } from "@/db/schema";
import { saveAiConfig } from "@/lib/ai/config";
import { emptyRoles } from "@/lib/ai/schema";
import { enqueueAttachmentJob, parseAttachmentPayload } from "@/lib/ai/jobs";
import { processNextJob } from "@/lib/ai/worker";
import { createInitialAccount } from "@/lib/auth/accounts";
import { __clearKeyStore, putKeys } from "@/lib/auth/key-store";
import type { UserKeys } from "@/lib/crypto/envelope";
import { env } from "@/lib/env";
import {
  countInbox,
  createImageAttachment,
  discardStack,
  getAttachment,
  getStack,
  listStacks,
  readAttachmentBlob,
  saveReading,
  stackKeyOf,
} from "./attachments";
import { confirmAsDreams, splitToFields } from "./confirm";
import { dreamFromTranscript, parseStackReading } from "./fields";
import { prepareImage } from "./image";

const EMAIL = "dreamer@example.com";
const PASSWORD = "a sufficiently long passphrase";
const CANARY = "zarquon-flying-over-the-cathedral-of-bees";

let userId: string;
let keys: UserKeys;

async function wipeAll() {
  await db.execute(
    sql`truncate table ${users}, ${nights}, ${dreams}, ${attachments}, ${jobs} restart identity cascade`,
  );
}

/** `shade` varies the bytes so two pages of one stack are not deduplicated. */
async function tinyJpeg(shade = 30): Promise<Buffer> {
  return sharp({
    create: { width: 12, height: 12, channels: 3, background: { r: shade, g: 20, b: 50 } },
  })
    .jpeg()
    .toBuffer();
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
  await db.execute(sql`truncate table ${nights}, ${dreams}, ${attachments}, ${jobs} restart identity cascade`);
  __clearKeyStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __clearKeyStore();
});

describe("encrypted attachments", () => {
  it("round-trips a photograph and keeps the plaintext off disk", async () => {
    const prepared = await prepareImage(await tinyJpeg());
    const { id } = await createImageAttachment(userId, keys, prepared, null);

    const blob = await readAttachmentBlob(userId, keys, id);
    expect(blob?.bytes.equals(prepared.bytes)).toBe(true);

    const [row] = await db.select().from(attachments).where(eq(attachments.id, id));
    const stored = await readFile(path.join(env().UPLOAD_DIR, row!.storageKey));
    expect(stored.equals(prepared.bytes)).toBe(false);
    expect(stored.toString("utf8")).not.toContain(CANARY);
  });

  it("stores an OCR transcript encrypted, bound to the row", async () => {
    const prepared = await prepareImage(await tinyJpeg());
    const { id } = await createImageAttachment(userId, keys, prepared, null);
    await saveReading(userId, keys, id, [dreamFromTranscript(`page: ${CANARY}`, 0.81)]);

    const record = await getAttachment(userId, keys, id);
    expect(record?.dreams[0]?.body.value).toBe(`page: ${CANARY}`);
    expect(record?.dreams[0]?.body.confidence).toBeCloseTo(0.81);

    const [row] = await db.select().from(attachments).where(eq(attachments.id, id));
    expect(Buffer.from(row!.transcriptEnc!).toString("utf8")).not.toContain(CANARY);
    expect(Buffer.from(row!.transcriptEnc!).toString("utf8")).not.toContain("page:");
  });

  it("queues only the attachment id, never the transcript", async () => {
    const prepared = await prepareImage(await tinyJpeg());
    const { id } = await createImageAttachment(userId, keys, prepared, null);
    await saveReading(userId, keys, id, [dreamFromTranscript(`page: ${CANARY}`, null)]);
    await enqueueAttachmentJob(userId, id, "ocr_attachment");

    const [job] = await db.select().from(jobs);
    expect(parseAttachmentPayload(job!.payload).attachmentId).toBe(id);
    expect(JSON.stringify(job!.payload)).not.toContain(CANARY);
    expect(JSON.stringify(job!.payload)).not.toContain("page:");
  });
});

describe("confirming a capture", () => {
  it("writes separate entries when a log is split", async () => {
    const ids = await confirmAsDreams(userId, keys, {
      parts: [
        splitToFields({ title: "Flying", body: `over ${CANARY}`, isFragment: false }, "2026-08-17", 0),
        splitToFields({ title: "Train", body: "then a train", isFragment: true }, "2026-08-17", 0),
      ],
      source: "ocr",
      attachmentIds: [],
      // A reviewed capture is a finished entry: the screen has just asked for
      // the night, the title, the text, the lucidity and the tags. `isDraft`
      // is for 3am capture mode, which deliberately asks nothing.
      isDraft: false,
    });
    expect(ids).toHaveLength(2);

    const rows = await db.select().from(dreams).where(eq(dreams.userId, userId));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.isDraft)).toBe(false);
    expect(rows.filter((row) => row.isFragment)).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(CANARY);
  });
});

describe("stacks", () => {
  async function photographStack(count: number): Promise<{ stackId: string; ids: string[] }> {
    const stackId = randomUUID();
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const prepared = await prepareImage(await tinyJpeg(60 + i));
      const created = await createImageAttachment(userId, keys, prepared, stackId);
      ids.push(created.id);
    }
    return { stackId, ids };
  }

  it("groups the pages of one upload into a single thing to review", async () => {
    const { stackId, ids } = await photographStack(3);
    await createImageAttachment(userId, keys, await prepareImage(await tinyJpeg(99)), randomUUID());

    const stacks = await listStacks(userId, keys);
    expect(stacks).toHaveLength(2);
    expect(await countInbox(userId)).toBe(2);

    const stack = await getStack(userId, keys, stackId);
    expect(stack?.pages.map((page) => page.id)).toEqual(ids);
    expect(stack?.leadId).toBe(ids[0]);
  });

  /*
   * The two ids are different values and were briefly used interchangeably.
   * A stack of one hides that -- its key and its lead are the same row -- so
   * the assertion is made against a stack of three.
   */
  it("is addressed by its own key, not by its lead page", async () => {
    const { stackId, ids } = await photographStack(3);
    expect(stackId).not.toBe(ids[0]);
    expect(await getStack(userId, keys, stackId)).not.toBeNull();
    expect(await getStack(userId, keys, ids[0]!)).toBeNull();
    expect(await stackKeyOf(userId, ids[2]!)).toBe(stackId);
  });

  it("counts pages photographed but not yet sent as unsent", async () => {
    const { stackId, ids } = await photographStack(2);

    let stack = await getStack(userId, keys, stackId);
    expect(stack?.sent).toBe(false);
    expect(stack?.status).toBe("pending");

    await enqueueAttachmentJob(userId, ids[0]!, "ocr_attachment");
    stack = await getStack(userId, keys, stackId);
    expect(stack?.sent).toBe(true);
  });

  it("discards every page of a stack, blobs and all", async () => {
    const { stackId, ids } = await photographStack(3);
    const rows = await db.select().from(attachments).where(eq(attachments.userId, userId));
    const paths = rows.map((row) => path.join(env().UPLOAD_DIR, row.storageKey));

    expect(await discardStack(userId, stackId)).toBe(3);
    expect(await listStacks(userId, keys)).toHaveLength(0);
    expect(await getAttachment(userId, keys, ids[0]!)).toBeNull();
    for (const file of paths) {
      await expect(readFile(file)).rejects.toThrow();
    }
  });
});

describe("the OCR worker", () => {
  /*
   * The store owns whatever it is handed: `dropKeys` wipes the buffers, and
   * `__clearKeyStore` in `afterEach` therefore zeroes the suite's own `keys`
   * if they go in directly. The next test then encrypts under a zero key and
   * fails to decrypt anything written before it, several tests away from the
   * cause. A copy goes in instead.
   */
  function lendKeysToWorker(): void {
    putKeys(
      "worker",
      userId,
      {
        field: Buffer.from(keys.field),
        blob: Buffer.from(keys.blob),
        index: Buffer.from(keys.index),
        vector: Buffer.from(keys.vector),
      },
      60_000,
    );
  }

  async function assignVisionModel(): Promise<void> {
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
        ocr: { providerId: "ollama", model: "llama3.2-vision" },
      },
    });
    lendKeysToWorker();
  }

  it("decrypts the page, calls the adapter, and stores an encrypted reading", async () => {
    const prepared = await prepareImage(await tinyJpeg());
    const { id } = await createImageAttachment(userId, keys, prepared, null);
    await assignVisionModel();

    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("/api/chat");
      const body = JSON.parse(String(init?.body));
      const user = body.messages.find((message: { role: string }) => message.role === "user");
      expect(user.images?.length).toBe(1);
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              dreams: [
                {
                  pages: [1],
                  date: "2026-08-17",
                  title: "The cathedral",
                  body: `I dreamt of ${CANARY}`,
                  bodyConfidence: 0.77,
                  tags: [],
                  lucidity: null,
                  isFragment: false,
                },
              ],
            }),
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchImpl);

    await enqueueAttachmentJob(userId, id, "ocr_attachment");
    expect(await processNextJob()).toBe("done");

    const stored = await getAttachment(userId, keys, id);
    expect(stored?.status).toBe("succeeded");
    expect(stored?.dreams[0]?.body.value).toContain(CANARY);
    expect(stored?.dreams[0]?.body.confidence).toBeCloseTo(0.77);

    const [row] = await db.select().from(attachments).where(eq(attachments.id, id));
    expect(Buffer.from(row!.transcriptEnc!).toString("utf8")).not.toContain(CANARY);

    const [job] = await db.select().from(jobs);
    expect(job?.status).toBe("succeeded");
    expect(job?.lastError).toBeNull();
  });

  /*
   * The assertion the whole flow exists for. Three pages holding two dreams --
   * one of them running across a page break -- come back as two entries from
   * ONE model call, with the photographs filed against the entry each belongs
   * to. Doing this a page at a time could not answer either question, and left
   * both to the writer as a tick-box join and a second model pass.
   */
  it("reads a whole stack in one call and carves it into separate dreams", async () => {
    const stackId = randomUUID();
    const ids: string[] = [];
    for (const shade of [10, 20, 30]) {
      const prepared = await prepareImage(await tinyJpeg(shade));
      const created = await createImageAttachment(userId, keys, prepared, stackId);
      ids.push(created.id);
    }
    await assignVisionModel();

    const calls: number[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const user = body.messages.find((message: { role: string }) => message.role === "user");
      calls.push(user.images?.length ?? 0);
      expect(user.content).toMatch(/pages 1 to 3/);
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              dreams: [
                {
                  pages: [1, 2],
                  date: "2026-08-17",
                  title: "The cathedral",
                  body: `I dreamt of ${CANARY}, and it went on`,
                  bodyConfidence: 0.8,
                  tags: ["flying"],
                  lucidity: 3,
                  isFragment: false,
                },
                {
                  pages: [3],
                  date: "",
                  title: "",
                  body: "Then a train.",
                  bodyConfidence: 0.6,
                  tags: [],
                  lucidity: null,
                  isFragment: true,
                },
              ],
            }),
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchImpl);

    await enqueueAttachmentJob(userId, ids[0]!, "ocr_attachment");
    expect(await processNextJob()).toBe("done");

    // One call, carrying every page.
    expect(calls).toEqual([3]);

    const stack = await getStack(userId, keys, stackId);
    expect(stack?.leadId).toBe(ids[0]);
    expect(stack?.pages.map((page) => page.id)).toEqual(ids);
    expect(stack?.dreams).toHaveLength(2);
    expect(stack?.dreams[0]?.pages).toEqual([1, 2]);
    expect(stack?.dreams[1]?.pages).toEqual([3]);
    expect(stack?.dreams[1]?.isFragment).toBe(true);

    // Every page moved with the lead, so the inbox shows one thing to review.
    const stacks = await listStacks(userId, keys);
    expect(stacks).toHaveLength(1);
    expect(stacks[0]?.status).toBe("succeeded");

    const rows = await db.select().from(attachments).where(eq(attachments.userId, userId));
    expect(rows.every((row) => row.status === "succeeded")).toBe(true);
    for (const row of rows) {
      if (row.transcriptEnc) {
        expect(Buffer.from(row.transcriptEnc).toString("utf8")).not.toContain(CANARY);
      }
    }
  });

  it("files each photograph with the dream it was read off", async () => {
    const stackId = randomUUID();
    const ids: string[] = [];
    for (const shade of [40, 50]) {
      const prepared = await prepareImage(await tinyJpeg(shade));
      const created = await createImageAttachment(userId, keys, prepared, stackId);
      ids.push(created.id);
    }

    const dreamIds = await confirmAsDreams(userId, keys, {
      parts: [
        {
          nightDate: "2026-08-17",
          title: "Flying",
          body: `over ${CANARY}`,
          lucidity: 0,
          tags: [],
          isFragment: false,
          attachmentIds: [ids[0]!],
        },
        {
          nightDate: "2026-08-17",
          title: "Train",
          body: "then a train",
          lucidity: 0,
          tags: [],
          isFragment: true,
          attachmentIds: [ids[1]!],
        },
      ],
      source: "ocr",
      attachmentIds: ids,
      isDraft: false,
    });

    const rows = await db.select().from(attachments).where(eq(attachments.userId, userId));
    const byId = new Map(rows.map((row) => [row.id, row.dreamId]));
    expect(byId.get(ids[0]!)).toBe(dreamIds[0]);
    expect(byId.get(ids[1]!)).toBe(dreamIds[1]);
  });
});

describe("reading parsing used by the worker", () => {
  it("does not put model chatter in a thrown error", () => {
    expect(() => parseStackReading(`sure, here is ${CANARY}`, 1)).toThrow(/did not return JSON/);
  });
});
