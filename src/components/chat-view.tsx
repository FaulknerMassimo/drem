"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatModelPicker, type ModelChoice } from "@/components/chat-model-picker";
import { AssistantTurn, type ChatSegment } from "@/components/chat-turn";
import { PanelIcon, PlusIcon, SendIcon, StopIcon, TrashIcon } from "@/components/chat-icons";
import {
  MAX_CHAT_MESSAGE_CHARS,
  readChatEvents,
  type ChatWireEvent,
} from "@/lib/ai/chat-events";
import type { Conversation, ConversationSummary } from "@/lib/ai/conversations";
import type { ChatModelOption, Destination } from "@/lib/ai/types";
import { CSRF_HEADER } from "@/lib/security/constants";

interface Turn {
  id: string;
  role: "user" | "assistant";
  content: string;
  segments: ChatSegment[];
  provider?: string | null;
  model?: string | null;
}

const OPENERS = [
  "What keeps recurring in the last month?",
  "How is my recall holding up?",
  "Which dream signs am I missing?",
];

/**
 * Journal chat.
 *
 * Everything here exists to make a slow answer legible while it happens. The
 * previous screen posted a form and waited: no cursor, no sign the model had
 * been reached, no indication that four entries were being read — and then a
 * page of text at once, or nothing at all when the request hit its ceiling.
 * A conversation with a local model is *minutes* long, and a minute of blank
 * screen is indistinguishable from a broken feature.
 *
 * So the turn is streamed and shown as it happens: the model's working, each
 * journal tool as it runs, then the answer a token at a time. The reader can
 * stop it, and what was written by then is kept.
 */
export function ChatView({
  conversations,
  conversation,
  destination,
  options,
  csrfToken,
}: {
  conversations: ConversationSummary[];
  conversation: Conversation | null;
  destination: Destination;
  options: ChatModelOption[];
  csrfToken: string;
}) {
  const router = useRouter();
  const [turns, setTurns] = useState<Turn[]>(() => storedTurns(conversation));
  /*
   * The conversation being written to, which is not always the one in the URL:
   * a new thread exists from the moment its first answer is saved, and a
   * second message sent before the address bar catches up belongs to it rather
   * than to another new thread.
   */
  const [threadId, setThreadId] = useState<string | null>(conversation?.id ?? null);
  const [title, setTitle] = useState<string | null>(conversation?.title ?? null);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<ModelChoice | null>(
    destination.configured
      ? { providerId: destination.providerId, model: destination.model }
      : null,
  );
  const [acknowledged, setAcknowledged] = useState(false);
  /** Null until the reader says: open beside the transcript, away on a phone. */
  const [threads, setThreads] = useState<boolean | null>(null);

  /*
   * The turn being written lives in a ref, not in state.
   *
   * A token is a state update, and a fast model emits them faster than a screen
   * refreshes; re-rendering the whole transcript on each one spends the frame
   * budget on frames nobody sees. The ref is mutated as events arrive and a
   * repaint is asked for at most once per frame.
   */
  const live = useRef<ChatSegment[] | null>(null);
  const liveMeta = useRef<{ sending?: Destination; thinkingFrom?: number }>({});
  const [, repaint] = useState(0);
  const frame = useRef<number | null>(null);
  const paint = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      repaint((count) => count + 1);
    });
  }, []);

  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const box = useRef<HTMLTextAreaElement>(null);
  const loaded = useRef<string | null>(conversation?.id ?? null);

  const selected = options.find((option) => option.providerId === choice?.providerId) ?? null;
  const remote = Boolean(selected?.leavesMachine && choice?.model);
  const ready = Boolean(choice?.model) && (!remote || acknowledged);

  // A different conversation is a different transcript; the same one refreshed
  // is not, and must not throw away the turn that was just streamed into it.
  useEffect(() => {
    const id = conversation?.id ?? null;
    if (loaded.current === id) return;
    loaded.current = id;
    // Whatever is still arriving belongs to the conversation being left.
    abort.current?.abort();
    setTurns(storedTurns(conversation));
    setThreadId(id);
    setTitle(conversation?.title ?? null);
    setError(null);
    live.current = null;
    setStreaming(false);
  }, [conversation]);

  // Nothing should be arriving into a screen that is gone.
  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 208)}px`;
  }, [draft]);

  const atBottom = useCallback(() => {
    const element = scroller.current;
    if (element && element.scrollHeight > element.clientHeight + 4) {
      return element.scrollHeight - element.scrollTop - element.clientHeight < 96;
    }
    const page = document.documentElement;
    return page.scrollHeight - window.scrollY - window.innerHeight < 96;
  }, []);

  const toBottom = useCallback(() => {
    const element = scroller.current;
    if (element && element.scrollHeight > element.clientHeight + 4) {
      element.scrollTop = element.scrollHeight;
      return;
    }
    window.scrollTo({ top: document.documentElement.scrollHeight });
  }, []);

  useEffect(() => {
    const watch = () => {
      stick.current = atBottom();
    };
    window.addEventListener("scroll", watch, { passive: true });
    return () => window.removeEventListener("scroll", watch);
  }, [atBottom]);

  // Follows the answer down, unless the reader has scrolled up to read.
  useEffect(() => {
    if (stick.current) toBottom();
  });

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || streaming || !choice?.model) return;

      const pending = `pending-${Date.now()}`;
      setError(null);
      setDraft("");
      setTurns((current) => [
        ...current,
        { id: pending, role: "user", content: message, segments: [] },
      ]);
      live.current = [];
      liveMeta.current = {};
      stick.current = true;
      setStreaming(true);

      const controller = new AbortController();
      abort.current = controller;
      let saved: string | null = null;

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json", [CSRF_HEADER]: csrfToken },
          signal: controller.signal,
          body: JSON.stringify({
            threadId: threadId ?? undefined,
            message,
            providerId: choice.providerId,
            model: choice.model,
            acknowledge: remote ? acknowledged : undefined,
          }),
        });

        if (!response.ok || !response.body) {
          const refusal: unknown = await response.json().catch(() => null);
          setError(
            (refusal as { error?: string } | null)?.error ??
              "The journal server refused that message.",
          );
        } else {
          for await (const event of readChatEvents(response.body)) {
            if (event.type === "done") {
              /*
               * The turn is settled here rather than after the stream closes,
               * because it is not the last thing on it: a new conversation is
               * named next, and holding the composer shut through a second
               * model call would make a finished answer look unfinished.
               */
              if (event.threadId) {
                saved = event.threadId;
                setThreadId(event.threadId);
                setTurns((current) => [
                  ...current,
                  {
                    id: `done-${Date.now()}`,
                    role: "assistant",
                    content: written(live.current ?? []),
                    segments: live.current ?? [],
                    provider: event.provider,
                    model: event.model,
                  },
                ]);
                live.current = null;
              }
              setStreaming(false);
            } else if (event.type === "title") {
              setTitle(event.title);
            } else if (event.type === "error") {
              setError(event.message);
            } else {
              apply(live, liveMeta, event);
              paint();
            }
          }
        }
      } catch {
        // An abort is the Stop button, and the server keeps what was written.
        if (!controller.signal.aborted) {
          setError("The connection to the journal was lost before the answer finished.");
        }
      } finally {
        /*
         * A newer turn can have started while this one was being named — the
         * composer is free from `done` onwards. That one owns the screen: this
         * one must not clear the answer it is writing, close its composer, or
         * move it to another page.
         */
        const superseded = abort.current !== controller;
        if (!superseded) {
          abort.current = null;
          live.current = null;
          setStreaming(false);
        }

        if (!saved) {
          /*
           * Nothing was saved, so nothing stays on screen pretending it was.
           *
           * A refused or failed turn leaves the transcript exactly as it was
           * and hands the message back to the box it was typed into — which is
           * what the old form did by not clearing itself, and the one part of
           * its behaviour worth keeping.
           */
          setTurns((current) => current.filter((turn) => turn.id !== pending));
          setDraft((current) => current || message);
        } else if (!superseded) {
          // The transcript is on the server now: pick it up, so a reload — and
          // the conversation list beside it — shows what just happened.
          if (saved !== conversation?.id) router.replace(`/chat/${saved}`);
          else router.refresh();
        }
      }
    },
    [acknowledged, choice, conversation?.id, csrfToken, paint, remote, router, streaming, threadId],
  );

  const asideShown = threads === null ? "hidden md:flex" : threads ? "flex" : "hidden";
  const mainShown = threads === true ? "hidden md:flex" : "flex";
  const empty = turns.length === 0 && !streaming;

  return (
    <div className="-mx-4 -my-8 flex flex-col md:-mx-8 md:h-dvh">
      <header className="flex items-center gap-2 border-b border-ink-800 px-3 py-2.5 md:px-4">
        <button
          type="button"
          onClick={() => setThreads((was) => (was === null ? false : !was))}
          aria-pressed={threads === true}
          title="Conversations"
          className="rounded-lg p-2 text-ink-400 transition-colors hover:bg-ink-900 hover:text-ink-100"
        >
          <PanelIcon className="size-4" />
          <span className="sr-only">Conversations</span>
        </button>

        <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-ink-200">
          {title ?? "New conversation"}
        </h1>

        <ChatModelPicker
          options={options}
          selected={choice}
          onSelect={(next) => {
            setChoice(next);
            setAcknowledged(false);
          }}
          csrfToken={csrfToken}
          disabled={streaming}
        />

        {conversation && (
          <Link
            href={`/chat/${conversation.id}/delete`}
            title="Delete conversation"
            className="rounded-lg p-2 text-ink-500 transition-colors hover:bg-ink-900 hover:text-danger-500"
          >
            <TrashIcon className="size-4" />
            <span className="sr-only">Delete conversation</span>
          </Link>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          className={`${asideShown} w-full shrink-0 flex-col gap-1 border-ink-800 p-2 md:w-56 md:border-r`}
        >
          <Link
            href="/chat"
            className="mb-1 flex items-center gap-2 rounded-lg border border-ink-800 px-3 py-2 text-sm text-ink-200 transition-colors hover:bg-ink-900 hover:text-ink-100"
          >
            <PlusIcon className="size-4" />
            New conversation
          </Link>
          <nav aria-label="Conversations" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
            {conversations.length === 0 && (
              <p className="px-3 py-2 text-xs text-ink-600">Nothing yet.</p>
            )}
            {conversations.map((thread) => (
              <Link
                key={thread.id}
                href={`/chat/${thread.id}`}
                aria-current={conversation?.id === thread.id ? "page" : undefined}
                className={`block rounded-lg px-3 py-2 text-sm transition-colors ${
                  conversation?.id === thread.id
                    ? "bg-ink-800 text-ink-100"
                    : "text-ink-400 hover:bg-ink-900 hover:text-ink-200"
                }`}
              >
                <span className="line-clamp-2 leading-snug">{thread.title}</span>
              </Link>
            ))}
          </nav>
        </aside>

        <section className={`${mainShown} min-h-0 min-w-0 flex-1 flex-col`}>
          <div
            ref={scroller}
            onScroll={() => {
              stick.current = atBottom();
            }}
            /* `min-h-0` is what lets this scroll rather than push the
               composer off the bottom: from `md` the whole frame is exactly
               one viewport tall, and a flex child will not shrink below its
               own content without it. */
            className="min-h-0 flex-1 px-4 py-6 md:overflow-y-auto md:px-6"
          >
            <div className="mx-auto w-full max-w-2xl space-y-6">
              {empty ? (
                <Opening onPick={(text) => setDraft(text)} />
              ) : (
                turns.map((turn) =>
                  turn.role === "user" ? (
                    <p
                      key={turn.id}
                      className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md border border-lucid-500/20 bg-lucid-500/10 px-4 py-2.5 text-[0.9375rem] text-ink-100"
                    >
                      {turn.content}
                    </p>
                  ) : (
                    <AssistantTurn
                      key={turn.id}
                      segments={turn.segments}
                      provider={turn.provider}
                      model={turn.model}
                    />
                  ),
                )
              )}

              {streaming && (
                <AssistantTurn
                  segments={live.current ?? []}
                  sending={liveMeta.current.sending}
                  streaming
                />
              )}

              {error && (
                <p
                  role="alert"
                  className="rounded-xl border border-danger-500/40 bg-danger-500/10 px-4 py-3 text-sm text-ink-100"
                >
                  {error}
                </p>
              )}
            </div>
          </div>

          <div className="sticky bottom-0 border-t border-ink-800 bg-ink-950/95 px-4 py-3 backdrop-blur md:static md:px-6 md:py-4">
            <div className="mx-auto w-full max-w-2xl space-y-2">
              <Sending
                destination={destination}
                option={selected}
                model={choice?.model}
                acknowledged={acknowledged}
                onAcknowledge={setAcknowledged}
              />

              <div className="flex items-end gap-2 rounded-2xl border border-ink-800 bg-ink-900 px-3 py-2 transition-colors focus-within:border-lucid-400/60">
                <label className="sr-only" htmlFor="chat-message">
                  Message
                </label>
                <textarea
                  id="chat-message"
                  ref={box}
                  rows={1}
                  value={draft}
                  maxLength={MAX_CHAT_MESSAGE_CHARS}
                  placeholder="Ask about a recurring place, compare lucid nights, reflect on a dream…"
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
                      return;
                    }
                    event.preventDefault();
                    if (ready) void send(draft);
                  }}
                  className="max-h-52 min-h-[1.5rem] w-full resize-none bg-transparent py-1.5 text-[0.9375rem] text-ink-100 placeholder:text-ink-500 focus:outline-none"
                />
                {streaming ? (
                  <button
                    type="button"
                    onClick={() => abort.current?.abort()}
                    title="Stop"
                    className="mb-0.5 shrink-0 rounded-xl border border-ink-700 p-2 text-ink-200 transition-colors hover:bg-ink-800"
                  >
                    <StopIcon className="size-4" />
                    <span className="sr-only">Stop</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void send(draft)}
                    disabled={!draft.trim() || !ready}
                    title="Send"
                    className="mb-0.5 shrink-0 rounded-xl bg-lucid-500 p-2 text-white transition-colors hover:bg-lucid-400 disabled:cursor-not-allowed disabled:bg-ink-800 disabled:text-ink-500"
                  >
                    <SendIcon className="size-4" />
                    <span className="sr-only">Send</span>
                  </button>
                )}
              </div>

              <p className="text-center text-[0.6875rem] text-ink-600">
                Enter sends · Shift + Enter starts a line · the model reads only what it asks for
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * Where the next message is going, immediately above the box it is typed into.
 *
 * The compact line is enough for a model on this machine. A destination that
 * leaves it gets the loud version and a checkbox, every time — that is the
 * rule everywhere else in the app, and a conversation is the screen where the
 * most journal material goes out at once.
 */
function Sending({
  destination,
  option,
  model,
  acknowledged,
  onAcknowledge,
}: {
  destination: Destination;
  option: ChatModelOption | null;
  model?: string;
  acknowledged: boolean;
  onAcknowledge: (value: boolean) => void;
}) {
  if (!option || !model) {
    return (
      <p className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-ink-400">
        {destination.configured
          ? "Choose a model to send to."
          : "No model is assigned for chat yet — pick one above."}
      </p>
    );
  }

  if (!option.leavesMachine) {
    return (
      <p role="status" className="flex flex-wrap items-center gap-1.5 text-[0.6875rem] text-ink-500">
        <span className="inline-block size-1.5 rounded-full bg-ok-500" aria-hidden />
        <span className="font-mono text-ink-400">{model}</span>
        <span>on {option.providerName},</span>
        <span className="text-ok-500">this machine</span>
      </p>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-warn-500/40 bg-warn-500/10 px-3 py-2">
      <p role="status" className="text-sm text-ink-100">
        This conversation, and any journal entries its tools read, will be sent to{" "}
        <span className="font-medium">{option.providerName}</span> at{" "}
        <span className="font-mono text-xs">{option.host}</span> using{" "}
        <span className="font-mono text-xs">{model}</span>. It{" "}
        <span className="text-warn-500">leaves this machine</span>.
      </p>
      <label className="flex items-start gap-2 text-sm text-ink-200">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => onAcknowledge(event.target.checked)}
          className="mt-0.5 size-4 accent-warn-500"
        />
        <span>I understand, send it there.</span>
      </label>
    </div>
  );
}

function Opening({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="py-10 text-center">
      <h2 className="text-2xl font-semibold text-ink-100">Talk with your journal</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-ink-400">
        The model starts with no dream text in its prompt. It reads only the entries, nights,
        signs, reports or statistics it asks for, and it cannot change any of them.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {OPENERS.map((opener) => (
          <button
            key={opener}
            type="button"
            onClick={() => onPick(opener)}
            className="rounded-full border border-ink-800 bg-ink-900 px-3.5 py-1.5 text-xs text-ink-300 transition-colors hover:border-ink-700 hover:text-ink-100"
          >
            {opener}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Folds one streamed event into the turn being written.
 *
 * Deltas of the same kind join onto the segment that is already open, so the
 * answer stays one block of prose rather than becoming one per token, and a
 * tool result finds the row that started it by id.
 */
function apply(
  live: React.RefObject<ChatSegment[] | null>,
  meta: React.RefObject<{ sending?: Destination; thinkingFrom?: number }>,
  event: ChatWireEvent,
): void {
  const segments = live.current;
  if (!segments) return;
  const last = segments[segments.length - 1];

  if (event.type === "start") {
    meta.current.sending = event.destination;
    return;
  }
  if (event.type === "thinking") {
    if (last?.kind === "thinking") last.text += event.delta;
    else {
      meta.current.thinkingFrom = Date.now();
      segments.push({ kind: "thinking", text: event.delta });
    }
    return;
  }
  if (event.type === "text") {
    closeThinking(segments, meta);
    if (last?.kind === "text") last.text += event.delta;
    else segments.push({ kind: "text", text: event.delta });
    return;
  }
  if (event.type === "tool_start") {
    closeThinking(segments, meta);
    segments.push({ kind: "tool", id: event.id, name: event.name, summary: event.summary });
    return;
  }
  if (event.type === "tool_end") {
    const row = segments.find(
      (segment): segment is Extract<ChatSegment, { kind: "tool" }> =>
        segment.kind === "tool" && segment.id === event.id,
    );
    if (row) {
      row.ok = event.ok;
      row.ms = event.ms;
    }
  }
}

/** Stamps how long the thinking took, the moment something else starts. */
function closeThinking(
  segments: ChatSegment[],
  meta: React.RefObject<{ thinkingFrom?: number }>,
): void {
  const last = segments[segments.length - 1];
  if (last?.kind !== "thinking" || !meta.current.thinkingFrom) return;
  last.ms = Date.now() - meta.current.thinkingFrom;
  meta.current.thinkingFrom = undefined;
}

/** The prose of a turn: what was saved, and what a copy is worth having. */
function written(segments: ChatSegment[]): string {
  return segments
    .filter((segment): segment is Extract<ChatSegment, { kind: "text" }> => segment.kind === "text")
    .map((segment) => segment.text)
    .join("\n\n")
    .trim();
}

function storedTurns(conversation: Conversation | null): Turn[] {
  return (conversation?.messages ?? []).map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    segments: [{ kind: "text", text: message.content }],
    provider: message.provider,
    model: message.model,
  }));
}
