import type { JobProgress, JobState } from "@/lib/ai/jobs";

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
        {state.progress ? (
          <>
            {" "}
            <Progress progress={state.progress} />
          </>
        ) : (
          state.status === "running" && (
            <>
              {" "}
              <span className="text-ink-300">
                The model has not started answering yet.
              </span>
            </>
          )
        )}
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

  /*
   * A model that ran out of its budget is a different problem from one that was
   * never there, and pointing both at the connection is how an operator ends up
   * restarting a model server that was working the whole time. These are also
   * the failures nothing retries -- the same request would spend the same time
   * and stop in the same place -- so the sentence has to say what to change.
   */
  if (/did not start answering|stopped sending|was still answering/i.test(error)) {
    return (
      <p className="text-xs text-ink-400">
        The model was working but did not finish in time. It was not tried again,
        because the same request would take just as long. Try a shorter period, a
        smaller model, or a model that does not reason before answering.
      </p>
    );
  }

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

/**
 * Proof that the machine is still working, without quoting a word of what it
 * wrote.
 *
 * The count is the point. A local model reading a season of entries can spend
 * twenty minutes on one answer, and for all of that time a screen saying only
 * "Generating…" is indistinguishable from a screen saying it about a job that
 * died — which is what made a slow feature look like a broken one. A number
 * that keeps climbing settles the question at a glance, and none of it is
 * derived from the journal: `jobs` never sees the text, only its length.
 */
function Progress({ progress }: { progress: JobProgress }) {
  const silent = Date.now() - progress.at.getTime();
  const verb = progress.phase === "thinking" ? "Thinking" : "Writing";
  return (
    <span className="text-ink-300">
      {verb} — {progress.characters.toLocaleString()} characters so far
      {silent >= QUIET_MS ? `, quiet for ${elapsed(silent)}` : ""}.
    </span>
  );
}

/** Long enough that an ordinary gap between tokens is not called a silence. */
const QUIET_MS = 15_000;

function elapsed(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 1) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${Math.round(ms / 1000)}s`;
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
