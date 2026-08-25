import { notFound } from "next/navigation";
import { ConversationView } from "@/components/conversation-view";
import { loadDestinations } from "@/lib/ai/config";
import { getConversation, listConversations } from "@/lib/ai/conversations";
import { sessionOrRedirect } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await sessionOrRedirect();
  const { id } = await params;
  const [conversation, conversations, destinations] = await Promise.all([
    getConversation(session.userId, session.keys, id),
    listConversations(session.userId, session.keys),
    loadDestinations(session.userId, session.keys),
  ]);
  if (!conversation) notFound();
  return (
    <ConversationView
      conversations={conversations}
      conversation={conversation}
      destination={destinations.chat}
    />
  );
}
