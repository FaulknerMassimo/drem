import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { clientContext, recordAuthEvent } from "@/lib/auth/audit";
import { currentSession } from "@/lib/auth/session";
import { ArchiveError, MIN_PASSPHRASE_LENGTH } from "@/lib/crypto/archive";
import { env } from "@/lib/env";
import { archiveFilename } from "@/lib/backup/document";
import { exportArchive } from "@/lib/backup/export";
import type { ExportErrorCode } from "@/lib/backup/form-state";
import { assertCsrf } from "@/lib/security/csrf-server";

export const dynamic = "force-dynamic";

/**
 * Writes a backup and hands it to the browser.
 *
 * A route handler rather than a Server Action because the result is a file: an
 * action can only return data for the page to do something with, and doing
 * something with it would mean the decrypted journal passing through client
 * JavaScript. Posting a plain form here means the bytes go from the encryption
 * straight into a download, and the whole screen still works with scripting
 * turned off.
 *
 * Failures come back as a redirect carrying a code, not a message — see
 * `EXPORT_ERRORS`.
 */
function refuse(code: ExportErrorCode): NextResponse {
  return NextResponse.redirect(new URL(`/backup?error=${code}`, env().APP_ORIGIN), {
    // 303: the browser must follow this with a GET, not repeat the POST.
    status: 303,
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const formData = await request.formData();
  await assertCsrf(formData);

  const session = await currentSession();
  if (!session) {
    return NextResponse.redirect(new URL("/login", env().APP_ORIGIN), { status: 303 });
  }

  const passphrase = String(formData.get("passphrase") ?? "");
  const confirmation = String(formData.get("passphraseConfirm") ?? "");
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) return refuse("passphrase");
  // Checked here as well as in the browser: a mistyped passphrase on a file
  // nobody can help you open is unrecoverable, and there is no second factor
  // behind it to fall back on.
  if (passphrase !== confirmation) return refuse("mismatch");

  let file: Buffer;
  let summary: { nights: number; dreams: number };
  try {
    const result = await exportArchive(session.userId, session.keys, passphrase);
    file = result.file;
    summary = result.summary;
  } catch (error) {
    if (error instanceof ArchiveError) return refuse("passphrase");
    console.error("[backup] export failed: %s", error);
    return refuse("failed");
  }

  /*
   * Structural only: how much left, never what. The whole journal has just been
   * decrypted and written to a file, which is precisely the event an audit log
   * exists to record — and precisely the one that must not be described.
   */
  await recordAuthEvent("export_created", {
    userId: session.userId,
    detail: { nights: summary.nights, dreams: summary.dreams, bytes: file.length },
    request: clientContext(await headers(), {
      trustProxy: env().APP_ORIGIN.startsWith("https://"),
    }),
  });

  return new NextResponse(new Uint8Array(file), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(file.length),
      "Content-Disposition": `attachment; filename="${archiveFilename()}"`,
      // Never let an intermediary or a shared browser cache keep a copy.
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
