/**
 * Capture types that client components may import.
 *
 * Kept free of `server-only`, the database, and the journal validation module
 * so the review UI does not pull Drizzle into the browser bundle.
 */

export interface FieldConfidence<T> {
  value: T;
  confidence: number | null;
}

export interface ExtractedFields {
  date: FieldConfidence<string | null>;
  title: FieldConfidence<string | null>;
  body: FieldConfidence<string>;
  tags: FieldConfidence<string[]>;
  lucidity: FieldConfidence<number | null>;
  raw: string;
}

export interface SplitPart {
  title: string | null;
  body: string;
  isFragment: boolean;
}

export interface ImportedDream {
  nightDate: string;
  title: string | null;
  body: string;
  lucidity: number;
  vividness: number | null;
  control: number | null;
  recallClarity: number | null;
  emotionalValence: number | null;
  isNightmare: boolean;
  isRecurring: boolean;
  isFragment: boolean;
  tags: string[];
}

export type AttachmentKind = "image" | "audio";
export type AttachmentStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface ReviewAttachment {
  id: string;
  kind: AttachmentKind;
  status: AttachmentStatus;
  fields: ExtractedFields;
}

/**
 * How the capture job behind an attachment is faring.
 *
 * Separate from `ReviewAttachment` because it comes from the queue, not the
 * attachment row, and the attachment row cannot tell the difference between a
 * first attempt and a third one waiting out a backoff.
 */
export interface CaptureProgress {
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
}
