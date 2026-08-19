/**
 * What of an entry actually gets embedded.
 *
 * Pure and separate from the pipeline because it is a decision, not plumbing:
 * change it and every stored vector silently means something slightly different
 * from the ones written before it. A change here should come with a re-index,
 * which is what bumping `EMBEDDING_TEXT_VERSION` is for.
 */

/**
 * Bump when the composition below changes.
 *
 * Stored alongside the model name in `embeddings.model`, so vectors built under
 * the old rules are not compared against vectors built under the new ones —
 * they would rank against each other as if nothing had happened.
 */
export const EMBEDDING_TEXT_VERSION = 1;

/**
 * Embedding models have small contexts — 2048 tokens is typical — and truncate
 * silently past them. Clipping here means the cut is visible in one place
 * rather than happening inside a provider.
 */
export const MAX_EMBEDDING_CHARS = 6_000;

export interface EmbeddableDream {
  title: string | null;
  body: string | null;
  tags: readonly string[];
}

/**
 * Title, tags and body, in that order.
 *
 * Title and tags lead because a truncated entry keeps them, and they carry a
 * disproportionate amount of what the entry is *about*. Metadata that is not
 * language — lucidity, vividness, dates — is deliberately left out: it is
 * already filterable in SQL, and putting numbers into an embedding only
 * smears the meaning it is supposed to capture.
 */
export function embeddingText(dream: EmbeddableDream): string {
  const parts: string[] = [];
  const title = dream.title?.trim();
  if (title) parts.push(title);
  if (dream.tags.length > 0) parts.push(dream.tags.join(", "));
  const body = dream.body?.trim();
  if (body) parts.push(body);

  const joined = parts.join("\n\n");
  return joined.length <= MAX_EMBEDDING_CHARS
    ? joined
    : joined.slice(0, MAX_EMBEDDING_CHARS);
}

/** True when there is enough here for a vector to mean anything. */
export function isEmbeddable(dream: EmbeddableDream): boolean {
  return embeddingText(dream).trim().length > 0;
}

/**
 * The identifier a vector is filed under.
 *
 * Vectors from two different models are not comparable, and neither are vectors
 * from two different compositions of the same entry, so both go into the key
 * that `embeddings.model` holds and that every search filters on.
 */
export function embeddingModelKey(model: string): string {
  return `${model}@v${EMBEDDING_TEXT_VERSION}`;
}

/** The model name back out of a key, for showing which model built an index. */
export function modelFromKey(key: string): string {
  const at = key.lastIndexOf("@v");
  return at === -1 ? key : key.slice(0, at);
}
