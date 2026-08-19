/**
 * Vector arithmetic and the on-disk vector format.
 *
 * Pure, so the ranking can be tested without a model or a database — the part
 * of semantic search most likely to be silently wrong is the comparison, and
 * "it returned something" is not evidence that it returned the right thing.
 *
 * Vectors are stored as little-endian float32 rather than JSON: a 768-dimension
 * vector is 3 KB packed against roughly 15 KB as text, and every one of them is
 * decrypted on every search under the default backend.
 */

/** The dimension the `embeddings.vector` pgvector column is declared at. */
export const PGVECTOR_DIM = 768;

const BYTES_PER_COMPONENT = 4;

export function packVector(vector: readonly number[]): Buffer {
  const buffer = Buffer.allocUnsafe(vector.length * BYTES_PER_COMPONENT);
  for (let i = 0; i < vector.length; i++) {
    buffer.writeFloatLE(vector[i]!, i * BYTES_PER_COMPONENT);
  }
  return buffer;
}

export function unpackVector(buffer: Buffer): number[] {
  if (buffer.length % BYTES_PER_COMPONENT !== 0) {
    throw new Error("Stored vector is not a whole number of float32 components");
  }
  const vector = new Array<number>(buffer.length / BYTES_PER_COMPONENT);
  for (let i = 0; i < vector.length; i++) {
    vector[i] = buffer.readFloatLE(i * BYTES_PER_COMPONENT);
  }
  return vector;
}

export function dot(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let total = 0;
  for (let i = 0; i < length; i++) total += a[i]! * b[i]!;
  return total;
}

/**
 * Cosine similarity, in the range -1 to 1.
 *
 * Vectors are normalised when they are embedded, so this is a dot product in
 * practice — but the division stays, because a vector that arrived by some
 * other route (a restored backup, a model swapped mid-backfill) must not be
 * silently mis-ranked just because it is the wrong length.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot(a, b) / Math.sqrt(normA * normB);
}

export interface Candidate {
  dreamId: string;
  vector: readonly number[];
}

export interface Match {
  dreamId: string;
  score: number;
}

/**
 * The `limit` best matches, strongest first.
 *
 * A full sort of a personal archive is a few thousand comparisons, which is
 * nothing — so this stays a sort rather than a heap, and stays obviously
 * correct instead of cleverly fast.
 *
 * `minScore` exists because cosine similarity always returns *something*: with
 * no floor, a query about aeroplanes ranks the least unrelated entry in the
 * journal first and presents it as a result.
 */
export function topMatches(
  query: readonly number[],
  candidates: readonly Candidate[],
  limit: number,
  minScore = 0,
): Match[] {
  const scored: Match[] = [];
  for (const candidate of candidates) {
    const score = cosineSimilarity(query, candidate.vector);
    if (score >= minScore) scored.push({ dreamId: candidate.dreamId, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
