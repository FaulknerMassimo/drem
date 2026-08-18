import "server-only";
import { randomUUID } from "node:crypto";
import { and, count, eq, inArray } from "drizzle-orm";
import { db, type Executor } from "@/db";
import { dreamTags, tags } from "@/db/schema";
import { decryptString, encrypt, type Aad } from "@/lib/crypto/aead";
import { namespacedBlindIndex } from "@/lib/crypto/blind-index";
import type { UserKeys } from "@/lib/crypto/envelope";

/**
 * Tags.
 *
 * A tag name is something a person wrote, so it is encrypted like everything
 * else — but tags also have to be grouped, counted and filtered on, which
 * ciphertext cannot do. Each name therefore carries a keyed fingerprint
 * alongside it. The namespace keeps a tag called "water" from fingerprinting
 * identically to a dream sign called "water".
 */
const TAG_NAMESPACE = "tag";

export interface TagRecord {
  id: string;
  name: string;
}

export interface TagCount extends TagRecord {
  dreamCount: number;
}

function tagAad(id: string): Aad {
  return { table: "tags", column: "name_enc", id };
}

/** The fingerprint a tag name is stored and looked up under. */
export function tagFingerprint(keys: UserKeys, name: string): Buffer {
  return namespacedBlindIndex(keys.index, TAG_NAMESPACE, name);
}

function decodeTag(keys: UserKeys, row: { id: string; nameEnc: Buffer }): TagRecord {
  return { id: row.id, name: decryptString(keys.field, row.nameEnc, tagAad(row.id)) };
}

/**
 * Finds or creates each tag, returning their ids in the order given.
 *
 * Matching is by fingerprint, so re-typing an existing tag with different
 * capitalisation attaches to the same tag rather than creating a twin. The
 * first spelling used is the one kept — renaming is a separate action, not a
 * side effect of tagging a dream.
 */
export async function resolveTagIds(
  exec: Executor,
  userId: string,
  keys: UserKeys,
  names: readonly string[],
): Promise<string[]> {
  if (names.length === 0) return [];

  const wanted = names.map((name) => ({ name, fingerprint: tagFingerprint(keys, name) }));
  const existing = await exec
    .select({ id: tags.id, nameBidx: tags.nameBidx })
    .from(tags)
    .where(
      and(
        eq(tags.userId, userId),
        inArray(
          tags.nameBidx,
          wanted.map((entry) => entry.fingerprint),
        ),
      ),
    );

  const byFingerprint = new Map(existing.map((row) => [row.nameBidx.toString("hex"), row.id]));

  const created: { id: string; userId: string; nameEnc: Buffer; nameBidx: Buffer }[] = [];
  const ids: string[] = [];
  for (const entry of wanted) {
    const key = entry.fingerprint.toString("hex");
    const found = byFingerprint.get(key);
    if (found) {
      ids.push(found);
      continue;
    }
    const id = randomUUID();
    created.push({
      id,
      userId,
      nameEnc: encrypt(keys.field, entry.name, tagAad(id)),
      nameBidx: entry.fingerprint,
    });
    byFingerprint.set(key, id);
    ids.push(id);
  }

  if (created.length > 0) await exec.insert(tags).values(created);
  return ids;
}

/** Replaces a dream's tags wholesale; the form always submits the full set. */
export async function setDreamTags(
  exec: Executor,
  userId: string,
  keys: UserKeys,
  dreamId: string,
  names: readonly string[],
): Promise<void> {
  const tagIds = await resolveTagIds(exec, userId, keys, names);
  await exec.delete(dreamTags).where(eq(dreamTags.dreamId, dreamId));

  /*
   * De-duplicated by id, not by name. Two names that look different can share a
   * fingerprint — normalisation folds Unicode forms, case and runs of
   * whitespace together — and they are then the same tag, so attaching both
   * would collide on the (dream, tag) primary key.
   */
  const unique = [...new Set(tagIds)];
  if (unique.length === 0) return;
  await exec.insert(dreamTags).values(unique.map((tagId) => ({ dreamId, tagId })));
}

/** Tag names for a page of dreams, in one query rather than one per row. */
export async function tagsForDreams(
  userId: string,
  keys: UserKeys,
  dreamIds: readonly string[],
): Promise<Map<string, string[]>> {
  const byDream = new Map<string, string[]>();
  if (dreamIds.length === 0) return byDream;

  const rows = await db
    .select({ dreamId: dreamTags.dreamId, id: tags.id, nameEnc: tags.nameEnc })
    .from(dreamTags)
    .innerJoin(tags, eq(tags.id, dreamTags.tagId))
    .where(and(eq(tags.userId, userId), inArray(dreamTags.dreamId, [...dreamIds])));

  for (const row of rows) {
    const list = byDream.get(row.dreamId) ?? [];
    list.push(decodeTag(keys, row).name);
    byDream.set(row.dreamId, list);
  }
  for (const list of byDream.values()) list.sort((a, b) => a.localeCompare(b));
  return byDream;
}

/**
 * Every tag with how many dreams carry it.
 *
 * Sorted in memory by name, which requires decrypting all of them — unavoidable,
 * since the database cannot order ciphertext. At journal scale (hundreds of
 * tags at the very most) that is a handful of milliseconds.
 */
export async function listTagCounts(userId: string, keys: UserKeys): Promise<TagCount[]> {
  const rows = await db
    .select({ id: tags.id, nameEnc: tags.nameEnc, dreamCount: count(dreamTags.dreamId) })
    .from(tags)
    .leftJoin(dreamTags, eq(dreamTags.tagId, tags.id))
    .where(eq(tags.userId, userId))
    .groupBy(tags.id, tags.nameEnc);

  return rows
    .map((row) => ({ ...decodeTag(keys, row), dreamCount: Number(row.dreamCount) }))
    .sort((a, b) => b.dreamCount - a.dreamCount || a.name.localeCompare(b.name));
}

/**
 * Deletes tags no dream references any more.
 *
 * Called after an edit removes the last use of a tag: an orphan would otherwise
 * linger in the filter list forever, and its fingerprint is a small standing
 * leak of a word that is no longer in the journal.
 */
export async function pruneOrphanedTags(exec: Executor, userId: string): Promise<number> {
  const orphans = await exec
    .select({ id: tags.id })
    .from(tags)
    .leftJoin(dreamTags, eq(dreamTags.tagId, tags.id))
    .where(eq(tags.userId, userId))
    .groupBy(tags.id)
    .having(eq(count(dreamTags.dreamId), 0));

  if (orphans.length === 0) return 0;
  await exec.delete(tags).where(
    and(
      eq(tags.userId, userId),
      inArray(
        tags.id,
        orphans.map((row) => row.id),
      ),
    ),
  );
  return orphans.length;
}
