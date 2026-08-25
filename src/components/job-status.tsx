import type { JobState } from "@/lib/ai/jobs";

/**
 * Says what the queue is actually doing, including when it has given up.
 *
 * Everything a model call can go wrong with — an unreachable host, a model
 * name with a typo in it, a role nobody assigned — lands in `jobs.last_error`
 * as a sentence written to be read. Before this existed, exactly one screen
 * (the page-reading review) read them; everywhere else a failure looked
 * identical to still working, and then identical to never having been asked.
 * That is the whole of "the AI features are broken": they were not silent
 * about failing, the screens were.
 */
export function JobStatus({
  state,
  label,
}: {
  state: JobState | null | undefined;
  /** What was asked for, lower case: "extraction", "the scan", "the report". */
  label: string;
}) {
  if (!state) return null;

  if (state.status === "pending" || state.status === "running") {
    // A first attempt still in flight is just work in progress; a retry means
    // something already went wrong, and the reason is the useful part.
    const retrying = state.attempts > 1 && state.lastError;
    return (
      <p role="status" className="text-sm text-ink-400">
        Generating {label}…
        {retrying && (
          <>
            {" "}
            <span className="text-warn-500">
              Attempt {state.attempts} of {state.maxAttempts}
            </span>{" "}
            — {sentence(state.lastError!)} {nextAttempt(state.scheduledFor)}
          </>
        )}
      </p>
    );
  }

  if (state.status === "failed") {
    return (
      <div
        role="alert"
        className="space-y-1 rounded-lg border border-danger-500/40 bg-danger-500/10 px-3 py-2 text-sm"
      >
        <p className="text-ink-100">
          {capitalise(label)} failed after {state.attempts}{" "}
          {state.attempts === 1 ? "attempt" : "attempts"}.
          {state.lastError ? ` ${sentence(state.lastError)}` : ""}
        </p>
        <Remedy error={state.lastError} />
      </div>
    );
  }

  if (state.status === "skipped") {
    return (
      <div
        role="status"
        className="space-y-1 rounded-lg border border-warn-500/40 bg-warn-500/10 px-3 py-2 text-sm"
      >
        <p className="text-ink-100">
          {capitalise(label)} was not run. {state.lastError ? sentence(state.lastError) : ""}
        </p>
        <Remedy error={state.lastError} />
      </div>
    );
  }

  return null;
}

/**
 * Points at the screen that can fix it.
 *
 * The provider messages name a host or a model but cannot know what to do
 * about it — and the two things that go wrong on a self-hosted install are
 * always the same: the model server is not running, or the role points at a
 * model that is not installed.
 */
function Remedy({ error }: { error: string | null }) {
  if (!error) return null;

  if (/could not reach|did not finish/i.test(error)) {
    return (
      <p className="text-xs text-ink-400">
        Check that the model server is running and reachable, then ask again.
      </p>
    );
  }

  if (/no model|not assigned|cannot read images|not found|404/i.test(error)) {
    return (
      <p className="text-xs text-ink-400">
        Check which model this role points at in{" "}
        <a href="/settings" className="text-lucid-300 hover:text-lucid-400">
          Settings
        </a>
        , then ask again.
      </p>
    );
  }

  return null;
}

/** "in about 4 minutes", or nothing once the wait is over. */
function nextAttempt(scheduledFor: Date): string {
  const ms = scheduledFor.getTime() - Date.now();
  if (ms <= 0) return "Trying again now.";
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 1) return `Trying again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  return `Trying again in ${Math.max(1, Math.round(ms / 1000))}s.`;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
