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
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    const budget = timeoutMs ? ` after ${Math.round(timeoutMs / 1000)}s` : "";
    return `${host} did not finish answering${budget}`;
  }
  return `Could not reach ${host}`;
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
