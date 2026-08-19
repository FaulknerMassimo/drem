"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { clientContext, recordAuthEvent } from "@/lib/auth/audit";
import { currentSession, type ActiveSession } from "@/lib/auth/session";
import { loadAiConfig } from "@/lib/ai/config";
import { RoleNotConfiguredError } from "@/lib/ai/chat";
import { gateDestination } from "@/lib/ai/gate";
import { enqueueEmbedDreams, enqueueSignScan } from "@/lib/ai/jobs";
import { ProviderError } from "@/lib/ai/providers/errors";
import { kickWorker } from "@/lib/ai/worker";
import { env } from "@/lib/env";
import { isIsoDate } from "@/lib/journal/dates";
import { assertCsrf } from "@/lib/security/csrf-server";
import { dreamsNeedingEmbedding } from "./embeddings";
import type { IndexFormState, SearchFormState, SignFormState } from "./form-state";
import { isSignCategory } from "./labels";
import { currentEmbeddingModel, semanticSearch } from "./search";
import { addManualSign, deleteSign, setSignActive } from "./signs";
import { MAX_SIGN_LABEL_LENGTH } from "./signs-parse";

/**
 * Search and dream-sign mutations.
 *
 * Same order as everywhere else: prove the request came from this app's own
 * UI, prove there is an unlocked session, then act. Two things are specific to
 * this module and deliberate.
 *
 * The search query is *not* put in the URL. Filters elsewhere are query strings
 * so a filtered view stays linkable, but a search phrase is content — it names
 * the thing being looked for — and a URL is the one part of a request that ends
 * up in browser history, referrers and proxy logs.
 *
 * And no action here ever echoes the query, a label, or an entry back in an
 * error message: those messages are shown on screen and, for jobs, persisted.
 */

/** Long enough for a sentence, short enough that nobody pastes a journal in. */
const MAX_QUERY_LENGTH = 500;
const MIN_QUERY_LENGTH = 2;

async function requireUnlockedSession(): Promise<ActiveSession> {
  const session = await currentSession();
  if (!session) redirect("/login");
  return session;
}

async function requestContext() {
  return clientContext(await headers(), {
    trustProxy: env().APP_ORIGIN.startsWith("https://"),
  });
}

function refresh(): void {
  revalidatePath("/", "layout");
}

/**
 * Turns a failed model call into one safe sentence.
 *
 * Provider errors already name only a host and a status, so they pass through;
 * anything else is flattened, because an unrecognised error may well have the
 * query or the entry inside it.
 */
function publicError(error: unknown, fallback: string): string {
  if (error instanceof RoleNotConfiguredError) return error.message;
  if (error instanceof ProviderError) return error.message;
  return fallback;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function searchAction(
  _previous: SearchFormState,
  formData: FormData,
): Promise<SearchFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const query = String(formData.get("q") ?? "").trim();
  if (query.length < MIN_QUERY_LENGTH) {
    return { error: "Type a few words to search for." };
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return { query: query.slice(0, MAX_QUERY_LENGTH), error: "That search is too long." };
  }

  const gated = await gateDestination(session, "embedding", formData);
  if (gated) return { query, ...gated };

  const config = await loadAiConfig(session.userId, session.keys);
  try {
    const result = await semanticSearch(session.userId, session.keys, config, query);
    await recordAuthEvent("ai_request", {
      userId: session.userId,
      detail: {
        kind: "search",
        provider: result.destination.providerKind,
        host: result.destination.host,
        leavesMachine: result.destination.leavesMachine,
        // A count, never the query and never which entries came back.
        hits: result.hits.length,
      },
      request: await requestContext(),
    });
    return { query, searched: true, hits: result.hits };
  } catch (error) {
    return { query, error: publicError(error, "The search could not be run.") };
  }
}

/**
 * Queues embeddings for every entry that has none, or whose entry has been
 * edited since it was last indexed.
 */
export async function indexJournalAction(
  _previous: IndexFormState,
  formData: FormData,
): Promise<IndexFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const gated = await gateDestination(session, "embedding", formData);
  if (gated) return gated;

  const config = await loadAiConfig(session.userId, session.keys);
  const model = currentEmbeddingModel(config);
  if (!model) return { error: "No embedding model is assigned. Choose one in Settings." };

  const outstanding = await dreamsNeedingEmbedding(session.userId, model);
  const queued = await enqueueEmbedDreams(session.userId, outstanding);
  if (queued > 0) kickWorker();

  refresh();
  return { queued };
}

// ---------------------------------------------------------------------------
// Dream signs
// ---------------------------------------------------------------------------

export async function scanSignsAction(
  _previous: SignFormState,
  formData: FormData,
): Promise<SignFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const periodStart = String(formData.get("periodStart") ?? "");
  const periodEnd = String(formData.get("periodEnd") ?? "");
  if (!isIsoDate(periodStart) || !isIsoDate(periodEnd)) {
    return { error: "Choose a start and end date." };
  }
  if (periodStart > periodEnd) {
    return { error: "The start of the period must be on or before the end." };
  }

  const gated = await gateDestination(session, "signs", formData);
  if (gated) return gated;

  await enqueueSignScan(session.userId, periodStart, periodEnd);
  kickWorker();
  refresh();
  return { queued: true };
}

export async function addSignAction(
  _previous: SignFormState,
  formData: FormData,
): Promise<SignFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const label = String(formData.get("label") ?? "")
    .trim()
    .replace(/\s+/gu, " ")
    .slice(0, MAX_SIGN_LABEL_LENGTH);
  if (!label) return { error: "Give the sign a label." };

  const category = String(formData.get("category") ?? "");
  if (!isSignCategory(category)) return { error: "Choose a category." };

  await addManualSign(session.userId, session.keys, label, category);
  refresh();
  return { added: true };
}

/**
 * Dismisses a sign, or brings a dismissed one back.
 *
 * Dismissing keeps the row: the label stays on file precisely so the next scan
 * does not propose it all over again.
 */
export async function setSignActiveAction(formData: FormData): Promise<void> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const signId = String(formData.get("signId") ?? "");
  const isActive = formData.get("isActive") === "1";
  if (signId) await setSignActive(session.userId, signId, isActive);

  refresh();
  redirect(String(formData.get("returnTo") || "/signs"));
}

export async function deleteSignAction(formData: FormData): Promise<void> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const signId = String(formData.get("signId") ?? "");
  if (signId) await deleteSign(session.userId, signId);

  refresh();
  redirect("/signs");
}
