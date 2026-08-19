/**
 * Encrypted attachments: photographed pages and voice memos.
 *
 * The file on disk is ciphertext under the blob key, bound to this row's id.
 * The transcript (OCR fields or speech) is a separate field ciphertext. A
 * stolen uploads directory plus a stolen database still yields nothing
 * readable without the live session's keys.
 */
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { attachments, dreams } from "@/db/schema";
import {
  decrypt,
  decryptStringOptional,
  encrypt,
  encryptOptional,
  type Aad,
} from "@/lib/crypto/aead";
import type { UserKeys } from "@/lib/crypto/envelope";
import { env } from "@/lib/env";
import { openCaptureAttachmentIds } from "@/lib/ai/jobs";
import { imageForModel, type ImageMime, type PreparedImage } from "./image";
import type { ReadDream } from "./fields";
import { parseStoredReading, serialiseReading } from "./fields";

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_UPLOAD_BATCH = 20;

const AUDIO_MIMES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
  "audio/x-m4a",
]);

export type AttachmentKind = import("./types").AttachmentKind;
export type AttachmentStatus = import("./types").AttachmentStatus;

export interface AttachmentRecord {
  id: string;
  dreamId: string | null;
  stackId: string;
  kind: AttachmentKind;
  mimeType: string;
  byteSize: number;
  status: AttachmentStatus;
  confidence: number | null;
  /** Empty until this row is a stack's lead and its reading has landed. */
  dreams: ReadDream[];
  createdAt: Date;
}

/**
 * The pages of one stack and the dreams read off them.
 *
 * `pages` is in photograph order, which is the order they were sent to the
 * model and therefore what the dreams' page numbers index into.
 *
 * `id` is the stack's own key — the `stack_id` the upload form minted, or the
 * row's own id for anything predating stacks. `leadId` is the page that
 * carries the reading and the job. They are usually different values and are
 * not interchangeable: addressing a stack by its lead worked only for a stack
 * of one, which is exactly the case that hides the bug.
 */
export interface StackRecord {
  id: string;
  leadId: string;
  kind: AttachmentKind;
  status: AttachmentStatus;
  /**
   * Whether this stack has been handed to a model yet.
   *
   * A page is stored at `pending` and stays there until the writer sends the
   * stack, so the status alone cannot tell "waiting for the worker" from
   * "still being photographed" — and calling the second one "reading…" is a
   * screen that lies about where the dream is.
   */
  sent: boolean;
  pages: AttachmentRecord[];
  dreams: ReadDream[];
}

export interface AttachmentBlob {
  bytes: Buffer;
  mimeType: string;
}

function blobAad(id: string): Aad {
  return { table: "attachments", column: "blob", id };
}

function transcriptAad(id: string): Aad {
  return { table: "attachments", column: "transcript_enc", id };
}

function storageKeyFor(userId: string, id: string): string {
  return `${userId}/${id}`;
}

function absolutePath(storageKey: string): string {
  return path.join(env().UPLOAD_DIR, storageKey);
}

function digestOf(bytes: Buffer): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function decodeRow(keys: UserKeys, row: typeof attachments.$inferSelect): AttachmentRecord {
  const transcript = decryptStringOptional(keys.field, row.transcriptEnc, transcriptAad(row.id));
  return {
    id: row.id,
    dreamId: row.dreamId,
    stackId: stackOf(row),
    kind: row.kind,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    status: row.status,
    confidence: row.confidence,
    dreams: transcript ? parseStoredReading(transcript) : [],
    createdAt: row.createdAt,
  };
}

/**
 * Which stack a row belongs to.
 *
 * A row uploaded before stacks existed, or a voice memo, has no `stack_id` and
 * is a stack of one under its own id. Folding here rather than backfilling
 * keeps the column meaning exactly one thing -- "these arrived together" --
 * instead of also meaning "and these did not, but something had to go here".
 */
function stackOf(row: { id: string; stackId: string | null }): string {
  return row.stackId ?? row.id;
}

export function isAudioMime(value: string): boolean {
  return AUDIO_MIMES.has(value) || value.startsWith("audio/");
}

export async function createImageAttachment(
  userId: string,
  keys: UserKeys,
  prepared: PreparedImage,
  stackId: string | null,
): Promise<{ id: string; duplicate: boolean }> {
  return createBlobAttachment(userId, keys, {
    kind: "image",
    mimeType: prepared.mimeType,
    bytes: prepared.bytes,
    stackId,
  });
}

export async function createAudioAttachment(
  userId: string,
  keys: UserKeys,
  bytes: Buffer,
  mimeType: string,
): Promise<{ id: string; duplicate: boolean }> {
  if (bytes.length > MAX_AUDIO_BYTES) {
    throw new Error("That recording is too large to store (25 MB limit).");
  }
  if (!isAudioMime(mimeType)) {
    throw new Error("That audio format is not supported.");
  }
  return createBlobAttachment(userId, keys, { kind: "audio", mimeType, bytes });
}

async function createBlobAttachment(
  userId: string,
  keys: UserKeys,
  input: { kind: AttachmentKind; mimeType: string; bytes: Buffer; stackId?: string | null },
): Promise<{ id: string; duplicate: boolean }> {
  const sha256 = digestOf(input.bytes);

  const [existing] = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(
      and(
        eq(attachments.userId, userId),
        eq(attachments.sha256, sha256),
        isNull(attachments.dreamId),
      ),
    )
    .limit(1);
  if (existing) return { id: existing.id, duplicate: true };

  const id = randomUUID();
  const storageKey = storageKeyFor(userId, id);
  await writeEncryptedBlob(keys, id, storageKey, input.bytes);

  await db.insert(attachments).values({
    id,
    userId,
    dreamId: null,
    stackId: input.stackId ?? null,
    kind: input.kind,
    mimeType: input.mimeType,
    byteSize: input.bytes.length,
    sha256,
    storageKey,
    status: "pending",
  });

  return { id, duplicate: false };
}

async function writeEncryptedBlob(
  keys: UserKeys,
  id: string,
  storageKey: string,
  plaintext: Buffer,
): Promise<void> {
  const ciphertext = encrypt(keys.blob, plaintext, blobAad(id));
  const dest = absolutePath(storageKey);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, ciphertext);
}

export async function readAttachmentBlob(
  userId: string,
  keys: UserKeys,
  attachmentId: string,
): Promise<AttachmentBlob | null> {
  const [row] = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.userId, userId)))
    .limit(1);
  if (!row) return null;

  const ciphertext = await readFile(absolutePath(row.storageKey));
  const bytes = decrypt(keys.blob, ciphertext, blobAad(row.id));
  return { bytes, mimeType: row.mimeType };
}

export async function imageBytesForModel(
  userId: string,
  keys: UserKeys,
  attachmentId: string,
): Promise<{ bytes: Buffer; mimeType: ImageMime } | null> {
  const blob = await readAttachmentBlob(userId, keys, attachmentId);
  if (!blob) return null;
  if (blob.mimeType !== "image/jpeg" && blob.mimeType !== "image/png" && blob.mimeType !== "image/webp") {
    return null;
  }
  const mimeType = blob.mimeType;
  const bytes = await imageForModel(blob.bytes, mimeType);
  return { bytes, mimeType };
}

export async function getAttachment(
  userId: string,
  keys: UserKeys,
  attachmentId: string,
): Promise<AttachmentRecord | null> {
  const [row] = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.userId, userId)))
    .limit(1);
  return row ? decodeRow(keys, row) : null;
}

/**
 * Everything waiting for review, oldest first.
 *
 * The order is the order the pages were photographed, which is the order they
 * have to be read in: each page is copied on its own and the copies are joined
 * in that order, so page three arriving first would file the dreams against
 * the wrong photographs.
 */
export async function listInbox(
  userId: string,
  keys: UserKeys,
): Promise<AttachmentRecord[]> {
  const rows = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.userId, userId), isNull(attachments.dreamId)))
    .orderBy(asc(attachments.createdAt));
  return rows.map((row) => decodeRow(keys, row));
}

/**
 * The inbox as stacks rather than as loose files.
 *
 * A stack's status is its lead page's, because the lead is what carries the
 * job: one reading covers every page, so a stack is never half read. Its
 * dreams are the lead's too, for the same reason.
 */
export async function listStacks(userId: string, keys: UserKeys): Promise<StackRecord[]> {
  const [pages, queued] = await Promise.all([
    listInbox(userId, keys),
    openCaptureAttachmentIds(userId),
  ]);
  return groupStacks(pages, queued);
}

export async function getStack(
  userId: string,
  keys: UserKeys,
  stackId: string,
): Promise<StackRecord | null> {
  const stacks = await listStacks(userId, keys);
  return stacks.find((stack) => stack.id === stackId) ?? null;
}

function groupStacks(pages: AttachmentRecord[], queued: Set<string>): StackRecord[] {
  const byStack = new Map<string, AttachmentRecord[]>();
  for (const page of pages) {
    const group = byStack.get(page.stackId);
    if (group) group.push(page);
    else byStack.set(page.stackId, [page]);
  }

  const stacks: StackRecord[] = [];
  for (const [id, group] of byStack) {
    const lead = group[0]!;
    stacks.push({
      id,
      leadId: lead.id,
      kind: lead.kind,
      status: lead.status,
      sent: lead.status !== "pending" || queued.has(lead.id),
      pages: group,
      dreams: lead.dreams,
    });
  }
  return stacks;
}

/** The stack a page belongs to, for callers that only hold a page's id. */
export async function stackKeyOf(userId: string, attachmentId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: attachments.id, stackId: attachments.stackId })
    .from(attachments)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.userId, userId)))
    .limit(1);
  return row ? stackOf(row) : null;
}

/** The pages of a stack in photograph order, for the model call. */
export async function stackPageIds(userId: string, stackId: string): Promise<string[]> {
  const rows = await db
    .select({ id: attachments.id, stackId: attachments.stackId })
    .from(attachments)
    .where(and(eq(attachments.userId, userId), isNull(attachments.dreamId)))
    .orderBy(asc(attachments.createdAt));
  return rows.filter((row) => stackOf(row) === stackId).map((row) => row.id);
}

/**
 * How many things are waiting for review, counted as stacks.
 *
 * A four-page night is one thing to review, not four. Counting rows made the
 * badge in the header read like a backlog every time a page turned.
 */
export async function countInbox(userId: string): Promise<number> {
  const rows = await db
    .select({ id: attachments.id, stackId: attachments.stackId })
    .from(attachments)
    .where(and(eq(attachments.userId, userId), isNull(attachments.dreamId)));
  return new Set(rows.map((row) => stackOf(row))).size;
}

export async function listAttachmentsForDream(
  userId: string,
  keys: UserKeys,
  dreamId: string,
): Promise<AttachmentRecord[]> {
  const rows = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.userId, userId), eq(attachments.dreamId, dreamId)))
    .orderBy(asc(attachments.createdAt));
  return rows.map((row) => decodeRow(keys, row));
}

/**
 * Writes a stack's reading onto its lead page.
 *
 * The reading belongs to the stack, and the stack has no row of its own, so it
 * lands on the row the stack is addressed by. The other pages carry no
 * transcript: splitting one reading across the rows it came from would mean
 * re-deriving which words came off which page, which is exactly the guesswork
 * reading the pages together exists to avoid.
 *
 * Confidence on the row stays the *body* confidence of the first dream, which
 * is what the inbox shows; the per-dream figures live inside the reading.
 */
export async function saveReading(
  userId: string,
  keys: UserKeys,
  leadId: string,
  dreams: ReadDream[],
  status: AttachmentStatus = "succeeded",
): Promise<void> {
  await db
    .update(attachments)
    .set({
      transcriptEnc: encryptOptional(keys.field, serialiseReading(dreams), transcriptAad(leadId)),
      status,
      confidence: dreams[0]?.body.confidence ?? null,
    })
    .where(and(eq(attachments.id, leadId), eq(attachments.userId, userId)));
}

export async function markAttachmentStatus(
  userId: string,
  attachmentId: string,
  status: AttachmentStatus,
): Promise<void> {
  await db
    .update(attachments)
    .set({ status })
    .where(and(eq(attachments.id, attachmentId), eq(attachments.userId, userId)));
}

/**
 * Moves every page of a stack to one status.
 *
 * The lead's status is what the UI reads, but the followers' has to track it
 * too: a page left at `pending` after its stack was read shows up as a stack
 * of one still waiting, which is a review screen for a page that has already
 * been reviewed.
 */
export async function markStackStatus(
  userId: string,
  stackId: string,
  status: AttachmentStatus,
): Promise<void> {
  const ids = await stackPageIds(userId, stackId);
  if (ids.length === 0) return;
  await db
    .update(attachments)
    .set({ status })
    .where(and(eq(attachments.userId, userId), inArray(attachments.id, ids)));
}

export async function attachToDream(
  userId: string,
  dreamId: string,
  attachmentIds: string[],
): Promise<void> {
  const ids = [...new Set(attachmentIds)].filter(Boolean);
  if (ids.length === 0) return;
  await db
    .update(attachments)
    .set({ dreamId })
    .where(and(eq(attachments.userId, userId), inArray(attachments.id, ids), isNull(attachments.dreamId)));
}

export async function discardAttachment(userId: string, attachmentId: string): Promise<boolean> {
  const [row] = await db
    .select({ storageKey: attachments.storageKey, dreamId: attachments.dreamId })
    .from(attachments)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.userId, userId)))
    .limit(1);
  if (!row || row.dreamId) return false;

  await db
    .delete(attachments)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.userId, userId)));
  await unlinkQuiet(absolutePath(row.storageKey));
  return true;
}

/** Discards every page of a stack, blobs and all. */
export async function discardStack(userId: string, stackId: string): Promise<number> {
  const ids = await stackPageIds(userId, stackId);
  let removed = 0;
  for (const id of ids) {
    if (await discardAttachment(userId, id)) removed++;
  }
  return removed;
}

/**
 * Removes ciphertext files for the given dreams. Call *before* the rows
 * cascade-delete, otherwise the paths are gone and the files orphan.
 */
export async function purgeBlobsForDreams(userId: string, dreamIds: string[]): Promise<void> {
  if (dreamIds.length === 0) return;
  const rows = await db
    .select({ storageKey: attachments.storageKey })
    .from(attachments)
    .where(and(eq(attachments.userId, userId), inArray(attachments.dreamId, dreamIds)));
  await Promise.all(rows.map((row) => unlinkQuiet(absolutePath(row.storageKey))));
}

export async function purgeBlobsForNight(userId: string, nightId: string): Promise<void> {
  const dreamRows = await db
    .select({ id: dreams.id })
    .from(dreams)
    .where(and(eq(dreams.userId, userId), eq(dreams.nightId, nightId)));
  await purgeBlobsForDreams(
    userId,
    dreamRows.map((row) => row.id),
  );
}

async function unlinkQuiet(filePath: string): Promise<void> {
  await unlink(filePath).catch(() => undefined);
}
