"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { uploadPhotoAction, uploadPhotosAction } from "@/lib/capture/actions";
import type { CaptureFormState, PhotoUploadResult } from "@/lib/capture/form-state";
import { MAX_STACK_PAGES } from "@/lib/ai/prompts";
import { randomUuid } from "@/lib/random-id";
import { CSRF_FIELD } from "@/lib/security/constants";

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif";

type PageStatus = "uploading" | "stored" | "duplicate" | "failed";

interface QueuedPage {
  key: number;
  name: string;
  preview: string;
  status: PageStatus;
  id?: string;
  error?: string;
}

/**
 * Photograph the pages of one night, then have them read together.
 *
 * A phone camera hands the file input a single image per capture and replaces
 * whatever was there before, so `multiple` buys nothing on the surface this
 * form exists for: the second page silently overwrites the first. Each photo
 * is therefore uploaded the moment it is taken and the input is emptied for
 * the next one, which also keeps a ten-page night from arriving as one request.
 *
 * What has changed is what happens next. Uploading no longer starts a reading
 * of its own. The pages accumulate into a *stack* under one id, and one model
 * call reads the whole stack when the writer says it is complete — because the
 * two questions a handwritten night actually raises, "does this dream carry on
 * over the page" and "does this page start a new one", are questions about the
 * stack and cannot be answered a page at a time. Asking them per page pushed
 * both back onto the writer as a tick-box join and a second model pass.
 *
 * Sending the stack is a step of its own, on the page above rather than in
 * here: `StackReadForm` owns it, so it is still there after a reload and it is
 * where the destination badge goes.
 *
 * The plain form underneath is the no-JavaScript path and still posts the
 * batch action; the queue replaces its submit button once hydrated.
 */
export function PhotoImportForm({ csrfToken }: { csrfToken: string }) {
  const [state, action] = useActionState<CaptureFormState, FormData>(uploadPhotosAction, {});
  const [pages, setPages] = useState<QueuedPage[]>([]);
  /*
   * One id for every page photographed on this visit. Sending the stack
   * redirects to its review screen, so this component unmounts and the next
   * visit mints a fresh one — a stack already at the model can never be added
   * to behind its back.
   */
  const [stackId] = useState<string>(randomUuid);
  const [hydrated, setHydrated] = useState(false);
  const router = useRouter();
  const chain = useRef<Promise<void>>(Promise.resolve());
  const previews = useRef<string[]>([]);
  const nextKey = useRef(0);

  useEffect(() => setHydrated(true), []);

  // Object URLs outlive the elements that showed them, so release them by hand.
  useEffect(() => () => previews.current.forEach((url) => URL.revokeObjectURL(url)), []);

  const stored = pages.filter((page) => page.status === "stored" || page.status === "duplicate");
  const uploading = pages.some((page) => page.status === "uploading");
  const full = stored.length >= MAX_STACK_PAGES;

  function onChoose(event: React.ChangeEvent<HTMLInputElement>): void {
    const input = event.currentTarget;
    const chosen = Array.from(input.files ?? []);
    // Emptying the field is the whole point: it is what lets the camera be
    // opened again for the next page instead of replacing the last one.
    input.value = "";
    if (chosen.length === 0) return;

    // Never more pages than one reading can carry. The rest is not refused —
    // it goes to the next stack, once this one has been sent.
    const room = Math.max(0, MAX_STACK_PAGES - stored.length);
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
    body.set("stackId", stackId);
    body.set("file", file);

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
              status: result.error ? "failed" : result.duplicate ? "duplicate" : "stored",
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
          Take every page of the night, then have them read together — one pass
          finds where each dream starts and ends, across the page breaks.
          Nothing is saved as a dream until you confirm the reading.
        </p>
      </div>

      <form action={action} className="space-y-4">
        <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
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
                onChange={onChoose}
              />
              Choose from library
            </label>
          </div>
        )}

        <FormError message={state.error} />
        {!hydrated && <SubmitButton pendingLabel="Uploading…">Upload pages</SubmitButton>}
      </form>

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
          : stored.length === 0
            ? "Photos appear here as you add them."
            : `${stored.length === 1 ? "1 page is" : `${stored.length} pages are`} ready to be read, at the top of this screen.`}
      </p>
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
  return <span className="text-xs text-ok-500">ready</span>;
}
