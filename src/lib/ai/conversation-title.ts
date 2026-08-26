/**
 * Names a conversation from the exchange that started it.
 *
 * The first sixty characters of the question was a placeholder that read like
 * one: every thread in the list began "What do you make of the dream where I
 * was", and the sidebar became a column of openings rather than of subjects.
 *
 * The model that just answered writes it, on the destination that was already
 * named and acknowledged for that turn — this is a second request to the same
 * host carrying a slice of what it has just seen, and never a new destination.
 * It is deliberately cheap: two dozen tokens, reasoning off, a short ceiling,
 * and a failure that costs nothing because the fallback title is already
 * saved.
 */
import "server-only";
import { completeRole } from "./chat";
import type { AiConfig, Destination, RoleAssignment } from "./types";

/** Enough of the exchange to name it; not enough to be a second prompt. */
const MAX_QUESTION_CHARS = 500;
const MAX_ANSWER_CHARS = 1_000;

const MAX_TITLE_CHARS = 72;
const TITLE_TIMEOUT_MS = 30_000;
const TITLE_MAX_TOKENS = 32;

const SYSTEM_PROMPT = `You name conversations. You are given the opening exchange of a private dream-journal conversation, and you reply with a title for it and nothing else.

- Six words at most.
- Name the subject, not the asking: "Recurring flooded corridors", not "A question about a dream".
- Use the words of the exchange. Do not invent detail that is not in it.
- No quotation marks, no full stop, no "Title:" prefix, no explanation.`;

export async function proposeConversationTitle(
  config: AiConfig,
  assignment: RoleAssignment | null,
  exchange: { question: string; answer: string },
): Promise<{ title: string; destination: Destination } | null> {
  const { response, destination } = await completeRole(
    config,
    "chat",
    [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          "Question:",
          exchange.question.slice(0, MAX_QUESTION_CHARS),
          "",
          "Answer:",
          exchange.answer.slice(0, MAX_ANSWER_CHARS),
        ].join("\n"),
      },
    ],
    {
      assignment,
      think: false,
      budget: { maxTokens: TITLE_MAX_TOKENS, timeoutMs: TITLE_TIMEOUT_MS },
    },
  );

  const title = cleanTitle(response.text);
  return title ? { title, destination } : null;
}

/**
 * What is usable of a model's reply, or nothing.
 *
 * Models answer this instruction in three shapes: the title alone, the title
 * after a line of preamble, and a whole sentence that ignored the brief. The
 * first two are recoverable; the third is not — and a trimmed sentence is
 * exactly the kind of title this exists to replace, so it is refused rather
 * than cut down, and the fallback stands.
 */
export function cleanTitle(raw: string): string | null {
  const lines = raw
    // Some models put their working in `content` rather than on a channel of
    // its own, and it is never part of the title.
    .replace(/<think>[\s\S]*?<\/think>/giu, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const last = lines.at(-1);
  if (!last) return null;

  const title = last
    .replace(/^(?:title|suggested title)\s*[:\-—]\s*/iu, "")
    .replace(/^[*_"'“”‘’`]+|[*_"'“”‘’`]+$/gu, "")
    .replace(/[.!,;:]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();

  if (!title || title.length > MAX_TITLE_CHARS) return null;
  return title;
}
