/**
 * Form state for search and dream signs.
 *
 * Kept out of the `"use server"` module so client components can import the
 * types without pulling the worker — and the database behind it — into the
 * bundle.
 */
import type { DreamSummary } from "@/lib/journal/dreams";

export interface SearchHitView {
  dream: DreamSummary;
  score: number;
}

export interface SearchFormState {
  error?: string;
  /** Echoed back so the box still holds what was searched for. */
  query?: string;
  hits?: SearchHitView[];
  /** True once a search has actually run, so "no matches" can be said. */
  searched?: boolean;
}

export interface IndexFormState {
  error?: string;
  /** How many entries were queued for indexing. */
  queued?: number;
}

export interface SignFormState {
  error?: string;
  queued?: boolean;
  added?: boolean;
}
