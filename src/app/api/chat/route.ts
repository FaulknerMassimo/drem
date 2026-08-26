import { headers } from "next/headers";
import { z } from "zod";
import { MAX_CHAT_MESSAGE_CHARS, summariseToolArguments, type ChatWireEvent } from "@/lib/ai/chat-events";
import { loadAiConfig, saveAiConfig } from "@/lib/ai/config";
import { streamConversationAgent } from "@/lib/ai/conversation-agent";
import { getConversation, renameConversation, saveConversationExchange } from "@/lib/ai/conversations";
import { proposeConversationTitle } from "@/lib/ai/conversation-title";
import { destinationForAssignment } from "@/lib/ai/destination";
import { publicModelError } from "@/lib/ai/public-error";
import { resolveRoles } from "@/lib/ai/schema";
import type { AiConfig, RoleAssignment } from "@/lib/ai/types";
import { clientContext, recordAuthEvent, type RequestContext } from "@/lib/auth/audit";
import { currentSession } from "@/lib/auth/session";
import type { UserKeys } from "@/lib/crypto/envelope";
import { env } from "@/lib/env";
import { assertCsrfHeader } from "@/lib/security/csrf-server";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  threadId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(MAX_CHAT_MESSAGE_CHARS),
  /** The on-screen picker. Absent means "whatever the chat role is set to". */
  providerId: z.string().min(1).max(64).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  acknowledge: z.boolean().optional(),
});

/**
 * One turn of journal chat, streamed.
 *
 * A route handler rather than a Server Action because the answer has to appear
 * as it is written: an action can only resolve once, which is what made this
 * screen a blank page followed by a wall of text, and what put every
 * conversation under a single 120-second ceiling regardless of whether the
 * model was still working.
 *
 * The gate is the same one every other model call passes through — the role
 * must be assigned, and a destination that leaves this machine must have been
 * acknowledged on screen. It is re-checked here rather than trusted from the
 * client, because the client is exactly what a crafted POST would be imitating.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    await assertCsrfHeader(request);
  } catch {
    return refuse("This request could not be verified. Reload the page and try again.", 403);
  }

  const session = await currentSession();
  if (!session) return refuse("Your session is locked. Unlock to continue.", 401);

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return refuse("That message could not be read.", 400);
  const body = parsed.data;

  const config = await loadAiConfig(session.userId, session.keys);
  const stored = resolveRoles(config).chat;
  const picked: RoleAssignment | null =
    body.providerId && body.model
      ? { providerId: body.providerId, model: body.model }
      : null;
  const assignment = picked ?? stored;
  const destination = destinationForAssignment(config, "chat", assignment);

  if (!destination.configured) {
    return refuse("No model is assigned for chat. Pick one above, or in Settings.", 400);
  }
  if (destination.leavesMachine && body.acknowledge !== true) {
    return refuse(`Confirm that you want this to be sent to ${destination.host}.`, 400);
  }

  const existing = body.threadId
    ? await getConversation(session.userId, session.keys, body.threadId)
    : null;
  if (body.threadId && !existing) return refuse("That conversation no longer exists.", 404);

  const context = clientContext(await headers(), {
    trustProxy: env().APP_ORIGIN.startsWith("https://"),
  });

  /*
   * Choosing a model on the chat screen is choosing it, full stop.
   *
   * The alternative — a per-conversation override that Settings knows nothing
   * about — leaves two answers to "which model does chat use", and the badge
   * on every other screen would go on naming the stale one.
   */
  if (picked && (stored?.providerId !== picked.providerId || stored.model !== picked.model)) {
    await saveAiConfig(session.userId, session.keys, {
      ...config,
      roles: { ...config.roles, chat: picked },
    });
    await recordAuthEvent("settings_changed", {
      userId: session.userId,
      detail: { section: "ai", role: "chat" },
      request: context,
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (event: ChatWireEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // The reader has gone. The turn still finishes and is still saved.
          open = false;
        }
      };

      send({ type: "start", destination });

      try {
        const turn = streamConversationAgent(
          config,
          { userId: session.userId, keys: session.keys },
          existing?.messages.map(({ role, content }) => ({ role, content })) ?? [],
          body.message,
          { assignment, signal: request.signal },
        );

        let step = await turn.next();
        while (!step.done) {
          const event = step.value;
          if (event.type === "tool_start") {
            send({
              type: "tool_start",
              id: event.id,
              name: event.name,
              summary: summariseToolArguments(event.arguments),
            });
          } else {
            send(event);
          }
          step = await turn.next();
        }

        const answer = step.value;
        // A turn stopped before the model wrote anything is not a transcript:
        // saving an empty answer would leave a question with no reply under it.
        const threadId = answer.text
          ? await saveConversationExchange(session.userId, session.keys, existing?.id ?? null, {
              user: body.message,
              assistant: answer.text,
              provider: answer.destination.providerName,
              model: answer.destination.model,
              inputTokens: answer.inputTokens,
              outputTokens: answer.outputTokens,
            })
          : null;

        await recordAuthEvent("ai_request", {
          userId: session.userId,
          detail: {
            kind: "chat",
            provider: answer.destination.providerKind,
            host: answer.destination.host,
            leavesMachine: answer.destination.leavesMachine,
            toolCalls: answer.toolCalls,
            stopped: answer.stopped,
          },
          request: context,
        });

        send({
          type: "done",
          threadId,
          stopped: answer.stopped,
          provider: answer.destination.providerName,
          model: answer.destination.model,
          inputTokens: answer.inputTokens,
          outputTokens: answer.outputTokens,
        });

        /*
         * Naming the thread comes after the answer, and after `done`.
         *
         * It is a second request to the host that just answered, and the reader
         * is not waiting on it: the transcript is already on screen and the
         * composer is already free by the time it runs. A turn that was stopped
         * is not named at all — Stop means stop working, and it would be a poor
         * exchange to name anyway.
         */
        if (!existing && threadId && !answer.stopped) {
          await title(
            { userId: session.userId, keys: session.keys },
            config,
            assignment,
            { threadId, question: body.message, answer: answer.text },
            send,
            context,
          );
        }
      } catch (error) {
        send({
          type: "error",
          message: publicModelError(
            error,
            "The model could not answer. Your message was not saved; you can send it again.",
          ),
        });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by the reader going away.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // Nothing about a conversation may be stored by a cache: it is decrypted
      // journal material on its way to one browser.
      "Cache-Control": "private, no-store, no-transform",
      "X-Content-Type-Options": "nosniff",
      // Proxies that buffer a response defeat the point of streaming it.
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Names a new conversation, or leaves the fallback title standing.
 *
 * Every failure here is silent on purpose: the thread already has a title, the
 * answer is already saved, and nothing about a cosmetic label is worth putting
 * an error under a finished conversation.
 */
async function title(
  session: { userId: string; keys: UserKeys },
  config: AiConfig,
  assignment: RoleAssignment | null,
  exchange: { threadId: string; question: string; answer: string },
  send: (event: ChatWireEvent) => void,
  context: RequestContext,
): Promise<void> {
  try {
    const named = await proposeConversationTitle(config, assignment, exchange);
    if (!named) return;
    await renameConversation(session.userId, session.keys, exchange.threadId, named.title);
    await recordAuthEvent("ai_request", {
      userId: session.userId,
      detail: {
        kind: "chat_title",
        provider: named.destination.providerKind,
        host: named.destination.host,
        leavesMachine: named.destination.leavesMachine,
      },
      request: context,
    });
    send({ type: "title", threadId: exchange.threadId, title: named.title });
  } catch {
    // The model could not be reached, or answered with something unusable.
  }
}

function refuse(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}
