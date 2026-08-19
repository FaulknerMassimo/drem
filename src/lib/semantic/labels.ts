/**
 * Human labels for dream-sign categories.
 *
 * Duplicated from the schema enum on purpose, the same way `journal/labels.ts`
 * is, so client components do not pull Drizzle into the browser bundle.
 * `signs-parse.ts` holds the compile-time guard against the two drifting.
 */

export const SIGN_CATEGORIES = [
  "person",
  "place",
  "object",
  "action",
  "emotion",
  "anomaly",
  "theme",
] as const;

export type SignCategory = (typeof SIGN_CATEGORIES)[number];

export const SIGN_CATEGORY_LABELS: Record<SignCategory, string> = {
  person: "Person",
  place: "Place",
  object: "Object",
  action: "Action",
  emotion: "Emotion",
  anomaly: "Anomaly",
  theme: "Theme",
};

export const SIGN_CATEGORY_HINTS: Record<SignCategory, string> = {
  person: "Someone who keeps turning up.",
  place: "A setting you return to.",
  object: "A thing that recurs.",
  action: "Something you keep doing, or that keeps happening to you.",
  emotion: "A feeling that recurs strongly enough to be recognisable.",
  anomaly: "An impossible or inconsistent detail — the richest lucidity cue.",
  theme: "A situation or shape the dream keeps taking.",
};

export function isSignCategory(value: unknown): value is SignCategory {
  return typeof value === "string" && (SIGN_CATEGORIES as readonly string[]).includes(value);
}
