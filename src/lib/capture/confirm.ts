/**
 * Turns a confirmed capture (or a split log) into journal entries.
 *
 * Shared by the review screen, file import, and the "split this log" action
 * on an existing dream, so the AAD-bound write path is the same as typing.
 */
import "server-only";
import type { UserKeys } from "@/lib/crypto/envelope";
import { createDream, updateDream, type DreamSource } from "@/lib/journal/dreams";
import { dreamInputSchema, type DreamInput } from "@/lib/journal/validation";
import { queueLocalEmbeddings } from "@/lib/semantic/queue";
import type { IsoDate } from "@/lib/journal/dates";
import { attachToDream } from "./attachments";
import type { SplitPart } from "./fields";
import type { ImportedDream } from "./import-parse";

export interface ConfirmFields {
  nightDate: IsoDate;
  title: string | null;
  body: string;
  lucidity: number;
  vividness?: number | null;
  control?: number | null;
  recallClarity?: number | null;
  emotionalValence?: number | null;
  isNightmare?: boolean;
  isRecurring?: boolean;
  tags: string[];
  isFragment: boolean;
  /**
   * The pages this entry was read off, filed with it.
   *
   * One stack of photographs can hold several dreams, and the photograph of
   * the second one belongs to the second entry. Anything no part claims falls
   * to the first, which is where a single-entry review leaves everything.
   */
  attachmentIds?: string[];
}

function asInput(fields: ConfirmFields, isDraft: boolean): DreamInput {
  return dreamInputSchema.parse({
    nightDate: fields.nightDate,
    title: fields.title,
    body: fields.body,
    lucidity: fields.lucidity,
    vividness: fields.vividness ?? null,
    control: fields.control ?? null,
    recallClarity: fields.recallClarity ?? null,
    emotionalValence: fields.emotionalValence ?? null,
    isNightmare: fields.isNightmare ?? false,
    isRecurring: fields.isRecurring ?? false,
    isFragment: fields.isFragment,
    isDraft,
    tags: fields.tags,
  });
}

export async function confirmAsDreams(
  userId: string,
  keys: UserKeys,
  options: {
    parts: ConfirmFields[];
    source: DreamSource;
    attachmentIds: string[];
    isDraft: boolean;
    replaceDreamId?: string;
  },
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < options.parts.length; i++) {
    const input = asInput(options.parts[i]!, options.isDraft);
    let id: string;
    if (i === 0 && options.replaceDreamId) {
      const updated = await updateDream(userId, keys, options.replaceDreamId, input);
      if (!updated) throw new Error("That entry no longer exists.");
      id = options.replaceDreamId;
    } else {
      // Stagger createdAt so a night's list keeps the split order.
      id = await createDream(userId, keys, input, options.source);
    }
    ids.push(id);
  }

  /*
   * Per-part first, so a page the model attributed to the second dream is
   * filed against the second entry. `attachToDream` only claims rows that are
   * still unattached, so the sweep afterwards cannot steal one back: whatever
   * no part asked for lands on the first entry.
   */
  for (let i = 0; i < options.parts.length; i++) {
    const claimed = options.parts[i]!.attachmentIds ?? [];
    if (ids[i] && claimed.length > 0) await attachToDream(userId, ids[i]!, claimed);
  }
  if (ids[0] && options.attachmentIds.length > 0) {
    await attachToDream(userId, ids[0], options.attachmentIds);
  }
  // Confirmed entries are real entries; they belong in the search index like
  // any other. Local embedding models only — see queueLocalEmbeddings.
  await queueLocalEmbeddings(userId, keys, ids);
  return ids;
}

export function importedToFields(entry: ImportedDream): ConfirmFields {
  return {
    nightDate: entry.nightDate,
    title: entry.title,
    body: entry.body,
    lucidity: entry.lucidity,
    vividness: entry.vividness,
    control: entry.control,
    recallClarity: entry.recallClarity,
    emotionalValence: entry.emotionalValence,
    isNightmare: entry.isNightmare,
    isRecurring: entry.isRecurring,
    tags: entry.tags,
    isFragment: entry.isFragment,
  };
}

export function splitToFields(part: SplitPart, nightDate: IsoDate, lucidity: number): ConfirmFields {
  return {
    nightDate,
    title: part.title,
    body: part.body,
    lucidity,
    vividness: part.vividness,
    control: part.control,
    recallClarity: part.recallClarity,
    emotionalValence: part.emotionalValence,
    isNightmare: part.isNightmare,
    isRecurring: part.isRecurring,
    tags: part.tags ?? [],
    isFragment: part.isFragment,
  };
}
