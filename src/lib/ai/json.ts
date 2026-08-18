/**
 * Parsing for model output that is supposed to be JSON.
 *
 * Models wrap objects in fences, chatter before them, or use snake_case keys.
 * None of that should leak into the stored extraction: later stages (and phase
 * 5's dream-sign scan) depend on a stable shape.
 */
import { z } from "zod";

const stringList = z.array(z.string()).catch([]);

const extractionSchema = z
  .object({
    summary: z.string().catch(""),
    people: stringList,
    places: stringList,
    objects: stringList,
    actions: stringList,
    emotions: stringList,
    anomalies: stringList,
    themes: stringList,
    dreamSigns: stringList,
    dream_signs: stringList.optional(),
  })
  .transform((value) => ({
    summary: value.summary.trim(),
    people: cleanList(value.people),
    places: cleanList(value.places),
    objects: cleanList(value.objects),
    actions: cleanList(value.actions),
    emotions: cleanList(value.emotions),
    anomalies: cleanList(value.anomalies),
    themes: cleanList(value.themes),
    dreamSigns: cleanList([...value.dreamSigns, ...(value.dream_signs ?? [])]),
  }));

export type Extraction = z.infer<typeof extractionSchema>;

function cleanList(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed.slice(0, 200));
  }
  return out.slice(0, 40);
}

/**
 * Pulls the first JSON object out of a model reply.
 *
 * Deliberately does not put the raw text in the thrown error: the reply is
 * dream-derived, and errors are what end up in `jobs.last_error`.
 */
export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        throw new Error("The model did not return JSON.");
      }
    }
    throw new Error("The model did not return JSON.");
  }
}

export function parseExtraction(text: string): Extraction {
  return extractionSchema.parse(parseJsonObject(text));
}

export function serialiseExtraction(extraction: Extraction): string {
  return JSON.stringify(extraction);
}
