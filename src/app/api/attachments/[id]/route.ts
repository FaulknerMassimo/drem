import { NextResponse } from "next/server";
import { currentSession } from "@/lib/auth/session";
import { readAttachmentBlob } from "@/lib/capture/attachments";

export const dynamic = "force-dynamic";

/**
 * Streams a decrypted attachment for the live session.
 *
 * The ciphertext lives on disk; this is the only path that unwraps it, and
 * the response is explicitly uncacheable so a shared browser cache cannot
 * keep plaintext around after lock.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await currentSession();
  if (!session) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { id } = await params;
  const blob = await readAttachmentBlob(session.userId, session.keys, id);
  if (!blob) {
    return new NextResponse("Not found", { status: 404 });
  }

  return new NextResponse(new Uint8Array(blob.bytes), {
    headers: {
      "Content-Type": blob.mimeType,
      "Content-Length": String(blob.bytes.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
