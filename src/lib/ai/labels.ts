/**
 * Human labels for insight kinds and provider kinds.
 *
 * Duplicated from the schema enums on purpose, the same way `journal/labels.ts`
 * is, so client components do not pull Drizzle into the browser bundle.
 */
import { CAPTURE_ROLES, INSIGHT_ROLES, PROVIDER_KINDS, type CaptureRole, type InsightRole, type ModelRole, type ProviderKind } from "./types";

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
  ocr: "Reads a photographed handwritten page. Assign a vision-capable model (llama3.2-vision, gpt-4o, Claude, …).",
  split: "Carves a log that contains several dreams into separate entries. Text only — any model will do.",
};

export const MODEL_ROLE_LABELS: Record<ModelRole, string> = {
  ...INSIGHT_KIND_LABELS,
  ...CAPTURE_ROLE_LABELS,
};

export const MODEL_ROLE_HINTS: Record<ModelRole, string> = {
  ...INSIGHT_KIND_HINTS,
  ...CAPTURE_ROLE_HINTS,
};

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
const kinds: readonly ProviderKind[] = PROVIDER_KINDS;
void roles;
void capture;
void kinds;
