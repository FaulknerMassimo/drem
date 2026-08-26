/**
 * Errors thrown by provider adapters.
 *
 * Messages are safe to persist: they name a host and a status code, never a
 * prompt, a completion, or an API key. `jobs.last_error` and the audit log
 * both consume them as-is.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * The host answered and the model was working; it just did not finish in time.
 *
 * A distinct type because the *response* to it is different, not the wording.
 * A host that cannot be reached is worth trying again: it is usually a model
 * server that had not started yet, and the retry costs nothing. A model that
 * was given ten minutes and spent all of them thinking is not — the next
 * attempt is the same prompt, on the same machine, against the same model, and
 * it will spend the same ten minutes before failing in the same place. On a
 * laptop running local inference those attempts are not free: they are the fans
 * coming on three times for one answer nobody is going to get.
 *
 * `jobs` reads this to decide whether a failure has a retry coming.
 */
export class ProviderStallError extends ProviderError {
  constructor(message: string) {
    super(message);
    this.name = "ProviderStallError";
  }
}

/** Hostname only — the path and query string of a failed URL are not our business. */
export function hostOfUrl(url: string): string {
  try {
    return new URL(url).host || "the provider";
  } catch {
    return "the provider";
  }
}

/**
 * `timeoutMs` is named in the message on purpose.
 *
 * "Timed out waiting for x:11434" reads like the host is down, and sends the
 * operator to check the connection -- when in fact the host answered the
 * socket and the model is simply slower than the budget. On CPU inference that
 * is the common case, and the number is the one thing that tells them apart.
 */
export function describeNetworkError(url: string, error: unknown, timeoutMs?: number): string {
  const host = hostOfUrl(url);
  if (ranOutOfTime(error)) {
    const budget = timeoutMs ? ` after ${Math.round(timeoutMs / 1000)}s` : "";
    return `${host} did not finish answering${budget}`;
  }
  return `Could not reach ${host}`;
}

/** A budget the caller set expiring, rather than the connection failing. */
export function ranOutOfTime(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/** The right class for a failed call: a stall the caller caused, or a dead host. */
export function networkError(url: string, error: unknown, timeoutMs?: number): ProviderError {
  const message = describeNetworkError(url, error, timeoutMs);
  return ranOutOfTime(error) ? new ProviderStallError(message) : new ProviderError(message);
}

/**
 * Reframes a 400 on a request that carried an image.
 *
 * Every provider here rejects an image sent to a text-only model with a 400,
 * and every one of them explains why in the response body — which is exactly
 * what `requestJson` refuses to read, because chat APIs echo the prompt back
 * inside their errors. The request is enough to say it: we know an image was
 * attached, and a model that accepts images does not answer one with a 400.
 *
 * Without this the operator gets "The provider returned HTTP 400" fifteen
 * minutes after uploading a photograph, with nothing pointing at the model
 * assignment that actually caused it.
 */
export function explainImageRejection(
  model: string,
  hasImages: boolean,
  error: unknown,
): unknown {
  if (!hasImages) return error;
  if (!(error instanceof ProviderError) || error.status !== 400) return error;
  return new ProviderError(
    `${model} cannot read images. Assign a vision model for page reading in Settings.`,
    error.status,
  );
}

/**
 * The reader stopped the answer.
 *
 * Not a failure, and deliberately not a `ProviderError`: nothing went wrong
 * with the provider, and the partial answer is worth keeping. Callers catch
 * this to save what was written rather than to report a problem.
 */
export class StreamStoppedError extends Error {
  constructor() {
    super("The answer was stopped");
    this.name = "StreamStoppedError";
  }
}
