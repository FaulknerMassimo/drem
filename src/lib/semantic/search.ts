/**
 * Meaning-based search over the journal.
 *
 * Nothing else in the app can look inside an entry: the text is encrypted, so
 * SQL cannot match a word in it, and that is by design. This is the one path
 * that finds an entry by what it was about, and it does so by comparing vectors
 * rather than by giving the database anything readable.
 */
import "server-only";
import { and, cosineDistance, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { embeddings } from "@/db/schema";
import { embedTexts } from "@/lib/ai/embed";
import { resolveRoles } from "@/lib/ai/schema";
import type { AiConfig, Destination } from "@/lib/ai/types";
import type { UserKeys } from "@/lib/crypto/envelope";
import { dreamSummaries, type DreamSummary } from "@/lib/journal/dreams";
import { loadCandidates, getVector, usesPgvector } from "./embeddings";
import { embeddingModelKey } from "./text";
import { topMatches, type Match } from "./vectors";

/**
 * Cosine similarity below which a hit is not worth showing.
 *
 * Embedding models put unrelated text around 0.2–0.4 rather than at zero, so
 * without a floor every search returns a full page: the least unrelated entry
 * in the archive, presented with the same confidence as a real match. Better to
 * say nothing came close.
 */
export const MIN_SIMILARITY = 0.35;

export const SEARCH_LIMIT = 20;
export const SIMILAR_LIMIT = 5;

export interface SearchHit {
  dream: DreamSummary;
  /** Cosine similarity, 0–1 in practice. */
  score: number;
}

export interface SearchResult {
  hits: SearchHit[];
  /** Where the query text was sent to be embedded. */
  destination: Destination;
  /** The index the search actually ran against. */
  model: string;
}

/** The model key the index is filed under, or null when no model is assigned. */
export function currentEmbeddingModel(config: AiConfig): string | null {
  const assignment = resolveRoles(config).embedding;
  return assignment ? embeddingModelKey(assignment.model) : null;
}

/**
 * Finds entries whose meaning is closest to a phrase.
 *
 * The phrase is embedded, not stored: it goes to the embedding model and is
 * dropped. It never reaches the URL either — the search form posts — so a
 * query about something private does not end up in browser history or in a
 * proxy log.
 */
export async function semanticSearch(
  userId: string,
  keys: UserKeys,
  config: AiConfig,
  query: string,
  limit = SEARCH_LIMIT,
): Promise<SearchResult> {
  const { vectors, model, destination } = await embedTexts(config, [query]);
  const vector = vectors[0];
  const modelKey = embeddingModelKey(model);
  if (!vector) return { hits: [], destination, model: modelKey };

  const matches = await rank(userId, keys, modelKey, vector, limit, null);
  return { hits: await hydrate(userId, keys, matches), destination, model: modelKey };
}

/**
 * The nearest entries to one already in the journal.
 *
 * No model call: the dream's own vector is already stored, so "dreams like
 * this" works while offline and costs nothing — which is why it can sit on
 * every entry page rather than behind a button.
 */
export async function similarDreams(
  userId: string,
  keys: UserKeys,
  config: AiConfig,
  dreamId: string,
  limit = SIMILAR_LIMIT,
): Promise<SearchHit[]> {
  const modelKey = currentEmbeddingModel(config);
  if (!modelKey) return [];

  const vector = await getVector(userId, keys, dreamId, modelKey);
  if (!vector) return [];

  const matches = await rank(userId, keys, modelKey, vector, limit, dreamId);
  return hydrate(userId, keys, matches);
}

async function rank(
  userId: string,
  keys: UserKeys,
  model: string,
  vector: number[],
  limit: number,
  excludeDreamId: string | null,
): Promise<Match[]> {
  if (usesPgvector()) return rankInDatabase(userId, model, vector, limit, excludeDreamId);

  const candidates = await loadCandidates(userId, keys, model);
  const usable = excludeDreamId
    ? candidates.filter((candidate) => candidate.dreamId !== excludeDreamId)
    : candidates;
  return topMatches(vector, usable, limit, MIN_SIMILARITY);
}

/**
 * The pgvector path: the same ranking, done by Postgres against the plaintext
 * vector column. Only reachable when the operator has turned that column on.
 */
async function rankInDatabase(
  userId: string,
  model: string,
  vector: number[],
  limit: number,
  excludeDreamId: string | null,
): Promise<Match[]> {
  const distance = cosineDistance(embeddings.vector, vector);
  const conditions = [
    eq(embeddings.userId, userId),
    eq(embeddings.model, model),
    sql`${embeddings.vector} is not null`,
  ];
  if (excludeDreamId) conditions.push(ne(embeddings.dreamId, excludeDreamId));

  const rows = await db
    .select({ dreamId: embeddings.dreamId, score: sql<number>`1 - (${distance})` })
    .from(embeddings)
    .where(and(...conditions))
    .orderBy(distance)
    .limit(limit);

  return rows
    .map((row) => ({ dreamId: row.dreamId, score: Number(row.score) }))
    .filter((match) => match.score >= MIN_SIMILARITY);
}

async function hydrate(
  userId: string,
  keys: UserKeys,
  matches: Match[],
): Promise<SearchHit[]> {
  if (matches.length === 0) return [];
  const summaries = await dreamSummaries(
    userId,
    keys,
    matches.map((match) => match.dreamId),
  );
  const scores = new Map(matches.map((match) => [match.dreamId, match.score]));
  return summaries.map((dream) => ({ dream, score: scores.get(dream.id) ?? 0 }));
}
