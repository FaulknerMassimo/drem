"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentSession, type ActiveSession } from "@/lib/auth/session";
import { completeRole } from "@/lib/ai/chat";
import { loadAiConfig } from "@/lib/ai/config";
import { destinationFor } from "@/lib/ai/destination";
import { gateDestination } from "@/lib/ai/gate";
import { enqueueAttachmentJob } from "@/lib/ai/jobs";
import { publicModelError } from "@/lib/ai/public-error";
import { MAX_STACK_PAGES, splitMessages } from "@/lib/ai/prompts";
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
  discardStack,
  getStack,
  markStackStatus,
} from "./attachments";
import { confirmAsDreams, importedToFields, splitToFields, type ConfirmFields } from "./confirm";
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

/** Stores one prepared photograph as a page of a stack. Reading is asked for later. */
async function storePhoto(
  session: ActiveSession,
  stackId: string | null,
  file: File,
): Promise<{ id: string; duplicate: boolean }> {
  const bytes = Buffer.from(await file.arrayBuffer());
  const prepared = await prepareImage(bytes);
  return createImageAttachment(session.userId, session.keys, prepared, stackId);
}

function photoError(error: unknown): string {
  return error instanceof Error ? error.message : "That photo could not be stored.";
}

/** A stack id minted by the form, or a fresh one if this upload brought none. */
function stackIdFrom(form: FormData): string {
  const value = text(form, "stackId");
  return UUID.test(value) ? value : randomUUID();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  /*
   * The no-JavaScript path, and the only one that knows the whole stack up
   * front. Pages beyond `MAX_STACK_PAGES` start a new stack rather than being
   * refused: what the ceiling bounds is one model call, not one night.
   */
  const ids: string[] = [];
  let stackId = randomUUID();
  try {
    for (const [index, file] of files.entries()) {
      if (index > 0 && index % MAX_STACK_PAGES === 0) stackId = randomUUID();
      const created = await storePhoto(session, stackId, file);
      ids.push(created.id);
    }
  } catch (error) {
    return { error: photoError(error) };
  }

  refreshCapture();
  redirect("/import");
}

/**
 * Stores a single photograph and returns its id instead of redirecting.
 *
 * A phone camera hands back one image per capture and clears nothing, so the
 * form uploads each page as it is taken and empties the file input for the
 * next one. Keeping each page in its own request also means a long night is
 * not one body large enough to hit `serverActions.bodySizeLimit`.
 *
 * Nothing is read here. The pages of one stack go to the model together, and
 * the stack is not finished until the writer says it is — which is also where
 * the destination badge is, so a page cannot leave this machine before the
 * screen has named where it is going.
 */
export async function uploadPhotoAction(formData: FormData): Promise<PhotoUploadResult> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const file = asFile(formData.get("file"));
  if (!file) return { error: "Choose a photograph first." };

  let created;
  try {
    created = await storePhoto(session, stackIdFrom(formData), file);
  } catch (error) {
    return { error: photoError(error) };
  }

  refreshCapture();
  return { id: created.id, duplicate: created.duplicate };
}

/**
 * Sends a finished stack to the page-reading model.
 *
 * Split out from the upload for two reasons. One model call covers the whole
 * stack, so the call cannot start until the stack is closed. And this is the
 * screen that names the destination: uploading used to queue the reading as a
 * side effect, which sent a photographed page to whatever model Settings held
 * without ever putting the host in front of the writer.
 */
export async function readStackAction(
  _previous: CaptureFormState,
  formData: FormData,
): Promise<CaptureFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const stackId = text(formData, "stackId");
  const stack = stackId ? await getStack(session.userId, session.keys, stackId) : null;
  if (!stack) return { error: "Those pages are no longer waiting to be read." };

  const gated = await gateDestination(session, "ocr", formData);
  if (gated) return gated;

  await enqueueAttachmentJob(session.userId, stack.leadId, "ocr_attachment");
  kickWorker();
  refreshCapture();
  redirect(`/import/review/${stack.id}`);
}

/**
 * Files a stack for review without reading it.
 *
 * The escape hatch for no page-reading model, or a page no model will manage.
 * The photographs are kept and the review screen offers an empty form to type
 * into, which is the same place the writer would end up anyway.
 */
export async function skipStackAction(
  _previous: CaptureFormState,
  formData: FormData,
): Promise<CaptureFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const stackId = text(formData, "stackId");
  const stack = stackId ? await getStack(session.userId, session.keys, stackId) : null;
  if (!stack) return { error: "Those pages are no longer waiting to be read." };

  await markStackStatus(session.userId, stack.id, "skipped");
  refreshCapture();
  redirect(`/import/review/${stack.id}`);
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

export async function discardStackAction(formData: FormData): Promise<void> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();
  const stackId = text(formData, "stackId");
  if (stackId) await discardStack(session.userId, stackId);
  refreshCapture();
  redirect("/import");
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

/**
 * Writes a reviewed stack to the journal.
 *
 * One path for every shape of review, because the screen now has one shape:
 * a list of entries. A stack the model found three dreams in arrives as three
 * cards; a voice memo arrives as one; a memo the writer split arrives as
 * however many the split proposed. There is no longer a separate action for
 * "confirm one" and "confirm a split", which is what made the split feel like
 * a second, later decision rather than an edit to what is on screen.
 *
 * Saved as real entries, not drafts. `isDraft` means "captured, not yet
 * written up" — the state 3am capture mode leaves things in, because it
 * deliberately asks nothing. This screen has just asked for the night, the
 * title, the text, the lucidity and the tags, so filing the result as
 * unfinished sent the writer to `/drafts` to declare it finished a second time.
 */
export async function confirmReviewAction(
  _previous: ReviewFormState,
  formData: FormData,
): Promise<ReviewFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const stackId = text(formData, "stackId");
  const stack = stackId ? await getStack(session.userId, session.keys, stackId) : null;
  if (!stack) return { error: "That upload is no longer waiting for review." };

  const nightDate = resolveNightDate(text(formData, "nightDate"));
  const parts = cardsFromForm(formData, nightDate);
  if (parts.length === 0) return { error: "Write the dream before saving." };

  const source = stack.kind === "audio" ? "voice" : "ocr";
  let ids: string[];
  try {
    ids = await confirmAsDreams(session.userId, session.keys, {
      parts,
      source,
      attachmentIds: stack.pages.map((page) => page.id),
      isDraft: false,
    });
  } catch (error) {
    if (error instanceof z.ZodError) return { error: firstIssue(error) };
    return { error: "Those entries could not be saved." };
  }
  refreshCapture();
  redirect(ids.length === 1 ? `/dream/${ids[0]}` : `/night/${nightDate}`);
}

/**
 * Carves the entry on screen into several, without leaving the screen.
 *
 * Only reachable for a voice memo, where there are no page breaks to read the
 * seams off and the transcript arrives as one block. A photographed stack is
 * already separated by the reading, which is one model call instead of two.
 */
export async function proposeReviewSplitAction(
  _previous: ReviewFormState,
  formData: FormData,
): Promise<ReviewFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const gated = await gateDestination(session, "split", formData);
  if (gated) return gated;

  const body = text(formData, "body-0").trim();
  if (!body) return { error: "Write or confirm the transcript first, then split it." };

  try {
    const proposal = await runSplit(session, body);
    return { splitProposal: proposal };
  } catch (error) {
    return { error: publicModelError(error, "The split request failed.") };
  }
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
      // Same reasoning as the review screen: an imported entry arrives with
      // its date, text and tags already on it. Nothing is left to write up.
      isDraft: false,
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

/**
 * The entry cards on the review screen, in the order they are shown.
 *
 * `pages-i` carries the attachment ids the model read that entry off, so a
 * stack holding two dreams files each photograph with the entry it belongs to.
 * The ids are round-tripped through the form rather than recomputed here: the
 * writer can have deleted or reordered cards since the reading landed, and the
 * screen is the only thing that knows what they did.
 */
function cardsFromForm(form: FormData, nightDate: IsoDate): ConfirmFields[] {
  const count = Number.parseInt(text(form, "count") || "0", 10);
  if (!Number.isFinite(count) || count < 1) return [];

  const cards: ConfirmFields[] = [];
  for (let i = 0; i < count; i++) {
    const body = text(form, `body-${i}`);
    if (!body.trim()) continue;
    cards.push({
      nightDate,
      title: text(form, `title-${i}`).trim() || null,
      body,
      lucidity: Number.parseInt(text(form, `lucidity-${i}`) || "0", 10) || 0,
      tags: parseTagInput(text(form, `tags-${i}`)),
      isFragment: form.get(`fragment-${i}`) !== null,
      attachmentIds: text(form, `pages-${i}`)
        .split(",")
        .map((id) => id.trim())
        .filter((id) => UUID.test(id)),
    });
  }
  return cards;
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

