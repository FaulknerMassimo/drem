"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentSession, type ActiveSession } from "@/lib/auth/session";
import { ArchiveError, openArchive } from "@/lib/crypto/archive";
import { assertCsrf } from "@/lib/security/csrf-server";
import { ArchiveDocumentError, parseDocument } from "./document";
import type { RestoreFormState } from "./form-state";
import { restoreArchive } from "./restore";

async function requireUnlockedSession(): Promise<ActiveSession> {
  const session = await currentSession();
  if (!session) redirect("/login");
  return session;
}

/**
 * Opens an archive and merges it into the journal, in one step.
 *
 * Deliberately unlike the file-import flow next door, which shows a preview and
 * writes nothing until it is confirmed. That preview exists because import
 * guesses at somebody else's format and can misread it; an archive is this
 * app's own format, validated against a schema, and a restore is
 * non-destructive and repeatable — it never deletes, never overwrites an
 * existing night, and skips entries it already has. There is nothing for a
 * confirmation step to save you from.
 *
 * The other half of the reason is worse: a preview would have to carry the
 * decrypted journal from one request to the next, which in practice means
 * parking every dream in a hidden form field. The result is reported after the
 * fact instead.
 */
export async function restoreArchiveAction(
  _previous: RestoreFormState,
  formData: FormData,
): Promise<RestoreFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose an archive to restore." };
  }
  const passphrase = String(formData.get("passphrase") ?? "");
  if (!passphrase) return { error: "Enter the passphrase this archive was sealed with." };

  try {
    const plaintext = await openArchive(passphrase, Buffer.from(await file.arrayBuffer()));
    const document = parseDocument(plaintext.toString("utf8"));
    const result = await restoreArchive(session.userId, session.keys, document);

    revalidatePath("/", "layout");
    return { result };
  } catch (error) {
    // Both of these are already written for a reader and name no dream content.
    if (error instanceof ArchiveError || error instanceof ArchiveDocumentError) {
      return { error: error.message };
    }
    // Anything else must not reach the page: an unexpected failure here is
    // holding decrypted text, and its message may well quote some of it.
    console.error("[backup] restore failed: %s", error);
    return { error: "That archive could not be restored." };
  }
}
