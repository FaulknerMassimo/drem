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
import { destinationFor } from "@/lib/ai/destination";
import { MAX_STACK_PAGES, OCR_RESPONSE_SCHEMA, ocrMessages, splitMessages } from "@/lib/ai/prompts";
import { SPLIT_TIMEOUT_MS } from "@/lib/ai/providers/http";
import { publicModelError } from "@/lib/ai/public-error";
import type { AiConfig } from "@/lib/ai/types";
import {
  getAttachment,
  imageBytesForModel,
  markAttachmentStatus,
  markStackStatus,
  readAttachmentBlob,
  saveReading,
  stackPageIds,
} from "./attachments";
import {
  dreamFromTranscript,
  emptyDream,
  joinPageTranscripts,
  mergePageTranscripts,
  parsePageTranscript,
  parseSplitParts,
  readingFromPages,
  type ReadDream,
  type SplitPart,
} from "./fields";
import { transcribeAudio } from "./whisper";

class SkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkipError";
  }
}

export { SkipError as CaptureSkipError };

/**
 * What the split pass may spend, given how many pages the log was copied from.
 *
 * The split's answer is the log written out again inside JSON, so both the
 * token ceiling and the wait scale with the stack. The role's own 4096-token
 * budget is written for a typed entry; four photographed pages joined together
 * are the failure that budget was already caught by — a transcript cut off
 * mid-sentence at the same place every time.
 */
function splitBudget(pageCount: number): { maxTokens: number; timeoutMs: number } {
  const pages = Math.max(1, Math.min(pageCount, MAX_STACK_PAGES));
  return { maxTokens: 4096 * pages, timeoutMs: SPLIT_TIMEOUT_MS * pages };
}

/**
 * Reads one stack of photographed pages into its separate dreams.
 *
 * Each page is copied on its own. A vision model handed several images and
 * asked to transcribe *and* carve them produced a paraphrase of the night
 * instead of the words on the page — mixed fragments, invented spellings,
 * lost lines — and changing the prompt or the model did not recover the
 * copy. One image, one transcript is the job the model can do.
 *
 * The copies are then joined in photograph order and, if a split model is
 * assigned, carved into dreams as a text-only pass. That is the original
 * pipeline, minus the tick-box join: the stack already says which pages
 * belong together, and "does this dream carry on over the page" is a
 * question about the joined log, not about any photograph in it.
 */
export async function runOcrJob(userId: string, keys: UserKeys, leadId: string): Promise<void> {
  const lead = await getAttachment(userId, keys, leadId);
  if (!lead) throw new SkipError("That upload no longer exists.");
  if (lead.kind !== "image") throw new SkipError("OCR is for photographs.");

  const pageIds = (await stackPageIds(userId, lead.stackId)).slice(0, MAX_STACK_PAGES);
  if (pageIds.length === 0) throw new SkipError("Those pages no longer exist.");

  await markStackStatus(userId, lead.stackId, "running");

  const config = await loadAiConfig(userId, keys);
  const pages = await copyPages(userId, keys, config, pageIds);
  const log = joinPageTranscripts(pages);
  if (!log) throw new Error("The model returned no dream text for those pages.");

  const parts = await splitCopiedLog(userId, config, log, pages.length);
  const dreams = parts ? readingFromPages(pages, parts) : [mergePageTranscripts(pages)];

  await saveReading(userId, keys, leadId, dreams);
  await markStackStatus(userId, lead.stackId, "succeeded");
}

async function copyPages(
  userId: string,
  keys: UserKeys,
  config: AiConfig,
  pageIds: string[],
): Promise<ReadDream[]> {
  const prompt = ocrMessages();
  const pages: ReadDream[] = [];
  let ocrDestination = null;

  for (let i = 0; i < pageIds.length; i++) {
    const image = await imageBytesForModel(userId, keys, pageIds[i]!);
    if (!image) {
      // An undecodable page keeps its slot so later pages stay numbered
      // against the strip on the review screen. An empty body contributes
      // nothing to the joined log.
      pages.push({ ...emptyDream(), pages: [i + 1] });
      continue;
    }

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
        images: [{ mimeType: image.mimeType, bytes: image.bytes }],
      },
    );
    ocrDestination = destination;
    const transcript = parsePageTranscript(response.text);
    pages.push({ ...transcript, pages: [i + 1] });
  }

  if (!ocrDestination && pages.every((page) => !page.body.value)) {
    throw new SkipError("Those photographs could not be read.");
  }

  if (ocrDestination) {
    await recordAuthEvent("ai_request", {
      userId,
      detail: {
        kind: "ocr",
        provider: ocrDestination.providerKind,
        host: ocrDestination.host,
        leavesMachine: ocrDestination.leavesMachine,
        pages: pageIds.length,
      },
    });
  }

  return pages;
}

/**
 * Carves the joined copies into dreams, if a split model is assigned.
 *
 * A split that fails after a good copy is not a failed reading: the writer
 * still has the words, and the review screen can split them. Failing the job
 * would re-copy every page to retry a text-only pass.
 */
async function splitCopiedLog(
  userId: string,
  config: AiConfig,
  log: string,
  pageCount: number,
): Promise<SplitPart[] | null> {
  if (!destinationFor(config, "split").configured) return null;
  try {
    const prompt = splitMessages(log, "pages");
    const { response, destination } = await completeRole(
      config,
      "split",
      [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      { json: true, budget: splitBudget(pageCount) },
    );
    await recordAuthEvent("ai_request", {
      userId,
      detail: {
        kind: "split",
        provider: destination.providerKind,
        host: destination.host,
        leavesMachine: destination.leavesMachine,
      },
    });
    return parseSplitParts(response.text);
  } catch {
    // The copies are already in hand. Failing here would re-photograph every
    // page to retry a text-only pass; the review screen can still split.
    return null;
  }
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
