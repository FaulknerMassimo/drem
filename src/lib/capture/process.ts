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
import { OCR_RESPONSE_SCHEMA, ocrMessages } from "@/lib/ai/prompts";
import { publicModelError } from "@/lib/ai/public-error";
import {
  getAttachment,
  imageBytesForModel,
  markAttachmentStatus,
  readAttachmentBlob,
  saveTranscript,
} from "./attachments";
import { fieldsFromTranscript, parseExtractedFields } from "./fields";
import { transcribeAudio } from "./whisper";

class SkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkipError";
  }
}

export { SkipError as CaptureSkipError };

export async function runOcrJob(userId: string, keys: UserKeys, attachmentId: string): Promise<void> {
  const attachment = await getAttachment(userId, keys, attachmentId);
  if (!attachment) throw new SkipError("That upload no longer exists.");
  if (attachment.kind !== "image") throw new SkipError("OCR is for photographs.");

  await markAttachmentStatus(userId, attachmentId, "running");

  const image = await imageBytesForModel(userId, keys, attachmentId);
  if (!image) throw new SkipError("That photograph could not be read.");

  const config = await loadAiConfig(userId, keys);
  const prompt = ocrMessages();
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

  const fields = parseExtractedFields(response.text);
  await saveTranscript(userId, keys, attachmentId, fields, "succeeded");

  await recordAuthEvent("ai_request", {
    userId,
    detail: {
      kind: "ocr",
      provider: destination.providerKind,
      host: destination.host,
      leavesMachine: destination.leavesMachine,
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
  const fields = fieldsFromTranscript(result.text, result.confidence);
  await saveTranscript(userId, keys, attachmentId, fields, "succeeded");
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
