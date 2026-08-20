"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { captureAction } from "@/lib/journal/actions";
import { nightDateFor } from "@/lib/journal/dates";
import type { JournalFormState } from "@/lib/journal/form-state";
import {
  acknowledge,
  enqueue,
  readQueue,
  type QueuedCapture,
} from "@/lib/capture/offline";
import { randomUuid } from "@/lib/random-id";
import { CSRF_FIELD } from "@/lib/security/constants";

/**
 * Capture mode.
 *
 * One field, deep red on black, and nothing else on the screen. The constraint
 * this is designed against is that a dream survives about ninety seconds after
 * waking, and every decision the interface asks for — which night, is it lucid,
 * what to call it — spends some of that. All of it is deferred to the draft
 * queue; the only job here is getting words into storage before they are gone.
 *
 * The same constraint is why this screen works offline. At 4am the phone is as
 * likely as not to have nothing, and "try again when you have signal" is a
 * dream lost. A save that cannot reach the server goes to `localStorage` and is
 * sent when one is available — with the trade-off that involves written out in
 * `capture/offline.ts`, and the count kept on screen so text waiting there is
 * never invisible.
 */

function SaveButton({ offline }: { offline: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="night-button" disabled={pending}>
      {pending ? "Saving…" : offline ? "Save on this device" : "Save and keep going"}
    </button>
  );
}

/** The double-submit token, for replaying a queued capture after a reconnect. */
function csrfFromCookie(): string {
  const match = document.cookie.match(/(?:^|;\s*)drem_csrf=([^;]*)/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

export function CaptureForm({
  serverNightDate,
  children,
}: {
  serverNightDate: string;
  children: React.ReactNode;
}) {
  const [state, formAction] = useActionState<JournalFormState, FormData>(
    captureAction,
    {},
  );

  /*
   * The browser knows the local wall clock and the server may not, so the date
   * is decided here — but it starts as the server's answer, so the form works
   * before hydration and with JavaScript off. The action refuses a value more
   * than a day away from its own, so this cannot be used to backdate an entry.
   */
  const [nightDate, setNightDate] = useState(serverNightDate);
  useEffect(() => setNightDate(nightDateFor(new Date())), []);

  const [saved, setSaved] = useState(0);
  useEffect(() => {
    if (state.savedAt) setSaved((count) => count + 1);
  }, [state.savedAt]);

  // Local counterparts of the server's `savedAt`, so a capture stored on the
  // device clears and refocuses the field exactly as a saved one does.
  const [queued, setQueued] = useState<QueuedCapture[]>([]);
  const [localSavedAt, setLocalSavedAt] = useState<number | null>(null);
  const [offlineNotice, setOfflineNotice] = useState<string | null>(null);
  const [flushError, setFlushError] = useState<string | null>(null);

  /**
   * Sends everything waiting on the device, oldest first.
   *
   * Each entry is acknowledged individually as the server confirms it, so a
   * flush interrupted halfway resumes rather than restarting.
   *
   * **Only a confirmed save removes anything.** A capture the server rejects
   * stays on the device and stops the flush, which means a permanently
   * unacceptable entry is retried on every load forever — and that is the
   * right trade. The alternative is discarding it, and discarding it is
   * destroying the dream, which is the one outcome this screen exists to
   * prevent. A queue that will not drain is at least visible: the count stays
   * on screen and the reason is printed under the field.
   */
  const flush = useCallback(async () => {
    const pending = readQueue(window.localStorage);
    if (pending.length === 0) return;

    const token = csrfFromCookie();
    if (!token) return;

    for (const entry of pending) {
      const form = new FormData();
      form.set(CSRF_FIELD, token);
      form.set("nightDate", entry.nightDate);
      form.set("body", entry.body);

      try {
        const result = await captureAction({}, form);
        if (!result.saved) {
          setFlushError(result.error ?? "Something on this device could not be saved.");
          break;
        }
        setQueued(acknowledge(window.localStorage, entry.id));
        setSaved((count) => count + 1);
        setFlushError(null);
      } catch {
        // Still no server, or the session has gone. Leave this and everything
        // after it exactly where it is.
        break;
      }
    }
  }, []);

  useEffect(() => {
    setQueued(readQueue(window.localStorage));
    void flush();

    const onOnline = () => void flush();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [flush]);

  const formRef = useRef<HTMLFormElement>(null);

  /**
   * Diverts a save to the device when the browser says there is no network.
   *
   * `navigator.onLine` is famously optimistic — it reports a connection that
   * goes nowhere — but it is never wrong in the direction that matters here:
   * when it says offline, it is. A request that fails despite it saying online
   * leaves the text in the textarea and an error on screen, which is recoverable
   * by pressing the button again; nothing is lost either way.
   */
  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    if (navigator.onLine) return;

    const form = event.currentTarget;
    const field = form.elements.namedItem("body") as HTMLTextAreaElement;
    const body = field.value.trim();
    event.preventDefault();
    if (!body) return;

    const result = enqueue(window.localStorage, {
      id: randomUuid(),
      nightDate,
      body,
      queuedAt: Date.now(),
    });

    if (!result.accepted) {
      setOfflineNotice(
        "This device is holding as much as it will. Get a connection before writing more.",
      );
      return;
    }

    setQueued(result.queue);
    setOfflineNotice(null);
    setLocalSavedAt(Date.now());
  };

  useEffect(() => {
    if (localSavedAt) formRef.current?.querySelector("textarea")?.focus();
  }, [localSavedAt]);

  const total = saved + queued.length;

  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={onSubmit}
      className="flex min-h-dvh flex-col gap-4 p-4"
    >
      {children}
      <input type="hidden" name="nightDate" value={nightDate} />

      <textarea
        // Remounting on each save clears the field and returns the cursor to
        // it, so the next fragment can be typed without touching anything.
        key={state.savedAt ?? localSavedAt ?? 0}
        name="body"
        autoFocus
        rows={10}
        spellCheck={false}
        autoComplete="off"
        placeholder="what happened…"
        className="night-field flex-1 text-2xl leading-relaxed"
      />

      {(state.error ?? offlineNotice ?? flushError) && (
        <p role="alert" className="text-base">
          {state.error ?? offlineNotice ?? flushError}
        </p>
      )}

      <SaveButton offline={queued.length > 0} />

      <div className="flex items-center justify-between text-sm">
        <span style={{ color: "var(--color-night-dim)" }}>
          {total > 0 ? `${total} saved — night of ${nightDate}` : `night of ${nightDate}`}
          {queued.length > 0 && ` · ${queued.length} on this device`}
        </span>
        <a href="/" style={{ color: "var(--color-night-dim)" }}>
          done
        </a>
      </div>
    </form>
  );
}
