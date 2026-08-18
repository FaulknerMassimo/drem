/**
 * Blind indexes.
 *
 * Tag names and dream-sign labels have to be grouped, counted and filtered in
 * SQL, which encrypted values cannot do (every ciphertext of the same tag is
 * different). A blind index is a keyed, deterministic fingerprint stored
 * alongside the ciphertext: equality queries work, but the value itself is not
 * recoverable without the key.
 *
 * This deliberately leaks *equality* - an observer can tell that two dreams
 * share a tag, without learning which tag. That is the minimum required for the
 * feature to exist at all.
 */
import { createHmac } from "node:crypto";

/**
 * Truncated to 16 bytes: enough to make collisions irrelevant at journal scale,
 * while storing half as much as the full digest.
 */
const INDEX_BYTES = 16;

/**
 * Normalisation must stay stable forever - changing it silently orphans every
 * previously stored index, so any change requires a full reindex migration.
 *
 * NFKC folds visually identical Unicode forms together, so a word typed with a
 * precomposed accent indexes the same as its decomposed spelling.
 */
export function normalizeForIndex(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

export function blindIndex(indexKey: Buffer, value: string): Buffer {
  return createHmac("sha256", indexKey)
    .update(normalizeForIndex(value), "utf8")
    .digest()
    .subarray(0, INDEX_BYTES);
}

/**
 * Namespaced variant, so an identical string used as a tag and as a dream-sign
 * label does not produce the same fingerprint in both tables.
 */
export function namespacedBlindIndex(
  indexKey: Buffer,
  namespace: string,
  value: string,
): Buffer {
  return createHmac("sha256", indexKey)
    .update(`${namespace} ${normalizeForIndex(value)}`, "utf8")
    .digest()
    .subarray(0, INDEX_BYTES);
}
