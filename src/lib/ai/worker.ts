/**
 * In-process worker for queued insight jobs.
 *
 * Runs inside the Next process because that is where the unwrapped data key
 * lives. Jobs are identifiers; this module re-reads the dream, decrypts it,
 * calls the model, and writes the ciphertext back. A drain is kicked after
 * enqueue and on each app-layout render, so work proceeds while a session is
 * live and stalls cleanly when it is not.
 */
import "server-only";
import { recordAuthEvent } from "@/lib/auth/audit";
import type { UserKeys } from "@/lib/crypto/envelope";
import { getDream, dreamsInRange } from "@/lib/journal/dreams";
import { completeRole, RoleNotConfiguredError } from "./chat";
import { publicModelError } from "./public-error";
import { loadAiConfig } from "./config";
import {
  latestExtractionsForDreams,
  latestInsightForDream,
  saveInsight,
} from "./insights";
import { parseExtraction, serialiseExtraction } from "./json";
import {
  claimNextJob,
  completeJob,
  failJob,
  parseAttachmentPayload,
  parseDreamPayload,
  parseReportPayload,
  reclaimStuckJobs,
  skipJob,
  unclaimJob,
  type JobRecord,
} from "./jobs";
import { releaseJobKeys, resolveJobKeys } from "./keys";
import {
  MAX_INSIGHT_CHARS,
  MAX_REPORT_DREAMS,
  messagesFor,
  PROMPT_VERSIONS,
  reportMessages,
  type DreamPromptInput,
} from "./prompts";
import type { AiConfig, InsightRole } from "./types";
import {
  CaptureSkipError,
  publicCaptureError,
  runOcrJob,
  runTranscribeJob,
} from "@/lib/capture/process";
import { markStackStatus, stackKeyOf } from "@/lib/capture/attachments";
import {
  runEmbedJob,
  runSignScanJob,
  SemanticSkipError,
} from "@/lib/semantic/process";

type DrainResult = "done" | "empty" | "locked";

const globalForWorker = globalThis as unknown as { dremAiDraining?: boolean };

export function kickWorker(): void {
  if (globalForWorker.dremAiDraining) return;
  globalForWorker.dremAiDraining = true;
  void drain()
    .catch((error) => {
      console.error("[ai] worker drain failed: %s", error instanceof Error ? error.message : error);
    })
    .finally(() => {
      globalForWorker.dremAiDraining = false;
    });
}

/**
 * How long one drain may keep working.
 *
 * An embedding backfill queues one job per entry, so the old fixed budget of
 * twenty would have needed twenty page loads to index a year. A wall-clock
 * budget instead: it drains a whole archive in one pass against a local model,
 * and still hands the process back promptly when the model is slow or remote.
 */
const DRAIN_BUDGET_MS = 120_000;
const DRAIN_MAX_JOBS = 2_000;

async function drain(): Promise<void> {
  await reclaimStuckJobs();
  const deadline = Date.now() + DRAIN_BUDGET_MS;
  for (let i = 0; i < DRAIN_MAX_JOBS; i++) {
    const result = await processNextJob();
    if (result !== "done") break;
    if (Date.now() >= deadline) break;
  }
}

export async function processNextJob(): Promise<DrainResult> {
  const job = await claimNextJob();
  if (!job) return "empty";

  const resolved = await resolveJobKeys(job.userId);
  if (!resolved) {
    // There is nothing to decrypt with until a session appears (or background
    // processing is enabled). That is not a failure — leave the job pending.
    await unclaimJob(job.id, "Waiting for an unlocked session");
    return "locked";
  }

  try {
    await runJob(job, resolved.keys);
    await completeJob(job.id);
    return "done";
  } catch (error) {
    /*
     * The job is against a stack's lead page, and the whole stack has to move
     * with it: a follower left at `pending` after the reading gave up shows in
     * the inbox as a second thing still waiting, for a page that is already on
     * the review screen the writer is looking at.
     */
    const leadId = captureLeadId(job);
    const stackId = leadId ? await stackKeyOf(job.userId, leadId) : null;
    if (error instanceof SkipError || error instanceof RoleNotConfiguredError) {
      await skipJob(job.id, error.message);
      if (stackId) await markStackStatus(job.userId, stackId, "skipped");
      return "done";
    }
    await failJob(job.id, job.attempts, publicError(error, job.kind));
    if (stackId && job.attempts >= 3) {
      await markStackStatus(job.userId, stackId, "failed");
    }
    return "done";
  } finally {
    releaseJobKeys(resolved);
  }
}

class SkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkipError";
  }
}

async function runJob(job: JobRecord, keys: UserKeys): Promise<void> {
  if (job.kind === "ocr_attachment") {
    const { attachmentId } = parseAttachmentPayload(job.payload);
    try {
      await runOcrJob(job.userId, keys, attachmentId);
    } catch (error) {
      if (error instanceof CaptureSkipError) throw new SkipError(error.message);
      throw error;
    }
    return;
  }

  if (job.kind === "transcribe_attachment") {
    const { attachmentId } = parseAttachmentPayload(job.payload);
    try {
      await runTranscribeJob(job.userId, keys, attachmentId);
    } catch (error) {
      if (error instanceof CaptureSkipError) throw new SkipError(error.message);
      throw error;
    }
    return;
  }

  if (job.kind === "embed_dream") {
    const { dreamId } = parseDreamPayload(job.payload);
    try {
      await runEmbedJob(job.userId, keys, dreamId);
    } catch (error) {
      if (error instanceof SemanticSkipError) throw new SkipError(error.message);
      throw error;
    }
    return;
  }

  if (job.kind === "detect_dream_signs") {
    const payload = parseReportPayload(job.payload);
    try {
      await runSignScanJob(job.userId, keys, payload.periodStart, payload.periodEnd);
    } catch (error) {
      if (error instanceof SemanticSkipError) throw new SkipError(error.message);
      throw error;
    }
    return;
  }

  const config = await loadAiConfig(job.userId, keys);

  if (job.kind === "period_report") {
    const payload = parseReportPayload(job.payload);
    await runReport(job.userId, keys, config, payload.periodStart, payload.periodEnd);
    return;
  }

  const { dreamId } = parseDreamPayload(job.payload);
  const role =
    job.kind === "extract_insight"
      ? "extraction"
      : job.kind === "lucidity_insight"
        ? "lucidity"
        : "symbolic";
  await runDreamInsight(job.userId, keys, config, dreamId, role);
}

async function runDreamInsight(
  userId: string,
  keys: UserKeys,
  config: AiConfig,
  dreamId: string,
  role: Exclude<InsightRole, "report">,
): Promise<void> {
  const dream = await getDream(userId, keys, dreamId);
  if (!dream) throw new SkipError("That entry no longer exists.");
  if (!dream.body?.trim()) throw new SkipError("Nothing to analyse.");

  const input = await dreamInput(userId, keys, dream, role !== "extraction");
  const prompt = messagesFor(role, input);
  const { response, destination } = await completeRole(
    config,
    role,
    [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    { json: role === "extraction" },
  );

  const content =
    role === "extraction"
      ? serialiseExtraction(parseExtraction(response.text))
      : clipInsight(response.text);

  await saveInsight(userId, keys, {
    dreamId,
    kind: role,
    provider: destination.providerName,
    model: destination.model,
    promptVersion: PROMPT_VERSIONS[role],
    content,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
  });

  await recordAuthEvent("ai_request", {
    userId,
    detail: {
      kind: role,
      provider: destination.providerKind,
      host: destination.host,
      leavesMachine: destination.leavesMachine,
    },
  });
}

async function runReport(
  userId: string,
  keys: UserKeys,
  config: AiConfig,
  periodStart: string,
  periodEnd: string,
): Promise<void> {
  const all = (await dreamsInRange(userId, keys, periodStart, periodEnd)).filter(
    (dream) => dream.body?.trim() && !dream.isDraft,
  );
  if (all.length === 0) throw new SkipError("No written entries in that period.");

  const capped = all.length > MAX_REPORT_DREAMS;
  const window = capped ? all.slice(-MAX_REPORT_DREAMS) : all;
  const extractions = await latestExtractionsForDreams(
    userId,
    keys,
    window.map((dream) => dream.id),
  );

  const inputs: DreamPromptInput[] = window.map((dream) => ({
    date: dream.dreamDate,
    title: dream.title,
    body: dream.body ?? "",
    isLucid: dream.isLucid,
    lucidity: dream.lucidity,
    vividness: dream.vividness,
    tags: dream.tags,
    extraction: extractions.get(dream.id)?.content ?? null,
  }));

  const prompt = reportMessages(periodStart, periodEnd, inputs, capped);
  const { response, destination } = await completeRole(config, "report", [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ]);

  await saveInsight(userId, keys, {
    kind: "report",
    periodStart,
    periodEnd,
    provider: destination.providerName,
    model: destination.model,
    promptVersion: PROMPT_VERSIONS.report,
    content: clipInsight(response.text),
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
  });

  await recordAuthEvent("ai_request", {
    userId,
    detail: {
      kind: "report",
      provider: destination.providerKind,
      host: destination.host,
      leavesMachine: destination.leavesMachine,
      entries: window.length,
    },
  });
}

async function dreamInput(
  userId: string,
  keys: UserKeys,
  dream: NonNullable<Awaited<ReturnType<typeof getDream>>>,
  includeExtraction: boolean,
): Promise<DreamPromptInput> {
  const extraction = includeExtraction
    ? await latestInsightForDream(userId, keys, dream.id, "extraction")
    : null;
  return {
    date: dream.dreamDate,
    title: dream.title,
    body: dream.body ?? "",
    isLucid: dream.isLucid,
    lucidity: dream.lucidity,
    vividness: dream.vividness,
    tags: dream.tags,
    extraction: extraction?.content ?? null,
  };
}

function clipInsight(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_INSIGHT_CHARS) return trimmed;
  return trimmed.slice(0, MAX_INSIGHT_CHARS);
}

/** The lead page a capture job names. Its stack is resolved from it. */
function captureLeadId(job: JobRecord): string | null {
  if (job.kind !== "ocr_attachment" && job.kind !== "transcribe_attachment") return null;
  try {
    return parseAttachmentPayload(job.payload).attachmentId;
  } catch {
    return null;
  }
}

function publicError(error: unknown, kind: JobRecord["kind"]): string {
  if (kind === "ocr_attachment" || kind === "transcribe_attachment") {
    return publicCaptureError(error);
  }
  return publicModelError(error, "The model request failed.");
}
