/**
 * How a model call says it is still working.
 *
 * A queued job used to be a black box: the screen said "Generating the scan…"
 * from the moment it was asked until either an insight appeared or a timeout
 * did, and in between there was no difference on screen between a model
 * halfway through an answer and a host that was never there. On a laptop where
 * a scan is genuinely twenty minutes of work, that is the whole of the
 * complaint — not that it was slow, but that nothing said it was alive.
 *
 * What travels is a *count*, never a character of what the model wrote. The
 * reasoning and the answer are both derived from the journal, and `jobs` is an
 * unencrypted table; a length is the most that can be put there without
 * breaking the rule the rest of the design exists for. It is also all the
 * screen needs: a number that keeps going up is the message.
 *
 * The listener is carried in async context rather than passed down, because
 * the alternative is an `onProgress` parameter threaded through every job
 * runner and every role — six signatures widened so one of them can count.
 * The worker says who is listening while a job runs; `completeRole` tells
 * whoever that is, and neither has to know about the other.
 */
import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/** Reasoning, or the answer itself. Models that do not think never report the first. */
export type ModelPhase = "thinking" | "writing";

export interface ModelProgress {
  phase: ModelPhase;
  /** Characters received in this phase so far. A length; never the text. */
  characters: number;
}

export type ProgressListener = (progress: ModelProgress) => void;

const listening = new AsyncLocalStorage<ProgressListener>();

/** Runs `work` with `listener` hearing every model call made inside it. */
export function withProgress<T>(listener: ProgressListener, work: () => Promise<T>): Promise<T> {
  return listening.run(listener, work);
}

/** Reports progress to whoever is listening, or to nobody. */
export function reportProgress(progress: ModelProgress): void {
  const listener = listening.getStore();
  if (!listener) return;
  try {
    listener(progress);
  } catch {
    // A listener that throws must not take down the answer it is watching.
  }
}
