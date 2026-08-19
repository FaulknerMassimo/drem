/**
 * Storage for embedding vectors.
 *
 * A vector is a lossy projection of the text it came from, but a lossy
 * projection is not an anonymous one: given the model, an attacker can invert
 * enough of one to recover the gist of an entry. So under the default backend a
 * vector is encrypted exactly like the dream it describes, and similarity is
 * computed in this process rather than in the database.
 *
 * `SEARCH_BACKEND=pgvector` additionally writes the vector into a queryable
 * column. That is a real, deliberate weakening — the whole point of the index
 * is that Postgres can read the vectors — and is why it is opt-in.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { and, count, eq, isNotNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { dreams, embeddings } from "@/db/schema";
import { decrypt, encrypt, type Aad } from "@/lib/crypto/aead";
import type { UserKeys } from "@/lib/crypto/envelope";
import { env } from "@/lib/env";
import { ProviderError } from "@/lib/ai/providers/errors";
import { packVector, PGVECTOR_DIM, unpackVector, type Candidate } from "./vectors";

function vectorAad(id: string): Aad {
  return { table: "embeddings", column: "vector_enc", id };
}

export function usesPgvector(): boolean {
  return env().SEARCH_BACKEND === "pgvector";
}

/**
 * Writes one dream's vector, replacing whatever was there for the same model.
 *
 * The row id is resolved *before* the ciphertext is built, because the AAD
 * binds the value to the row it lands in: minting a fresh uuid, encrypting
 * under it and then updating an existing row would write a vector nobody can
 * ever decrypt. The lookup and the write share a transaction so a concurrent
 * writer cannot slip a row in between them — if one does, the unique index
 * raises and the job retries rather than storing an unreadable value.
 */
export async function saveEmbedding(
  userId: string,
  keys: UserKeys,
  dreamId: string,
  model: string,
  vector: readonly number[],
): Promise<void> {
  const storeVector = usesPgvector();
  if (storeVector && vector.length !== PGVECTOR_DIM) {
    // A ProviderError so the worker surfaces the message verbatim on the job:
    // this is a configuration mistake the operator can fix, and "the model
    // request failed" would send them looking in the wrong place. A dimension
    // count is as safe to persist as a status code.
    throw new ProviderError(
      `SEARCH_BACKEND=pgvector needs ${PGVECTOR_DIM}-dimension vectors; this model returned ${vector.length}. Use a ${PGVECTOR_DIM}-dimension model such as embeddinggemma, or set SEARCH_BACKEND=encrypted.`,
    );
  }

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: embeddings.id })
      .from(embeddings)
      .where(and(eq(embeddings.dreamId, dreamId), eq(embeddings.model, model)))
      .limit(1);

    const id = existing?.id ?? randomUUID();
    const vectorEnc = encrypt(keys.vector, packVector(vector), vectorAad(id));
    const plain = storeVector ? [...vector] : null;

    if (existing) {
      await tx
        .update(embeddings)
        .set({ vectorEnc, vector: plain, dim: vector.length, createdAt: new Date() })
        .where(eq(embeddings.id, id));
      return;
    }

    await tx.insert(embeddings).values({
      id,
      userId,
      dreamId,
      model,
      dim: vector.length,
      vectorEnc,
      vector: plain,
    });
  });
}

/**
 * Every stored vector for one model, decrypted.
 *
 * The whole set, on every search. A personal archive is a few thousand vectors
 * at most — a few megabytes and a few milliseconds of AES — and the alternative
 * is handing the database something it can read.
 */
export async function loadCandidates(
  userId: string,
  keys: UserKeys,
  model: string,
): Promise<Candidate[]> {
  const rows = await db
    .select({ id: embeddings.id, dreamId: embeddings.dreamId, vectorEnc: embeddings.vectorEnc })
    .from(embeddings)
    .where(
      and(
        eq(embeddings.userId, userId),
        eq(embeddings.model, model),
        isNotNull(embeddings.vectorEnc),
      ),
    );

  return rows.map((row) => ({
    dreamId: row.dreamId,
    vector: unpackVector(decrypt(keys.vector, row.vectorEnc!, vectorAad(row.id))),
  }));
}

export async function getVector(
  userId: string,
  keys: UserKeys,
  dreamId: string,
  model: string,
): Promise<number[] | null> {
  const [row] = await db
    .select({ id: embeddings.id, vectorEnc: embeddings.vectorEnc })
    .from(embeddings)
    .where(
      and(
        eq(embeddings.userId, userId),
        eq(embeddings.dreamId, dreamId),
        eq(embeddings.model, model),
      ),
    )
    .limit(1);

  if (!row?.vectorEnc) return null;
  return unpackVector(decrypt(keys.vector, row.vectorEnc, vectorAad(row.id)));
}

/**
 * Entries whose vector is missing or out of date, newest first.
 *
 * Staleness is `embeddings.created_at < dreams.updated_at` rather than a stored
 * digest of the text: the entry is encrypted, so the only honest comparison
 * available in SQL is when each was written. It over-reports — re-saving an
 * entry with only its vividness changed marks the vector stale — and that is
 * the right direction to be wrong in.
 */
function outstandingWhere(userId: string, model: string) {
  return and(
    eq(dreams.userId, userId),
    // Nothing to embed in a row with no words in it.
    or(isNotNull(dreams.bodyEnc), isNotNull(dreams.titleEnc)),
    or(sql`${embeddings.id} is null`, lt(embeddings.createdAt, dreams.updatedAt)),
  );
}

function joinOn(model: string) {
  return and(eq(embeddings.dreamId, dreams.id), eq(embeddings.model, model));
}

export async function dreamsNeedingEmbedding(
  userId: string,
  model: string,
  limit = 1_000,
): Promise<string[]> {
  const rows = await db
    .select({ id: dreams.id })
    .from(dreams)
    .leftJoin(embeddings, joinOn(model))
    .where(outstandingWhere(userId, model))
    .orderBy(sql`${dreams.dreamDate} desc`)
    .limit(limit);
  return rows.map((row) => row.id);
}

export interface IndexCoverage {
  /** Entries with any text in them at all. */
  embeddable: number;
  /** Of those, how many have an up-to-date vector. */
  indexed: number;
  /** Missing or stale. */
  outstanding: number;
}

export async function indexCoverage(userId: string, model: string): Promise<IndexCoverage> {
  const [embeddableRow] = await db
    .select({ total: count() })
    .from(dreams)
    .where(
      and(
        eq(dreams.userId, userId),
        or(isNotNull(dreams.bodyEnc), isNotNull(dreams.titleEnc)),
      ),
    );

  const [outstandingRow] = await db
    .select({ total: count() })
    .from(dreams)
    .leftJoin(embeddings, joinOn(model))
    .where(outstandingWhere(userId, model));

  const embeddable = Number(embeddableRow?.total ?? 0);
  const outstanding = Number(outstandingRow?.total ?? 0);
  return { embeddable, outstanding, indexed: Math.max(0, embeddable - outstanding) };
}
