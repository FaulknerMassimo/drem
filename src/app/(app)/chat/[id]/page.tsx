import { notFound } from "next/navigation";
import { ChatView } from "@/components/chat-view";
import { loadAiConfig } from "@/lib/ai/config";
import { getConversation, listConversations } from "@/lib/ai/conversations";
import { destinationFor } from "@/lib/ai/destination";
import { chatModelOptions } from "@/lib/ai/models";
import { sessionOrRedirect } from "@/lib/auth/session";
import { readCsrfToken } from "@/lib/security/csrf-server";

export const dynamic = "force-dynamic";

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await sessionOrRedirect();
  const { id } = await params;
  const config = await loadAiConfig(session.userId, session.keys);
  const [conversation, conversations, options, csrfToken] = await Promise.all([
    getConversation(session.userId, session.keys, id),
    listConversations(session.userId, session.keys),
    chatModelOptions(config),
    readCsrfToken(),
  ]);
  if (!conversation) notFound();

  return (
    <ChatView
      conversations={conversations}
      conversation={conversation}
      destination={destinationFor(config, "chat")}
      options={options}
      csrfToken={csrfToken}
    />
  );
}
