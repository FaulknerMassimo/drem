/**
 * Human labels for insight kinds and provider kinds.
 *
 * Duplicated from the schema enums on purpose, the same way `journal/labels.ts`
 * is, so client components do not pull Drizzle into the browser bundle.
 */
import {
  CAPTURE_ROLES,
  CONVERSATION_ROLES,
  INSIGHT_ROLES,
  PROVIDER_KINDS,
  SEMANTIC_ROLES,
  type CaptureRole,
  type ConversationRole,
  type InsightRole,
  type ModelRole,
  type ProviderKind,
  type SemanticRole,
} from "./types";

export const INSIGHT_KIND_LABELS: Record<InsightRole, string> = {
  extraction: "Extraction",
  lucidity: "Lucidity coach",
  symbolic: "Symbolic reading",
  report: "Period report",
};

export const INSIGHT_KIND_HINTS: Record<InsightRole, string> = {
  extraction:
    "A literal inventory of people, places, objects and anomalies. Substrate for the other insights.",
  lucidity:
    "Concrete feedback on missed dream signs and what might have made this dream lucid.",
  symbolic: "A tentative psychological reading, grounded in what actually appeared.",
  report: "A cross-dream review of a stretch of nights: signs, themes, practice.",
};

export const CAPTURE_ROLE_LABELS: Record<CaptureRole, string> = {
  ocr: "Page reading",
  split: "Split a log",
};

export const CAPTURE_ROLE_HINTS: Record<CaptureRole, string> = {
  ocr: "Copies one photographed handwritten page. Assign a vision-capable model (llama3.2-vision, gpt-4o, Claude, …).",
  split:
    "Carves a joined night — photographed pages or a voice memo — into separate dreams. Text only — any model will do.",
};

export const SEMANTIC_ROLE_LABELS: Record<SemanticRole, string> = {
  embedding: "Embedding",
  signs: "Dream-sign scan",
};

export const SEMANTIC_ROLE_HINTS: Record<SemanticRole, string> = {
  embedding:
    "Turns entries into vectors so search can work by meaning. Assign an embedding model (embeddinggemma, nomic-embed-text, text-embedding-3-small, …), not a chat one.",
  signs:
    "Reads across the archive for cues that keep recurring. Text only — the same model you use for reports will do.",
};

export const CONVERSATION_ROLE_LABELS: Record<ConversationRole, string> = {
  chat: "Journal chat",
};

export const CONVERSATION_ROLE_HINTS: Record<ConversationRole, string> = {
  chat: "Talk with a model that can inspect dreams, nights, signs, reports and statistics through read-only tools. The chat screen can change this without coming back here.",
};

export const MODEL_ROLE_LABELS: Record<ModelRole, string> = {
  ...INSIGHT_KIND_LABELS,
  ...CAPTURE_ROLE_LABELS,
  ...SEMANTIC_ROLE_LABELS,
  ...CONVERSATION_ROLE_LABELS,
};

export const MODEL_ROLE_HINTS: Record<ModelRole, string> = {
  ...INSIGHT_KIND_HINTS,
  ...CAPTURE_ROLE_HINTS,
  ...SEMANTIC_ROLE_HINTS,
  ...CONVERSATION_ROLE_HINTS,
};

/**
 * What each journal tool is doing, for the row that appears while it runs.
 *
 * The tool names are the model's interface, not the reader's: "read_dreams"
 * under a spinner reads like a debug log. Anything not listed falls back to its
 * own name with the underscores taken out, so a tool added later degrades to
 * something legible rather than to nothing.
 */
export const CHAT_TOOL_LABELS: Record<string, { busy: string; done: string }> = {
  get_journal_overview: { busy: "Counting the journal", done: "Read the journal totals" },
  list_dreams: { busy: "Listing dreams", done: "Listed dreams" },
  read_dreams: { busy: "Reading dreams", done: "Read dreams" },
  search_dream_text: { busy: "Searching entries", done: "Searched entries" },
  list_nights: { busy: "Listing nights", done: "Listed nights" },
  read_night: { busy: "Reading a night", done: "Read a night" },
  list_dream_signs: { busy: "Listing dream signs", done: "Listed dream signs" },
  read_dream_sign: { busy: "Reading a dream sign", done: "Read a dream sign" },
  list_tags: { busy: "Listing tags", done: "Listed tags" },
  get_statistics: { busy: "Working out statistics", done: "Read statistics" },
  get_activity: { busy: "Reading activity", done: "Read activity" },
  list_reports: { busy: "Reading reports", done: "Read reports" },
  read_dream_insights: { busy: "Reading saved insights", done: "Read saved insights" },
};

export function chatToolLabel(name: string, done: boolean): string {
  const known = CHAT_TOOL_LABELS[name];
  if (known) return done ? known.done : known.busy;
  return name.replace(/_/gu, " ");
}

export const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
  ollama: "Ollama",
  openai: "OpenAI-compatible",
  anthropic: "Anthropic",
};

export const PROVIDER_KIND_HINTS: Record<ProviderKind, string> = {
  ollama: "Local models. The dream stays on this machine.",
  openai: "OpenAI, OpenRouter, LM Studio, or anything that speaks the Chat Completions API.",
  anthropic: "Claude, via Anthropic's Messages API.",
};

/** Compile-time: these lists are the ones `types.ts` and the UI both use. */
const roles: readonly InsightRole[] = INSIGHT_ROLES;
const capture: readonly CaptureRole[] = CAPTURE_ROLES;
const semantic: readonly SemanticRole[] = SEMANTIC_ROLES;
const conversation: readonly ConversationRole[] = CONVERSATION_ROLES;
const kinds: readonly ProviderKind[] = PROVIDER_KINDS;
void roles;
void capture;
void semantic;
void conversation;
void kinds;
