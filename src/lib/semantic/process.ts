/**
 * Semantic jobs: embed one entry, scan the archive for dream signs.
 *
 * Called from the in-process worker. Identifiers in, ciphertext out — the job
 * row never carries the text, and the vector goes back encrypted.
 */
import "server-only";
import { recordAuthEvent } from "@/lib/auth/audit";
import { completeRole } from "@/lib/ai/chat";
import { embedTexts } from "@/lib/ai/embed";
import { loadAiConfig } from "@/lib/ai/config";
import { parseExtraction, type Extraction } from "@/lib/ai/json";
import {
  dreamSignMessages,
  MAX_SCAN_BODY_CHARS,
  MAX_SCAN_DREAMS,
  type ScanEntry,
} from "@/lib/ai/prompts";
import type { UserKeys } from "@/lib/crypto/envelope";
import { latestExtractionsForDreams } from "@/lib/ai/insights";
import { dreamsInRange, getDream } from "@/lib/journal/dreams";
import type { IsoDate } from "@/lib/journal/dates";
import { saveEmbedding } from "./embeddings";
import { knownSignLabels, mergeScanResults } from "./signs";
import { parseSignScan } from "./signs-parse";
import { embeddingModelKey, embeddingText } from "./text";

class SkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkipError";
  }
}

export { SkipError as SemanticSkipError };

/** A scan needs something to recur *across*. One entry cannot have a pattern. */
export const MIN_SCAN_DREAMS = 3;

export async function runEmbedJob(
  userId: string,
  keys: UserKeys,
  dreamId: string,
): Promise<void> {
  const dream = await getDream(userId, keys, dreamId);
  if (!dream) throw new SkipError("That entry no longer exists.");

  const text = embeddingText(dream);
  if (!text.trim()) throw new SkipError("Nothing to index.");

  const config = await loadAiConfig(userId, keys);
  const { vectors, model, destination } = await embedTexts(config, [text]);
  const vector = vectors[0];
  if (!vector) throw new SkipError("The model returned no vector.");

  await saveEmbedding(userId, keys, dreamId, embeddingModelKey(model), vector);

  await recordAuthEvent("ai_request", {
    userId,
    detail: {
      kind: "embedding",
      provider: destination.providerKind,
      host: destination.host,
      leavesMachine: destination.leavesMachine,
    },
  });
}

export async function runSignScanJob(
  userId: string,
  keys: UserKeys,
  periodStart: IsoDate,
  periodEnd: IsoDate,
): Promise<void> {
  const all = (await dreamsInRange(userId, keys, periodStart, periodEnd)).filter(
    (dream) => dream.body?.trim() && !dream.isDraft,
  );
  if (all.length < MIN_SCAN_DREAMS) {
    throw new SkipError(
      `A scan needs at least ${MIN_SCAN_DREAMS} written entries in the period.`,
    );
  }

  // The most recent slice when the window is larger than one request can hold:
  // recent practice is what the dreamer can still act on.
  const window = all.length > MAX_SCAN_DREAMS ? all.slice(-MAX_SCAN_DREAMS) : all;
  const extractions = await latestExtractionsForDreams(
    userId,
    keys,
    window.map((dream) => dream.id),
  );

  const entries: ScanEntry[] = window.map((dream) => ({
    date: dream.dreamDate,
    isLucid: dream.isLucid,
    summary: scanSummary(extractions.get(dream.id)?.content ?? null, dream.body ?? ""),
  }));

  const config = await loadAiConfig(userId, keys);
  const known = await knownSignLabels(userId, keys);
  const prompt = dreamSignMessages(entries, known);

  const { response, destination } = await completeRole(
    config,
    "signs",
    [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    { json: true },
  );

  const proposals = parseSignScan(response.text, window.length);
  const merged = await mergeScanResults(
    userId,
    keys,
    proposals,
    window.map((dream) => dream.id),
  );

  await recordAuthEvent("ai_request", {
    userId,
    detail: {
      kind: "signs",
      provider: destination.providerKind,
      host: destination.host,
      leavesMachine: destination.leavesMachine,
      entries: window.length,
      signs: merged.created + merged.matched,
    },
  });
}

/**
 * What one entry contributes to a scan.
 *
 * The structured extraction is preferred when there is one: it is already the
 * literal inventory of who and what appeared, which is exactly the substrate a
 * dream-sign scan needs, and it fits four entries in the space one raw entry
 * would take. Falls back to a clip of the entry itself so a journal that has
 * never run extraction can still be scanned.
 */
export function scanSummary(extractionContent: string | null, body: string): string {
  if (extractionContent) {
    try {
      return summariseExtraction(parseExtraction(extractionContent));
    } catch {
      // A malformed stored extraction is not worth failing the scan over.
    }
  }
  return body.slice(0, MAX_SCAN_BODY_CHARS);
}

function summariseExtraction(extraction: Extraction): string {
  const parts: string[] = [];
  if (extraction.summary) parts.push(extraction.summary);

  const facets: Array<[string, string[]]> = [
    ["People", extraction.people],
    ["Places", extraction.places],
    ["Objects", extraction.objects],
    ["Actions", extraction.actions],
    ["Emotions", extraction.emotions],
    ["Anomalies", extraction.anomalies],
    ["Themes", extraction.themes],
  ];
  for (const [label, values] of facets) {
    if (values.length > 0) parts.push(`${label}: ${values.join(", ")}`);
  }

  return parts.join(" | ").slice(0, MAX_SCAN_BODY_CHARS);
}
