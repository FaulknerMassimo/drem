/**
 * Shared shape for journal form actions.
 *
 * Kept in its own module so client components can import the type without
 * pulling a `"use server"` module — or the database schema behind it — into the
 * browser bundle.
 */
export interface JournalFormState {
  error?: string;
  /** Set by the capture screen, which stays put instead of navigating away. */
  saved?: boolean;
  /** Changes on every save, so the confirmation re-announces itself. */
  savedAt?: number;
}
