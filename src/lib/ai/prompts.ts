/**
 * Versioned prompts for the four insight kinds.
 *
 * `promptVersion` is stored with every insight so a later rewrite can
 * regenerate cleanly instead of silently mixing two prompts' output. Changing
 * the *text* of a prompt requires bumping the version; changing it in place
 * would make existing rows lie about how they were produced.
 */
import type { ChatRole, InsightRole } from "./types";

/** Journal chat owns a conversational system prompt, not a saved insight version. */
export const PROMPT_VERSIONS: Record<Exclude<ChatRole, "chat">, string> = {
  extraction: "extraction.v1",
  lucidity: "lucidity.v1",
  symbolic: "symbolic.v1",
  report: "report.v1",
  ocr: "ocr.v5",
  split: "split.v2",
  signs: "signs.v1",
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

/**
 * How many pages one reading job may carry.
 *
 * Not a storage limit -- `MAX_UPLOAD_BATCH` is twenty and stays there. This is
 * how many photographs one job will copy, one page at a time, before the
 * split pass carves the joined log. A longer night is photographed as more
 * than one stack, which costs a second review screen and nothing else.
 */
export const MAX_STACK_PAGES = 4;

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
 * The same shape again, as a grammar the model is held to.
 *
 * `OCR_SCHEMA` above only *asks*. Asking was not enough: a page the model
 * found hard came back as a well-formed object with none of these keys in it,
 * which parsed into a blank transcript and saved as a success, and the writer
 * got an empty form with nothing to explain it. Every key is required, so
 * "the model read nothing" and "the model answered its own way" stop looking
 * alike. The prose copy stays because a schema constrains the shape of an
 * answer and not its meaning -- the wording is what asks for the writer's own
 * words rather than a tidied paraphrase.
 */
const CONFIDENCE_SCHEMA = { type: "number", minimum: 0, maximum: 1 } as const;

export const OCR_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    date: { type: "string" },
    dateConfidence: CONFIDENCE_SCHEMA,
    title: { type: "string" },
    titleConfidence: CONFIDENCE_SCHEMA,
    body: { type: "string" },
    bodyConfidence: CONFIDENCE_SCHEMA,
    tags: { type: "array", items: { type: "string" } },
    tagsConfidence: CONFIDENCE_SCHEMA,
    // A page that states no rating must be able to say so; 0 is a rating.
    lucidity: { anyOf: [{ type: "integer", minimum: 0, maximum: 5 }, { type: "null" }] },
    lucidityConfidence: CONFIDENCE_SCHEMA,
  },
  required: [
    "date",
    "dateConfidence",
    "title",
    "titleConfidence",
    "body",
    "bodyConfidence",
    "tags",
    "tagsConfidence",
    "lucidity",
    "lucidityConfidence",
  ],
};

/**
 * OCR of one photographed journal page.
 *
 * One image, one copy of the handwriting, nothing else. Asking a vision model
 * to transcribe several pages *and* carve them into dreams in the same call
 * produced a paraphrase of the night instead of the words on the page — mixed
 * fragments, invented spellings, lost lines. Copying a single page is the
 * job the model can actually do; joining the copies and splitting the log
 * are text-only passes afterwards.
 *
 * The image is attached separately; this is only the instruction.
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
export function splitMessages(body: string, source: "log" | "pages" = "log") {
  const pageBreak =
    source === "pages"
      ? " A page break is not a new dream by itself — the writing often continues mid-sentence onto the next page."
      : "";
  return {
    system:
      `You split a dream-journal log into individual dream episodes. Keep the writer's words. Do not interpret, summarise, or add detail. A new dream usually starts at a scene change, a waking, or an explicit marker like 'Dream 2'.${pageBreak} If the log is one continuous dream, return a single item. Reply with a JSON object matching the schema and nothing else.`,
    user: `Schema:\n${SPLIT_SCHEMA}\n\nLog:\n${clip(body)}`,
  };
}

// ---------------------------------------------------------------------------
// Dream signs
// ---------------------------------------------------------------------------

/** How many entries one scan may carry. Beyond this the window is narrowed. */
export const MAX_SCAN_DREAMS = 60;

/** Per-entry budget inside a scan. Sixty full entries would not fit a context. */
export const MAX_SCAN_BODY_CHARS = 900;

const SIGNS_SCHEMA = `{
  "signs": [
    {
      "label": "two or three words, lower case",
      "category": "person | place | object | action | emotion | anomaly | theme",
      "entries": [1, 4, 9],
      "confidence": 0.0
    }
  ]
}`;

export interface ScanEntry {
  date: string;
  isLucid: boolean;
  /** The structured extraction if one exists, otherwise a clip of the entry. */
  summary: string;
}

/**
 * Finds the cues that repeat across an archive.
 *
 * The scan is deliberately given *numbered* entries and asked to return
 * indices, not quotes: the occurrence table needs to know which dreams a sign
 * appeared in, and asking for text back would mean matching prose against the
 * archive to find out.
 *
 * `known` carries the labels already on file — signs added by hand and signs
 * kept from earlier scans — so a recurring cue accumulates occurrences under
 * one label instead of forking into three spellings of the same thing.
 */
export function dreamSignMessages(
  entries: ScanEntry[],
  known: string[],
): { system: string; user: string } {
  const blocks = entries.map((entry, index) => {
    const lucid = entry.isLucid ? " [lucid]" : "";
    return `${index + 1}. (${entry.date})${lucid} ${clip(entry.summary, MAX_SCAN_BODY_CHARS)}`;
  });

  const knownBlock =
    known.length > 0
      ? `\n\nLabels already on file — reuse one verbatim when the cue is the same, rather than inventing a near-duplicate:\n${known.join("\n")}`
      : "";

  return {
    system:
      "You find dream signs in a dream journal: the people, places, objects, actions, emotions, anomalies and themes that recur across entries and could be recognised from inside a dream. Only report a cue that appears in at least two entries. Prefer specific cues over generic ones — 'teeth falling out' is a dream sign, 'a person' is not. Anomalies, meaning impossible or inconsistent details, are the most useful category. Do not invent cues that are not in the entries. Reply with a JSON object matching the schema and nothing else.",
    user: `Schema:\n${SIGNS_SCHEMA}\n\nEntry numbers in "entries" refer to the numbered list below.${knownBlock}\n\nEntries:\n${blocks.join("\n\n")}`,
  };
}
