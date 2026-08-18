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

export const MODEL_ROLES = [...INSIGHT_ROLES, ...CAPTURE_ROLES] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

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
  /** Attached to the last user message. OCR is the only caller today. */
  images?: ChatImage[];
}

export interface ChatResponse {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
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
