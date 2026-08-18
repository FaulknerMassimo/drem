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

export function describeNetworkError(url: string, error: unknown): string {
  const host = hostOfUrl(url);
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `Timed out waiting for ${host}`;
  }
  return `Could not reach ${host}`;
}
