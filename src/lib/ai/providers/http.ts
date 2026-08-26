/**
 * HTTP for provider adapters: one buffered call, one streamed one.
 *
 * Two jobs, and they are the same for both: bound how long a call may take,
 * and make sure a failure cannot leak the request or the response. Chat APIs
 * routinely echo the prompt in error bodies, so no error body is ever read.
 */
import { describeNetworkError, hostOfUrl, ProviderError, StreamStoppedError } from "./errors";

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

/**
 * The three budgets a *streamed* answer is held to.
 *
 * A single total timeout is the wrong shape for a conversation. `CHAT_TIMEOUT_MS`
 * is 120s because that is a fair ceiling on one buffered call, and against a
 * large model it cut the reply off mid-thought: the model was working the whole
 * time, and the budget was measuring how long the answer *is* rather than
 * whether anything is still happening. A stream can tell those apart, so it is
 * bounded on silence instead.
 *
 * `firstByteMs` is separate and generous because nothing at all comes back
 * while a cold model is being paged into VRAM, which on a large local model is
 * minutes before the first token. `idleMs` then applies between tokens, where
 * silence really does mean something has gone wrong. `totalMs` exists only so a
 * stream that drips forever cannot hold a connection open for a day.
 */
export interface StreamBudget {
  /** How long to wait for the first byte. Covers a cold model being loaded. */
  firstByteMs: number;
  /** How long the stream may then go silent before it is abandoned. */
  idleMs: number;
  /** A ceiling regardless of progress. */
  totalMs: number;
  /** The reader's own stop: a Stop button, or a closed tab. */
  signal?: AbortSignal;
}

export const CHAT_FIRST_TOKEN_TIMEOUT_MS = 300_000;
export const CHAT_IDLE_TIMEOUT_MS = 120_000;
export const CHAT_TOTAL_TIMEOUT_MS = 1_800_000;

export function chatStreamBudget(signal?: AbortSignal): StreamBudget {
  return {
    firstByteMs: CHAT_FIRST_TOKEN_TIMEOUT_MS,
    idleMs: CHAT_IDLE_TIMEOUT_MS,
    totalMs: CHAT_TOTAL_TIMEOUT_MS,
    signal,
  };
}

type StreamStall = "first-byte" | "idle" | "total";

/**
 * Yields a streamed response one line at a time.
 *
 * Both wire formats in use here are line-oriented — Ollama sends one JSON
 * object per line, OpenAI and Anthropic send SSE, whose payload is always a
 * single `data:` line — so line framing is the whole parser this needs. Blank
 * lines and SSE's `event:` lines are dropped: every event carries its own type
 * inside the JSON, so the separators say nothing the payload does not.
 *
 * As with `requestJson`, an error body is drained and never read: chat APIs
 * routinely echo the prompt back inside their errors.
 */
export async function* streamLines(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  budget: StreamBudget,
): AsyncGenerator<string> {
  const controller = new AbortController();
  let stall: StreamStall | null = null;
  const stop = (reason: StreamStall) => {
    stall = reason;
    controller.abort();
  };

  let quiet = setTimeout(() => stop("first-byte"), budget.firstByteMs);
  const whole = setTimeout(() => stop("total"), budget.totalMs);
  const relay = () => controller.abort();
  budget.signal?.addEventListener("abort", relay, { once: true });
  const fail = (error: unknown): never => {
    if (budget.signal?.aborted) throw new StreamStoppedError();
    throw new ProviderError(describeStreamStall(url, error, stall, budget));
  };

  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      fail(error);
      return;
    }
    if (!response.ok) {
      await response.text().catch(() => undefined);
      throw new ProviderError(`The provider returned HTTP ${response.status}`, response.status);
    }
    if (!response.body) throw new ProviderError("The provider returned an empty response body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    /*
     * The budgets are enforced here rather than left to the abort signal alone.
     * Aborting a fetch is *supposed* to error the body it handed back, and does
     * — but that makes the ceiling on a silent stream depend on the transport
     * propagating it, which is the one part of this nobody can test and the
     * exact case where a hung read would otherwise wait forever.
     */
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("The stream was ended before it finished")),
        { once: true },
      );
    });

    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), aborted]);
      } catch (error) {
        fail(error);
        return;
      }
      clearTimeout(quiet);
      if (chunk.done) break;
      quiet = setTimeout(() => stop("idle"), budget.idleMs);

      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/u, "");
        buffer = buffer.slice(newline + 1);
        if (line) yield line;
        newline = buffer.indexOf("\n");
      }
    }
    // Flushes any bytes of a character the stream ended in the middle of.
    const tail = (buffer + decoder.decode()).trim();
    if (tail) yield tail;
  } finally {
    clearTimeout(quiet);
    clearTimeout(whole);
    budget.signal?.removeEventListener("abort", relay);
    // Releases the socket when the consumer stops reading early — a tool round
    // that has seen everything it needs, or a reader who pressed Stop.
    controller.abort();
  }
}

/**
 * Why a stream ended without finishing.
 *
 * The distinction the reader needs is the one a single timeout cannot make:
 * a model that never started is a different problem from one that stopped
 * halfway, and both are different from a host that is not there at all.
 */
function describeStreamStall(
  url: string,
  error: unknown,
  stall: StreamStall | null,
  budget: StreamBudget,
): string {
  const host = hostOfUrl(url);
  const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;
  if (stall === "first-byte") return `${host} did not start answering within ${seconds(budget.firstByteMs)}`;
  if (stall === "idle") return `${host} stopped sending after ${seconds(budget.idleMs)} of silence`;
  if (stall === "total") return `${host} was still answering after ${seconds(budget.totalMs)}`;
  return describeNetworkError(url, error);
}

/** The sentinel OpenAI-compatible servers close a stream with. */
export const SSE_DONE = Symbol("sse-done");

/**
 * The payload of one SSE line, or null for a line that carries none.
 *
 * `event:` lines and comments are skipped rather than parsed: both providers
 * that speak SSE here also put the event's type inside the JSON, so the
 * framing adds nothing a parser needs. A line that will not parse is dropped
 * for the same reason a malformed Ollama line is — one bad frame is not a
 * reason to abandon an answer that is still arriving.
 */
export function sseData(line: string): unknown {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload) return null;
  if (payload === "[DONE]") return SSE_DONE;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}
