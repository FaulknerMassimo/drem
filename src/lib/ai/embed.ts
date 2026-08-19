/**
 * Embeds text for the configured `embedding` role.
 *
 * The sibling of `chat.ts`, and deliberately shaped the same way: look up the
 * assignment, refuse to guess a model, hand the call to the adapter, and return
 * the destination alongside the result so the caller can record *where* the
 * text went without reconstructing it.
 *
 * Vectors come back normalised to unit length. Every comparison downstream is
 * therefore a dot product, and — more importantly — the encrypted and pgvector
 * backends rank identically instead of agreeing only approximately.
 */
import "server-only";
import { destinationFor } from "./destination";
import { providerEmbed } from "./providers";
import { resolveRoles } from "./schema";
import type { AiConfig, Destination } from "./types";
import { RoleNotConfiguredError } from "./chat";

/**
 * How many entries go in one request.
 *
 * Large enough that a year's backfill is a handful of round-trips, small enough
 * that a failure re-does seconds of work rather than minutes — and that a
 * remote provider's per-request payload limit is not the thing that discovers
 * the ceiling for us.
 */
export const EMBED_BATCH_SIZE = 16;

export interface EmbedResult {
  vectors: number[][];
  model: string;
  destination: Destination;
  inputTokens?: number;
}

export async function embedTexts(
  config: AiConfig,
  texts: string[],
): Promise<EmbedResult> {
  const destination = destinationFor(config, "embedding");
  if (!destination.configured) throw new RoleNotConfiguredError("embedding");

  const assignment = resolveRoles(config).embedding;
  const provider = config.providers.find((candidate) => candidate.id === assignment?.providerId);
  if (!provider || !assignment) throw new RoleNotConfiguredError("embedding");

  if (texts.length === 0) {
    return { vectors: [], model: assignment.model, destination };
  }

  const vectors: number[][] = [];
  let inputTokens: number | undefined;

  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
    const response = await providerEmbed(
      provider,
      { model: assignment.model, inputs: batch },
      globalThis.fetch,
    );
    for (const vector of response.vectors) vectors.push(normalise(vector));
    if (response.inputTokens !== undefined) {
      inputTokens = (inputTokens ?? 0) + response.inputTokens;
    }
  }

  return { vectors, model: assignment.model, destination, inputTokens };
}

/**
 * Scales a vector to unit length.
 *
 * A zero vector is returned untouched rather than divided by zero: some models
 * emit one for whitespace-only input, and a NaN vector would poison every
 * comparison it took part in instead of simply matching nothing.
 */
export function normalise(vector: number[]): number[] {
  let sum = 0;
  for (const component of vector) sum += component * component;
  const length = Math.sqrt(sum);
  if (length === 0) return vector;
  return vector.map((component) => component / length);
}
