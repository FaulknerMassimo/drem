/**
 * Parsing for OCR, transcription and split-log model output.
 *
 * Same posture as `ai/json.ts`: models wrap objects in fences or chatter,
 * and none of that (nor the raw reply) should leak into `jobs.last_error`.
 */
import { z } from "zod";
import { isIsoDate } from "@/lib/journal/dates";
import { parseJsonObject } from "@/lib/ai/json";
import type { ExtractedFields, FieldConfidence, SplitPart } from "./types";

export type { ExtractedFields, FieldConfidence, SplitPart };

const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 50_000;
const MAX_TAG_LENGTH = 60;
const MAX_TAGS_PER_DREAM = 24;

const confidence = z.coerce.number().min(0).max(1).catch(0).transform((value) => value);

function clip(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function asConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function nestedValue(record: Record<string, unknown>, key: string): unknown {
  const direct = record[key];
  if (direct && typeof direct === "object" && !Array.isArray(direct) && "value" in direct) {
    return (direct as { value: unknown }).value;
  }
  return direct;
}

function nestedConfidence(record: Record<string, unknown>, key: string, flatKey: string): number | null {
  const nested = record[key];
  if (nested && typeof nested === "object" && !Array.isArray(nested) && "confidence" in nested) {
    return asConfidence((nested as { confidence: unknown }).confidence);
  }
  return asConfidence(record[flatKey]);
}

const ocrSchema = z
  .object({
    date: z.unknown().optional(),
    dateConfidence: confidence.optional(),
    title: z.unknown().optional(),
    titleConfidence: confidence.optional(),
    body: z.unknown().optional(),
    bodyConfidence: confidence.optional(),
    tags: z.unknown().optional(),
    tagsConfidence: confidence.optional(),
    lucidity: z.unknown().optional(),
    lucidityConfidence: confidence.optional(),
    text: z.unknown().optional(),
  })
  .passthrough();

export function emptyFields(): ExtractedFields {
  return {
    date: { value: null, confidence: null },
    title: { value: null, confidence: null },
    body: { value: "", confidence: null },
    tags: { value: [], confidence: null },
    lucidity: { value: null, confidence: null },
    raw: "",
  };
}

export function parseExtractedFields(text: string): ExtractedFields {
  const parsed = ocrSchema.parse(parseJsonObject(text));
  const record = parsed as Record<string, unknown>;

  const dateRaw = stringOrNull(nestedValue(record, "date"));
  const date = dateRaw && isIsoDate(dateRaw) ? dateRaw : null;

  const title = stringOrNull(nestedValue(record, "title"));
  const body =
    stringOrNull(nestedValue(record, "body")) ??
    stringOrNull(nestedValue(record, "text")) ??
    "";

  const tags = stringList(nestedValue(record, "tags"));
  const lucidity = intOrNull(nestedValue(record, "lucidity"), 0, 5);

  return {
    date: { value: date, confidence: nestedConfidence(record, "date", "dateConfidence") },
    title: {
      value: title ? clip(title, MAX_TITLE_LENGTH) : null,
      confidence: nestedConfidence(record, "title", "titleConfidence"),
    },
    body: {
      value: clip(body, MAX_BODY_LENGTH),
      confidence: nestedConfidence(record, "body", "bodyConfidence"),
    },
    tags: {
      value: tags.slice(0, MAX_TAGS_PER_DREAM).map((tag) => clip(tag, MAX_TAG_LENGTH)),
      confidence: nestedConfidence(record, "tags", "tagsConfidence"),
    },
    lucidity: {
      value: lucidity,
      confidence: nestedConfidence(record, "lucidity", "lucidityConfidence"),
    },
    raw: clip(body, MAX_BODY_LENGTH),
  };
}

export function fieldsFromTranscript(text: string, confidence: number | null): ExtractedFields {
  const body = clip(text, MAX_BODY_LENGTH);
  return {
    ...emptyFields(),
    body: { value: body, confidence },
    raw: body,
  };
}

export function serialiseFields(fields: ExtractedFields): string {
  return JSON.stringify(fields);
}

export function parseStoredFields(text: string): ExtractedFields {
  try {
    const parsed = JSON.parse(text) as Partial<ExtractedFields>;
    if (parsed && typeof parsed === "object" && parsed.body && typeof parsed.body === "object") {
      return {
        ...emptyFields(),
        ...parsed,
        date: parsed.date ?? emptyFields().date,
        title: parsed.title ?? emptyFields().title,
        body: parsed.body,
        tags: parsed.tags ?? emptyFields().tags,
        lucidity: parsed.lucidity ?? emptyFields().lucidity,
        raw: typeof parsed.raw === "string" ? parsed.raw : parsed.body.value,
      };
    }
  } catch {
    // A stored transcript from an older shape (plain text) still has to show.
  }
  return fieldsFromTranscript(text, null);
}

const splitPartSchema = z.object({
  title: z.string().optional().nullable(),
  body: z.string(),
  isFragment: z.boolean().optional(),
  is_fragment: z.boolean().optional(),
});

const splitSchema = z.object({
  dreams: z.array(splitPartSchema).min(1).max(20),
});

export function parseSplitParts(text: string): SplitPart[] {
  const parsed = splitSchema.parse(parseJsonObject(text));
  const parts: SplitPart[] = [];
  for (const part of parsed.dreams) {
    const body = clip(part.body, MAX_BODY_LENGTH);
    if (!body) continue;
    const title = part.title?.trim() ? clip(part.title, MAX_TITLE_LENGTH) : null;
    parts.push({
      title,
      body,
      isFragment: Boolean(part.isFragment ?? part.is_fragment),
    });
  }
  if (parts.length === 0) throw new Error("The model did not return JSON.");
  return parts;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function intOrNull(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) return null;
  return rounded;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
