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
/**
 * Reading one photographed page.
 *
 * Shared the report ceiling until a measurement on the machine this was
 * written for: a 27B vision model on an Intel iGPU spends ~12s decoding the
 * image before it emits a token, then writes the transcript at ~5 tok/s, and a
 * clean printed page came to 91s. A dense handwritten one at phone resolution
 * is several times that, and 180s cut it off mid-transcript.
 *
 * Nobody is blocked on this: it is a queued job whose result lands on a page
 * that polls, the same reasoning that makes the scan ceiling generous.
 */
export const OCR_TIMEOUT_MS = 300_000;
/** A backfill batch of a few dozen entries against a local model. */
export const EMBED_TIMEOUT_MS = 120_000;
/**
 * A dream-sign scan reads dozens of entries in one request, and nobody is
 * waiting on the response — it is a queued job whose result lands on a page
 * that polls. The ceiling is generous for that reason.
 */
export const SCAN_TIMEOUT_MS = 300_000;

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
    throw new ProviderError(describeNetworkError(url, error, timeoutMs));
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
