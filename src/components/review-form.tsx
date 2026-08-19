"use client";

import { useActionState } from "react";
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
import type { Destination } from "@/lib/ai/types";
import type { CaptureProgress, ReviewAttachment } from "@/lib/capture/types";
import type { SplitPart } from "@/lib/capture/types";
import { LUCIDITY_LABELS } from "@/lib/journal/labels";
import { CSRF_FIELD } from "@/lib/security/constants";

export function ReviewForm({
  attachment,
  extras,
  defaultDate,
  csrfToken,
  splitDestination,
  progress = null,
}: {
  attachment: ReviewAttachment;
  extras: ReviewAttachment[];
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
              extras={extras}
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
              extras={extras}
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
  extras,
  defaultDate,
  csrfToken,
  splitDestination,
  saveState,
  saveAction,
  splitState,
  splitAction,
}: {
  attachment: ReviewAttachment;
  extras: ReviewAttachment[];
  defaultDate: string;
  csrfToken: string;
  splitDestination: Destination;
  saveState: ReviewFormState;
  saveAction: (payload: FormData) => void;
  splitState: ReviewFormState;
  splitAction: (payload: FormData) => void;
}) {
  const fields = attachment.fields;
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
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink-200">Also attach</legend>
            <p className="text-xs text-ink-400">
              Extra pages of the same dream. Their text is not merged; open
              each to copy if you need it.
            </p>
            {extras.map((item) => (
              <label key={item.id} className="flex items-center gap-2 text-sm text-ink-200">
                <input
                  type="checkbox"
                  name="extra"
                  value={item.id}
                  className="size-4 accent-lucid-500"
                />
                {item.kind === "audio" ? "Recording" : "Page"} {item.id.slice(0, 8)}
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
  extras,
  defaultDate,
  lucidity,
  proposal,
  csrfToken,
  state,
  action,
}: {
  attachmentId: string;
  extras: ReviewAttachment[];
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
      {extras.map((item) => (
        <input key={item.id} type="hidden" name="extra" value={item.id} />
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
