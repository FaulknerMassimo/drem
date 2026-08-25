import { ConversationView } from "@/components/conversation-view";
import { loadDestinations } from "@/lib/ai/config";
import { listConversations } from "@/lib/ai/conversations";
import { sessionOrRedirect } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const session = await sessionOrRedirect();
  const [conversations, destinations] = await Promise.all([
    listConversations(session.userId, session.keys),
    loadDestinations(session.userId, session.keys),
  ]);
  return (
    <ConversationView
      conversations={conversations}
      conversation={null}
      destination={destinations.chat}
    />
  );
}
