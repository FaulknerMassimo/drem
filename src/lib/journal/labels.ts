/**
 * Human labels for the journal's enumerations.
 *
 * Kept free of any database or `server-only` import so client components can
 * use it without pulling Drizzle into the browser bundle. `validation.ts` holds
 * a compile-time guard that these lists cannot drift from the schema enums.
 */

export const TECHNIQUES = [
  "none",
  "mild",
  "wbtb",
  "wild",
  "ssild",
  "fild",
  "dild",
  "reality_check",
  "dream_journal",
  "other",
] as const;

export type Technique = (typeof TECHNIQUES)[number];

/** Spelled out: the acronyms are unreadable at 7am, which is when they are used. */
export const TECHNIQUE_LABELS: Record<Technique, string> = {
  none: "None",
  mild: "MILD — mnemonic induction",
  wbtb: "WBTB — wake back to bed",
  wild: "WILD — wake induced",
  ssild: "SSILD — senses initiated",
  fild: "FILD — finger induced",
  dild: "DILD — dream initiated",
  reality_check: "Reality checks",
  dream_journal: "Journalling",
  other: "Other",
};

/**
 * Lucidity is a scale, not a flag: "I knew I was dreaming and immediately woke"
 * and "I knew, and stayed in for twenty minutes" are different results from the
 * same technique, and collapsing them hides whether practice is working.
 */
export const LUCIDITY_LABELS: Record<number, string> = {
  0: "Not lucid",
  1: "A flicker of awareness",
  2: "Knew it was a dream, briefly",
  3: "Lucid, but unstable",
  4: "Stable and aware",
  5: "Fully lucid with control",
};

export const VALENCE_LABELS: Record<number, string> = {
  [-2]: "Nightmarish",
  [-1]: "Unpleasant",
  0: "Neutral",
  1: "Pleasant",
  2: "Blissful",
};

export const RATING_LABELS: Record<number, string> = {
  1: "1 — barely",
  2: "2",
  3: "3 — moderate",
  4: "4",
  5: "5 — completely",
};

export const SOURCE_LABELS: Record<string, string> = {
  typed: "Typed",
  quick_capture: "Captured at night",
  ocr: "Photographed",
  voice: "Dictated",
  import: "Imported",
};
