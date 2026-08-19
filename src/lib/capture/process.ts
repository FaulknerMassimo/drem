/**
 * Capture jobs: OCR a photographed page, transcribe a voice memo.
 *
 * Called from the in-process worker. Identifiers in, ciphertext out. The
 * transcript is written to `attachments.transcript_enc` and never into the
 * job row.
 */
import "server-only";
import { recordAuthEvent } from "@/lib/auth/audit";
import type { UserKeys } from "@/lib/crypto/envelope";
import { completeRole, RoleNotConfiguredError } from "@/lib/ai/chat";
import { loadAiConfig } from "@/lib/ai/config";
import { MAX_STACK_PAGES, OCR_RESPONSE_SCHEMA, ocrMessages } from "@/lib/ai/prompts";
import { OCR_TIMEOUT_MS } from "@/lib/ai/providers/http";
import { publicModelError } from "@/lib/ai/public-error";
import {
  getAttachment,
  imageBytesForModel,
  markAttachmentStatus,
  markStackStatus,
  readAttachmentBlob,
  saveReading,
  stackPageIds,
} from "./attachments";
import { dreamFromTranscript, parseStackReading } from "./fields";
import { transcribeAudio } from "./whisper";

class SkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkipError";
  }
}

export { SkipError as CaptureSkipError };

/**
 * What one reading may spend, given how many pages it carries.
 *
 * The per-role ceilings in `chat.ts` are written for a call whose cost is
 * fixed. A stack's is not: every page is another image in the request and
 * another page of handwriting that has to come back inside the JSON before
 * there is anything to parse, so both halves scale with the stack. The old
 * one-page budget applied to a four-page stack does not fail cleanly -- it
 * cuts the transcript off mid-sentence at the same place every time, which is
 * the failure the split role was already caught by.
 *
 * Linear in the page count, and bounded only because `MAX_STACK_PAGES` is.
 * Nobody waits on this: it is a queued job behind a screen that polls.
 */
function readingBudget(pageCount: number): { maxTokens: number; timeoutMs: number } {
  const pages = Math.max(1, Math.min(pageCount, MAX_STACK_PAGES));
  return { maxTokens: 4096 * pages, timeoutMs: OCR_TIMEOUT_MS * pages };
}

/**
 * Reads one stack of photographed pages into its separate dreams.
 *
 * The job is enqueued against the stack's lead page and covers every page of
 * it, because "does this dream carry on over the page" and "does this page
 * start a new one" are questions about the stack rather than about any page in
 * it. Reading page by page could not answer either, and pushed both back onto
 * the writer as a tick-box join followed by a second model pass to split the
 * joined text apart again.
 */
export async function runOcrJob(userId: string, keys: UserKeys, leadId: string): Promise<void> {
  const lead = await getAttachment(userId, keys, leadId);
  if (!lead) throw new SkipError("That upload no longer exists.");
  if (lead.kind !== "image") throw new SkipError("OCR is for photographs.");

  const pageIds = (await stackPageIds(userId, lead.stackId)).slice(0, MAX_STACK_PAGES);
  if (pageIds.length === 0) throw new SkipError("Those pages no longer exist.");

  await markStackStatus(userId, lead.stackId, "running");

  const images = [];
  for (const pageId of pageIds) {
    const image = await imageBytesForModel(userId, keys, pageId);
    // A page that will not decode is dropped rather than failing the stack:
    // the rest of the night is still readable, and the writer can see which
    // photograph has no text against it on the review screen.
    if (image) images.push({ mimeType: image.mimeType, bytes: image.bytes });
  }
  if (images.length === 0) throw new SkipError("Those photographs could not be read.");

  const config = await loadAiConfig(userId, keys);
  const prompt = ocrMessages(images.length);
  const { response, destination } = await completeRole(
    config,
    "ocr",
    [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    {
      json: true,
      jsonSchema: OCR_RESPONSE_SCHEMA,
      images,
      budget: readingBudget(images.length),
    },
  );

  const dreams = parseStackReading(response.text, images.length);
  await saveReading(userId, keys, leadId, dreams);
  await markStackStatus(userId, lead.stackId, "succeeded");

  await recordAuthEvent("ai_request", {
    userId,
    detail: {
      kind: "ocr",
      provider: destination.providerKind,
      host: destination.host,
      leavesMachine: destination.leavesMachine,
      pages: images.length,
      dreams: dreams.length,
    },
  });
}

export async function runTranscribeJob(
  userId: string,
  keys: UserKeys,
  attachmentId: string,
): Promise<void> {
  const attachment = await getAttachment(userId, keys, attachmentId);
  if (!attachment) throw new SkipError("That upload no longer exists.");
  if (attachment.kind !== "audio") throw new SkipError("Transcription is for voice memos.");

  await markAttachmentStatus(userId, attachmentId, "running");

  const blob = await readAttachmentBlob(userId, keys, attachmentId);
  if (!blob) throw new SkipError("That recording could not be read.");

  const extension = extensionFor(blob.mimeType);
  const result = await transcribeAudio(blob.bytes, blob.mimeType, `memo.${extension}`);
  // A memo is its own stack of one, and speech has no page structure to carve
  // by, so the reading is a single dream. The review screen's split is what
  // separates a memo that ran through several dreams.
  await saveReading(userId, keys, attachmentId, [
    dreamFromTranscript(result.text, result.confidence),
  ]);
}

export function publicCaptureError(error: unknown): string {
  // The generic "No model is assigned for ocr." does not tell the operator
  // which setting to go and change; every other case is the shared cascade.
  if (error instanceof RoleNotConfiguredError) {
    return "No page-reading model is assigned. Choose one in Settings.";
  }
  return publicModelError(error, "Processing failed.");
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("flac")) return "flac";
  return "bin";
}
