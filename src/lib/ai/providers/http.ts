/**
 * HTTP for provider adapters: one buffered call, one streamed one.
 *
 * Two jobs, and they are the same for both: bound how long a call may take,
 * and make sure a failure cannot leak the request or the response. Chat APIs
 * routinely echo the prompt in error bodies, so no error body is ever read.
 */
import {
  hostOfUrl,
  networkError,
  ProviderError,
  ProviderStallError,
  StreamStoppedError,
} from "./errors";

export const TEST_TIMEOUT_MS = 10_000;
export const CHAT_TIMEOUT_MS = 120_000;

/**
 * The ceilings on a *completion*, and what they now mean.
 *
 * These used to be total wall-clock budgets on a buffered call, and that shape
 * was wrong for every one of them. A buffered request can tell you nothing
 * until it is finished, so the only question it can answer is "has the whole
 * answer arrived yet" — and the honest answer on a laptop running a local
 * model over dozens of entries is "no, and it will not be for a while". Five
 * minutes was not too little patience so much as the wrong thing being
 * measured: the budget was timing how long the answer *is* rather than whether
 * the machine is still working on it, then reporting a working model as a
 * broken one and asking for the whole thing again twice.
 *
 * Every completion in drem now streams (`completeRole` collapses the stream
 * back into one answer), which makes the useful question askable: silence.
 * These numbers are the outer ceiling that stops a stream dripping forever,
 * and they are generous because nothing else depends on them being tight —
 * `JOB_IDLE_TIMEOUT_MS` is what actually catches a model that has stopped.
 */
export const REPORT_TIMEOUT_MS = 1_800_000;
/**
 * Reading one photographed page.
 *
 * Measured on the machine this was written for: a 27B vision model on an Intel
 * iGPU spends ~12s decoding the image before it emits a token, then writes the
 * transcript at ~5 tok/s, and a clean printed page came to 91s. A dense
 * handwritten one at phone resolution is several times that. Nobody is blocked
 * on it either way: it is a queued job whose result lands on a page that polls.
 */
export const OCR_TIMEOUT_MS = 900_000;
/**
 * Splitting one log into its separate dreams.
 *
 * The only role whose answer is its own prompt written out again: every word
 * of the log has to come back inside the JSON before there is anything to
 * parse. That makes it the slowest output in the app per character of input,
 * and it scales with the entry rather than with the size of the answer -- a
 * night with four dreams in it is four dreams' worth of tokens.
 *
 * Measured against a 2,900-character log of four dreams: 200s on qwen3.5:9b,
 * 155s on qwen3.8:27b -- both writing ~700 tokens at 4-6 tok/s. This is the one
 * ceiling still sized around a person's patience rather than a model's speed:
 * a split is a form the writer is sitting in front of, not a queued job. It is
 * scaled again by page count where a stack was photographed.
 */
export const SPLIT_TIMEOUT_MS = 600_000;
/** A backfill batch of a few dozen entries against a local model. */
export const EMBED_TIMEOUT_MS = 120_000;
/**
 * A dream-sign scan reads dozens of entries in one request and answers with the
 * largest token budget in the app, on a model that may reason its way there
 * first. At the 4-6 tok/s a laptop manages, sixteen thousand tokens is most of
 * an hour, and nobody is waiting on it: it is a queued job whose result lands
 * on a page that polls.
 */
export const SCAN_TIMEOUT_MS = 3_600_000;

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
    throw networkError(url, error, timeoutMs);
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

/**
 * The same shape for work nobody is sitting in front of.
 *
 * More patient than the conversation's on both counts, for the same reason the
 * roles' ceilings are. A scan's prompt is dozens of entries, and every token of
 * it is evaluated before a single one comes back — so the first-byte wait is
 * covering a cold model being loaded *and* a prompt that takes minutes to read,
 * on a machine that is also doing something else. Nothing has gone wrong during
 * that silence, and there is nothing to show for it either; it is simply the
 * shape of local inference on a laptop.
 *
 * `idleMs` is the number that matters. It is the one that says "this stopped"
 * rather than "this is slow", and it is why the role ceilings can afford to be
 * hours: a model that dies mid-answer is caught in two minutes regardless of
 * how long its role was allowed.
 */
export const JOB_FIRST_TOKEN_TIMEOUT_MS = 900_000;
export const JOB_IDLE_TIMEOUT_MS = 180_000;

/**
 * `totalMs` comes from the role (or the caller, where a call is sized by what
 * it was handed). The silence budgets are clamped to it so a caller that asks
 * for a short call gets a short one — a thirty-second title must not be able
 * to sit waiting ten minutes for a first token.
 */
export function jobStreamBudget(totalMs: number, signal?: AbortSignal): StreamBudget {
  return {
    firstByteMs: Math.min(JOB_FIRST_TOKEN_TIMEOUT_MS, totalMs),
    idleMs: Math.min(JOB_IDLE_TIMEOUT_MS, totalMs),
    totalMs,
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
    // A budget of ours expiring is a stall; anything else is the connection.
    if (stall) throw new ProviderStallError(describeStreamStall(stall, url, budget));
    throw networkError(url, error);
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
function describeStreamStall(stall: StreamStall, url: string, budget: StreamBudget): string {
  const host = hostOfUrl(url);
  const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;
  if (stall === "first-byte") {
    return `${host} did not start answering within ${seconds(budget.firstByteMs)}`;
  }
  if (stall === "idle") return `${host} stopped sending after ${seconds(budget.idleMs)} of silence`;
  return `${host} was still answering after ${seconds(budget.totalMs)}`;
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
