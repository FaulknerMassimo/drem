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
