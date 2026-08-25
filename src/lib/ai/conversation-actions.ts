"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { clientContext, recordAuthEvent } from "@/lib/auth/audit";
import { currentSession, type ActiveSession } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { assertCsrf } from "@/lib/security/csrf-server";
import { runConversationAgent } from "./conversation-agent";
import { deleteConversation, getConversation, saveConversationExchange } from "./conversations";
import { loadAiConfig } from "./config";
import { gateDestination } from "./gate";
import { publicModelError } from "./public-error";

const MAX_MESSAGE_LENGTH = 8_000;
const threadIdSchema = z.string().uuid();

export interface ConversationFormState {
  error?: string;
  sent?: boolean;
  threadId?: string;
}

async function requireUnlockedSession(): Promise<ActiveSession> {
  const session = await currentSession();
  if (!session) redirect("/login");
  return session;
}

export async function sendConversationMessageAction(
  _previous: ConversationFormState,
  formData: FormData,
): Promise<ConversationFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();
  const content = String(formData.get("message") ?? "").trim();
  if (!content) return { error: "Write a message first." };
  if (content.length > MAX_MESSAGE_LENGTH) {
    return { error: `Keep one message under ${MAX_MESSAGE_LENGTH.toLocaleString()} characters.` };
  }

  const rawThreadId = String(formData.get("threadId") ?? "");
  const threadId = rawThreadId ? threadIdSchema.safeParse(rawThreadId) : null;
  if (threadId && !threadId.success) return { error: "That conversation is not recognised." };

  const existing = threadId?.success
    ? await getConversation(session.userId, session.keys, threadId.data)
    : null;
  if (threadId?.success && !existing) return { error: "That conversation no longer exists." };

  const gated = await gateDestination(session, "chat", formData);
  if (gated) return gated;

  const config = await loadAiConfig(session.userId, session.keys);
  try {
    const answer = await runConversationAgent(
      config,
      { userId: session.userId, keys: session.keys },
      existing?.messages.map(({ role, content: message }) => ({ role, content: message })) ?? [],
      content,
    );
    const savedThreadId = await saveConversationExchange(
      session.userId,
      session.keys,
      existing?.id ?? null,
      {
        user: content,
        assistant: answer.text,
        provider: answer.destination.providerName,
        model: answer.destination.model,
        inputTokens: answer.inputTokens,
        outputTokens: answer.outputTokens,
      },
    );

    await recordAuthEvent("ai_request", {
      userId: session.userId,
      detail: {
        kind: "chat",
        provider: answer.destination.providerKind,
        host: answer.destination.host,
        leavesMachine: answer.destination.leavesMachine,
        toolCalls: answer.toolCalls,
      },
      request: clientContext(await headers(), {
        trustProxy: env().APP_ORIGIN.startsWith("https://"),
      }),
    });

    revalidatePath("/chat", "layout");
    return { sent: true, threadId: savedThreadId };
  } catch (error) {
    return {
      threadId: existing?.id,
      error: publicModelError(error, "The model could not answer. Your message was not saved; you can retry it."),
    };
  }
}

export async function deleteConversationAction(formData: FormData): Promise<void> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();
  const parsed = threadIdSchema.safeParse(String(formData.get("threadId") ?? ""));
  if (parsed.success) await deleteConversation(session.userId, parsed.data);
  revalidatePath("/chat", "layout");
  redirect("/chat");
}
