/**
 * Load and save the encrypted AI config.
 *
 * The whole document is one ciphertext on `settings.ai_config_enc`. API keys
 * live inside it; they never have a column of their own.
 */
import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { decryptStringOptional, encrypt } from "@/lib/crypto/aead";
import type { UserKeys } from "@/lib/crypto/envelope";
import { env } from "@/lib/env";
import { destinationsFor } from "./destination";
import {
  defaultAiConfig,
  mergeProviderSecrets,
  parseAiConfig,
  publicAiConfig,
} from "./schema";
import type { AiConfig, PublicAiConfig } from "./types";

function configAad(userId: string) {
  return { table: "settings", column: "ai_config_enc", id: userId };
}

export async function loadAiConfig(userId: string, keys: UserKeys): Promise<AiConfig> {
  const [row] = await db
    .select({ aiConfigEnc: settings.aiConfigEnc })
    .from(settings)
    .where(eq(settings.userId, userId))
    .limit(1);

  const plaintext = decryptStringOptional(
    keys.field,
    row?.aiConfigEnc,
    configAad(userId),
  );
  if (!plaintext) return defaultAiConfig(env().OLLAMA_BASE_URL);

  try {
    return parseAiConfig(JSON.parse(plaintext));
  } catch {
    // A corrupt blob must not take the journal down with it. The user can
    // re-save settings; existing insights are unaffected.
    return defaultAiConfig(env().OLLAMA_BASE_URL);
  }
}

export async function saveAiConfig(
  userId: string,
  keys: UserKeys,
  incoming: AiConfig,
): Promise<AiConfig> {
  const stored = await loadAiConfig(userId, keys);
  const merged = mergeProviderSecrets(incoming, stored);
  const ciphertext = encrypt(keys.field, JSON.stringify(merged), configAad(userId));

  await db
    .insert(settings)
    .values({ userId, aiConfigEnc: ciphertext, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.userId,
      set: { aiConfigEnc: ciphertext, updatedAt: new Date() },
    });

  return merged;
}

export async function loadPublicAiConfig(
  userId: string,
  keys: UserKeys,
): Promise<PublicAiConfig> {
  return publicAiConfig(await loadAiConfig(userId, keys));
}

export async function loadDestinations(userId: string, keys: UserKeys) {
  return destinationsFor(await loadAiConfig(userId, keys));
}
