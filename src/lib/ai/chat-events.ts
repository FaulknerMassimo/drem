/**
 * The wire between the chat route and the chat screen.
 *
 * One `data:` line per event, each a JSON object with a `type` — the same shape
 * the model providers use, for the same reason: it survives being cut in half
 * by a network buffer, and a reader that does not recognise an event can skip
 * it rather than break.
 *
 * Kept free of `server-only` and of the database so the browser can import the
 * types, and free of anything derived from a dream: a `tool_start` carries a
 * short summary of what was asked for, never what came back.
 */
import type { Destination } from "./types";

export type ChatWireEvent =
  /** Sent before the first token, so the screen can name the destination. */
  | { type: "start"; destination: Destination }
  | { type: "thinking"; delta: string }
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; name: string; summary: string }
  | { type: "tool_end"; id: string; ok: boolean; ms: number }
  | {
      type: "done";
      /** Null when nothing was written, so nothing was saved. */
      threadId: string | null;
      stopped: boolean;
      provider: string;
      model: string;
      inputTokens?: number;
      outputTokens?: number;
    }
  /** A new conversation, named by the model a moment after its first answer. */
  | { type: "title"; threadId: string; title: string }
  | { type: "error"; message: string };

/** One message. Bounded here so the textarea and the route agree on it. */
export const MAX_CHAT_MESSAGE_CHARS = 8_000;

const MAX_SUMMARY_CHARS = 140;

/**
 * A tool call's arguments, in a line a person can read.
 *
 * The arguments are the model's, but they are shaped by the journal — a search
 * phrase is often lifted straight out of a dream — so this is bounded rather
 * than dumped. It is a label under a spinner, not a debug view.
 */
export function summariseToolArguments(args: unknown): string {
  if (args === null || typeof args !== "object") return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${key.replace(/_/gu, " ")}: ${describeValue(value)}`);
  }
  const summary = parts.join(" · ");
  return summary.length > MAX_SUMMARY_CHARS
    ? `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…`
    : summary;
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return `${value.length}`;
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/**
 * Reads the route's events back out of a response body.
 *
 * The browser has `EventSource`, and it is no use here: it can only issue GET
 * requests, and this one is a POST carrying the message. So the framing is
 * parsed by hand, which is short work: every event is one `data:` line, lines
 * are held until they are whole, and one that will not parse is skipped rather
 * than allowed to end an answer that is still arriving.
 */
export async function* readChatEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatWireEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });

    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      const event = parseChatEvent(line);
      if (event) yield event;
      newline = buffer.indexOf("\n");
    }
  }
}

function parseChatEvent(line: string): ChatWireEvent | null {
  if (!line.startsWith("data:")) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(5).trim());
    if (parsed && typeof parsed === "object" && typeof (parsed as ChatWireEvent).type === "string") {
      return parsed as ChatWireEvent;
    }
  } catch {
    // A line cut in half by a buffer boundary is not an error worth ending on.
  }
  return null;
}
