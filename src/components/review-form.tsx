"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { DestinationBadge } from "@/components/destination-badge";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import {
  confirmReviewAction,
  discardStackAction,
  proposeReviewSplitAction,
} from "@/lib/capture/actions";
import type { ReviewFormState } from "@/lib/capture/form-state";
import type { Destination } from "@/lib/ai/types";
import type { CaptureProgress, ReadDream, ReviewStack, SplitPart } from "@/lib/capture/types";
import { LUCIDITY_LABELS } from "@/lib/journal/labels";
import { CSRF_FIELD } from "@/lib/security/constants";

/**
 * One entry as the writer is editing it.
 *
 * `pageIds` rides along rather than being recomputed on save: the model said
 * which pages this dream was written across, and by the time the form is
 * submitted the cards may have been added, removed or re-split, so the screen
 * is the only thing that still knows which photograph belongs to which entry.
 */
interface Card {
  key: number;
  title: string;
  body: string;
  lucidity: number;
  tags: string;
  isFragment: boolean;
  pageIds: string[];
  confidence: ReadDream["body"]["confidence"];
  titleConfidence: number | null;
  dateConfidence: number | null;
}

/**
 * Confirming a stack of pages, or a voice memo, into journal entries.
 *
 * The screen is a list of entries and one Save. A photographed stack arrives
 * with the list already carved when a split model is assigned: each page was
 * copied on its own, the copies were joined, and the split carved the log.
 * A voice memo arrives as one entry with a Split beside it, because speech
 * has no page breaks to read the seams off. A photographed stack that was
 * not split — no model assigned, or the split pass gave up — looks the same,
 * and the same button carves it.
 */
export function ReviewForm({
  stack,
  defaultDate,
  csrfToken,
  splitDestination,
  progress = null,
}: {
  stack: ReviewStack;
  defaultDate: string;
  csrfToken: string;
  splitDestination: Destination;
  progress?: CaptureProgress | null;
}) {
  const [saveState, saveAction] = useActionState<ReviewFormState, FormData>(
    confirmReviewAction,
    {},
  );
  const [splitState, splitAction] = useActionState<ReviewFormState, FormData>(
    proposeReviewSplitAction,
    {},
  );

  const processing = stack.status === "pending" || stack.status === "running";
  const failed = stack.status === "failed";
  const [cards, setCards] = useState<Card[]>(() => cardsFrom(stack));
  const nextKey = useRef(cards.length);

  /*
   * The reading lands while this screen is already open, so the blank card the
   * form started with has to be replaced when it does. Seeded once and never
   * again: after that the cards are the writer's, and a poll landing on top of
   * a half-typed correction would be worse than a stale field.
   */
  const seeded = useRef(stack.dreams.length > 0);
  useEffect(() => {
    if (seeded.current || stack.dreams.length === 0) return;
    seeded.current = true;
    const seed = cardsFrom(stack);
    nextKey.current = seed.length;
    setCards(seed);
  }, [stack]);

  // A split replaces the entry it was asked about, in place. Same one-shot
  // guard: the proposal only arrives once per submission.
  const proposal = splitState.splitProposal;
  const splitFrom = useRef<SplitPart[] | null>(null);
  useEffect(() => {
    if (!proposal || proposal === splitFrom.current) return;
    splitFrom.current = proposal;
    setCards((prev) => {
      const pageIds = prev[0]?.pageIds ?? [];
      return proposal.map((part, index) => ({
        ...blankCard(nextKey.current + index),
        title: part.title ?? "",
        body: part.body,
        isFragment: part.isFragment,
        // Every part came off the same recording, so it stays with the first.
        pageIds: index === 0 ? pageIds : [],
      }));
    });
    nextKey.current += proposal.length;
  }, [proposal]);

  const defaultNight = stack.dreams.find((dream) => dream.date.value)?.date.value ?? defaultDate;

  function update(key: number, patch: Partial<Card>): void {
    setCards((prev) => prev.map((card) => (card.key === key ? { ...card, ...patch } : card)));
  }

  function addCard(): void {
    setCards((prev) => [...prev, blankCard(nextKey.current++)]);
  }

  function removeCard(key: number): void {
    setCards((prev) => (prev.length > 1 ? prev.filter((card) => card.key !== key) : prev));
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <PageStrip stack={stack} />
      <div className="space-y-4">
        <ReadingState
          stack={stack}
          processing={processing}
          failed={failed}
          progress={progress}
          dreams={cards.length}
        />

        <form action={saveAction} className="space-y-4">
          <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
          <input type="hidden" name="stackId" value={stack.id} />
          <input type="hidden" name="count" value={String(cards.length)} />

          <div>
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <label className="label mb-0" htmlFor="nightDate">
                Night
              </label>
              <Confidence value={cards[0]?.dateConfidence ?? null} />
            </div>
            <input
              id="nightDate"
              name="nightDate"
              type="date"
              defaultValue={defaultNight}
              key={defaultNight}
              className="field"
            />
            {cards.length > 1 && (
              <p className="mt-1 text-xs text-ink-400">
                All {cards.length} entries are filed under this night.
              </p>
            )}
          </div>

          {cards.map((card, index) => (
            <EntryCard
              key={card.key}
              card={card}
              index={index}
              total={cards.length}
              stack={stack}
              onChange={(patch) => update(card.key, patch)}
              onRemove={() => removeCard(card.key)}
            />
          ))}

          <button type="button" onClick={addCard} className="text-sm text-lucid-300 hover:underline">
            Add another entry
          </button>

          <FormError message={saveState.error} />
          <SubmitButton pendingLabel="Saving…">
            {cards.length === 1 ? "Save to the journal" : `Save ${cards.length} entries`}
          </SubmitButton>
        </form>

        {cards.length === 1 && (
          /*
           * This is deliberately a form of its own. A button-level action on
           * the Save form made the split depend on two useActionState hooks
           * sharing one form submission. The model could finish successfully
           * while its returned proposal never reached the split state, leaving
           * the writer on an unchanged card after a minutes-long wait.
           */
          <form action={splitAction} className="space-y-3 rounded-lg border border-ink-800 p-4">
            <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
            <input type="hidden" name="body-0" value={cards[0]?.body ?? ""} />
            <h3 className="text-sm font-medium">Several dreams in this log?</h3>
            <p className="text-xs text-ink-400">
              {stack.kind === "audio"
                ? "Speech has no page breaks to read the seams off, so a memo arrives as one entry."
                : "The pages were copied in order and joined. If several dreams are in this log, split them here."}{" "}
              The model proposes the split from the text above; you edit and
              confirm it here before anything is written.
            </p>
            <DestinationBadge destination={splitDestination} what="this transcript" />
            {splitDestination.leavesMachine && splitDestination.configured && (
              <label className="flex items-start gap-3 text-sm text-ink-200">
                <input
                  type="checkbox"
                  name="acknowledge"
                  value="1"
                  required
                  className="mt-0.5 size-4 accent-warn-500"
                />
                <span>I understand this transcript will be sent to {splitDestination.host}.</span>
              </label>
            )}
            {proposal?.length === 1 && (
              <p role="status" className="text-sm text-warn-500">
                The model found one dream, so it left this as one entry. You can
                add another entry by hand or try the split again after marking
                the seams in the transcript.
              </p>
            )}
            <FormError message={splitState.error} />
            <SubmitButton className="btn btn-ghost" pendingLabel="Reading…">
              Split into separate dreams
            </SubmitButton>
          </form>
        )}

        <form action={discardStackAction}>
          <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
          <input type="hidden" name="stackId" value={stack.id} />
          <button type="submit" className="text-sm text-danger-500 hover:underline">
            {stack.pages.length > 1
              ? `Discard these ${stack.pages.length} pages`
              : "Discard this upload"}
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * The reading as editable cards, or one empty card when there is no reading.
 *
 * A stack that failed, was skipped, or is still being read has no dreams on
 * it, and the screen still has to be typeable: the photographs are the point
 * of keeping it, and typing what is on them is the fallback every failure
 * path lands in.
 */
function cardsFrom(stack: ReviewStack): Card[] {
  if (stack.dreams.length === 0) return [blankCard(0)];
  return stack.dreams.map((dream, index) => ({
    key: index,
    title: dream.title.value ?? "",
    body: dream.body.value,
    lucidity: dream.lucidity.value ?? 0,
    tags: dream.tags.value.join(", "),
    isFragment: dream.isFragment,
    pageIds: dream.pages
      .map((page) => stack.pages[page - 1]?.id)
      .filter((id): id is string => Boolean(id)),
    confidence: dream.body.confidence,
    titleConfidence: dream.title.confidence,
    dateConfidence: dream.date.confidence,
  }));
}

function blankCard(key: number): Card {
  return {
    key,
    title: "",
    body: "",
    lucidity: 0,
    tags: "",
    isFragment: false,
    pageIds: [],
    confidence: null,
    titleConfidence: null,
    dateConfidence: null,
  };
}

function EntryCard({
  card,
  index,
  total,
  stack,
  onChange,
  onRemove,
}: {
  card: Card;
  index: number;
  total: number;
  stack: ReviewStack;
  onChange: (patch: Partial<Card>) => void;
  onRemove: () => void;
}) {
  const pageNumbers = card.pageIds
    .map((id) => stack.pages.findIndex((page) => page.id === id) + 1)
    .filter((number) => number > 0);

  return (
    <div className="space-y-3 rounded-lg border border-ink-800 p-4">
      <input type="hidden" name={`pages-${index}`} value={card.pageIds.join(",")} />

      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">
          {total === 1 ? "Entry" : `Dream ${index + 1} of ${total}`}
          {pageNumbers.length > 0 && stack.kind === "image" && (
            <span className="ml-2 text-xs font-normal text-ink-400">
              {pageNumbers.length === 1 ? "page" : "pages"} {pageNumbers.join(", ")}
            </span>
          )}
        </h3>
        {total > 1 && (
          <button
            type="button"
            onClick={onRemove}
            className="text-xs text-danger-500 hover:underline"
          >
            Remove
          </button>
        )}
      </div>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <label className="label mb-0" htmlFor={`title-${index}`}>
            Title
          </label>
          <Confidence value={card.titleConfidence} />
        </div>
        <input
          id={`title-${index}`}
          name={`title-${index}`}
          value={card.title}
          onChange={(event) => onChange({ title: event.currentTarget.value })}
          className="field"
        />
      </div>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <label className="label mb-0" htmlFor={`body-${index}`}>
            Dream
          </label>
          <Confidence value={card.confidence} />
        </div>
        <textarea
          id={`body-${index}`}
          name={`body-${index}`}
          rows={total > 1 ? 10 : 14}
          value={card.body}
          onChange={(event) => onChange({ body: event.currentTarget.value })}
          className="field min-h-40"
          required
        />
      </div>

      <div>
        <label className="label" htmlFor={`lucidity-${index}`}>
          Lucidity
        </label>
        <select
          id={`lucidity-${index}`}
          name={`lucidity-${index}`}
          value={card.lucidity}
          onChange={(event) => onChange({ lucidity: Number(event.currentTarget.value) })}
          className="field"
        >
          {Object.entries(LUCIDITY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor={`tags-${index}`}>
          Tags
        </label>
        <input
          id={`tags-${index}`}
          name={`tags-${index}`}
          value={card.tags}
          onChange={(event) => onChange({ tags: event.currentTarget.value })}
          className="field"
        />
        <p className="mt-1 text-xs text-ink-400">Comma-separated</p>
      </div>

      <label className="flex items-center gap-2 text-sm text-ink-200">
        <input
          type="checkbox"
          name={`fragment-${index}`}
          checked={card.isFragment}
          onChange={(event) => onChange({ isFragment: event.currentTarget.checked })}
          className="size-4 accent-lucid-500"
        />
        This is a fragment
      </label>
    </div>
  );
}

/** What the reading is doing, or why there is nothing in the fields. */
function ReadingState({
  stack,
  processing,
  failed,
  progress,
  dreams,
}: {
  stack: ReviewStack;
  processing: boolean;
  failed: boolean;
  progress: CaptureProgress | null;
  dreams: number;
}) {
  /*
   * Null unless a previous attempt actually failed. `unclaimJob` also parks a
   * reason on the job when the session is locked, but it winds `attempts` back
   * to zero on the way out, so that case reads as "not yet started" rather
   * than as a failure the operator has to act on.
   */
  const retrying =
    processing && progress && progress.attempts > 0 && progress.lastError
      ? { ...progress, lastError: progress.lastError }
      : null;

  if (processing) {
    return (
      <div className="space-y-1">
        <p className="text-sm text-ink-400">
          {stack.kind === "audio"
            ? "Transcribing…"
            : `Reading ${stack.pages.length === 1 ? "the page" : `these ${stack.pages.length} pages`}…`}{" "}
          You can wait, or type over it.
        </p>
        {/*
          A retry is invisible from the attachment row alone: it stays at
          `running` through the whole backoff, so an unreachable model looks
          identical to a slow one for a quarter of an hour. Saying which
          attempt this is, and why the last one failed, is the difference
          between waiting and knowing to go fix Settings.
        */}
        {retrying && (
          <p role="status" className="text-sm text-warn-500">
            Attempt {retrying.attempts} of {retrying.maxAttempts} failed:{" "}
            {sentence(retrying.lastError)} Retrying.
          </p>
        )}
      </div>
    );
  }

  if (failed) {
    return (
      <p role="alert" className="text-sm text-warn-500">
        Automatic reading failed
        {progress?.lastError ? `: ${sentence(progress.lastError)}` : "."} The
        {stack.pages.length === 1 ? " photograph is" : " photographs are"} still here — type what
        you see, then save.
      </p>
    );
  }

  if (stack.status === "skipped") {
    return (
      <p className="text-sm text-ink-400">
        {stack.pages.length === 1 ? "This page was" : "These pages were"} not read, so the fields
        are blank. Type what you see, or assign a vision model in{" "}
        <a href="/settings" className="text-lucid-300 hover:text-lucid-400">
          Settings
        </a>
        .
      </p>
    );
  }

  if (dreams > 1) {
    return (
      <p className="text-sm text-ink-400">
        {dreams} dreams read off {stack.pages.length === 1 ? "this page" : "these pages"}. Correct
        anything the model got wrong, then save them all at once.
      </p>
    );
  }
  return null;
}

function PageStrip({ stack }: { stack: ReviewStack }) {
  if (stack.kind === "audio") {
    return (
      <div className="card space-y-3">
        <h2 className="font-medium">Recording</h2>
        <audio controls src={`/api/attachments/${stack.leadId}`} className="w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {stack.pages.map((page, index) => (
        <div key={page.id} className="card overflow-hidden p-0">
          {stack.pages.length > 1 && (
            <p className="border-b border-ink-800 px-3 py-1.5 text-xs text-ink-400">
              Page {index + 1} of {stack.pages.length}
            </p>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/attachments/${page.id}`}
            alt={`Photographed journal page ${index + 1}`}
            className="max-h-[80vh] w-full object-contain bg-ink-950"
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Provider messages are written as fragments ("Could not reach x:11434") and
 * as full sentences alike, and both get spliced into surrounding prose here.
 */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function Confidence({ value }: { value: number | null }) {
  if (value === null) return null;
  const pct = Math.round(value * 100);
  const tone = pct >= 80 ? "text-ok-500" : pct >= 50 ? "text-warn-500" : "text-danger-500";
  return (
    <span className={`text-xs ${tone}`} title="The model's own confidence">
      {pct}% confident
    </span>
  );
}
