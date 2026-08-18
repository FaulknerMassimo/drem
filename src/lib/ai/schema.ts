/**
 * Validation for the encrypted AI config blob.
 *
 * The blob is one JSON document covering every provider, every role assignment
 * and every API key. Encrypting it as a whole means a stolen dump yields
 * neither the endpoints nor the credentials, and adding a field later does not
 * need a new column.
 */
import { z } from "zod";
import {
  INSIGHT_ROLES,
  PROVIDER_KINDS,
  type AiConfig,
  type InsightRole,
  type ProviderConfig,
  type PublicAiConfig,
  type RoleMap,
} from "./types";

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_OPENAI_URL = "https://api.openai.com/v1";
export const DEFAULT_ANTHROPIC_URL = "https://api.anthropic.com";

const providerSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(PROVIDER_KINDS),
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().trim().max(500),
  apiKey: z.string().max(500).optional(),
  enabled: z.boolean(),
});

const assignmentSchema = z
  .object({
    providerId: z.string().min(1).max(64),
    model: z.string().trim().min(1).max(200),
  })
  .nullable();

export const aiConfigSchema = z.object({
  providers: z.array(providerSchema).max(8),
  roles: z.object({
    extraction: assignmentSchema,
    lucidity: assignmentSchema,
    symbolic: assignmentSchema,
    report: assignmentSchema,
  }),
});

export function emptyRoles(): RoleMap {
  return {
    extraction: null,
    lucidity: null,
    symbolic: null,
    report: null,
  };
}

export function defaultAiConfig(ollamaBaseUrl = DEFAULT_OLLAMA_URL): AiConfig {
  return {
    providers: [
      {
        id: "ollama",
        kind: "ollama",
        name: "Ollama",
        baseUrl: ollamaBaseUrl,
        enabled: true,
      },
    ],
    roles: emptyRoles(),
  };
}

export function defaultUrlFor(kind: ProviderConfig["kind"]): string {
  if (kind === "ollama") return DEFAULT_OLLAMA_URL;
  if (kind === "openai") return DEFAULT_OPENAI_URL;
  return DEFAULT_ANTHROPIC_URL;
}

/**
 * Fills in a missing base URL so adapters never have to guess, and drops
 * blank API keys so "not set" stays distinct from "set to a space".
 */
export function parseAiConfig(value: unknown): AiConfig {
  const parsed = aiConfigSchema.parse(value);
  return {
    providers: parsed.providers.map((provider) => ({
      ...provider,
      baseUrl: provider.baseUrl || defaultUrlFor(provider.kind),
      apiKey: provider.apiKey?.trim() ? provider.apiKey.trim() : undefined,
    })),
    roles: parsed.roles,
  };
}

/**
 * A newly typed key replaces a stored one; an empty field keeps it.
 *
 * The settings form never re-displays a stored key, so submitting the form
 * without touching the field must not wipe the credential.
 */
export function mergeProviderSecrets(incoming: AiConfig, stored: AiConfig | null): AiConfig {
  return {
    ...incoming,
    providers: incoming.providers.map((provider) => {
      if (provider.apiKey) return provider;
      const previous = stored?.providers.find((candidate) => candidate.id === provider.id);
      return { ...provider, apiKey: previous?.apiKey };
    }),
    roles: incoming.roles,
  };
}

/**
 * Drops a role assignment that points at a provider that is gone or disabled,
 * so the destination badge and the worker agree that the role is unconfigured.
 */
export function resolveRoles(config: AiConfig): RoleMap {
  const usable = new Set(
    config.providers.filter((provider) => provider.enabled).map((provider) => provider.id),
  );
  const roles = { ...config.roles };
  for (const role of INSIGHT_ROLES) {
    const assignment = roles[role];
    if (assignment && !usable.has(assignment.providerId)) {
      roles[role] = null;
    }
  }
  return roles;
}

export function publicAiConfig(config: AiConfig): PublicAiConfig {
  return {
    providers: config.providers.map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      name: provider.name,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
      hasApiKey: Boolean(provider.apiKey),
    })),
    roles: config.roles,
  };
}

export function isInsightRole(value: string): value is InsightRole {
  return (INSIGHT_ROLES as readonly string[]).includes(value);
}
