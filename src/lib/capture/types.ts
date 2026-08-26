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

/**
 * One dream, as a stack of pages was read.
 *
 * The fields a page states, plus the two facts that only make sense once the
 * copies have been joined and split: whether this is a fragment, and which
 * pages of the stack it was written across.
 */
export interface ReadDream extends ExtractedFields {
  isFragment: boolean;
  /**
   * 1-based page numbers within the stack, in the order they were sent.
   *
   * Empty when the model did not say, or said something outside the stack —
   * an index is dropped rather than clamped, because a page filed against the
   * wrong dream is a mistake nothing downstream can detect.
   */
  pages: number[];
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

/** One file within a stack, for the review screen's page strip. */
export interface ReviewPage {
  id: string;
  kind: AttachmentKind;
}

/**
 * A stack of pages and what the reading job made of them.
 *
 * The stack has no row of its own — a table whose only column is a uuid would
 * be one — so it is keyed by the `stack_id` its pages share. `dreams` is empty
 * until the reading lands, and holds one entry per dream the job found,
 * which is not one per page and is the whole reason the stack is the unit.
 */
export interface ReviewStack {
  /** The stack's own key, which is what every stack-level action takes. */
  id: string;
  /** The page carrying the reading and the job. Not interchangeable with `id`. */
  leadId: string;
  kind: AttachmentKind;
  status: AttachmentStatus;
  sent: boolean;
  pages: ReviewPage[];
  dreams: ReadDream[];
}

/**
 * How the capture job behind an attachment is faring.
 *
 * Separate from `ReviewStack` because it comes from the queue, not the
 * attachment row, and the attachment row cannot tell the difference between a
 * first attempt and a third one waiting out a backoff.
 */
export interface CaptureProgress {
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  /**
   * How far the transcript has got, while it is being written. A phase and a
   * count of characters — never a word of the page itself, which is the whole
   * reason the reading is happening at all.
   */
  progress: { phase: "thinking" | "writing"; characters: number; at: Date } | null;
}
