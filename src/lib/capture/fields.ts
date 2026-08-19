/**
 * Parsing for OCR, transcription and split-log model output.
 *
 * Same posture as `ai/json.ts`: models wrap objects in fences or chatter,
 * and none of that (nor the raw reply) should leak into `jobs.last_error`.
 */
import { z } from "zod";
import { isIsoDate } from "@/lib/journal/dates";
import { parseJsonObject } from "@/lib/ai/json";
import type { ExtractedFields, FieldConfidence, ReadDream, SplitPart } from "./types";

export type { ExtractedFields, FieldConfidence, ReadDream, SplitPart };

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

const dreamSchema = z
  .object({
    pages: z.unknown().optional(),
    isFragment: z.unknown().optional(),
    is_fragment: z.unknown().optional(),
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

const readingSchema = z.object({
  dreams: z.array(z.unknown()).min(1).max(20),
});

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * The date the page is dated, not the date it was photographed.
 *
 * A journal page is headed the way a person writes a date -- "12 March 2026",
 * "March 12, 2026" -- and the model transcribes it literally, as instructed.
 * Insisting on ISO here meant every imported page silently fell back to
 * tonight's night date, which is precisely wrong for the case this feature
 * exists to serve: working through a stack of old pages.
 *
 * Only month-name spellings are read. All-numeric forms are left alone because
 * 03/04/2026 is March or April depending on who wrote it, and quietly picking
 * one would file entries under a date the writer never wrote.
 */
function isoDateFrom(value: string | null): string | null {
  if (!value) return null;
  // Lowercased before the guard: `isIsoDate` narrows to a branded type, and
  // the else-branch of that narrowing is `never`.
  const text = value.toLowerCase();
  if (isIsoDate(value)) return value;

  const monthIndex = MONTHS.findIndex((month) => text.includes(month.slice(0, 3)));
  if (monthIndex < 0) return null;

  const numbers = [...text.matchAll(/\d+/g)].map((match) => Number(match[0]));
  const day = numbers.find((number) => number >= 1 && number <= 31);
  const year = numbers.find((number) => number >= 1000 && number <= 9999);
  if (day === undefined || year === undefined) return null;

  const candidate = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isIsoDate(candidate) ? candidate : null;
}

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

/**
 * The keys that make a reply a transcript rather than just an object.
 *
 * Every field here is optional, and deliberately so -- a model that reads a
 * date but no title should not lose the date over it. The cost is that an
 * object sharing *no* keys with the schema also parses, silently, into blanks.
 * That is not a page with nothing on it; that is a reply we did not understand,
 * and the two must not be filed the same way.
 */
const TRANSCRIPT_KEYS = [
  "date",
  "title",
  "body",
  "text",
  "tags",
  "lucidity",
  "dateConfidence",
  "titleConfidence",
  "bodyConfidence",
  "tagsConfidence",
  "lucidityConfidence",
];

function hasTranscriptKey(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  return TRANSCRIPT_KEYS.some((key) => key in (value as Record<string, unknown>));
}

/** The wrapper counts too: `{ dreams: [...] }` is the shape actually asked for. */
function hasReadingKey(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if ("dreams" in (value as Record<string, unknown>)) return true;
  return hasTranscriptKey(value);
}

/**
 * One dream out of a reading, from whatever shape the model used for it.
 *
 * `pageCount` is the size of the stack that was actually sent. Any page number
 * outside it is dropped, never clamped: the same rule the dream-sign scan
 * holds to, and for the same reason -- a page filed against the wrong dream is
 * a mistake nothing downstream can detect, and the photograph strip on the
 * review screen would show it next to text it has nothing to do with.
 */
function readDreamFrom(reply: unknown, pageCount: number): ReadDream {
  const parsed = dreamSchema.parse(reply);
  const record = parsed as Record<string, unknown>;

  const dateRaw = stringOrNull(nestedValue(record, "date"));
  const date = isoDateFrom(dateRaw);

  const title = stringOrNull(nestedValue(record, "title"));
  const body =
    stringOrNull(nestedValue(record, "body")) ??
    stringOrNull(nestedValue(record, "text")) ??
    "";

  const tags = stringList(nestedValue(record, "tags"));
  const lucidity = intOrNull(nestedValue(record, "lucidity"), 0, 5);
  const clipped = clip(body, MAX_BODY_LENGTH);

  return {
    date: { value: date, confidence: nestedConfidence(record, "date", "dateConfidence") },
    title: {
      value: title ? clip(title, MAX_TITLE_LENGTH) : null,
      confidence: nestedConfidence(record, "title", "titleConfidence"),
    },
    body: {
      value: clipped,
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
    raw: clipped,
    isFragment: Boolean(record.isFragment ?? record.is_fragment),
    pages: pageList(record.pages, pageCount),
  };
}

/**
 * What one model call made of a stack of pages: its separate dreams.
 *
 * A bare transcript object -- no `dreams` array, just the fields -- is read as
 * a stack holding one dream rather than rejected. That is what a model does
 * when it decides the schema's wrapper is noise, and it is a correct answer to
 * a one-page stack written the wrong way round; refusing it would fail a
 * reading that is entirely usable.
 */
export function parseStackReading(text: string, pageCount: number): ReadDream[] {
  const reply = parseJsonObject(text);
  /*
   * Thrown rather than returned empty so the job fails, backs off and retries,
   * and -- if the model keeps answering its own way -- says so on the review
   * screen. Returning blanks instead hands the writer an empty form and no
   * reason for it, which is indistinguishable from a page the model could not
   * read. The reply itself is never quoted: it is dream-derived, and this
   * message is persisted on the job.
   */
  if (!hasReadingKey(reply)) {
    throw new Error("The model's reply had none of the fields a page transcript needs.");
  }

  const record = reply as Record<string, unknown>;
  if (!Array.isArray(record.dreams)) return [readDreamFrom(reply, pageCount)];

  const dreams: ReadDream[] = [];
  for (const item of readingSchema.parse(record).dreams) {
    if (!hasTranscriptKey(item)) continue;
    const dream = readDreamFrom(item, pageCount);
    // An item with no text is not a dream the pages hold; it is the model
    // padding the array out to the shape of the schema.
    if (dream.body.value) dreams.push(dream);
  }
  if (dreams.length === 0) {
    throw new Error("The model returned no dream text for those pages.");
  }
  return dreams;
}

/** A speech transcript: one dream, no page structure to speak of. */
export function dreamFromTranscript(text: string, confidence: number | null): ReadDream {
  const body = clip(text, MAX_BODY_LENGTH);
  return {
    ...emptyDream(),
    body: { value: body, confidence },
    raw: body,
  };
}

export function emptyDream(): ReadDream {
  return { ...emptyFields(), isFragment: false, pages: [] };
}

export function serialiseReading(dreams: ReadDream[]): string {
  return JSON.stringify({ dreams });
}

/**
 * A stored reading, including ones written before a stack was the unit.
 *
 * Three shapes have been persisted into `transcript_enc`: the current
 * `{ dreams: [...] }`, a single `ExtractedFields` object from when a reading
 * was one page, and bare text from before that. All three still have to open,
 * because the rows are encrypted under a key only the owner has and there is
 * no migration that could rewrite them.
 */
export function parseStoredReading(text: string): ReadDream[] {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.dreams)) {
        const dreams = parsed.dreams
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
          .map((item) => storedDream(item));
        if (dreams.length > 0) return dreams;
      }
      if (parsed.body && typeof parsed.body === "object") return [storedDream(parsed)];
    }
  } catch {
    // A stored transcript from an older shape (plain text) still has to show.
  }
  return [dreamFromTranscript(text, null)];
}

function storedDream(parsed: Record<string, unknown>): ReadDream {
  const base = emptyDream();
  const fields = parsed as Partial<ReadDream>;
  const body = fields.body ?? base.body;
  return {
    ...base,
    ...fields,
    date: fields.date ?? base.date,
    title: fields.title ?? base.title,
    body,
    tags: fields.tags ?? base.tags,
    lucidity: fields.lucidity ?? base.lucidity,
    raw: typeof fields.raw === "string" ? fields.raw : body.value,
    isFragment: Boolean(fields.isFragment),
    pages: Array.isArray(fields.pages) ? fields.pages : [],
  };
}

/**
 * Page numbers the stack actually has, de-duplicated and in reading order.
 *
 * A model that answers `[2, 1]`, or `[1, 1]`, means the same thing as `[1, 2]`
 * and `[1]`; a model that answers `[7]` for a three-page stack does not mean
 * anything, and that entry is left with no pages rather than a guessed one.
 */
function pageList(value: unknown, pageCount: number): number[] {
  const raw = typeof value === "number" ? [value] : Array.isArray(value) ? value : [];
  const seen = new Set<number>();
  for (const item of raw) {
    const page = typeof item === "number" ? item : Number(item);
    if (!Number.isInteger(page) || page < 1 || page > pageCount) continue;
    seen.add(page);
  }
  return [...seen].sort((a, b) => a - b);
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

/**
 * A rating as written on the page, which is rarely a bare number.
 *
 * Pages say "Lucidity: fairly clear, maybe a 3", and the model echoes that
 * phrase verbatim because the prompt tells it to be literal. Refusing anything
 * that is not already a number throws away a rating the page states plainly.
 *
 * Prose is only mined when it contains exactly one number in range: two
 * numbers means the sentence is about something else as well, and a guess
 * there would be worse than the blank the reviewer can fill in.
 */
function intOrNull(value: unknown, min: number, max: number): number | null {
  if (typeof value === "string") return intOrNull(numberInText(value, min, max), min, max);
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) return null;
  return rounded;
}

function numberInText(text: string, min: number, max: number): number | null {
  const inRange = [...text.matchAll(/-?\d+(?:\.\d+)?/g)]
    .map((match) => Number(match[0]))
    .filter((value) => Number.isFinite(value) && value >= min && value <= max);
  return inRange.length === 1 ? inRange[0]! : null;
}

/**
 * Tags as the model actually returns them.
 *
 * The prompt asks for an array and a strong model obliges, but a page whose
 * tag line reads "tags: lighthouse, stairs, hands" invites the model to hand
 * that line straight back as one string. Returning `[]` for it drops tags the
 * model read correctly, and drops them silently -- the review screen just
 * shows an empty box, which reads as "the model could not see the page".
 */
function stringList(value: unknown): string[] {
  if (typeof value === "string") return stringList(value.split(/[,;\n]/));
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
