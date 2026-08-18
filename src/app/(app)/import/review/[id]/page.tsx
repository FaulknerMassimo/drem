import { notFound } from "next/navigation";
import { JobRefresh } from "@/components/job-refresh";
import { ReviewForm } from "@/components/review-form";
import { sessionOrRedirect } from "@/lib/auth/session";
import { loadDestinations } from "@/lib/ai/config";
import { getAttachment, listInbox } from "@/lib/capture/attachments";
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
  const attachment = await getAttachment(session.userId, session.keys, id);
  if (!attachment || attachment.dreamId) notFound();

  const [inbox, destinations, csrfToken] = await Promise.all([
    listInbox(session.userId, session.keys),
    loadDestinations(session.userId, session.keys),
    readCsrfToken(),
  ]);
  const extras = inbox.filter((item) => item.id !== attachment.id);
  const processing = attachment.status === "pending" || attachment.status === "running";

  return (
    <div className="space-y-6">
      <JobRefresh active={processing} />
      <div>
        <p className="text-sm text-ink-400">
          <a href="/import" className="hover:text-ink-200">
            Import
          </a>
        </p>
        <h1 className="text-2xl font-semibold">
          {attachment.kind === "audio" ? "Review voice memo" : "Review photographed page"}
        </h1>
        <p className="mt-2 text-sm text-ink-400">
          Confirm the fields on the right. Nothing is written to the journal
          until you save.
        </p>
      </div>
      <ReviewForm
        attachment={attachment}
        extras={extras}
        defaultDate={nightDateFor()}
        csrfToken={csrfToken}
        splitDestination={destinations.split}
      />
    </div>
  );
}
