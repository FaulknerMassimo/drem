/**
 * Form parsing for the journal.
 *
 * Everything a form submits arrives as strings, and half of it arrives absent:
 * an unchecked checkbox is simply missing, and a cleared number field is the
 * empty string rather than null. These schemas are the single place that gets
 * translated into typed values, so no action has to guess.
 */
import { z } from "zod";
import { inductionTechnique } from "@/db/schema";
import { isIsoDate, type IsoDate } from "./dates";
import { TECHNIQUES, type Technique } from "./labels";

/**
 * Compile-time guard: `TECHNIQUES` is duplicated in `labels.ts` so client
 * components need not import the schema, and this fails the build if the two
 * ever diverge.
 */
type EnumTechnique = (typeof inductionTechnique.enumValues)[number];
type TechniquesMatchSchema = Technique extends EnumTechnique
  ? EnumTechnique extends Technique
    ? true
    : never
  : never;
const techniquesMatchSchema: TechniquesMatchSchema = true;
void techniquesMatchSchema;

export const MAX_TITLE_LENGTH = 200;
export const MAX_BODY_LENGTH = 50_000;
export const MAX_NOTES_LENGTH = 10_000;
export const MAX_TAG_LENGTH = 60;
export const MAX_TAGS_PER_DREAM = 24;

const isoDate = z.string().refine(isIsoDate, "That is not a valid date.");

/** `<input type="time">` submits HH:MM; Postgres `time` reads back HH:MM:SS. */
const clockTime = z
  .string()
  .regex(/^\d{2}:\d{2}(:\d{2})?$/, "Times must look like 23:30.")
  .transform((value) => value.slice(0, 5));

/** An empty field means "not recorded", which is a null, not a zero. */
function optional<T extends z.ZodTypeAny>(inner: T) {
  return z.preprocess(
    (value) => (value === "" || value === undefined || value === null ? null : value),
    inner.nullable(),
  );
}

function rating(field: string) {
  return optional(
    z.coerce
      .number()
      .int()
      .min(1, `${field} must be between 1 and 5.`)
      .max(5, `${field} must be between 1 and 5.`),
  );
}

export const dreamInputSchema = z
  .object({
    nightDate: isoDate,
    title: optional(z.string().trim().max(MAX_TITLE_LENGTH, "That title is too long.")),
    body: optional(z.string().max(MAX_BODY_LENGTH, "That entry is too long to store.")),
    lucidity: z.coerce
      .number()
      .int()
      .min(0, "Lucidity must be between 0 and 5.")
      .max(5, "Lucidity must be between 0 and 5.")
      .default(0),
    vividness: rating("Vividness"),
    control: rating("Control"),
    recallClarity: rating("Recall clarity"),
    emotionalValence: optional(
      z.coerce
        .number()
        .int()
        .min(-2, "Emotional tone must be between -2 and 2.")
        .max(2, "Emotional tone must be between -2 and 2."),
    ),
    isNightmare: z.boolean().default(false),
    isRecurring: z.boolean().default(false),
    isFragment: z.boolean().default(false),
    isDraft: z.boolean().default(false),
    tags: z.array(z.string()).default([]),
  })
  .refine((value) => Boolean(value.title || value.body), {
    message: "Write something before saving — a title or the dream itself.",
  });

export type DreamInput = z.infer<typeof dreamInputSchema>;

export const nightInputSchema = z.object({
  date: isoDate,
  bedTime: optional(clockTime),
  wakeTime: optional(clockTime),
  wbtbTime: optional(clockTime),
  sleepQuality: rating("Sleep quality"),
  techniques: z.array(z.enum(TECHNIQUES)).default([]),
  noRecall: z.boolean().default(false),
  notes: optional(z.string().max(MAX_NOTES_LENGTH, "Those notes are too long to store.")),
});

export type NightInput = z.infer<typeof nightInputSchema>;

export const captureInputSchema = z.object({
  nightDate: isoDate,
  body: z
    .string()
    .trim()
    .min(1, "Nothing to save yet.")
    .max(MAX_BODY_LENGTH, "That entry is too long to store."),
});

export type CaptureInput = z.infer<typeof captureInputSchema>;

// ---------------------------------------------------------------------------
// FormData readers
// ---------------------------------------------------------------------------

function text(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
}

/** An unchecked box submits nothing at all, which is the whole subtlety. */
function checkbox(form: FormData, name: string): boolean {
  return form.get(name) !== null;
}

function list(form: FormData, name: string): string[] {
  return form.getAll(name).filter((value): value is string => typeof value === "string");
}

/**
 * Splits a free-text tag field. Commas and newlines both separate, because both
 * are what people actually type, and blanks from trailing commas are dropped.
 */
export function parseTagInput(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const candidate of raw.split(/[,\n]/u)) {
    const name = candidate.trim().slice(0, MAX_TAG_LENGTH);
    if (!name) continue;
    // De-duplicate case-insensitively so "Flying" and "flying" are one tag.
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= MAX_TAGS_PER_DREAM) break;
  }
  return names;
}

export function readDreamForm(form: FormData): unknown {
  return {
    nightDate: text(form, "nightDate"),
    title: text(form, "title"),
    body: text(form, "body"),
    lucidity: text(form, "lucidity") || 0,
    vividness: text(form, "vividness"),
    control: text(form, "control"),
    recallClarity: text(form, "recallClarity"),
    emotionalValence: text(form, "emotionalValence"),
    isNightmare: checkbox(form, "isNightmare"),
    isRecurring: checkbox(form, "isRecurring"),
    isFragment: checkbox(form, "isFragment"),
    isDraft: false,
    tags: parseTagInput(text(form, "tags")),
  };
}

export function readNightForm(form: FormData): unknown {
  return {
    date: text(form, "date"),
    bedTime: text(form, "bedTime"),
    wakeTime: text(form, "wakeTime"),
    wbtbTime: text(form, "wbtbTime"),
    sleepQuality: text(form, "sleepQuality"),
    techniques: list(form, "techniques"),
    noRecall: checkbox(form, "noRecall"),
    notes: text(form, "notes"),
  };
}

/**
 * Turns a validation failure into one sentence.
 *
 * Deliberately terse: the alternative is echoing the submitted value back into
 * the message, and submitted values here are dream text.
 */
export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "That entry could not be saved.";
}

// ---------------------------------------------------------------------------
// List filters
// ---------------------------------------------------------------------------

export const SORT_ORDERS = ["newest", "oldest", "longest"] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

export interface JournalFilters {
  from: IsoDate | null;
  to: IsoDate | null;
  lucidOnly: boolean;
  nightmaresOnly: boolean;
  includeFragments: boolean;
  tag: string | null;
  sort: SortOrder;
  page: number;
}

/**
 * Filters come from the query string rather than a POST, so a filtered view is
 * linkable and survives a reload — and needs no CSRF token to be safe.
 */
export function parseFilters(params: URLSearchParams): JournalFilters {
  const raw = (name: string) => params.get(name)?.trim() || null;
  const date = (name: string) => {
    const value = raw(name);
    return value && isIsoDate(value) ? value : null;
  };
  const sort = raw("sort");
  const page = Number.parseInt(raw("page") ?? "1", 10);

  return {
    from: date("from"),
    to: date("to"),
    lucidOnly: raw("lucid") === "1",
    nightmaresOnly: raw("nightmares") === "1",
    // Fragments are scraps; they clutter the list unless asked for.
    includeFragments: raw("fragments") !== "0",
    tag: raw("tag"),
    sort: SORT_ORDERS.includes(sort as SortOrder) ? (sort as SortOrder) : "newest",
    page: Number.isFinite(page) && page > 0 ? Math.min(page, 10_000) : 1,
  };
}

/** Rebuilds a query string, omitting defaults so links stay readable. */
export function filtersToQuery(
  filters: JournalFilters,
  overrides: Partial<JournalFilters> = {},
): string {
  const merged = { ...filters, ...overrides };
  const params = new URLSearchParams();
  if (merged.from) params.set("from", merged.from);
  if (merged.to) params.set("to", merged.to);
  if (merged.lucidOnly) params.set("lucid", "1");
  if (merged.nightmaresOnly) params.set("nightmares", "1");
  if (!merged.includeFragments) params.set("fragments", "0");
  if (merged.tag) params.set("tag", merged.tag);
  if (merged.sort !== "newest") params.set("sort", merged.sort);
  if (merged.page > 1) params.set("page", String(merged.page));
  const query = params.toString();
  return query ? `?${query}` : "";
}
