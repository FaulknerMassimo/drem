/**
 * What actually goes inside an archive.
 *
 * Pure: no database, no keys. The container in `crypto/archive.ts` encrypts
 * whatever this produces, and `restore.ts` validates every row back through
 * `dreamInputSchema` before writing, so a hand-edited archive cannot smuggle an
 * oversized body past the limits the editor enforces.
 *
 * **What is in it, and what is not.** The archive holds the nights, the dreams
 * and their tags — the things a person wrote, which no amount of computation
 * can reconstruct. It deliberately omits insights, embeddings, dream signs and
 * attachment blobs. The first three are derived: re-running a model over a
 * restored journal rebuilds them, and carrying them would double the file for
 * data that goes stale the moment a prompt or an embedding model changes. The
 * blobs are excluded because they are files rather than rows, they dwarf the
 * text by orders of magnitude, and they are already backed up by copying
 * `UPLOAD_DIR` — see `docs/BACKUP.md`, which says all of this to the operator
 * rather than only to the reader of this comment.
 *
 * **No ids.** Rows are keyed by date, not by uuid. A uuid means nothing outside
 * the database it came from, and matching on one would make a restore into a
 * fresh install behave differently from a restore into an existing one. Dreams
 * find their night by `nightDate`, which is the same thing the journal itself
 * keys on.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { isIsoDate } from "@/lib/journal/dates";
import { TECHNIQUES } from "@/lib/journal/labels";
import {
  MAX_BODY_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_TAGS_PER_DREAM,
  MAX_TAG_LENGTH,
  MAX_TITLE_LENGTH,
} from "@/lib/journal/validation";

export const DOCUMENT_FORMAT = "drem-journal";
export const DOCUMENT_VERSION = 1;

const isoDate = z.string().refine(isIsoDate, "That is not a valid date.");
const clockTime = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable();
const rating = z.number().int().min(1).max(5).nullable();

export const archiveNightSchema = z.object({
  date: isoDate,
  bedTime: clockTime,
  wakeTime: clockTime,
  wbtbTime: clockTime,
  sleepQuality: rating,
  techniques: z.array(z.enum(TECHNIQUES)),
  noRecall: z.boolean(),
  notes: z.string().max(MAX_NOTES_LENGTH).nullable(),
});

export const archiveDreamSchema = z.object({
  nightDate: isoDate,
  title: z.string().max(MAX_TITLE_LENGTH).nullable(),
  body: z.string().max(MAX_BODY_LENGTH).nullable(),
  lucidity: z.number().int().min(0).max(5),
  vividness: rating,
  control: rating,
  recallClarity: rating,
  emotionalValence: z.number().int().min(-2).max(2).nullable(),
  isNightmare: z.boolean(),
  isRecurring: z.boolean(),
  isFragment: z.boolean(),
  isDraft: z.boolean(),
  source: z.enum(["typed", "quick_capture", "ocr", "voice", "import"]),
  /** ISO instant. Preserved so a restore reproduces the order within a night. */
  createdAt: z.string(),
  tags: z.array(z.string().max(MAX_TAG_LENGTH)).max(MAX_TAGS_PER_DREAM),
});

export const archiveDocumentSchema = z.object({
  format: z.literal(DOCUMENT_FORMAT),
  version: z.literal(DOCUMENT_VERSION),
  exportedAt: z.string(),
  nights: z.array(archiveNightSchema),
  dreams: z.array(archiveDreamSchema),
});

export type ArchiveNight = z.infer<typeof archiveNightSchema>;
export type ArchiveDream = z.infer<typeof archiveDreamSchema>;
export type ArchiveDocument = z.infer<typeof archiveDocumentSchema>;

export class ArchiveDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveDocumentError";
  }
}

export function serialiseDocument(document: ArchiveDocument): string {
  return JSON.stringify(document);
}

/**
 * Parses a decrypted archive.
 *
 * Everything past this point can assume the shape is right. The error is one
 * sentence and names no value, for the same reason `firstIssue()` does: the
 * values in question are dream text.
 */
export function parseDocument(text: string): ArchiveDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ArchiveDocumentError("That archive's contents could not be read.");
  }

  const parsed = archiveDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ArchiveDocumentError(
      "That archive is not in a format this version understands.",
    );
  }
  return parsed.data;
}

/**
 * A content identity for a dream, so restoring the same archive twice does not
 * double the journal.
 *
 * Over the date and the text only. The ratings are deliberately excluded: an
 * entry whose vividness was edited after the backup was taken is still the same
 * dream, and re-importing it should not produce a second copy of it. The cost
 * of that choice is that two genuinely different dreams with identical text on
 * the same night collapse to one, which is not a thing that happens.
 */
export function dreamFingerprint(
  dream: Pick<ArchiveDream, "nightDate" | "title" | "body">,
): string {
  return createHash("sha256")
    .update(`${dream.nightDate}\n${dream.title ?? ""}\n${dream.body ?? ""}`, "utf8")
    .digest("hex");
}

export interface DocumentSummary {
  nights: number;
  dreams: number;
  lucidDreams: number;
  from: string | null;
  to: string | null;
  exportedAt: string;
}

/** What the confirm screen shows before anything is written. */
export function summariseDocument(document: ArchiveDocument): DocumentSummary {
  const dates = [
    ...document.nights.map((night) => night.date),
    ...document.dreams.map((dream) => dream.nightDate),
  ].sort();

  return {
    nights: document.nights.length,
    dreams: document.dreams.length,
    lucidDreams: document.dreams.filter((dream) => dream.lucidity > 0).length,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    exportedAt: document.exportedAt,
  };
}

/** `drem-2026-08-19.dremarchive` — sorts chronologically in a directory listing. */
export function archiveFilename(now: Date = new Date()): string {
  return `drem-${now.toISOString().slice(0, 10)}.dremarchive`;
}
