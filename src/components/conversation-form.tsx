"use client";

import { useActionState, useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { DestinationBadge } from "@/components/destination-badge";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import {
  sendConversationMessageAction,
  type ConversationFormState,
} from "@/lib/ai/conversation-actions";
import type { Destination } from "@/lib/ai/types";

export function ConversationForm({
  threadId,
  destination,
  children,
}: {
  threadId?: string;
  destination: Destination;
  children: React.ReactNode;
}) {
  const [state, action] = useActionState<ConversationFormState, FormData>(
    sendConversationMessageAction,
    {},
  );
  const form = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!state.sent || !state.threadId) return;
    form.current?.reset();
    const target = `/chat/${state.threadId}`;
    if (pathname === target) router.refresh();
    else router.push(target);
  }, [pathname, router, state.sent, state.threadId]);

  return (
    <form ref={form} action={action} className="space-y-3">
      {children}
      {threadId && <input type="hidden" name="threadId" value={threadId} />}
      <label className="sr-only" htmlFor="chat-message">
        Message
      </label>
      <textarea
        id="chat-message"
        name="message"
        required
        maxLength={8000}
        rows={4}
        className="field resize-y"
        placeholder="Ask about a recurring place, compare lucid nights, reflect on a dream…"
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <DestinationBadge
        destination={destination}
        what="your message and any journal entries the model chooses to read"
        compact
      />
      {destination.leavesMachine && destination.configured && (
        <label className="flex items-start gap-3 text-sm text-ink-200">
          <input
            type="checkbox"
            name="acknowledge"
            value="1"
            required
            className="mt-0.5 size-4 accent-warn-500"
          />
          <span>
            I understand this conversation and journal data selected by its tools will be sent to {destination.host}.
          </span>
        </label>
      )}
      <FormError message={state.error} />
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-ink-500">Ctrl/⌘ + Enter to send</p>
        <SubmitButton
          pendingLabel="Reading and thinking…"
          className="btn btn-primary w-auto"
        >
          Send
        </SubmitButton>
      </div>
    </form>
  );
}
