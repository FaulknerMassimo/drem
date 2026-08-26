/**
 * Completes a chat request for one configured role.
 *
 * Looks up the assignment, refuses to guess a model if none is set, and hands
 * the call to the matching adapter. The destination is returned alongside the
 * completion so the worker can record *where* the dream went without having to
 * reconstruct it.
 *
 * Two ways out: `completeRole` for a queued job, which wants the finished text,
 * and `streamRole` for the conversation, which wants the pieces as they arrive.
 * Both resolve the call the same way, so a role that is refused for one is
 * refused for the other, and both read the provider as a stream — the
 * difference is only whether the pieces reach the caller or are assembled
 * first.
 */
import "server-only";
import { destinationForAssignment } from "./destination";
import { providerChatStream } from "./providers";
import { reportProgress } from "./progress";
import {
  chatStreamBudget,
  CHAT_TIMEOUT_MS,
  jobStreamBudget,
  OCR_TIMEOUT_MS,
  REPORT_TIMEOUT_MS,
  SCAN_TIMEOUT_MS,
  SPLIT_TIMEOUT_MS,
} from "./providers/http";
import { resolveRoles } from "./schema";
import type {
  AiConfig,
  ChatImage,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatRole,
  ChatStreamEvent,
  ChatTool,
  Destination,
  ModelRole,
  ProviderConfig,
  RoleAssignment,
  ToolCall,
} from "./types";

export class RoleNotConfiguredError extends Error {
  constructor(role: ModelRole) {
    super(`No model is assigned for ${role}.`);
    this.name = "RoleNotConfiguredError";
  }
}

/** Keyed by ChatRole, not ModelRole: `embedding` returns vectors, not tokens. */
const MAX_TOKENS: Record<ChatRole, number> = {
  extraction: 2048,
  lucidity: 2048,
  symbolic: 2048,
  report: 4096,
  ocr: 4096,
  split: 4096,
  /*
   * The largest budget in the app, and it is not for a long answer: a scan
   * reads dozens of entries at once, and on a reasoning model the working is
   * charged to the same budget as the reply. At 4096 a sixty-entry scan came
   * back empty because the model was still thinking when it ran out.
   */
  signs: 16384,
  chat: 4096,
};

const TEMPERATURE: Record<ChatRole, number> = {
  extraction: 0.1,
  lucidity: 0.5,
  symbolic: 0.6,
  report: 0.4,
  ocr: 0,
  split: 0.1,
  // A dream-sign scan is a clustering job over an archive, not a creative one.
  signs: 0.2,
  chat: 0.4,
};

/**
 * Whether a role's model may think before it answers.
 *
 * Only the roles where reasoning is pure cost are listed; the rest are left at
 * the model's own default, because working out what an entry means is exactly
 * what they are for. Transcribing a page is not one of those: the answer is on
 * the page, and on a local vision model at three tokens a second a few hundred
 * tokens of deliberation is minutes of a hot GPU spent before the first word of
 * the transcript, which is how a page ends up timing out mid-sentence. Splitting
 * a log is the same shape of job -- find the seams in text that is already
 * written -- against a tighter budget still.
 */
const THINKING: Partial<Record<ChatRole, boolean>> = {
  ocr: false,
  split: false,
};

/**
 * How long each role's answer may take in total.
 *
 * A ceiling on a stream that is making progress, not a stopwatch on the model:
 * one that has actually stopped is caught by `JOB_IDLE_TIMEOUT_MS` in minutes,
 * whatever its role is allowed here. The roles absent from this list are the
 * per-entry insights, whose prompt is one dream.
 */
const TIMEOUTS: Partial<Record<ChatRole, number>> = {
  signs: SCAN_TIMEOUT_MS,
  ocr: OCR_TIMEOUT_MS,
  report: REPORT_TIMEOUT_MS,
  split: SPLIT_TIMEOUT_MS,
};

/**
 * What a call may spend, when the role's own ceiling is the wrong shape for it.
 *
 * `MAX_TOKENS` and `TIMEOUTS` assume a role costs about the same every time.
 * Splitting a *stack* of photographed pages writes the joined log out again
 * inside JSON, so both halves scale with how many pages were copied. The
 * caller that knows the page count passes the budget rather than this module
 * guessing at it from the message array.
 */
export interface ChatBudget {
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * The finished answer for one role.
 *
 * Streamed underneath even though the caller wants the whole thing, which is
 * not a detail: a buffered request cannot distinguish a model that is working
 * from a host that has gone away, so the only budget it can be held to is a
 * total one — and a total budget on a local model reading a whole period is a
 * working answer thrown away and asked for again. Reading it as a stream buys
 * two things a queued job could not have otherwise: it is bounded on silence
 * rather than on length, and it can say how far along it is while it runs.
 *
 * The pieces are collapsed here rather than by each caller. Everything but the
 * chat screen wants one answer to file, and the assembly is identical for all
 * of them.
 */
export async function completeRole(
  config: AiConfig,
  role: ChatRole,
  messages: ChatMessage[],
  options: CallOptions = {},
): Promise<{ response: ChatResponse; destination: Destination }> {
  const call = resolveCall(config, role, options.assignment ?? null);
  const totalMs = options.budget?.timeoutMs ?? TIMEOUTS[role] ?? CHAT_TIMEOUT_MS;
  const events = providerChatStream(
    call.provider,
    request(call, role, messages, options),
    globalThis.fetch,
    jobStreamBudget(totalMs),
  );

  return { response: await collect(events), destination: call.destination };
}

/**
 * One answer out of the pieces it arrived in.
 *
 * The running totals are reported as they grow and then discarded. `thinking`
 * is never accumulated at all — only measured — because it is not part of the
 * answer, is worth nothing once the answer exists, and is derived from the
 * journal.
 */
async function collect(events: AsyncGenerator<ChatStreamEvent>): Promise<ChatResponse> {
  let text = "";
  let thought = 0;
  let toolCalls: ToolCall[] | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  for await (const event of events) {
    if (event.type === "text") {
      text += event.delta;
      reportProgress({ phase: "writing", characters: text.length });
    } else if (event.type === "thinking") {
      thought += event.delta.length;
      reportProgress({ phase: "thinking", characters: thought });
    } else if (event.type === "tool_calls") {
      toolCalls = event.calls;
    } else {
      inputTokens = event.inputTokens;
      outputTokens = event.outputTokens;
    }
  }

  return { text, toolCalls, inputTokens, outputTokens };
}

/**
 * The same call, streamed.
 *
 * Not `async`, deliberately: the destination is known from the config alone,
 * and the screen has to be able to name it *before* the first token — the same
 * rule the badge follows everywhere else. Awaiting a promise for it would put
 * the destination and the first piece of the answer on screen together.
 *
 * `assignment` overrides the role's stored model for this one call, which is
 * what the model picker on the chat screen sends. It is resolved through the
 * same code as the stored one, so an unknown or disabled provider is refused
 * here rather than reaching an adapter.
 */
export function streamRole(
  config: AiConfig,
  role: ChatRole,
  messages: ChatMessage[],
  options: {
    tools?: ChatTool[];
    budget?: ChatBudget;
    assignment?: RoleAssignment | null;
    signal?: AbortSignal;
  } = {},
): { destination: Destination; events: AsyncGenerator<ChatStreamEvent> } {
  const call = resolveCall(config, role, options.assignment ?? null);
  return {
    destination: call.destination,
    events: providerChatStream(
      call.provider,
      request(call, role, messages, options),
      globalThis.fetch,
      chatStreamBudget(options.signal),
    ),
  };
}

interface ResolvedCall {
  provider: ProviderConfig;
  assignment: RoleAssignment;
  destination: Destination;
}

function resolveCall(
  config: AiConfig,
  role: ChatRole,
  override: RoleAssignment | null,
): ResolvedCall {
  const assignment = override ?? resolveRoles(config)[role];
  const destination = destinationForAssignment(config, role, assignment);
  const provider = config.providers.find((candidate) => candidate.id === assignment?.providerId);
  if (!destination.configured || !provider || !assignment) throw new RoleNotConfiguredError(role);
  return { provider, assignment, destination };
}

interface CallOptions {
  json?: boolean;
  jsonSchema?: Record<string, unknown>;
  images?: ChatImage[];
  budget?: ChatBudget;
  tools?: ChatTool[];
  /** Overrides the role's stored model for this one call. */
  assignment?: RoleAssignment | null;
  /**
   * Overrides `THINKING` for one call.
   *
   * The role's entry is about what the role is *for*; this is about what a
   * particular call can afford. Naming a conversation is the case it exists
   * for: a two-dozen-token budget is spent before a reasoning model has
   * finished considering the question, and comes back empty.
   */
  think?: boolean;
}

function request(
  call: ResolvedCall,
  role: ChatRole,
  messages: ChatMessage[],
  options: CallOptions,
): ChatRequest {
  return {
    model: call.assignment.model,
    messages,
    maxTokens: options.budget?.maxTokens ?? MAX_TOKENS[role],
    temperature: TEMPERATURE[role],
    json: options.json,
    jsonSchema: options.jsonSchema,
    images: options.images,
    think: options.think ?? THINKING[role],
    tools: options.tools,
  };
}
