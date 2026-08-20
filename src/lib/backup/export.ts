import "server-only";
import { sealArchive } from "@/lib/crypto/archive";
import type { UserKeys } from "@/lib/crypto/envelope";
import { dreamsInRange } from "@/lib/journal/dreams";
import { nightsInRange } from "@/lib/journal/nights";
import {
  DOCUMENT_FORMAT,
  DOCUMENT_VERSION,
  serialiseDocument,
  summariseDocument,
  type ArchiveDocument,
  type DocumentSummary,
} from "./document";

/**
 * Taking a backup.
 *
 * This is the one operation in the app that deliberately decrypts the entire
 * journal at once and hands it to the browser as a file. That is the point of
 * it, and it is why the export screen states the trade-off before doing it: the
 * result is protected by its passphrase alone, with no MASTER_KEY behind it.
 *
 * The whole archive is assembled in memory. At journal scale — a decade of
 * nightly entries is a few tens of megabytes of text — that is fine, and the
 * alternative is streaming a file whose encryption has to be finalised at the
 * end anyway.
 */

/** Wide enough to hold any journal; the queries are range-scans either way. */
const EARLIEST = "0001-01-01";
const LATEST = "9999-12-31";

export async function buildDocument(
  userId: string,
  keys: UserKeys,
  now: Date = new Date(),
): Promise<ArchiveDocument> {
  const [nights, dreams] = await Promise.all([
    nightsInRange(userId, keys, EARLIEST, LATEST),
    dreamsInRange(userId, keys, EARLIEST, LATEST),
  ]);

  return {
    format: DOCUMENT_FORMAT,
    version: DOCUMENT_VERSION,
    exportedAt: now.toISOString(),
    nights: nights.map((night) => ({
      date: night.date,
      bedTime: night.bedTime,
      wakeTime: night.wakeTime,
      wbtbTime: night.wbtbTime,
      sleepQuality: night.sleepQuality,
      techniques: night.techniques,
      noRecall: night.noRecall,
      notes: night.notes,
    })),
    dreams: dreams.map((dream) => ({
      nightDate: dream.dreamDate,
      title: dream.title,
      body: dream.body,
      lucidity: dream.lucidity,
      vividness: dream.vividness,
      control: dream.control,
      recallClarity: dream.recallClarity,
      emotionalValence: dream.emotionalValence,
      isNightmare: dream.isNightmare,
      isRecurring: dream.isRecurring,
      isFragment: dream.isFragment,
      isDraft: dream.isDraft,
      source: dream.source,
      createdAt: dream.createdAt.toISOString(),
      tags: dream.tags,
    })),
  };
}

export interface ExportResult {
  file: Buffer;
  summary: DocumentSummary;
}

export async function exportArchive(
  userId: string,
  keys: UserKeys,
  passphrase: string,
  now: Date = new Date(),
): Promise<ExportResult> {
  const document = await buildDocument(userId, keys, now);
  const serialised = serialiseDocument(document);
  const file = await sealArchive(passphrase, serialised, { now });
  return { file, summary: summariseDocument(document) };
}
