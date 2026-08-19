/**
 * Capture: encrypted attachments, OCR/transcript storage, and split-into-entries.
 *
 * Requires: npm run dev:up
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  createImageAttachment,
  getAttachment,
  readAttachmentBlob,
  saveTranscript,
} from "./attachments";
import { confirmAsDreams, splitToFields } from "./confirm";
import { fieldsFromTranscript, parseExtractedFields } from "./fields";
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

async function tinyJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 12, height: 12, channels: 3, background: { r: 30, g: 20, b: 50 } },
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
    const { id } = await createImageAttachment(userId, keys, prepared);

    const blob = await readAttachmentBlob(userId, keys, id);
    expect(blob?.bytes.equals(prepared.bytes)).toBe(true);

    const [row] = await db.select().from(attachments).where(eq(attachments.id, id));
    const stored = await readFile(path.join(env().UPLOAD_DIR, row!.storageKey));
    expect(stored.equals(prepared.bytes)).toBe(false);
    expect(stored.toString("utf8")).not.toContain(CANARY);
  });

  it("stores an OCR transcript encrypted, bound to the row", async () => {
    const prepared = await prepareImage(await tinyJpeg());
    const { id } = await createImageAttachment(userId, keys, prepared);
    await saveTranscript(userId, keys, id, fieldsFromTranscript(`page: ${CANARY}`, 0.81));

    const record = await getAttachment(userId, keys, id);
    expect(record?.fields.body.value).toBe(`page: ${CANARY}`);
    expect(record?.fields.body.confidence).toBeCloseTo(0.81);

    const [row] = await db.select().from(attachments).where(eq(attachments.id, id));
    expect(Buffer.from(row!.transcriptEnc!).toString("utf8")).not.toContain(CANARY);
    expect(Buffer.from(row!.transcriptEnc!).toString("utf8")).not.toContain("page:");
  });

  it("queues only the attachment id, never the transcript", async () => {
    const prepared = await prepareImage(await tinyJpeg());
    const { id } = await createImageAttachment(userId, keys, prepared);
    await saveTranscript(userId, keys, id, fieldsFromTranscript(`page: ${CANARY}`, null));
    await enqueueAttachmentJob(userId, id, "ocr_attachment");

    const [job] = await db.select().from(jobs);
    expect(parseAttachmentPayload(job!.payload).attachmentId).toBe(id);
    expect(JSON.stringify(job!.payload)).not.toContain(CANARY);
    expect(JSON.stringify(job!.payload)).not.toContain("page:");
  });
});

describe("confirming a capture", () => {
  it("writes separate drafts when a log is split", async () => {
    const ids = await confirmAsDreams(userId, keys, {
      parts: [
        splitToFields({ title: "Flying", body: `over ${CANARY}`, isFragment: false }, "2026-08-17", 0),
        splitToFields({ title: "Train", body: "then a train", isFragment: true }, "2026-08-17", 0),
      ],
      source: "ocr",
      attachmentIds: [],
      isDraft: true,
    });
    expect(ids).toHaveLength(2);

    const rows = await db.select().from(dreams).where(eq(dreams.userId, userId));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.isDraft)).toBe(true);
    expect(rows.filter((row) => row.isFragment)).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(CANARY);
  });
});

describe("the OCR worker", () => {
  it("decrypts the page, calls the adapter, and stores encrypted fields", async () => {
    const prepared = await prepareImage(await tinyJpeg());
    const { id } = await createImageAttachment(userId, keys, prepared);

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
    putKeys("worker", userId, keys, 60_000);

    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("/api/chat");
      const body = JSON.parse(String(init?.body));
      const user = body.messages.find((message: { role: string }) => message.role === "user");
      expect(user.images?.length).toBe(1);
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              date: "2026-08-17",
              title: "The cathedral",
              body: `I dreamt of ${CANARY}`,
              bodyConfidence: 0.77,
              tags: [],
              lucidity: null,
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
    expect(stored?.fields.body.value).toContain(CANARY);
    expect(stored?.fields.body.confidence).toBeCloseTo(0.77);

    const [row] = await db.select().from(attachments).where(eq(attachments.id, id));
    expect(Buffer.from(row!.transcriptEnc!).toString("utf8")).not.toContain(CANARY);

    const [job] = await db.select().from(jobs);
    expect(job?.status).toBe("succeeded");
    expect(job?.lastError).toBeNull();
  });
});

describe("extracted field parsing used by the worker", () => {
  it("does not put model chatter in a thrown error", () => {
    expect(() => parseExtractedFields(`sure, here is ${CANARY}`)).toThrow(/did not return JSON/);
  });
});
