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
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
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
import { imageForModel, type ImageMime, type PreparedImage } from "./image";
import type { ExtractedFields } from "./fields";
import {
  emptyFields,
  parseStoredFields,
  serialiseFields,
} from "./fields";

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
  kind: AttachmentKind;
  mimeType: string;
  byteSize: number;
  status: AttachmentStatus;
  confidence: number | null;
  fields: ExtractedFields;
  createdAt: Date;
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
    kind: row.kind,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    status: row.status,
    confidence: row.confidence,
    fields: transcript ? parseStoredFields(transcript) : emptyFields(),
    createdAt: row.createdAt,
  };
}

export function isAudioMime(value: string): boolean {
  return AUDIO_MIMES.has(value) || value.startsWith("audio/");
}

export async function createImageAttachment(
  userId: string,
  keys: UserKeys,
  prepared: PreparedImage,
): Promise<{ id: string; duplicate: boolean }> {
  return createBlobAttachment(userId, keys, {
    kind: "image",
    mimeType: prepared.mimeType,
    bytes: prepared.bytes,
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
  input: { kind: AttachmentKind; mimeType: string; bytes: Buffer },
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

export async function listInbox(
  userId: string,
  keys: UserKeys,
): Promise<AttachmentRecord[]> {
  const rows = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.userId, userId), isNull(attachments.dreamId)))
    .orderBy(desc(attachments.createdAt));
  return rows.map((row) => decodeRow(keys, row));
}

export async function countInbox(userId: string): Promise<number> {
  const rows = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(eq(attachments.userId, userId), isNull(attachments.dreamId)));
  return rows.length;
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

export async function saveTranscript(
  userId: string,
  keys: UserKeys,
  attachmentId: string,
  fields: ExtractedFields,
  status: AttachmentStatus = "succeeded",
): Promise<void> {
  const confidence = fields.body.confidence;
  await db
    .update(attachments)
    .set({
      transcriptEnc: encryptOptional(keys.field, serialiseFields(fields), transcriptAad(attachmentId)),
      status,
      confidence,
    })
    .where(and(eq(attachments.id, attachmentId), eq(attachments.userId, userId)));
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
