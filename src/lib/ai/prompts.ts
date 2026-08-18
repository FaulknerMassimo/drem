/**
 * Versioned prompts for the four insight kinds.
 *
 * `promptVersion` is stored with every insight so a later rewrite can
 * regenerate cleanly instead of silently mixing two prompts' output. Changing
 * the *text* of a prompt requires bumping the version; changing it in place
 * would make existing rows lie about how they were produced.
 */
import type { InsightRole } from "./types";

export const PROMPT_VERSIONS: Record<InsightRole, string> = {
  extraction: "extraction.v1",
  lucidity: "lucidity.v1",
  symbolic: "symbolic.v1",
  report: "report.v1",
};

export const MAX_INSIGHT_CHARS = 50_000;
export const MAX_PROMPT_BODY_CHARS = 8_000;
export const MAX_REPORT_DREAMS = 40;

export interface DreamPromptInput {
  date: string;
  title: string | null;
  body: string;
  isLucid: boolean;
  lucidity: number;
  vividness: number | null;
  tags: string[];
  extraction?: string | null;
}

const EXTRACTION_SCHEMA = `{
  "summary": "one or two sentences, literal",
  "people": ["..."],
  "places": ["..."],
  "objects": ["..."],
  "actions": ["..."],
  "emotions": ["..."],
  "anomalies": ["impossible or inconsistent details — the lucidity cues"],
  "themes": ["..."],
  "dreamSigns": ["short labels for recurring cues worth noticing next time"]
}`;

function clip(text: string, max = MAX_PROMPT_BODY_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[clipped]`;
}

function metadata(dream: DreamPromptInput): string {
  const lines = [
    `Date: ${dream.date}`,
    `Title: ${dream.title ?? "(untitled)"}`,
    `Lucidity: ${dream.lucidity}/5${dream.isLucid ? " (lucid)" : ""}`,
  ];
  if (dream.vividness !== null) lines.push(`Vividness: ${dream.vividness}/5`);
  if (dream.tags.length > 0) lines.push(`Tags: ${dream.tags.join(", ")}`);
  return lines.join("\n");
}

function dreamBlock(dream: DreamPromptInput): string {
  return `${metadata(dream)}\n\n${clip(dream.body)}`;
}

export function extractionMessages(dream: DreamPromptInput) {
  return {
    system:
      "You extract structured facts from a single dream-journal entry. Be literal and complete. Do not interpret, advise, diagnose, or moralise. Do not invent details that are not in the entry. Reply with a JSON object matching the schema and nothing else.",
    user: `Schema:\n${EXTRACTION_SCHEMA}\n\nEntry:\n${dreamBlock(dream)}`,
  };
}

export function lucidityMessages(dream: DreamPromptInput) {
  const extraction = dream.extraction
    ? `\n\nStructured extraction:\n${clip(dream.extraction, 4_000)}`
    : "";
  return {
    system:
      "You are a lucid-dreaming coach reading one journal entry. Give concrete, specific feedback: missed dream signs, reality-check opportunities, and what might have helped the dreamer become (or stay) lucid. Ground every suggestion in something that actually appeared. Short paragraphs, no preamble, no diagnosis of the dreamer's waking life.",
    user: `${dreamBlock(dream)}${extraction}`,
  };
}

export function symbolicMessages(dream: DreamPromptInput) {
  const extraction = dream.extraction
    ? `\n\nStructured extraction:\n${clip(dream.extraction, 4_000)}`
    : "";
  return {
    system:
      "You offer a symbolic and psychological reading of one dream. Tentative, not diagnostic — never claim to know the dreamer's history, relationships, or health. Ground every observation in something that actually appeared in the entry. Short paragraphs, no preamble.",
    user: `${dreamBlock(dream)}${extraction}`,
  };
}

export function reportMessages(
  periodStart: string,
  periodEnd: string,
  dreams: DreamPromptInput[],
  capped: boolean,
) {
  const blocks = dreams.map((dream, index) => {
    const extraction = dream.extraction ? `\nExtraction: ${clip(dream.extraction, 1_200)}` : "";
    return `--- Dream ${index + 1} ---\n${metadata(dream)}\n${clip(dream.body, 1_500)}${extraction}`;
  });
  const capNote = capped
    ? `\n\nThe archive is larger than this; only the most recent ${dreams.length} entries in the window were included.`
    : "";

  return {
    system:
      "You write a period review of a dream journal, for someone practising lucid dreaming. Cover recurring people, places and anomalies (the dream signs), lucidity patterns, themes, and one or two concrete practice suggestions. Ground everything in the supplied entries. Do not invent entries, and do not diagnose the dreamer's waking life.",
    user: `Period: ${periodStart} to ${periodEnd}\nEntries: ${dreams.length}${capNote}\n\n${blocks.join("\n\n")}`,
  };
}

export function messagesFor(
  role: Exclude<InsightRole, "report">,
  dream: DreamPromptInput,
): { system: string; user: string } {
  if (role === "extraction") return extractionMessages(dream);
  if (role === "lucidity") return lucidityMessages(dream);
  return symbolicMessages(dream);
}
