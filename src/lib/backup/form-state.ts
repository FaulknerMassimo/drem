/**
 * Form state for the backup screens.
 *
 * Kept out of the `"use server"` module so client components can import the
 * types without pulling the export path into the browser bundle.
 */
import type { RestoreResult } from "./restore";

export interface RestoreFormState {
  error?: string;
  result?: RestoreResult;
}

/**
 * Why an export was refused.
 *
 * A code rather than a message, because the export form posts natively to a
 * route handler and the answer comes back on the query string: a code cannot
 * be used to reflect arbitrary text onto the page.
 */
export const EXPORT_ERRORS = {
  passphrase: "That passphrase is too short — it is the only thing protecting the file.",
  mismatch: "Those two passphrases are not the same.",
  failed: "The archive could not be written.",
} as const;

export type ExportErrorCode = keyof typeof EXPORT_ERRORS;

export function isExportErrorCode(value: unknown): value is ExportErrorCode {
  return typeof value === "string" && value in EXPORT_ERRORS;
}
