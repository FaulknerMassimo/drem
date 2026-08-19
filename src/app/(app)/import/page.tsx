import { FileImportForm } from "@/components/file-import-form";
import { PhotoImportForm } from "@/components/photo-import-form";
import { VoiceRecorder } from "@/components/voice-recorder";
import { JobRefresh } from "@/components/job-refresh";
import { sessionOrRedirect } from "@/lib/auth/session";
import { listInbox } from "@/lib/capture/attachments";
import { nightDateFor } from "@/lib/journal/dates";
import { readCsrfToken } from "@/lib/security/csrf-server";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const session = await sessionOrRedirect();
  const inbox = await listInbox(session.userId, session.keys);
  const csrfToken = await readCsrfToken();
  const processing = inbox.some((item) => item.status === "pending" || item.status === "running");

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Import</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-400">
          Photograph a handwritten page, dictate a memo, or bring in a file.
          Nothing becomes a journal entry until you confirm it.
        </p>
      </div>

      {inbox.length > 0 && (
        <section className="space-y-3">
          <JobRefresh active={processing} />
          <h2 className="text-lg font-medium">Waiting for review</h2>
          {inbox.length > 1 && (
            <p className="text-sm text-ink-400">
              One dream over several pages? Open its first page — the rest can
              be joined onto it there, as one entry.
            </p>
          )}
          <ul className="space-y-2">
            {inbox.map((item) => (
              <li key={item.id}>
                <a
                  href={`/import/review/${item.id}`}
                  className="card flex items-center justify-between gap-3 hover:border-ink-600"
                >
                  <span className="text-sm text-ink-200">
                    {item.kind === "audio" ? "Voice memo" : "Photographed page"}
                    <span className="ml-2 text-xs text-ink-400">{statusLabel(item.status)}</span>
                  </span>
                  <span className="text-sm text-lucid-300">Review</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <PhotoImportForm csrfToken={csrfToken} />
      <VoiceRecorder csrfToken={csrfToken} />
      <FileImportForm csrfToken={csrfToken} />
      <p className="text-xs text-ink-400">Today is {nightDateFor()} on this machine.</p>
    </div>
  );
}

function statusLabel(status: string): string {
  if (status === "pending" || status === "running") return "reading…";
  if (status === "failed") return "reading failed";
  if (status === "skipped") return "type it yourself";
  return "ready";
}
