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
  tags: string[];
  isFragment: boolean;
}

function asInput(fields: ConfirmFields, isDraft: boolean): DreamInput {
  return dreamInputSchema.parse({
    nightDate: fields.nightDate,
    title: fields.title,
    body: fields.body,
    lucidity: fields.lucidity,
    vividness: null,
    control: null,
    recallClarity: null,
    emotionalValence: null,
    isNightmare: false,
    isRecurring: false,
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
    tags: [],
    isFragment: part.isFragment,
  };
}
