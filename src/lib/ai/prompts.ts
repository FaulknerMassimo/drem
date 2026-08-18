/**
 * Versioned prompts for the four insight kinds.
 *
 * `promptVersion` is stored with every insight so a later rewrite can
 * regenerate cleanly instead of silently mixing two prompts' output. Changing
 * the *text* of a prompt requires bumping the version; changing it in place
 * would make existing rows lie about how they were produced.
 */
import type { InsightRole, ModelRole } from "./types";

export const PROMPT_VERSIONS: Record<ModelRole, string> = {
  extraction: "extraction.v1",
  lucidity: "lucidity.v1",
  symbolic: "symbolic.v1",
  report: "report.v1",
  ocr: "ocr.v1",
  split: "split.v1",
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

const OCR_SCHEMA = `{
  "date": "YYYY-MM-DD or empty if none is written",
  "dateConfidence": 0.0,
  "title": "short title if the page has one, else empty",
  "titleConfidence": 0.0,
  "body": "the dream text, preserving the writer's words",
  "bodyConfidence": 0.0,
  "tags": ["short labels only if clearly written as tags"],
  "tagsConfidence": 0.0,
  "lucidity": null,
  "lucidityConfidence": 0.0
}`;

/**
 * OCR of a photographed journal page. The image is attached separately;
 * this is only the instruction. Confidence is the model's own, surfaced
 * in the review UI so low-certainty fields are obvious before anything is saved.
 */
export function ocrMessages() {
  return {
    system:
      "You transcribe a photographed handwritten dream-journal page. Be literal. Do not interpret, complete, or tidy the writing into something the page does not say. If a word is unreadable, use [illegible]. Reply with a JSON object matching the schema and nothing else. Confidence is 0–1 for each field.",
    user: `Schema:\n${OCR_SCHEMA}\n\nTranscribe the attached page.`,
  };
}

const SPLIT_SCHEMA = `{
  "dreams": [
    { "title": "short title or empty", "body": "the text of this one dream", "isFragment": false }
  ]
}`;

/**
 * Carves a single log that contains several dreams into separate entries.
 *
 * The writer often dumps a whole night into one field. Scene breaks, "then I
 * was somewhere else", or waking and falling back to sleep are the usual
 * seams. If it is clearly one continuous dream, return a single item — never
 * invent a split, and never invent text that was not in the log.
 */
export function splitMessages(body: string) {
  return {
    system:
      "You split a dream-journal log into individual dream episodes. Keep the writer's words. Do not interpret, summarise, or add detail. A new dream usually starts at a scene change, a waking, or an explicit marker like 'Dream 2'. If the log is one continuous dream, return a single item. Reply with a JSON object matching the schema and nothing else.",
    user: `Schema:\n${SPLIT_SCHEMA}\n\nLog:\n${clip(body)}`,
  };
}
