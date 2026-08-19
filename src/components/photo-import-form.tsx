"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { uploadPhotoAction, uploadPhotosAction } from "@/lib/capture/actions";
import type { CaptureFormState, PhotoUploadResult } from "@/lib/capture/form-state";
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
 * Photograph a page, one page at a time.
 *
 * A phone camera hands the file input a single image per capture and replaces
 * whatever was there before, so `multiple` buys nothing on the surface this
 * form exists for: the second page silently overwrites the first. Each photo
 * is therefore uploaded the moment it is taken and the input is emptied for
 * the next one, which also keeps a ten-page night from arriving as one request.
 *
 * The plain form underneath is the no-JavaScript path and still posts the
 * batch action; the queue replaces its submit button once hydrated.
 */
export function PhotoImportForm({ csrfToken }: { csrfToken: string }) {
  const [state, action] = useActionState<CaptureFormState, FormData>(uploadPhotosAction, {});
  const [pages, setPages] = useState<QueuedPage[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const router = useRouter();
  const chain = useRef<Promise<void>>(Promise.resolve());
  const previews = useRef<string[]>([]);
  const nextKey = useRef(0);

  useEffect(() => setHydrated(true), []);

  // Object URLs outlive the elements that showed them, so release them by hand.
  useEffect(() => () => previews.current.forEach((url) => URL.revokeObjectURL(url)), []);

  function onChoose(event: React.ChangeEvent<HTMLInputElement>): void {
    const input = event.currentTarget;
    const chosen = Array.from(input.files ?? []);
    // Emptying the field is the whole point: it is what lets the camera be
    // opened again for the next page instead of replacing the last one.
    input.value = "";
    if (chosen.length === 0) return;

    const queued = chosen.map((file) => {
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
    setPages((prev) => [...prev, ...queued.map((entry) => entry.page)]);

    // Uploaded one at a time, and the chain swallows rejections: a single
    // failed page must not strand every page queued behind it.
    for (const { page, file } of queued) {
      chain.current = chain.current.then(() => upload(page.key, file)).catch(() => {});
    }
    // One refresh once the batch drains, so the inbox above lists the pages.
    chain.current = chain.current.then(() => router.refresh());
  }

  async function upload(key: number, file: File): Promise<void> {
    const body = new FormData();
    body.set(CSRF_FIELD, csrfToken);
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

  const uploading = pages.some((page) => page.status === "uploading");

  return (
    <form action={action} className="card space-y-4">
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <div>
        <h2 className="font-medium">Photograph a page</h2>
        <p className="mt-1 text-sm text-ink-400">
          Each photo uploads on its own, so you can take one page after another.
          Nothing is saved as a dream until you confirm the reading.
        </p>
      </div>

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

      {pages.length > 0 && (
        <ul className="space-y-2">
          {pages.map((page) => (
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
              <span className="min-w-0 flex-1 truncate text-sm text-ink-200">{page.name}</span>
              <PageStatusLabel page={page} />
            </li>
          ))}
        </ul>
      )}

      <FormError message={state.error} />

      {hydrated ? (
        <p className="text-sm text-ink-400" aria-live="polite">
          {uploading
            ? "Uploading…"
            : pages.length === 0
              ? "Photos appear here as you add them."
              : "Pages are waiting for review at the top of this screen."}
        </p>
      ) : (
        <SubmitButton pendingLabel="Uploading…">Upload pages</SubmitButton>
      )}
    </form>
  );
}

function PageStatusLabel({ page }: { page: QueuedPage }) {
  if (page.status === "uploading") {
    return <span className="text-xs text-ink-400">uploading…</span>;
  }
  if (page.status === "failed") {
    return <span className="text-xs text-danger-500">{page.error ?? "failed"}</span>;
  }
  return (
    <a href={`/import/review/${page.id}`} className="text-sm text-lucid-300 hover:underline">
      {page.status === "duplicate" ? "already added" : "Review"}
    </a>
  );
}
