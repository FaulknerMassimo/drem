"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { recordAuthEvent, clientContext } from "@/lib/auth/audit";
import { currentSession, type ActiveSession } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { assertCsrf } from "@/lib/security/csrf-server";
import { daysBetween, isIsoDate, nightDateFor, type IsoDate } from "./dates";
import {
  captureDream,
  createDream,
  deleteDream,
  updateDream,
} from "./dreams";
import type { JournalFormState } from "./form-state";
import { deleteNight, saveNight } from "./nights";
import {
  captureInputSchema,
  dreamInputSchema,
  firstIssue,
  nightInputSchema,
  readDreamForm,
  readNightForm,
} from "./validation";

/**
 * Journal mutations.
 *
 * Every one of these follows the same order: prove the request came from this
 * app's own UI, prove there is an unlocked session, validate, then write. The
 * session is what carries the keys, so there is no path here that can write an
 * entry without one — an entry that could not be encrypted is not saved at all.
 */

async function requireUnlockedSession(): Promise<ActiveSession> {
  const session = await currentSession();
  // No session means no keys, and no keys means nothing can be read or written.
  if (!session) redirect("/login");
  return session;
}

async function requestContext() {
  return clientContext(await headers(), {
    trustProxy: env().APP_ORIGIN.startsWith("https://"),
  });
}

/** Clears the client router cache so a saved entry is visible everywhere at once. */
function refreshJournal(): void {
  revalidatePath("/", "layout");
}

// ---------------------------------------------------------------------------
// Dreams
// ---------------------------------------------------------------------------

export async function saveDreamAction(
  _previous: JournalFormState,
  formData: FormData,
): Promise<JournalFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const parsed = dreamInputSchema.safeParse(readDreamForm(formData));
  if (!parsed.success) return { error: firstIssue(parsed.error) };

  const dreamId = String(formData.get("id") ?? "");
  let destination: string;

  if (dreamId) {
    const updated = await updateDream(session.userId, session.keys, dreamId, parsed.data);
    if (!updated) return { error: "That entry no longer exists." };
    destination = `/dream/${dreamId}`;
  } else {
    const created = await createDream(session.userId, session.keys, parsed.data);
    destination = `/dream/${created}`;
  }

  refreshJournal();
  redirect(destination);
}

export async function deleteDreamAction(formData: FormData): Promise<void> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const dreamId = String(formData.get("id") ?? "");
  const deleted = dreamId ? await deleteDream(session.userId, dreamId) : false;

  if (deleted) {
    // Structural only. The audit log must never become a plaintext index of
    // what was in the journal.
    await recordAuthEvent("entry_deleted", {
      userId: session.userId,
      detail: { kind: "dream" },
      request: await requestContext(),
    });
  }

  refreshJournal();
  redirect(String(formData.get("returnTo") || "/journal"));
}

// ---------------------------------------------------------------------------
// Nights
// ---------------------------------------------------------------------------

export async function saveNightAction(
  _previous: JournalFormState,
  formData: FormData,
): Promise<JournalFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const parsed = nightInputSchema.safeParse(readNightForm(formData));
  if (!parsed.success) return { error: firstIssue(parsed.error) };

  await saveNight(session.userId, session.keys, parsed.data);
  refreshJournal();
  redirect(`/night/${parsed.data.date}`);
}

export async function deleteNightAction(formData: FormData): Promise<void> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const date = String(formData.get("date") ?? "");
  if (isIsoDate(date)) {
    const result = await deleteNight(session.userId, date);
    if (result.deleted) {
      await recordAuthEvent("entry_deleted", {
        userId: session.userId,
        detail: { kind: "night", dreams: result.dreamCount },
        request: await requestContext(),
      });
    }
  }

  refreshJournal();
  redirect("/journal");
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Decides which night a capture belongs to.
 *
 * The browser is the right authority on the user's local clock, so its answer
 * is preferred — but only within a day of the server's own, so a stale or
 * tampered field cannot file an entry against an arbitrary date.
 */
function resolveNightDate(submitted: unknown, now = new Date()): IsoDate {
  const fallback = nightDateFor(now);
  if (!isIsoDate(submitted)) return fallback;
  return Math.abs(daysBetween(fallback, submitted)) <= 1 ? submitted : fallback;
}

/**
 * Saves a 3am capture and stays on the screen.
 *
 * Deliberately does not redirect: the next fragment of the same dream tends to
 * surface seconds after the first, and navigating away — or worse, into a form
 * with twelve fields — is how it gets lost.
 */
export async function captureAction(
  _previous: JournalFormState,
  formData: FormData,
): Promise<JournalFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const parsed = captureInputSchema.safeParse({
    nightDate: resolveNightDate(formData.get("nightDate")),
    body: formData.get("body") ?? "",
  });
  if (!parsed.success) return { error: firstIssue(parsed.error) };

  await captureDream(
    session.userId,
    session.keys,
    parsed.data.nightDate,
    parsed.data.body,
  );

  refreshJournal();
  return { saved: true, savedAt: Date.now() };
}
