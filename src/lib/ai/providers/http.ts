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
/**
 * Splitting one log into its separate dreams.
 *
 * The only role whose answer is its own prompt written out again: every word
 * of the log has to come back inside the JSON before there is anything to
 * parse. That makes it the slowest output in the app per character of input,
 * and it scales with the entry rather than with the size of the answer -- a
 * night with four dreams in it is four dreams' worth of tokens.
 *
 * Measured on the machine this was written for, against a 2,900-character log
 * of four dreams: 200s on qwen3.5:9b, 155s on qwen3.8:27b -- both of them
 * writing ~700 tokens at 4-6 tok/s. The old default of 120s could not finish
 * either one, and cut out at the same place every time, so a night with
 * several dreams in it never split and the feature looked broken rather than
 * slow.
 *
 * This ceiling is not generous the way the OCR and scan ones are: those are
 * queued jobs nobody waits on, and a split is a form the writer is sitting in
 * front of. It buys roughly 5,000 characters of log at these rates. A longer
 * one still runs out -- but it now says so, naming the host and the budget,
 * instead of failing anonymously.
 */
export const SPLIT_TIMEOUT_MS = 300_000;
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
