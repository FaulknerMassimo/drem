"use client";

import { useActionState, useRef, useState } from "react";
import { DestinationBadge } from "@/components/destination-badge";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import {
  confirmReviewAction,
  confirmReviewSplitAction,
  discardAttachmentAction,
  proposeReviewSplitAction,
} from "@/lib/capture/actions";
import type { ReviewFormState } from "@/lib/capture/form-state";
import { addPage, removePage } from "@/lib/capture/pages";
import type { Destination } from "@/lib/ai/types";
import type { CaptureProgress, ReviewAttachment } from "@/lib/capture/types";
import type { SplitPart } from "@/lib/capture/types";
import { LUCIDITY_LABELS } from "@/lib/journal/labels";
import { CSRF_FIELD } from "@/lib/security/constants";

export function ReviewForm({
  attachment,
  pages,
  defaultDate,
  csrfToken,
  splitDestination,
  progress = null,
}: {
  attachment: ReviewAttachment;
  /** Everything waiting for review, in the order it was photographed. */
  pages: ReviewAttachment[];
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
  const [confirmSplitState, confirmSplitAction] = useActionState<ReviewFormState, FormData>(
    confirmReviewSplitAction,
    {},
  );
  /*
   * Which other pending pages are part of this dream. Held here rather than in
   * `SingleReview` because a split replaces that whole form, and the pages the
   * writer joined are the pages the split's entries have to be filed under.
   */
  const [picked, setPicked] = useState<string[]>([]);

  const fields = attachment.fields;
  const proposal = splitState.splitProposal;
  const processing = attachment.status === "pending" || attachment.status === "running";
  const failed = attachment.status === "failed";
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

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <MediaPane attachment={attachment} />
        <div className="space-y-4">
          {processing && (
            <div className="space-y-1">
              <p className="text-sm text-ink-400">
                {attachment.kind === "audio"
                  ? "Transcribing…"
                  : "Reading the page…"}{" "}
                You can wait, or type over it.
              </p>
              {/*
                A retry is invisible from the attachment row alone: it stays at
                `running` through the whole backoff, so an unreachable model
                looks identical to a slow one for a quarter of an hour. Saying
                which attempt this is, and why the last one failed, is the
                difference between waiting and knowing to go fix Settings.
              */}
              {retrying && (
                <p role="status" className="text-sm text-warn-500">
                  Attempt {retrying.attempts} of {retrying.maxAttempts} failed:{" "}
                  {sentence(retrying.lastError)} Retrying.
                </p>
              )}
            </div>
          )}
          {failed && (
            <p role="alert" className="text-sm text-warn-500">
              Automatic reading failed
              {progress?.lastError ? `: ${sentence(progress.lastError)}` : "."} The file is
              still here — type what you see or hear, then save.
            </p>
          )}
          {attachment.status === "skipped" && attachment.kind === "image" && (
            <p className="text-sm text-ink-400">
              No page-reading model is assigned, so the fields are blank. Type
              what you see, or choose a vision model in Settings.
            </p>
          )}

          {proposal && proposal.length > 0 ? (
            <SplitConfirm
              attachmentId={attachment.id}
              picked={picked}
              defaultDate={fields.date.value ?? defaultDate}
              lucidity={fields.lucidity.value ?? 0}
              proposal={proposal}
              csrfToken={csrfToken}
              state={confirmSplitState}
              action={confirmSplitAction}
            />
          ) : (
            <SingleReview
              attachment={attachment}
              pages={pages}
              picked={picked}
              onPick={setPicked}
              processing={processing}
              defaultDate={fields.date.value ?? defaultDate}
              csrfToken={csrfToken}
              splitDestination={splitDestination}
              saveState={saveState}
              saveAction={saveAction}
              splitState={splitState}
              splitAction={splitAction}
            />
          )}
        </div>
      </div>
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

function MediaPane({ attachment }: { attachment: ReviewAttachment }) {
  const src = `/api/attachments/${attachment.id}`;
  if (attachment.kind === "audio") {
    return (
      <div className="card space-y-3">
        <h2 className="font-medium">Recording</h2>
        <audio controls src={src} className="w-full" />
      </div>
    );
  }
  return (
    <div className="card overflow-hidden p-0">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="Photographed journal page"
        className="max-h-[80vh] w-full object-contain bg-ink-950"
      />
    </div>
  );
}

function SingleReview({
  attachment,
  pages,
  picked,
  onPick,
  processing,
  defaultDate,
  csrfToken,
  splitDestination,
  saveState,
  saveAction,
  splitState,
  splitAction,
}: {
  attachment: ReviewAttachment;
  pages: ReviewAttachment[];
  picked: string[];
  onPick: (ids: string[]) => void;
  processing: boolean;
  defaultDate: string;
  csrfToken: string;
  splitDestination: Destination;
  saveState: ReviewFormState;
  saveAction: (payload: FormData) => void;
  splitState: ReviewFormState;
  splitAction: (payload: FormData) => void;
}) {
  const fields = attachment.fields;
  const extras = pages.filter((item) => item.id !== attachment.id);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  /*
   * Joining is done to the textarea itself rather than through state: the
   * transcript arrives late, and a controlled value initialised from a prop
   * would freeze at whatever the field held when the model was still reading.
   *
   * A page goes in ahead of the first page after it whose text is already in
   * the field -- the page being reviewed counts, since its text is what the
   * field started as -- so the entry reads in photograph order however the
   * writer ticks, including from a page in the middle of the dream. Once that
   * text has been edited it can no longer be found, and the page joins at the
   * end for the writer to move.
   */
  function togglePage(item: ReviewAttachment, joined: boolean): void {
    const node = bodyRef.current;
    if (node) {
      if (joined) {
        const following = pages
          .slice(pages.indexOf(item) + 1)
          .find((other) => other.id === attachment.id || picked.includes(other.id));
        node.value = addPage(node.value, item.fields.body.value, following?.fields.body.value);
      } else {
        node.value = removePage(node.value, item.fields.body.value);
      }
    }
    onPick(joined ? [...picked, item.id] : picked.filter((id) => id !== item.id));
  }

  return (
    <div className="space-y-6">
      <form action={saveAction} className="space-y-4">
        <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
        <input type="hidden" name="id" value={attachment.id} />

        <Field
          label="Night"
          name="nightDate"
          type="date"
          defaultValue={defaultDate}
          confidence={fields.date.confidence}
        />
        <Field
          label="Title"
          name="title"
          defaultValue={fields.title.value ?? ""}
          confidence={fields.title.confidence}
        />
        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-3">
            <label className="label mb-0" htmlFor="body">
              Dream
            </label>
            <Confidence value={fields.body.confidence} />
          </div>
          <textarea
            id="body"
            ref={bodyRef}
            name="body"
            rows={14}
            defaultValue={fields.body.value}
            className="field min-h-48"
            required
          />
        </div>
        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-3">
            <label className="label mb-0" htmlFor="lucidity">
              Lucidity
            </label>
            <Confidence value={fields.lucidity.confidence} />
          </div>
          <select
            id="lucidity"
            name="lucidity"
            defaultValue={fields.lucidity.value ?? 0}
            className="field"
          >
            {Object.entries(LUCIDITY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Tags"
          name="tags"
          defaultValue={fields.tags.value.join(", ")}
          confidence={fields.tags.confidence}
          hint="Comma-separated"
        />
        <label className="flex items-center gap-2 text-sm text-ink-200">
          <input type="checkbox" name="isFragment" className="size-4 accent-lucid-500" />
          This is a fragment
        </label>

        {extras.length > 0 && (
          <fieldset className="space-y-3 rounded-lg border border-ink-800 p-4">
            <legend className="px-1 text-sm font-medium text-ink-200">
              Does this dream carry on?
            </legend>
            <p className="text-xs text-ink-400">
              {processing
                ? "Wait for this page to finish reading, then tick the pages it continues onto."
                : "Tick every page of the same dream and their text joins the entry above, in the order they were photographed. One entry, all the pages filed with it. Leave a page clear if it is a different dream."}
            </p>
            {extras.map((item) => (
              <label key={item.id} className="flex items-center gap-3 text-sm text-ink-200">
                <input
                  type="checkbox"
                  name="extra"
                  value={item.id}
                  checked={picked.includes(item.id)}
                  disabled={processing}
                  onChange={(event) => togglePage(item, event.currentTarget.checked)}
                  className="size-4 accent-lucid-500"
                />
                {item.kind === "image" && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={`/api/attachments/${item.id}`}
                    alt=""
                    className="h-12 w-12 shrink-0 rounded object-cover bg-ink-950"
                  />
                )}
                <span className="flex-1">{item.kind === "audio" ? "Recording" : "Page"}</span>
                <PageState item={item} />
              </label>
            ))}
          </fieldset>
        )}

        <FormError message={saveState.error} />
        <SubmitButton pendingLabel="Saving…">Save as a draft</SubmitButton>

        <div className="space-y-3 rounded-lg border border-ink-800 p-4">
          <h3 className="text-sm font-medium">Several dreams in this log?</h3>
          <p className="text-xs text-ink-400">
            The model proposes a split from the text above. You edit and confirm
            before anything is written — one night, separate entries.
          </p>
          <DestinationBadge destination={splitDestination} what="this log" />
          {splitDestination.leavesMachine && splitDestination.configured && (
            <label className="flex items-start gap-3 text-sm text-ink-200">
              <input
                type="checkbox"
                name="acknowledge"
                value="1"
                className="mt-0.5 size-4 accent-warn-500"
              />
              <span>I understand this log will be sent to {splitDestination.host}.</span>
            </label>
          )}
          <FormError message={splitState.error} />
          <SubmitButton
            className="btn btn-ghost"
            pendingLabel="Reading…"
            formAction={splitAction}
          >
            Split into separate dreams
          </SubmitButton>
        </div>
      </form>

      <form action={discardAttachmentAction}>
        <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
        <input type="hidden" name="id" value={attachment.id} />
        <button type="submit" className="text-sm text-danger-500 hover:underline">
          Discard this upload
        </button>
      </form>
    </div>
  );
}

function SplitConfirm({
  attachmentId,
  picked,
  defaultDate,
  lucidity,
  proposal,
  csrfToken,
  state,
  action,
}: {
  attachmentId: string;
  picked: string[];
  defaultDate: string;
  lucidity: number;
  proposal: SplitPart[];
  csrfToken: string;
  state: ReviewFormState;
  action: (payload: FormData) => void;
}) {
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name="id" value={attachmentId} />
      <input type="hidden" name="count" value={String(proposal.length)} />
      <input type="hidden" name="nightDate" value={defaultDate} />
      <input type="hidden" name="lucidity" value={String(lucidity)} />
      {picked.map((id) => (
        <input key={id} type="hidden" name="extra" value={id} />
      ))}
      <p className="text-sm text-ink-400">
        {proposal.length} {proposal.length === 1 ? "dream" : "dreams"} proposed.
        Edit the text, then save. The original log is not kept as one entry.
      </p>
      {proposal.map((part, index) => (
        <div key={index} className="space-y-2 rounded-lg border border-ink-800 p-4">
          <label className="label" htmlFor={`title-${index}`}>
            Title {index + 1}
          </label>
          <input
            id={`title-${index}`}
            name={`title-${index}`}
            defaultValue={part.title ?? ""}
            className="field"
          />
          <label className="label" htmlFor={`body-${index}`}>
            Dream {index + 1}
          </label>
          <textarea
            id={`body-${index}`}
            name={`body-${index}`}
            rows={8}
            defaultValue={part.body}
            className="field"
            required
          />
          <label className="flex items-center gap-2 text-sm text-ink-200">
            <input
              type="checkbox"
              name={`fragment-${index}`}
              defaultChecked={part.isFragment}
              className="size-4 accent-lucid-500"
            />
            Fragment
          </label>
        </div>
      ))}
      <FormError message={state.error} />
      <SubmitButton pendingLabel="Saving…">Save as separate drafts</SubmitButton>
    </form>
  );
}

/** Whether a pending page has text to contribute yet. */
function PageState({ item }: { item: ReviewAttachment }) {
  if (item.status === "pending" || item.status === "running") {
    return <span className="text-xs text-ink-400">reading…</span>;
  }
  if (!item.fields.body.value.trim()) {
    return <span className="text-xs text-warn-500">no text — files the photo only</span>;
  }
  return null;
}

function Field({
  label,
  name,
  type = "text",
  defaultValue,
  confidence,
  hint,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue: string;
  confidence: number | null;
  hint?: string;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label className="label mb-0" htmlFor={name}>
          {label}
        </label>
        <Confidence value={confidence} />
      </div>
      <input id={name} name={name} type={type} defaultValue={defaultValue} className="field" />
      {hint && <p className="mt-1 text-xs text-ink-400">{hint}</p>}
    </div>
  );
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
