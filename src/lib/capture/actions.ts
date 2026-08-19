"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentSession, type ActiveSession } from "@/lib/auth/session";
import { completeRole } from "@/lib/ai/chat";
import { loadAiConfig } from "@/lib/ai/config";
import { destinationFor } from "@/lib/ai/destination";
import { gateDestination } from "@/lib/ai/gate";
import { enqueueAttachmentJob } from "@/lib/ai/jobs";
import { publicModelError } from "@/lib/ai/public-error";
import { splitMessages } from "@/lib/ai/prompts";
import { kickWorker } from "@/lib/ai/worker";
import { recordAuthEvent } from "@/lib/auth/audit";
import { getDream } from "@/lib/journal/dreams";
import { isIsoDate, nightDateFor, type IsoDate } from "@/lib/journal/dates";
import { parseTagInput } from "@/lib/journal/validation";
import { firstIssue } from "@/lib/journal/validation";
import { z } from "zod";
import { assertCsrf } from "@/lib/security/csrf-server";
import {
  MAX_UPLOAD_BATCH,
  createAudioAttachment,
  createImageAttachment,
  discardAttachment,
  getAttachment,
  markAttachmentStatus,
} from "./attachments";
import { confirmAsDreams, importedToFields, splitToFields } from "./confirm";
import type {
  CaptureFormState,
  ImportFormState,
  PhotoUploadResult,
  ReviewFormState,
  SplitFormState,
} from "./form-state";
import { parseSplitParts, type SplitPart } from "./fields";
import { parseImport, MAX_IMPORT_ENTRIES } from "./import-parse";
import { prepareImage } from "./image";

async function requireUnlockedSession(): Promise<ActiveSession> {
  const session = await currentSession();
  if (!session) redirect("/login");
  return session;
}

function refreshCapture(): void {
  revalidatePath("/", "layout");
}

function asFile(value: FormDataEntryValue | null): File | null {
  return value instanceof File && value.size > 0 ? value : null;
}

function filesOf(form: FormData, name: string): File[] {
  return form.getAll(name).filter((value): value is File => value instanceof File && value.size > 0);
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function resolveNightDate(submitted: string): IsoDate {
  return isIsoDate(submitted) ? submitted : nightDateFor();
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

/** Stores one prepared photograph and queues its reading. */
async function storePhoto(
  session: ActiveSession,
  ocrReady: boolean,
  file: File,
): Promise<{ id: string; duplicate: boolean }> {
  const bytes = Buffer.from(await file.arrayBuffer());
  const prepared = await prepareImage(bytes);
  const created = await createImageAttachment(session.userId, session.keys, prepared);
  if (created.duplicate) return created;
  if (ocrReady) {
    await enqueueAttachmentJob(session.userId, created.id, "ocr_attachment");
  } else {
    await markAttachmentStatus(session.userId, created.id, "skipped");
  }
  return created;
}

function photoError(error: unknown): string {
  return error instanceof Error ? error.message : "That photo could not be stored.";
}

export async function uploadPhotosAction(
  _previous: CaptureFormState,
  formData: FormData,
): Promise<CaptureFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const files = filesOf(formData, "files");
  if (files.length === 0) return { error: "Choose one or more photographs." };
  if (files.length > MAX_UPLOAD_BATCH) {
    return { error: `Upload at most ${MAX_UPLOAD_BATCH} pages at a time.` };
  }

  const config = await loadAiConfig(session.userId, session.keys);
  const ocrReady = destinationFor(config, "ocr").configured;
  const ids: string[] = [];

  try {
    for (const file of files) {
      const created = await storePhoto(session, ocrReady, file);
      ids.push(created.id);
    }
  } catch (error) {
    return { error: photoError(error) };
  }

  kickWorker();
  refreshCapture();
  if (ids.length === 1) redirect(`/import/review/${ids[0]}`);
  redirect("/import");
}

/**
 * Stores a single photograph and returns its id instead of redirecting.
 *
 * A phone camera hands back one image per capture and clears nothing, so the
 * form uploads each page as it is taken and empties the file input for the
 * next one. Keeping each page in its own request also means a long night is
 * not one body large enough to hit `serverActions.bodySizeLimit`.
 */
export async function uploadPhotoAction(formData: FormData): Promise<PhotoUploadResult> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const file = asFile(formData.get("file"));
  if (!file) return { error: "Choose a photograph first." };

  const config = await loadAiConfig(session.userId, session.keys);
  const ocrReady = destinationFor(config, "ocr").configured;

  let created;
  try {
    created = await storePhoto(session, ocrReady, file);
  } catch (error) {
    return { error: photoError(error) };
  }

  kickWorker();
  refreshCapture();
  return { id: created.id, duplicate: created.duplicate };
}

export async function uploadVoiceAction(
  _previous: CaptureFormState,
  formData: FormData,
): Promise<CaptureFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const file = asFile(formData.get("audio"));
  if (!file) return { error: "Record or choose a voice memo first." };

  let created;
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    created = await createAudioAttachment(
      session.userId,
      session.keys,
      bytes,
      file.type || "audio/webm",
    );
    if (!created.duplicate) {
      await enqueueAttachmentJob(session.userId, created.id, "transcribe_attachment");
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "That recording could not be stored." };
  }
  kickWorker();
  refreshCapture();
  redirect(`/import/review/${created.id}`);
}

export async function discardAttachmentAction(formData: FormData): Promise<void> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();
  const id = text(formData, "id");
  if (id) await discardAttachment(session.userId, id);
  refreshCapture();
  redirect("/import");
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export async function confirmReviewAction(
  _previous: ReviewFormState,
  formData: FormData,
): Promise<ReviewFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const attachmentId = text(formData, "id");
  const attachment = attachmentId
    ? await getAttachment(session.userId, session.keys, attachmentId)
    : null;
  if (!attachment || attachment.dreamId) {
    return { error: "That upload is no longer waiting for review." };
  }

  const extra = formData
    .getAll("extra")
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  const source = attachment.kind === "audio" ? "voice" : "ocr";
  let ids: string[];
  try {
    ids = await confirmAsDreams(session.userId, session.keys, {
      parts: [fieldsFromForm(formData)],
      source,
      attachmentIds: [attachmentId, ...extra],
      isDraft: true,
    });
  } catch (error) {
    if (error instanceof z.ZodError) return { error: firstIssue(error) };
    return { error: "That entry could not be saved." };
  }
  refreshCapture();
  redirect(`/dream/${ids[0]}`);
}

export async function proposeReviewSplitAction(
  _previous: ReviewFormState,
  formData: FormData,
): Promise<ReviewFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const gated = await gateDestination(session, "split", formData);
  if (gated) return gated;

  const body = text(formData, "body").trim();
  if (!body) return { error: "Write or confirm the transcript first, then split it." };

  try {
    const proposal = await runSplit(session, body);
    return { splitProposal: proposal };
  } catch (error) {
    return { error: publicModelError(error, "The split request failed.") };
  }
}

export async function confirmReviewSplitAction(
  _previous: ReviewFormState,
  formData: FormData,
): Promise<ReviewFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const attachmentId = text(formData, "id");
  const attachment = attachmentId
    ? await getAttachment(session.userId, session.keys, attachmentId)
    : null;
  if (!attachment || attachment.dreamId) {
    return { error: "That upload is no longer waiting for review." };
  }

  const parts = partsFromForm(formData);
  if (parts.length === 0) return { error: "Nothing to save." };

  const extra = formData
    .getAll("extra")
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const nightDate = resolveNightDate(text(formData, "nightDate"));
  const lucidity = Number.parseInt(text(formData, "lucidity") || "0", 10) || 0;

  const source = attachment.kind === "audio" ? "voice" : "ocr";
  let ids: string[];
  try {
    ids = await confirmAsDreams(session.userId, session.keys, {
      parts: parts.map((part) => splitToFields(part, nightDate, lucidity)),
      source,
      attachmentIds: [attachmentId, ...extra],
      isDraft: true,
    });
  } catch (error) {
    if (error instanceof z.ZodError) return { error: firstIssue(error) };
    return { error: "Those entries could not be saved." };
  }
  refreshCapture();
  redirect(ids.length === 1 ? `/dream/${ids[0]}` : `/night/${nightDate}`);
}

// ---------------------------------------------------------------------------
// File import
// ---------------------------------------------------------------------------

export async function parseImportAction(
  _previous: ImportFormState,
  formData: FormData,
): Promise<ImportFormState> {
  await assertCsrf(formData);
  await requireUnlockedSession();

  const file = asFile(formData.get("file"));
  if (!file) return { error: "Choose a JSON, Markdown or CSV file." };

  const textContent = await file.text();
  const parsed = parseImport(file.name, textContent);
  if (parsed.error) return { error: parsed.error };
  return {
    entries: parsed.entries,
    skipped: parsed.skipped,
    format: parsed.format,
  };
}

export async function confirmImportAction(
  _previous: ImportFormState,
  formData: FormData,
): Promise<ImportFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  let entries;
  try {
    entries = JSON.parse(text(formData, "entries"));
  } catch {
    return { error: "That import could not be read." };
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return { error: "Nothing to import." };
  }
  if (entries.length > MAX_IMPORT_ENTRIES) {
    return { error: `Import at most ${MAX_IMPORT_ENTRIES} entries at a time.` };
  }

  const parsed = parseImport("import.json", JSON.stringify({ dreams: entries }));
  if (parsed.error || parsed.entries.length === 0) {
    return { error: parsed.error ?? "Nothing to import." };
  }

  let ids: string[];
  try {
    ids = await confirmAsDreams(session.userId, session.keys, {
      parts: parsed.entries.map(importedToFields),
      source: "import",
      attachmentIds: [],
      isDraft: true,
    });
  } catch (error) {
    if (error instanceof z.ZodError) return { error: firstIssue(error) };
    return { error: "Those entries could not be saved." };
  }
  refreshCapture();
  return { created: ids.length };
}

// ---------------------------------------------------------------------------
// Split an existing entry
// ---------------------------------------------------------------------------

export async function proposeDreamSplitAction(
  _previous: SplitFormState,
  formData: FormData,
): Promise<SplitFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const gated = await gateDestination(session, "split", formData);
  if (gated) return gated;

  const dreamId = text(formData, "dreamId");
  const dream = dreamId ? await getDream(session.userId, session.keys, dreamId) : null;
  if (!dream?.body?.trim()) return { error: "There is nothing in this entry to split." };

  try {
    const proposal = await runSplit(session, dream.body);
    return { proposal };
  } catch (error) {
    return { error: publicModelError(error, "The split request failed.") };
  }
}

export async function confirmDreamSplitAction(
  _previous: SplitFormState,
  formData: FormData,
): Promise<SplitFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const dreamId = text(formData, "dreamId");
  const dream = dreamId ? await getDream(session.userId, session.keys, dreamId) : null;
  if (!dream) return { error: "That entry no longer exists." };

  const parts = partsFromForm(formData);
  if (parts.length === 0) return { error: "Nothing to save." };

  let ids: string[];
  try {
    ids = await confirmAsDreams(session.userId, session.keys, {
      parts: parts.map((part) =>
        splitToFields(part, dream.dreamDate, dream.lucidity),
      ),
      source: dream.source,
      attachmentIds: [],
      isDraft: dream.isDraft,
      replaceDreamId: dream.id,
    });
  } catch (error) {
    if (error instanceof z.ZodError) return { error: firstIssue(error) };
    return { error: "Those entries could not be saved." };
  }
  refreshCapture();
  redirect(ids.length === 1 ? `/dream/${ids[0]}` : `/night/${dream.dreamDate}`);
}

async function runSplit(session: ActiveSession, body: string): Promise<SplitPart[]> {
  const config = await loadAiConfig(session.userId, session.keys);
  const prompt = splitMessages(body);
  const { response, destination } = await completeRole(
    config,
    "split",
    [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    { json: true },
  );
  await recordAuthEvent("ai_request", {
    userId: session.userId,
    detail: {
      kind: "split",
      provider: destination.providerKind,
      host: destination.host,
      leavesMachine: destination.leavesMachine,
    },
  });
  return parseSplitParts(response.text);
}

function fieldsFromForm(form: FormData) {
  return {
    nightDate: resolveNightDate(text(form, "nightDate")),
    title: text(form, "title").trim() || null,
    body: text(form, "body"),
    lucidity: Number.parseInt(text(form, "lucidity") || "0", 10) || 0,
    tags: parseTagInput(text(form, "tags")),
    isFragment: form.get("isFragment") !== null,
  };
}

function partsFromForm(form: FormData): SplitPart[] {
  const count = Number.parseInt(text(form, "count") || "0", 10);
  if (!Number.isFinite(count) || count < 1) return [];
  const parts: SplitPart[] = [];
  for (let i = 0; i < count; i++) {
    const body = text(form, `body-${i}`).trim();
    if (!body) continue;
    parts.push({
      title: text(form, `title-${i}`).trim() || null,
      body,
      isFragment: form.get(`fragment-${i}`) !== null,
    });
  }
  return parts;
}

