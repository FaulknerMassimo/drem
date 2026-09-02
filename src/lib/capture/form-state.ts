/**
 * Form state for capture flows.
 *
 * Kept out of the `"use server"` module so client components can import the
 * type without pulling the worker into the bundle.
 */
import type { ImportedDream } from "./types";
import type { SplitPart } from "./types";

export interface CaptureFormState {
  error?: string;
  uploaded?: number;
  ids?: string[];
}

/**
 * The result of storing a single photograph.
 *
 * The photo form uploads page by page rather than as one batch, so it needs a
 * per-file answer instead of a redirect.
 */
export interface PhotoUploadResult {
  id?: string;
  duplicate?: boolean;
  queued?: boolean;
  error?: string;
}

export interface ReviewFormState {
  error?: string;
  saved?: boolean;
  dreamIds?: string[];
  splitProposal?: SplitPart[];
}

export interface ImportFormState {
  error?: string;
  entries?: ImportedDream[];
  skipped?: number;
  format?: string;
  created?: number;
}

export interface SplitFormState {
  error?: string;
  proposal?: SplitPart[];
  created?: number;
  dreamIds?: string[];
}
