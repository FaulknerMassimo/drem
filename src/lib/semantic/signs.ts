/**
 * Dream signs: the recurring cues that, once recognised, can trigger a reality
 * check inside a dream. The point of the whole exercise.
 *
 * A label is something a person (or a model reading their journal) wrote, so it
 * is encrypted like everything else — but signs also have to be counted,
 * deduplicated and correlated against lucidity, which ciphertext cannot do.
 * Each label therefore carries a keyed fingerprint alongside it, namespaced so
 * a sign called "water" does not fingerprint identically to a tag called
 * "water".
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, type Executor } from "@/db";
import { dreamSignOccurrences, dreamSigns, dreams } from "@/db/schema";
import { decryptString, encrypt, type Aad } from "@/lib/crypto/aead";
import { namespacedBlindIndex } from "@/lib/crypto/blind-index";
import type { UserKeys } from "@/lib/crypto/envelope";
import type { IsoDate } from "@/lib/journal/dates";
import { correlateSign, type SignCorrelation } from "./correlation";
import type { SignCategory } from "./labels";
import type { ProposedSign } from "./signs-parse";

const SIGN_NAMESPACE = "sign";

export interface DreamSignRecord {
  id: string;
  label: string;
  category: SignCategory;
  isAuto: boolean;
  isActive: boolean;
  occurrenceCount: number;
  lucidCount: number;
  lastSeenAt: IsoDate | null;
}

export interface RankedSign extends DreamSignRecord {
  correlation: SignCorrelation;
}

function labelAad(id: string): Aad {
  return { table: "dream_signs", column: "label_enc", id };
}

/** The fingerprint a sign label is stored and looked up under. */
export function signFingerprint(keys: UserKeys, label: string): Buffer {
  return namespacedBlindIndex(keys.index, SIGN_NAMESPACE, label);
}

function decode(keys: UserKeys, row: typeof dreamSigns.$inferSelect): DreamSignRecord {
  return {
    id: row.id,
    label: decryptString(keys.field, row.labelEnc, labelAad(row.id)),
    category: row.category,
    isAuto: row.isAuto,
    isActive: row.isActive,
    occurrenceCount: row.occurrenceCount,
    lucidCount: row.lucidCount,
    lastSeenAt: row.lastSeenAt,
  };
}

/**
 * Rebuilds the denormalised counters from the occurrence table.
 *
 * The counters are a cache, and every path that can invalidate them is not
 * worth chasing — deleting a dream cascades its occurrences away without
 * touching the sign, and a number that is quietly one too high is exactly the
 * kind of wrong that never gets noticed. One grouped statement over a table
 * with a few hundred rows costs nothing, so it is run before the signs are
 * read rather than hoped about.
 *
 * The `IS DISTINCT FROM` guard means a page render that changes nothing writes
 * nothing.
 */
export async function refreshSignCounts(userId: string): Promise<void> {
  await db.execute(sql`
    update ${dreamSigns} as s
    set occurrence_count = agg.occurrences,
        lucid_count = agg.lucid,
        last_seen_at = agg.last_seen
    from (
      select s2.id as id,
             count(o.dream_id)::int as occurrences,
             coalesce(sum(case when d.is_lucid then 1 else 0 end), 0)::int as lucid,
             max(d.dream_date) as last_seen
      from ${dreamSigns} s2
      left join ${dreamSignOccurrences} o on o.sign_id = s2.id
      left join ${dreams} d on d.id = o.dream_id
      where s2.user_id = ${userId}
      group by s2.id
    ) as agg
    where s.id = agg.id
      and (s.occurrence_count is distinct from agg.occurrences
        or s.lucid_count is distinct from agg.lucid
        or s.last_seen_at is distinct from agg.last_seen)
  `);
}

export interface ListSignsOptions {
  includeDismissed?: boolean;
  /** The archive's lucid rate, for the correlation. */
  baseline: number;
}

export async function listSigns(
  userId: string,
  keys: UserKeys,
  options: ListSignsOptions,
): Promise<RankedSign[]> {
  await refreshSignCounts(userId);

  const conditions = [eq(dreamSigns.userId, userId)];
  if (!options.includeDismissed) conditions.push(eq(dreamSigns.isActive, true));

  const rows = await db
    .select()
    .from(dreamSigns)
    .where(and(...conditions))
    .orderBy(asc(dreamSigns.createdAt));

  return rows.map((row) => {
    const record = decode(keys, row);
    return {
      ...record,
      correlation: correlateSign(
        { occurrences: record.occurrenceCount, lucidOccurrences: record.lucidCount },
        options.baseline,
      ),
    };
  });
}

export async function getSign(
  userId: string,
  keys: UserKeys,
  signId: string,
  baseline: number,
): Promise<RankedSign | null> {
  await refreshSignCounts(userId);

  const [row] = await db
    .select()
    .from(dreamSigns)
    .where(and(eq(dreamSigns.userId, userId), eq(dreamSigns.id, signId)))
    .limit(1);
  if (!row) return null;

  const record = decode(keys, row);
  return {
    ...record,
    correlation: correlateSign(
      { occurrences: record.occurrenceCount, lucidOccurrences: record.lucidCount },
      baseline,
    ),
  };
}

/** The dreams carrying a sign, most recent first. */
export async function dreamIdsForSign(userId: string, signId: string): Promise<string[]> {
  const rows = await db
    .select({ dreamId: dreamSignOccurrences.dreamId })
    .from(dreamSignOccurrences)
    .innerJoin(dreams, eq(dreams.id, dreamSignOccurrences.dreamId))
    .where(and(eq(dreams.userId, userId), eq(dreamSignOccurrences.signId, signId)))
    .orderBy(sql`${dreams.dreamDate} desc`);
  return rows.map((row) => row.dreamId);
}

/** Signs attached to a page of dreams, in one query rather than one per row. */
export async function signsForDreams(
  userId: string,
  keys: UserKeys,
  dreamIds: readonly string[],
): Promise<Map<string, DreamSignRecord[]>> {
  const byDream = new Map<string, DreamSignRecord[]>();
  if (dreamIds.length === 0) return byDream;

  const rows = await db
    .select({ dreamId: dreamSignOccurrences.dreamId, sign: dreamSigns })
    .from(dreamSignOccurrences)
    .innerJoin(dreamSigns, eq(dreamSigns.id, dreamSignOccurrences.signId))
    .where(
      and(
        eq(dreamSigns.userId, userId),
        eq(dreamSigns.isActive, true),
        inArray(dreamSignOccurrences.dreamId, [...dreamIds]),
      ),
    );

  for (const row of rows) {
    const list = byDream.get(row.dreamId) ?? [];
    list.push(decode(keys, row.sign));
    byDream.set(row.dreamId, list);
  }
  for (const list of byDream.values()) list.sort((a, b) => a.label.localeCompare(b.label));
  return byDream;
}

/**
 * Adds a sign by hand, or brings back one that was dismissed.
 *
 * Re-adding a dismissed label reactivates the existing row rather than creating
 * a twin: the fingerprint is unique per user, so a second row is not even
 * possible, and silently failing would look like the button was broken.
 */
export async function addManualSign(
  userId: string,
  keys: UserKeys,
  label: string,
  category: SignCategory,
): Promise<string> {
  const fingerprint = signFingerprint(keys, label);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: dreamSigns.id })
      .from(dreamSigns)
      .where(and(eq(dreamSigns.userId, userId), eq(dreamSigns.labelBidx, fingerprint)))
      .limit(1);

    if (existing) {
      await tx
        .update(dreamSigns)
        .set({ isActive: true, isAuto: false, category })
        .where(eq(dreamSigns.id, existing.id));
      return existing.id;
    }

    const id = randomUUID();
    await tx.insert(dreamSigns).values({
      id,
      userId,
      labelEnc: encrypt(keys.field, label, labelAad(id)),
      labelBidx: fingerprint,
      category,
      isAuto: false,
      isActive: true,
    });
    return id;
  });
}

export async function setSignActive(
  userId: string,
  signId: string,
  isActive: boolean,
): Promise<boolean> {
  const updated = await db
    .update(dreamSigns)
    .set({ isActive })
    .where(and(eq(dreamSigns.userId, userId), eq(dreamSigns.id, signId)))
    .returning({ id: dreamSigns.id });
  return updated.length > 0;
}

/**
 * Removes a sign outright, occurrences and all.
 *
 * Distinct from dismissing it: a dismissed sign stays on file precisely so the
 * next scan does not propose it again, whereas a deleted one is free to come
 * back. Deleting is for a label that was simply wrong.
 */
export async function deleteSign(userId: string, signId: string): Promise<boolean> {
  const deleted = await db
    .delete(dreamSigns)
    .where(and(eq(dreamSigns.userId, userId), eq(dreamSigns.id, signId)))
    .returning({ id: dreamSigns.id });
  return deleted.length > 0;
}

/** Active labels, so a scan reuses them instead of inventing near-duplicates. */
export async function knownSignLabels(userId: string, keys: UserKeys): Promise<string[]> {
  const rows = await db
    .select()
    .from(dreamSigns)
    .where(and(eq(dreamSigns.userId, userId), eq(dreamSigns.isActive, true)));
  return rows.map((row) => decode(keys, row).label).sort((a, b) => a.localeCompare(b));
}

export interface MergeResult {
  created: number;
  matched: number;
  occurrences: number;
  pruned: number;
}

/**
 * Writes a scan's findings.
 *
 * Occurrences are re-derived wholesale for the dreams that were scanned: every
 * occurrence on those entries is dropped first, then the scan's findings are
 * inserted. Otherwise a re-scan could only ever add, and a sign the model
 * correctly stopped reporting would stay attached forever.
 *
 * What is *not* re-derived is the sign itself. A sign that already exists keeps
 * its `isActive` and `isAuto` flags, so a dismissed sign is not resurrected by
 * the next scan and a hand-made one is not quietly reclassified as automatic.
 */
export async function mergeScanResults(
  userId: string,
  keys: UserKeys,
  proposals: readonly ProposedSign[],
  windowDreamIds: readonly string[],
): Promise<MergeResult> {
  const result: MergeResult = { created: 0, matched: 0, occurrences: 0, pruned: 0 };

  await db.transaction(async (tx) => {
    if (windowDreamIds.length > 0) {
      await tx
        .delete(dreamSignOccurrences)
        .where(inArray(dreamSignOccurrences.dreamId, [...windowDreamIds]));
    }

    const rows: { dreamId: string; signId: string; confidence: number }[] = [];

    for (const proposal of proposals) {
      const fingerprint = signFingerprint(keys, proposal.label);
      const [existing] = await tx
        .select({ id: dreamSigns.id })
        .from(dreamSigns)
        .where(and(eq(dreamSigns.userId, userId), eq(dreamSigns.labelBidx, fingerprint)))
        .limit(1);

      let signId: string;
      if (existing) {
        signId = existing.id;
        result.matched += 1;
      } else {
        signId = randomUUID();
        await tx.insert(dreamSigns).values({
          id: signId,
          userId,
          labelEnc: encrypt(keys.field, proposal.label, labelAad(signId)),
          labelBidx: fingerprint,
          category: proposal.category,
          isAuto: true,
          isActive: true,
        });
        result.created += 1;
      }

      for (const index of proposal.entries) {
        const dreamId = windowDreamIds[index];
        if (!dreamId) continue;
        rows.push({ dreamId, signId, confidence: proposal.confidence });
      }
    }

    /*
     * De-duplicated by (dream, sign), not by label. Two labels that look
     * different can share a fingerprint — normalisation folds Unicode form,
     * case and whitespace together — and they are then the same sign, so
     * inserting both would collide on the composite primary key.
     */
    const unique = new Map<string, { dreamId: string; signId: string; confidence: number }>();
    for (const row of rows) unique.set(`${row.dreamId}:${row.signId}`, row);

    if (unique.size > 0) {
      await tx.insert(dreamSignOccurrences).values([...unique.values()]);
      result.occurrences = unique.size;
    }

    result.pruned = await pruneEmptyAutoSigns(tx, userId);
  });

  await refreshSignCounts(userId);
  return result;
}

/**
 * Drops automatic signs that no longer occur anywhere.
 *
 * Only untouched automatic ones: a dismissed sign is a deliberate tombstone,
 * and a hand-made one is something the dreamer is watching for on purpose even
 * if it has not turned up yet.
 */
async function pruneEmptyAutoSigns(exec: Executor, userId: string): Promise<number> {
  const orphans = await exec
    .select({ id: dreamSigns.id })
    .from(dreamSigns)
    .leftJoin(dreamSignOccurrences, eq(dreamSignOccurrences.signId, dreamSigns.id))
    .where(
      and(
        eq(dreamSigns.userId, userId),
        eq(dreamSigns.isAuto, true),
        eq(dreamSigns.isActive, true),
      ),
    )
    .groupBy(dreamSigns.id)
    .having(sql`count(${dreamSignOccurrences.dreamId}) = 0`);

  if (orphans.length === 0) return 0;
  await exec.delete(dreamSigns).where(
    inArray(
      dreamSigns.id,
      orphans.map((row) => row.id),
    ),
  );
  return orphans.length;
}
