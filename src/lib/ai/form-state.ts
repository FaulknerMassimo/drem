/**
 * Form state for AI settings and insight requests.
 *
 * Kept out of the `"use server"` module so client components can import the
 * type without pulling the worker — and the database behind it — into the
 * bundle.
 */
export interface SettingsFormState {
  error?: string;
  saved?: boolean;
}

export interface TestFormState {
  error?: string;
  ok?: boolean;
  message?: string;
  models?: string[];
  providerId?: string;
}

export interface InsightFormState {
  error?: string;
  queued?: boolean;
}
