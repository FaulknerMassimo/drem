/**
 * Word counting.
 *
 * Counted from the plaintext at write time and stored in the clear, so length
 * statistics and the heatmap's intensity scale never need to decrypt the
 * archive. This is a deliberate, bounded leak: a stolen dump reveals how much
 * was written on a given night, never what.
 */

/**
 * Counts whitespace-separated runs, which is close enough for a trend line and
 * — unlike anything smarter — behaves the same for every language written with
 * spaces. Punctuation attached to a word is not counted separately.
 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/u).length;
}

/**
 * A short preview for list rows. Collapses whitespace so a multi-paragraph
 * entry does not render as a wall of gaps, and cuts on a word boundary.
 */
export function excerpt(text: string, limit = 200): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  const cut = collapsed.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
