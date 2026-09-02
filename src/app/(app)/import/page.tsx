import { FileImportForm } from "@/components/file-import-form";
import { PhotoImportForm } from "@/components/photo-import-form";
import { VoiceRecorder } from "@/components/voice-recorder";
import { JobRefresh } from "@/components/job-refresh";
import { StackReadForm } from "@/components/stack-read-form";
import { sessionOrRedirect } from "@/lib/auth/session";
import { loadDestinations } from "@/lib/ai/config";
import { attachmentJobProgress } from "@/lib/ai/jobs";
import { listStacks } from "@/lib/capture/attachments";
import { nightDateFor } from "@/lib/journal/dates";
import { readCsrfToken } from "@/lib/security/csrf-server";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const session = await sessionOrRedirect();
  const [stacks, destinations, csrfToken] = await Promise.all([
    listStacks(session.userId, session.keys),
    loadDestinations(session.userId, session.keys),
    readCsrfToken(),
  ]);
  const unread = stacks.filter((stack) => !stack.sent);
  const waiting = stacks.filter((stack) => stack.sent);
  const processing = waiting.some(
    (stack) => stack.status === "pending" || stack.status === "running",
  );

  /*
   * Why a reading gave up, on the list rather than only inside the review
   * screen. "reading failed" on its own sends the writer into a page they
   * then have to read to find out that Ollama was not running — and a stack
   * that failed for a reason they can fix is the one they most need to see.
   */
  const failures = new Map<string, string>();
  await Promise.all(
    waiting
      .filter((stack) => stack.status === "failed" || stack.status === "skipped")
      .map(async (stack) => {
        const progress = await attachmentJobProgress(session.userId, stack.leadId);
        if (progress?.lastError) failures.set(stack.id, progress.lastError);
      }),
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Import</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-400">
          Photograph a page and leave it here: transcription, splitting and
          metadata happen in the background. Open an item only when it needs attention.
        </p>
      </div>

      {unread.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Not read yet</h2>
          {unread.map((stack) => (
            <StackReadForm
              key={stack.id}
              stackId={stack.id}
              pages={stack.pages.length}
              destination={destinations.ocr}
              splitDestination={destinations.split}
              csrfToken={csrfToken}
            />
          ))}
        </section>
      )}

      {waiting.length > 0 && (
        <section className="space-y-3">
          <JobRefresh active={processing} />
          <h2 className="text-lg font-medium">Processing or needs attention</h2>
          <ul className="space-y-2">
            {waiting.map((stack) => {
              const activePhoto =
                stack.kind === "image" &&
                (stack.status === "pending" || stack.status === "running");
              const content = (
                <>
                  <span className="text-sm text-ink-200">
                    {describe(stack.kind, stack.pages.length)}
                    <span
                      className={`ml-2 text-xs ${
                        failures.has(stack.id) ? "text-danger-500" : "text-ink-400"
                      }`}
                    >
                      {statusLabel(stack.status, stack.dreams.length)}
                      {failures.has(stack.id) && ` — ${failures.get(stack.id)}`}
                    </span>
                  </span>
                  <span className="text-sm text-lucid-300">
                    {activePhoto ? "Filing automatically" : "Review"}
                  </span>
                </>
              );
              return (
                <li key={stack.id}>
                  {activePhoto ? (
                    <div className="card flex items-center justify-between gap-3">{content}</div>
                  ) : (
                    <a
                      href={`/import/review/${stack.id}`}
                      className="card flex items-center justify-between gap-3 hover:border-ink-600"
                    >
                      {content}
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <PhotoImportForm
        csrfToken={csrfToken}
        destination={destinations.ocr}
        splitDestination={destinations.split}
      />
      <VoiceRecorder csrfToken={csrfToken} />
      <FileImportForm csrfToken={csrfToken} />
      <p className="text-xs text-ink-400">Today is {nightDateFor()} on this machine.</p>
    </div>
  );
}

function describe(kind: string, pages: number): string {
  if (kind === "audio") return "Voice memo";
  return pages === 1 ? "Photographed page" : `${pages} photographed pages`;
}

function statusLabel(status: string, dreams: number): string {
  if (status === "pending" || status === "running") return "reading…";
  if (status === "failed") return "reading failed";
  if (status === "skipped") return "type it yourself";
  if (dreams > 1) return `${dreams} dreams read`;
  return "ready";
}
