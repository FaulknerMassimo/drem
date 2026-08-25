import Link from "next/link";
import { ConversationForm } from "@/components/conversation-form";
import { CsrfField } from "@/components/csrf-field";
import { ModelProse } from "@/components/model-prose";
import type { Conversation, ConversationSummary } from "@/lib/ai/conversations";
import type { Destination } from "@/lib/ai/types";

export function ConversationView({
  conversations,
  conversation,
  destination,
}: {
  conversations: ConversationSummary[];
  conversation: Conversation | null;
  destination: Destination;
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <aside className="space-y-3">
        <Link href="/chat" className="btn btn-ghost w-full text-sm">
          New conversation
        </Link>
        <nav aria-label="Conversations" className="flex gap-2 overflow-x-auto pb-1 lg:block lg:space-y-1">
          {conversations.map((thread) => (
            <Link
              key={thread.id}
              href={`/chat/${thread.id}`}
              aria-current={conversation?.id === thread.id ? "page" : undefined}
              className={`min-w-44 rounded-lg px-3 py-2 text-sm lg:block lg:min-w-0 ${
                conversation?.id === thread.id
                  ? "bg-ink-800 text-ink-100"
                  : "text-ink-400 hover:bg-ink-900 hover:text-ink-200"
              }`}
            >
              <span className="line-clamp-2">{thread.title}</span>
            </Link>
          ))}
        </nav>
      </aside>

      <section className="min-w-0 space-y-6">
        {conversation ? (
          <>
            <div className="flex items-start justify-between gap-4">
              <h1 className="text-xl font-semibold">{conversation.title}</h1>
              <Link
                href={`/chat/${conversation.id}/delete`}
                className="text-xs text-ink-500 hover:text-danger-500"
              >
                Delete conversation
              </Link>
            </div>
            <div className="space-y-5" aria-live="polite">
              {conversation.messages.map((message) => (
                <article
                  key={message.id}
                  className={
                    message.role === "user"
                      ? "ml-auto max-w-[90%] rounded-2xl rounded-br-md bg-lucid-500/15 px-4 py-3 text-sm text-ink-100"
                      : "max-w-none rounded-2xl rounded-bl-md border border-ink-800 bg-ink-900/50 px-4 py-4 text-sm"
                  }
                >
                  {message.role === "assistant" ? (
                    <>
                      <ModelProse text={message.content} />
                      {message.provider && message.model && (
                        <p className="mt-3 text-[0.6875rem] text-ink-600">
                          {message.provider} · {message.model}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="whitespace-pre-wrap">{message.content}</p>
                  )}
                </article>
              ))}
            </div>
          </>
        ) : (
          <div>
            <h1 className="text-2xl font-semibold">Talk with your journal</h1>
            <p className="mt-2 max-w-2xl text-sm text-ink-400">
              Ask naturally. The model starts with no dream text in its prompt and uses read-only tools to fetch only the entries, nights, signs, reports, or statistics it needs.
            </p>
          </div>
        )}

        <div className="card">
          <ConversationForm threadId={conversation?.id} destination={destination}>
            <CsrfField />
          </ConversationForm>
        </div>
      </section>
    </div>
  );
}
