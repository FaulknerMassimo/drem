/**
 * JSON fetch wrapper for provider adapters.
 *
 * Two jobs: apply a timeout, and make sure a failure cannot leak the request
 * or the response. Chat APIs routinely echo the prompt in error bodies.
 */
import { describeNetworkError, ProviderError } from "./errors";

export const TEST_TIMEOUT_MS = 10_000;
export const CHAT_TIMEOUT_MS = 120_000;
export const REPORT_TIMEOUT_MS = 180_000;

export async function requestJson(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new ProviderError(describeNetworkError(url, error));
  }

  if (!response.ok) {
    // Drain so the socket is released; never inspect the text.
    await response.text().catch(() => undefined);
    throw new ProviderError(`The provider returned HTTP ${response.status}`, response.status);
  }

  try {
    return await response.json();
  } catch {
    throw new ProviderError("The provider returned a response that was not JSON");
  }
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
