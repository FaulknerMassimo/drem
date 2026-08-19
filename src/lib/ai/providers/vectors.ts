/**
 * Reads a batch of vectors out of a provider's reply.
 *
 * Shared by the adapters because the failure they have to guard against is the
 * same one: a provider that silently returns fewer vectors than it was given
 * inputs. Zipping that back onto the dreams by position would attach one
 * entry's meaning to another's row, and nothing downstream could tell.
 */
import { ProviderError } from "./errors";

export function readVectors(value: unknown, expected: number): number[][] {
  if (!Array.isArray(value)) {
    throw new ProviderError("The provider returned no embeddings");
  }

  const vectors = value.map(readVector);
  if (vectors.length !== expected) {
    throw new ProviderError(
      `The provider returned ${vectors.length} embeddings for ${expected} inputs`,
    );
  }
  return vectors;
}

export function readVector(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProviderError("The provider returned an empty embedding");
  }

  const vector = new Array<number>(value.length);
  for (let i = 0; i < value.length; i++) {
    const component = value[i];
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw new ProviderError("The provider returned a malformed embedding");
    }
    vector[i] = component;
  }
  return vector;
}
