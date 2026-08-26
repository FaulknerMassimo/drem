"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { currentSession, type ActiveSession } from "@/lib/auth/session";
import { assertCsrf } from "@/lib/security/csrf-server";
import { deleteConversation } from "./conversations";
import { loadAiConfig } from "./config";
import { providerTest } from "./providers";

const threadIdSchema = z.string().uuid();

async function requireUnlockedSession(): Promise<ActiveSession> {
  const session = await currentSession();
  if (!session) redirect("/login");
  return session;
}

export interface ProviderModelsState {
  error?: string;
  providerId?: string;
  models?: string[];
}

/**
 * Asks one provider what models it has.
 *
 * A button rather than something the chat screen does on arrival, because for
 * a remote provider this is a request to somebody else's server — the same
 * rule Settings follows. Nothing of the journal is in it: it lists models.
 */
export async function listProviderModelsAction(
  _previous: ProviderModelsState,
  formData: FormData,
): Promise<ProviderModelsState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();
  const providerId = String(formData.get("providerId") ?? "");

  const config = await loadAiConfig(session.userId, session.keys);
  const provider = config.providers.find((candidate) => candidate.id === providerId);
  if (!provider || !provider.enabled) return { error: "That provider is not available." };

  const result = await providerTest(provider);
  if (!result.ok) return { providerId, error: result.message };
  if (result.models.length === 0) {
    return { providerId, error: `${provider.name} listed no models.` };
  }
  return { providerId, models: result.models };
}

export async function deleteConversationAction(formData: FormData): Promise<void> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();
  const parsed = threadIdSchema.safeParse(String(formData.get("threadId") ?? ""));
  if (parsed.success) await deleteConversation(session.userId, parsed.data);
  revalidatePath("/chat", "layout");
  redirect("/chat");
}
