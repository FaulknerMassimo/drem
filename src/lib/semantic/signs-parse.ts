/**
 * Parsing for the dream-sign scan's reply.
 *
 * The scan is the only model output that becomes *rows*, not prose: a bad
 * entry index would attach a sign to a dream it never appeared in, and nothing
 * downstream could tell that it was wrong. So indices are validated against the
 * window that was actually sent, and anything outside it is dropped rather
 * than clamped — a model that invented an index also invented the sign.
 */
import { dreamSignCategory } from "@/db/schema";
import { parseJsonObject } from "@/lib/ai/json";
import { isSignCategory, SIGN_CATEGORIES, type SignCategory } from "./labels";

/**
 * Compile-time guard: `SIGN_CATEGORIES` is duplicated in `labels.ts` so client
 * components need not import the schema, and this fails the build if the two
 * ever diverge.
 */
type EnumCategory = (typeof dreamSignCategory.enumValues)[number];
type CategoriesMatchSchema = SignCategory extends EnumCategory
  ? EnumCategory extends SignCategory
    ? true
    : never
  : never;
const categoriesMatchSchema: CategoriesMatchSchema = true;
void categoriesMatchSchema;
void SIGN_CATEGORIES;

export const MAX_SIGN_LABEL_LENGTH = 60;

/** A ceiling on one scan's output, so a runaway reply cannot flood the table. */
export const MAX_SIGNS_PER_SCAN = 40;

/**
 * A cue must appear at least twice to be a dream sign at all — that is what
 * makes it recognisable from inside a dream rather than a one-off detail.
 */
export const MIN_OCCURRENCES = 2;

export interface ProposedSign {
  label: string;
  category: SignCategory;
  /** Zero-based positions into the window that was sent. */
  entries: number[];
  confidence: number;
}

/**
 * Every field is read defensively rather than through a schema, so one
 * malformed entry costs its own sign and not the whole scan: a validator that
 * rejects the array wholesale throws away nineteen good signs because the
 * twentieth had a number where a string belonged.
 *
 * @param windowSize how many entries the scan was given; indices are 1-based
 *                   in the reply and returned zero-based here.
 */
export function parseSignScan(text: string, windowSize: number): ProposedSign[] {
  const payload = parseJsonObject(text);
  const raws = readRecord(payload).signs;
  if (!Array.isArray(raws)) return [];

  const signs: ProposedSign[] = [];
  const seen = new Set<string>();

  for (const entry of raws) {
    const raw = readRecord(entry);
    const label = readLabel(raw.label);
    if (!label) continue;

    // Case-folded, because a model listing "Blue Door" and "blue door" means
    // one sign, and the two would collide on the blind index anyway.
    const key = label.toLowerCase();
    if (seen.has(key)) continue;

    const entries = readEntries(raw.entries, windowSize);
    if (entries.length < MIN_OCCURRENCES) continue;

    seen.add(key);
    signs.push({
      label,
      category: isSignCategory(raw.category) ? raw.category : "theme",
      entries,
      confidence: readConfidence(raw.confidence),
    });
    if (signs.length >= MAX_SIGNS_PER_SCAN) break;
  }

  return signs;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/gu, " ").slice(0, MAX_SIGN_LABEL_LENGTH);
  return trimmed.length > 0 ? trimmed : null;
}

function readEntries(value: unknown, windowSize: number): number[] {
  if (!Array.isArray(value)) return [];
  const indices = new Set<number>();
  for (const entry of value) {
    const index = typeof entry === "number" ? entry : Number.parseInt(String(entry), 10);
    if (!Number.isInteger(index)) continue;
    // The prompt numbers entries from 1; anything outside that range is
    // hallucinated, and silently clamping it would file a real sign against
    // an unrelated dream.
    if (index < 1 || index > windowSize) continue;
    indices.add(index - 1);
  }
  return [...indices].sort((a, b) => a - b);
}

function readConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}
