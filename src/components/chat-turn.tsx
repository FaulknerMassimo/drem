"use client";

import { useEffect, useState } from "react";
import { AlertIcon, CheckIcon, ChevronIcon, CopyIcon, SpinnerIcon } from "@/components/chat-icons";
import { ModelProse } from "@/components/model-prose";
import { chatToolLabel } from "@/lib/ai/labels";
import type { Destination } from "@/lib/ai/types";

/**
 * One piece of an assistant turn, in the order it happened.
 *
 * The turn is a list rather than a string because a model that thinks, reads
 * four entries and then answers did three separate things, and collapsing them
 * into the final paragraph is what made this screen a blank page for a minute
 * followed by a wall of text. Only `text` is persisted; the rest exists for as
 * long as the reader is watching it.
 */
export type ChatSegment =
  | { kind: "thinking"; text: string; ms?: number }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; summary: string; ok?: boolean; ms?: number };

export function AssistantTurn({
  segments,
  streaming = false,
  sending,
  provider,
  model,
}: {
  segments: ChatSegment[];
  streaming?: boolean;
  /** Where the server said it was sending, once it has said so. */
  sending?: Destination;
  provider?: string | null;
  model?: string | null;
}) {
  return (
    <div className="space-y-3">
      {streaming && sending && (
        /*
         * The badge above the composer is the client's copy of the config
         * saying where a message *would* go. This is the server saying where it
         * has just gone, which is the one that cannot be stale.
         */
        <p className="flex items-center gap-1.5 text-[0.6875rem] text-ink-600">
          <span
            className={`inline-block size-1.5 rounded-full ${
              sending.leavesMachine ? "bg-warn-500" : "bg-ok-500"
            }`}
            aria-hidden
          />
          <span className="font-mono">{sending.model}</span>
          <span>at {sending.host}</span>
        </p>
      )}
      {segments.map((segment, index) => {
        if (segment.kind === "thinking") {
          return (
            <ThinkingBlock
              key={index}
              text={segment.text}
              ms={segment.ms}
              live={streaming && index === segments.length - 1}
            />
          );
        }
        if (segment.kind === "tool") return <ToolRow key={segment.id} segment={segment} />;
        return (
          <div key={index} className="text-[0.9375rem]">
            <ModelProse text={segment.text} />
            {streaming && index === segments.length - 1 && <Caret />}
          </div>
        );
      })}

      {streaming && segments.length === 0 && (
        <p className="flex items-center gap-2 text-sm text-ink-400">
          <SpinnerIcon className="size-3.5" />
          <span className="animate-pulse">Reading and thinking…</span>
        </p>
      )}

      {!streaming && written(segments) && (
        <div className="flex items-center gap-3 pt-0.5 text-[0.6875rem] text-ink-600">
          <CopyButton text={written(segments)} />
          {provider && model && (
            <span>
              {provider} · {model}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The model's private working.
 *
 * Open while it is the only thing happening, because a minute of nothing is
 * what this screen was being blamed for; collapsed the moment the answer starts
 * arriving, because by then it is scaffolding. Toggling it by hand wins over
 * both — once the reader has said which they want, nothing moves it back.
 */
function ThinkingBlock({ text, ms, live }: { text: string; ms?: number; live: boolean }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? live;

  return (
    <div className="rounded-xl border border-ink-800 bg-ink-900/40">
      <button
        type="button"
        onClick={() => setManual(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-ink-400 hover:text-ink-200"
      >
        {live ? <SpinnerIcon className="size-3.5" /> : <CheckIcon className="size-3.5 text-ink-600" />}
        <span className={live ? "animate-pulse" : undefined}>
          {live ? "Thinking…" : ms ? `Thought for ${seconds(ms)}` : "Thought about it"}
        </span>
        <ChevronIcon
          className={`ml-auto size-3.5 transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open && (
        <p className="max-h-56 overflow-y-auto whitespace-pre-wrap border-t border-ink-800 px-3 py-2 text-xs leading-relaxed text-ink-400">
          {text}
        </p>
      )}
    </div>
  );
}

/**
 * One journal tool, as it runs.
 *
 * The arguments are shown because they are the reader's own journal being
 * named — which dates, which phrase — and that is the difference between "the
 * model is doing something" and "the model is reading last week".
 */
function ToolRow({ segment }: { segment: Extract<ChatSegment, { kind: "tool" }> }) {
  const done = segment.ok !== undefined;
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-ink-800 bg-ink-900/40 px-3 py-2 text-xs">
      {!done ? (
        <SpinnerIcon className="size-3.5 shrink-0 text-lucid-300" />
      ) : segment.ok ? (
        <CheckIcon className="size-3.5 shrink-0 text-ok-500" />
      ) : (
        <AlertIcon className="size-3.5 shrink-0 text-warn-500" />
      )}
      <span className={`shrink-0 ${done ? "text-ink-300" : "text-ink-200"}`}>
        {chatToolLabel(segment.name, done)}
      </span>
      {segment.summary && (
        <span className="truncate font-mono text-[0.6875rem] text-ink-500">{segment.summary}</span>
      )}
      {segment.ms !== undefined && (
        <span className="ml-auto shrink-0 text-[0.6875rem] text-ink-600">
          {seconds(segment.ms)}
        </span>
      )}
    </div>
  );
}

/**
 * Copies the answer, not the working.
 *
 * The tool rows and the thinking are scaffolding for watching it happen; what
 * is worth pasting into an entry is the prose, which is also exactly what was
 * saved.
 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  /*
   * `navigator.clipboard` is secure-context only, and this journal is very
   * often reached over plain HTTP on a LAN — the same trap `randomUuid()`
   * exists for. Checked after mount rather than during render, so the server's
   * markup and the browser's first pass agree.
   */
  const [available, setAvailable] = useState(false);
  useEffect(() => setAvailable(Boolean(navigator.clipboard)), []);
  if (!available) return null;

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1_500);
          },
          () => undefined,
        );
      }}
      className="flex items-center gap-1 transition-colors hover:text-ink-300"
    >
      <CopyIcon className="size-3" />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function written(segments: ChatSegment[]): string {
  return segments
    .filter((segment): segment is Extract<ChatSegment, { kind: "text" }> => segment.kind === "text")
    .map((segment) => segment.text)
    .join("\n\n")
    .trim();
}

function Caret() {
  return (
    <span
      aria-hidden
      className="chat-caret ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 rounded-full bg-lucid-400 align-baseline"
    />
  );
}

function seconds(ms: number): string {
  if (ms < 950) return `${Math.max(ms, 1)}ms`;
  return `${(ms / 1000).toFixed(ms < 9_500 ? 1 : 0)}s`;
}
