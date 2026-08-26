import { ChatView } from "@/components/chat-view";
import { loadAiConfig } from "@/lib/ai/config";
import { listConversations } from "@/lib/ai/conversations";
import { destinationFor } from "@/lib/ai/destination";
import { chatModelOptions } from "@/lib/ai/models";
import { sessionOrRedirect } from "@/lib/auth/session";
import { readCsrfToken } from "@/lib/security/csrf-server";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const session = await sessionOrRedirect();
  const config = await loadAiConfig(session.userId, session.keys);
  const [conversations, options, csrfToken] = await Promise.all([
    listConversations(session.userId, session.keys),
    chatModelOptions(config),
    readCsrfToken(),
  ]);

  return (
    <ChatView
      conversations={conversations}
      conversation={null}
      destination={destinationFor(config, "chat")}
      options={options}
      csrfToken={csrfToken}
    />
  );
}
