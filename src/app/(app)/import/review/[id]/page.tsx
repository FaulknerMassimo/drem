import { notFound, redirect } from "next/navigation";
import { JobRefresh } from "@/components/job-refresh";
import { ReviewForm } from "@/components/review-form";
import { sessionOrRedirect } from "@/lib/auth/session";
import { loadDestinations } from "@/lib/ai/config";
import { attachmentJobProgress } from "@/lib/ai/jobs";
import { getStack } from "@/lib/capture/attachments";
import { nightDateFor } from "@/lib/journal/dates";
import { readCsrfToken } from "@/lib/security/csrf-server";

export const dynamic = "force-dynamic";

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await sessionOrRedirect();
  const stack = await getStack(session.userId, session.keys, id);
  if (!stack) notFound();
  /*
   * There is nothing to review until the stack has been sent. The button that
   * sends it lives on `/import`, so that is where an unread stack belongs —
   * showing a blank form here would say "reading…" about pages no model has
   * been given.
   */
  if (!stack.sent) redirect("/import");

  const [destinations, csrfToken, progress] = await Promise.all([
    loadDestinations(session.userId, session.keys),
    readCsrfToken(),
    attachmentJobProgress(session.userId, stack.leadId),
  ]);
  const reading = stack.status === "pending" || stack.status === "running";

  return (
    <div className="space-y-6">
      <JobRefresh active={reading} />
      <div>
        <p className="text-sm text-ink-400">
          <a href="/import" className="hover:text-ink-200">
            Import
          </a>
        </p>
        <h1 className="text-2xl font-semibold">
          {stack.kind === "audio"
            ? "Review voice memo"
            : stack.pages.length === 1
              ? "Review photographed page"
              : `Review ${stack.pages.length} photographed pages`}
        </h1>
        <p className="mt-2 text-sm text-ink-400">
          Confirm the entries on the right. Nothing is written to the journal
          until you save.
        </p>
      </div>
      <ReviewForm
        stack={stack}
        defaultDate={nightDateFor()}
        csrfToken={csrfToken}
        splitDestination={destinations.split}
        progress={progress}
      />
    </div>
  );
}
