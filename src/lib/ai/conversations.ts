/** Encrypted persistence for the human-visible part of journal chats. */
import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { chatMessages, chatThreads } from "@/db/schema";
import { decryptString, decryptStringOptional, encrypt } from "@/lib/crypto/aead";
import type { UserKeys } from "@/lib/crypto/envelope";

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: Date;
}

export interface Conversation extends ConversationSummary {
  messages: ConversationMessage[];
}

function titleAad(id: string) {
  return { table: "chat_threads", column: "title_enc", id };
}

function contentAad(id: string) {
  return { table: "chat_messages", column: "content_enc", id };
}

function titleFrom(message: string): string {
  const oneLine = message.trim().replace(/\s+/gu, " ");
  return oneLine.length <= 64 ? oneLine : `${oneLine.slice(0, 61).trimEnd()}…`;
}

export async function listConversations(
  userId: string,
  keys: UserKeys,
  limit = 30,
): Promise<ConversationSummary[]> {
  const rows = await db
    .select()
    .from(chatThreads)
    .where(eq(chatThreads.userId, userId))
    .orderBy(desc(chatThreads.updatedAt))
    .limit(Math.max(1, Math.min(limit, 100)));

  return rows.map((row) => ({
    id: row.id,
    title: decryptStringOptional(keys.field, row.titleEnc, titleAad(row.id)) ?? "New conversation",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function getConversation(
  userId: string,
  keys: UserKeys,
  threadId: string,
): Promise<Conversation | null> {
  const [thread] = await db
    .select()
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .limit(1);
  if (!thread) return null;

  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, thread.id))
    .orderBy(asc(chatMessages.createdAt));

  return {
    id: thread.id,
    title: decryptStringOptional(keys.field, thread.titleEnc, titleAad(thread.id)) ?? "New conversation",
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messages: rows.flatMap((row) => {
      if (row.role !== "user" && row.role !== "assistant") return [];
      return [{
        id: row.id,
        role: row.role,
        content: decryptString(keys.field, row.contentEnc, contentAad(row.id)),
        provider: row.provider,
        model: row.model,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        createdAt: row.createdAt,
      }];
    }),
  };
}

/**
 * Saves a completed turn atomically.
 *
 * The user message is deliberately not inserted before the provider call: if
 * the model is unavailable, the form still holds the draft and retrying does
 * not duplicate a stranded prompt in the transcript.
 */
export async function saveConversationExchange(
  userId: string,
  keys: UserKeys,
  threadId: string | null,
  input: {
    user: string;
    assistant: string;
    provider: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
  },
): Promise<string> {
  const resolvedThreadId = threadId ?? randomUUID();
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const now = new Date();

  await db.transaction(async (tx) => {
    if (threadId) {
      const [owned] = await tx
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
        .limit(1);
      if (!owned) throw new Error("CHAT_NOT_FOUND");
    } else {
      const title = titleFrom(input.user);
      await tx.insert(chatThreads).values({
        id: resolvedThreadId,
        userId,
        titleEnc: encrypt(keys.field, title, titleAad(resolvedThreadId)),
        createdAt: now,
        updatedAt: now,
      });
    }

    await tx.insert(chatMessages).values([
      {
        id: userMessageId,
        threadId: resolvedThreadId,
        role: "user",
        contentEnc: encrypt(keys.field, input.user, contentAad(userMessageId)),
        createdAt: now,
      },
      {
        id: assistantMessageId,
        threadId: resolvedThreadId,
        role: "assistant",
        contentEnc: encrypt(keys.field, input.assistant, contentAad(assistantMessageId)),
        provider: input.provider,
        model: input.model,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        createdAt: new Date(now.getTime() + 1),
      },
    ]);

    if (threadId) {
      await tx
        .update(chatThreads)
        .set({ updatedAt: now })
        .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)));
    }
  });

  return resolvedThreadId;
}

export async function deleteConversation(userId: string, threadId: string): Promise<boolean> {
  const deleted = await db
    .delete(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .returning({ id: chatThreads.id });
  return deleted.length > 0;
}
