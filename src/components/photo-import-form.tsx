"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { DestinationBadge } from "@/components/destination-badge";
import { readStackAction, uploadPhotoAction, uploadPhotosAction } from "@/lib/capture/actions";
import type { CaptureFormState, PhotoUploadResult } from "@/lib/capture/form-state";
import type { Destination } from "@/lib/ai/types";
import { MAX_STACK_PAGES } from "@/lib/ai/prompts";
import { randomUuid } from "@/lib/random-id";
import { CSRF_FIELD } from "@/lib/security/constants";

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif";

type PageStatus = "uploading" | "stored" | "duplicate" | "queued" | "failed";

interface QueuedPage {
  key: number;
  name: string;
  preview: string;
  status: PageStatus;
  id?: string;
  error?: string;
}

/**
 * One-tap photo capture, with an explicit multi-page mode for the rarer case.
 *
 * A phone camera hands the file input a single image per capture and replaces
 * whatever was there before, so `multiple` buys nothing on the surface this
 * form exists for: the second page silently overwrites the first. Each photo
 * is therefore uploaded the moment it is taken and the input is emptied for
 * the next one, which also keeps a ten-page night from arriving as one request.
 *
 * A normal photo is queued as soon as its encrypted upload lands. Multi-page
 * mode accumulates a *stack* under one id until the writer says it is complete,
 * because starting after page one would make it impossible to discover that a
 * sentence or dream continues onto page two.
 *
 * The plain form underneath is the no-JavaScript path and still posts the
 * batch action; the queue replaces its submit button once hydrated.
 */
export function PhotoImportForm({
  csrfToken,
  destination,
  splitDestination,
}: {
  csrfToken: string;
  destination: Destination;
  splitDestination: Destination;
}) {
  const [state, action] = useActionState<CaptureFormState, FormData>(uploadPhotosAction, {});
  const [readState, readAction] = useActionState<CaptureFormState, FormData>(readStackAction, {});
  const [pages, setPages] = useState<QueuedPage[]>([]);
  /*
   * One id for every page photographed in multi-page mode. Single photos mint
   * their own id inside `upload`, so another tap can never append a page behind
   * a job that is already reading.
   */
  const [stackId] = useState<string>(randomUuid);
  const [hydrated, setHydrated] = useState(false);
  const [multiplePages, setMultiplePages] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const router = useRouter();
  const chain = useRef<Promise<void>>(Promise.resolve());
  const previews = useRef<string[]>([]);
  const nextKey = useRef(0);

  useEffect(() => setHydrated(true), []);

  // Object URLs outlive the elements that showed them, so release them by hand.
  useEffect(() => () => previews.current.forEach((url) => URL.revokeObjectURL(url)), []);

  const stored = pages.filter((page) => page.status === "stored" || page.status === "duplicate");
  const queued = pages.filter((page) => page.status === "queued");
  const uploading = pages.some((page) => page.status === "uploading");
  const full = multiplePages && stored.length >= MAX_STACK_PAGES;
  const remote = [destination, splitDestination].filter(
    (item) => item.configured && item.leavesMachine,
  );
  const remoteHosts = [...new Set(remote.map((item) => item.host))];
  const canChoose = destination.configured && (remote.length === 0 || acknowledged);

  function onChoose(event: React.ChangeEvent<HTMLInputElement>): void {
    const input = event.currentTarget;
    const chosen = Array.from(input.files ?? []);
    // Emptying the field is the whole point: it is what lets the camera be
    // opened again for the next page instead of replacing the last one.
    input.value = "";
    if (chosen.length === 0) return;

    // Never more pages than one reading can carry. The rest is not refused —
    // it goes to the next stack, once this one has been sent.
    const room = multiplePages ? Math.max(0, MAX_STACK_PAGES - stored.length) : chosen.length;
    const queued = chosen.slice(0, room).map((file) => {
      const preview = URL.createObjectURL(file);
      previews.current.push(preview);
      const page: QueuedPage = {
        key: nextKey.current++,
        name: file.name || "photograph",
        preview,
        status: "uploading",
      };
      return { page, file };
    });
    if (queued.length === 0) return;
    setPages((prev) => [...prev, ...queued.map((entry) => entry.page)]);

    // Uploaded one at a time, and the chain swallows rejections: a single
    // failed page must not strand every page queued behind it.
    for (const { page, file } of queued) {
      chain.current = chain.current.then(() => upload(page.key, file)).catch(() => {});
    }
    // One refresh once the batch drains, so the inbox above lists the stack.
    chain.current = chain.current.then(() => router.refresh());
  }

  async function upload(key: number, file: File): Promise<void> {
    const body = new FormData();
    body.set(CSRF_FIELD, csrfToken);
    body.set("stackId", multiplePages ? stackId : randomUuid());
    body.set("file", file);
    if (!multiplePages) body.set("autoProcess", "1");
    if (acknowledged) body.set("acknowledge", "1");

    let result: PhotoUploadResult;
    try {
      result = await uploadPhotoAction(body);
    } catch {
      result = { error: "That photo could not be uploaded." };
    }

    setPages((prev) =>
      prev.map((page) =>
        page.key === key
          ? {
              ...page,
              status: result.error
                ? "failed"
                : result.queued
                  ? "queued"
                  : result.duplicate
                    ? "duplicate"
                    : "stored",
              id: result.id,
              error: result.error,
            }
          : page,
      ),
    );
  }

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="font-medium">Photograph a page</h2>
        <p className="mt-1 text-sm text-ink-400">
          Take a photo and leave. It is transcribed, divided into dreams and
          filed with its ratings and tags in the background.
        </p>
      </div>

      <form action={action} className="space-y-4">
        <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
        <DestinationBadge destination={destination} what="the photograph" />
        {splitDestination.configured && (
          <DestinationBadge destination={splitDestination} what="the transcript" />
        )}
        {remote.length > 0 && (
          <label className="flex items-start gap-3 text-sm text-ink-200">
            <input
              type="checkbox"
              name="acknowledge"
              value="1"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.currentTarget.checked)}
              className="mt-0.5 size-4 accent-warn-500"
            />
            <span>I understand this will be sent to {remoteHosts.join(" and ")}.</span>
          </label>
        )}
        {/*
          Hidden rather than disabled once the stack is full: a picker that
          opens the camera and then silently drops the photograph is worse than
          one that is not there, and the note below says why it went.
        */}
        {!full && (
          <div className="flex flex-wrap gap-2">
            <label className="btn btn-primary cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-lucid-400">
              <input
                name="files"
                type="file"
                accept={ACCEPT}
                capture="environment"
                className="sr-only"
                disabled={!canChoose}
                onChange={onChoose}
              />
              Take a photo
            </label>
            <label className="btn btn-ghost cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-lucid-400">
              <input
                name="files"
                type="file"
                accept={ACCEPT}
                multiple
                className="sr-only"
                disabled={!canChoose}
                onChange={onChoose}
              />
              Choose from library
            </label>
          </div>
        )}

        <FormError message={state.error} />
        <FormError message={readState.error} />
        {!hydrated && <SubmitButton pendingLabel="Uploading…">Upload pages</SubmitButton>}
      </form>

      {hydrated && (
        <label className="flex items-center gap-2 text-sm text-ink-300">
          <input
            type="checkbox"
            checked={multiplePages}
            disabled={stored.length > 0 || uploading}
            onChange={(event) => setMultiplePages(event.currentTarget.checked)}
            className="size-4 accent-lucid-500"
          />
          These are several pages of the same night
        </label>
      )}

      {pages.length > 0 && (
        <ul className="space-y-2">
          {pages.map((page, index) => (
            <li
              key={page.key}
              className="flex items-center gap-3 rounded-lg border border-ink-800 bg-ink-850 p-2"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={page.preview}
                alt=""
                className="h-12 w-12 shrink-0 rounded object-cover bg-ink-950"
              />
              <span className="min-w-0 flex-1 truncate text-sm text-ink-200">
                <span className="text-ink-400">Page {index + 1}</span> · {page.name}
              </span>
              <PageStatusLabel page={page} />
            </li>
          ))}
        </ul>
      )}

      <p className="text-sm text-ink-400" aria-live="polite">
        {uploading
          ? "Uploading…"
          : queued.length > 0 && !multiplePages
            ? "Queued. You can leave this page; the finished entries will appear in your journal."
            : stored.length === 0
              ? "Photos appear here as you add them."
              : `${stored.length === 1 ? "1 page is" : `${stored.length} pages are`} ready.`}
      </p>

      {multiplePages && stored.length > 0 && !uploading && (
        <form action={readAction} className="space-y-2">
          <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
          <input type="hidden" name="stackId" value={stackId} />
          {acknowledged && <input type="hidden" name="acknowledge" value="1" />}
          <SubmitButton pendingLabel="Queuing…">
            Finish and process {stored.length === 1 ? "this page" : `these ${stored.length} pages`}
          </SubmitButton>
        </form>
      )}
    </div>
  );
}

function PageStatusLabel({ page }: { page: QueuedPage }) {
  if (page.status === "uploading") {
    return <span className="text-xs text-ink-400">uploading…</span>;
  }
  if (page.status === "failed") {
    return <span className="text-xs text-danger-500">{page.error ?? "failed"}</span>;
  }
  if (page.status === "duplicate") {
    return <span className="text-xs text-ink-400">already added</span>;
  }
  if (page.status === "queued") {
    return <span className="text-xs text-ok-500">queued</span>;
  }
  return <span className="text-xs text-ok-500">ready</span>;
}
