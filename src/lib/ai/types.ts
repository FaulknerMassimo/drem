/**
 * Shared AI types.
 *
 * Kept free of `server-only` and of the database schema so client components
 * can render a destination badge without pulling Drizzle — or the decrypted
 * config — into the browser bundle.
 */

export const PROVIDER_KINDS = ["ollama", "openai", "anthropic"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const INSIGHT_ROLES = [
  "extraction",
  "lucidity",
  "symbolic",
  "report",
] as const;
export type InsightRole = (typeof INSIGHT_ROLES)[number];
export type DreamInsightKind = Exclude<InsightRole, "report">;

/**
 * Capture roles sit next to insights in the same config blob so the
 * destination badge, the settings page and the worker share one assignment
 * map. They are not insight kinds: OCR reads a photograph, split carves a
 * log into separate entries.
 */
export const CAPTURE_ROLES = ["ocr", "split"] as const;
export type CaptureRole = (typeof CAPTURE_ROLES)[number];

/**
 * The semantic layer's two roles. `embedding` is not a chat model — it calls a
 * different endpoint and returns vectors — but it lives in the same assignment
 * map because it is still a destination a dream gets sent to, and the badge
 * that says so must work for it exactly as it does for the rest.
 */
export const SEMANTIC_ROLES = ["embedding", "signs"] as const;
export type SemanticRole = (typeof SEMANTIC_ROLES)[number];

export const MODEL_ROLES = [
  ...INSIGHT_ROLES,
  ...CAPTURE_ROLES,
  ...SEMANTIC_ROLES,
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** Every role but `embedding`, which has no prompt and no completion. */
export type ChatRole = Exclude<ModelRole, "embedding">;

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  name: string;
  /** Origin the adapter will call. Empty means the kind's built-in default. */
  baseUrl: string;
  /** Present only in the decrypted server copy; never sent to the client. */
  apiKey?: string;
  enabled: boolean;
}

export interface RoleAssignment {
  providerId: string;
  model: string;
}

export type RoleMap = Record<ModelRole, RoleAssignment | null>;

export interface AiConfig {
  providers: ProviderConfig[];
  roles: RoleMap;
}

/**
 * What the settings page is allowed to see: the same shape, minus secrets.
 * `hasApiKey` tells the form a key is stored without revealing it.
 */
export interface PublicProvider extends Omit<ProviderConfig, "apiKey"> {
  hasApiKey: boolean;
}

export interface PublicAiConfig {
  providers: PublicProvider[];
  roles: RoleMap;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** A photographed page, attached to a chat request. Never logged. */
export interface ChatImage {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  bytes: Buffer;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** Upper bound on the completion. Adapters map this onto each vendor's name. */
  maxTokens: number;
  temperature: number;
  /** Ask the model for a JSON object. Extraction uses this; the rest do not. */
  json?: boolean;
  /**
   * A JSON Schema the reply has to match, for adapters that can hold a model
   * to one. `json` on its own buys a valid object and nothing more: the keys
   * inside it are still the model's choice, and a reply that renames them
   * parses cleanly into nothing. Roles whose output is read field-by-field
   * send the schema; roles that read the whole reply do not need it.
   */
  jsonSchema?: Record<string, unknown>;
  /** Attached to the last user message. OCR is the only caller today. */
  images?: ChatImage[];
  /**
   * Whether the model may reason before answering, where it can choose.
   * Only adapters with a switch for it act on this; the rest ignore it.
   */
  think?: boolean;
}

export interface ChatResponse {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * A batch of texts to embed.
 *
 * Batched because a backfill embeds hundreds of entries, and one request per
 * dream turns a local index build into minutes of round-trips.
 */
export interface EmbedRequest {
  model: string;
  inputs: string[];
}

export interface EmbedResponse {
  /** One vector per input, in the order they were given. */
  vectors: number[][];
  inputTokens?: number;
}

export interface ConnectionTest {
  ok: boolean;
  message: string;
  models: string[];
}

/**
 * Where a request for one role will actually go.
 *
 * Computed on the server from the decrypted config and passed to the client as
 * this bag of strings — never the API key, never the dream.
 */
export interface Destination {
  role: ModelRole;
  configured: boolean;
  leavesMachine: boolean;
  providerId: string;
  providerName: string;
  providerKind: ProviderKind;
  model: string;
  host: string;
  /** One line, suitable for a badge. */
  label: string;
}
