import Link from "next/link";
import { notFound } from "next/navigation";
import { CsrfField } from "@/components/csrf-field";
import { deleteConversationAction } from "@/lib/ai/conversation-actions";
import { getConversation } from "@/lib/ai/conversations";
import { sessionOrRedirect } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function DeleteConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await sessionOrRedirect();
  const { id } = await params;
  const conversation = await getConversation(session.userId, session.keys, id);
  if (!conversation) notFound();

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Delete conversation?</h1>
        <p className="mt-2 text-sm text-ink-400">
          “{conversation.title}” and its encrypted transcript will be permanently deleted.
          Your dreams and every other part of the journal are unchanged.
        </p>
      </div>
      <form action={deleteConversationAction} className="flex gap-3">
        <CsrfField />
        <input type="hidden" name="threadId" value={conversation.id} />
        <button type="submit" className="btn bg-danger-500 text-white hover:bg-danger-500/90">
          Delete conversation
        </button>
        <Link href={`/chat/${conversation.id}`} className="btn btn-ghost">
          Keep it
        </Link>
      </form>
    </div>
  );
}
