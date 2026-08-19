/**
 * The durable queue for model work.
 *
 * Payloads are identifiers only. Plaintext in a job row would sit in the
 * database unencrypted for the lifetime of the queue, which is exactly what
 * the rest of the design refuses to do. The worker re-reads the dream (or
 * the period) and decrypts it under the live session's key.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { isIsoDate, type IsoDate } from "@/lib/journal/dates";
import type { DreamInsightKind, InsightRole } from "./types";

export type InsightJobKind =
  | "extract_insight"
  | "lucidity_insight"
  | "symbolic_insight"
  | "period_report";

export type CaptureJobKind = "ocr_attachment" | "transcribe_attachment";

export type SemanticJobKind = "embed_dream" | "detect_dream_signs";

export type JobKind = InsightJobKind | CaptureJobKind | SemanticJobKind;

export interface DreamJobPayload {
  dreamId: string;
}

export interface ReportJobPayload {
  periodStart: IsoDate;
  periodEnd: IsoDate;
}

export interface AttachmentJobPayload {
  attachmentId: string;
}

export type JobPayload = DreamJobPayload | ReportJobPayload | AttachmentJobPayload;

export interface JobRecord {
  id: string;
  userId: string;
  kind: JobKind;
  payload: JobPayload;
  status: (typeof jobs.$inferSelect)["status"];
  attempts: number;
  lastError: string | null;
  scheduledFor: Date;
}

const DREAM_JOB: Record<DreamInsightKind, InsightJobKind> = {
  extraction: "extract_insight",
  lucidity: "lucidity_insight",
  symbolic: "symbolic_insight",
};

const KIND_FROM_JOB: Record<InsightJobKind, InsightRole> = {
  extract_insight: "extraction",
  lucidity_insight: "lucidity",
  symbolic_insight: "symbolic",
  period_report: "report",
};

const ALL_JOB_KINDS: JobKind[] = [
  "extract_insight",
  "lucidity_insight",
  "symbolic_insight",
  "period_report",
  "ocr_attachment",
  "transcribe_attachment",
  "embed_dream",
  "detect_dream_signs",
];

const OPEN: Array<(typeof jobs.$inferSelect)["status"]> = ["pending", "running"];

export function jobKindFor(role: DreamInsightKind): InsightJobKind {
  return DREAM_JOB[role];
}

export function roleForJob(kind: InsightJobKind): InsightRole {
  return KIND_FROM_JOB[kind];
}

export function isInsightJobKind(value: string): value is InsightJobKind {
  return value in KIND_FROM_JOB;
}

export function isJobKind(value: string): value is JobKind {
  return (ALL_JOB_KINDS as string[]).includes(value);
}

function asDreamPayload(value: unknown): DreamJobPayload | null {
  if (!value || typeof value !== "object") return null;
  const dreamId = (value as { dreamId?: unknown }).dreamId;
  return typeof dreamId === "string" && dreamId.length > 0 ? { dreamId } : null;
}

function asReportPayload(value: unknown): ReportJobPayload | null {
  if (!value || typeof value !== "object") return null;
  const periodStart = (value as { periodStart?: unknown }).periodStart;
  const periodEnd = (value as { periodEnd?: unknown }).periodEnd;
  if (!isIsoDate(periodStart) || !isIsoDate(periodEnd)) return null;
  return { periodStart, periodEnd };
}

function asAttachmentPayload(value: unknown): AttachmentJobPayload | null {
  if (!value || typeof value !== "object") return null;
  const attachmentId = (value as { attachmentId?: unknown }).attachmentId;
  return typeof attachmentId === "string" && attachmentId.length > 0
    ? { attachmentId }
    : null;
}

export function parseDreamPayload(value: unknown): DreamJobPayload {
  const parsed = asDreamPayload(value);
  if (!parsed) throw new Error("Job payload is missing dreamId");
  return parsed;
}

export function parseReportPayload(value: unknown): ReportJobPayload {
  const parsed = asReportPayload(value);
  if (!parsed) throw new Error("Job payload is missing a period");
  return parsed;
}

export function parseAttachmentPayload(value: unknown): AttachmentJobPayload {
  const parsed = asAttachmentPayload(value);
  if (!parsed) throw new Error("Job payload is missing attachmentId");
  return parsed;
}

/**
 * Enqueues a dream insight, or returns the already-open job.
 *
 * Two clicks on Generate must not fire two model calls for the same kind.
 */
export async function enqueueDreamInsight(
  userId: string,
  dreamId: string,
  role: DreamInsightKind,
): Promise<string> {
  const kind = DREAM_JOB[role];
  const existing = await findOpenJobForDream(userId, dreamId, kind);
  if (existing) return existing;

  const id = randomUUID();
  await db.insert(jobs).values({
    id,
    userId,
    kind,
    payload: { dreamId },
  });
  return id;
}

export async function enqueuePeriodReport(
  userId: string,
  periodStart: IsoDate,
  periodEnd: IsoDate,
): Promise<string> {
  const id = randomUUID();
  await db.insert(jobs).values({
    id,
    userId,
    kind: "period_report",
    payload: { periodStart, periodEnd },
  });
  return id;
}

/**
 * Enqueues OCR or transcription for an attachment, or returns the already-open
 * job. Same de-dupe as insights: two uploads of the same file must not fire
 * two model calls.
 */
export async function enqueueAttachmentJob(
  userId: string,
  attachmentId: string,
  kind: CaptureJobKind,
): Promise<string> {
  const existing = await findOpenAttachmentJob(userId, attachmentId, kind);
  if (existing) return existing;

  const id = randomUUID();
  await db.insert(jobs).values({
    id,
    userId,
    kind,
    payload: { attachmentId },
  });
  return id;
}

async function findOpenJobForDream(
  userId: string,
  dreamId: string,
  kind: InsightJobKind | SemanticJobKind,
): Promise<string | null> {
  const rows = await db
    .select({ id: jobs.id, payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.userId, userId), eq(jobs.kind, kind), inArray(jobs.status, OPEN)));
  for (const row of rows) {
    if (asDreamPayload(row.payload)?.dreamId === dreamId) return row.id;
  }
  return null;
}

async function findOpenAttachmentJob(
  userId: string,
  attachmentId: string,
  kind: CaptureJobKind,
): Promise<string | null> {
  const rows = await db
    .select({ id: jobs.id, payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.userId, userId), eq(jobs.kind, kind), inArray(jobs.status, OPEN)));
  for (const row of rows) {
    if (asAttachmentPayload(row.payload)?.attachmentId === attachmentId) return row.id;
  }
  return null;
}

export async function pendingDreamJobs(
  userId: string,
  dreamId: string,
): Promise<DreamInsightKind[]> {
  const rows = await db
    .select({ kind: jobs.kind, payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.userId, userId), inArray(jobs.status, OPEN)));

  const pending: DreamInsightKind[] = [];
  for (const row of rows) {
    if (!isInsightJobKind(row.kind) || row.kind === "period_report") continue;
    if (asDreamPayload(row.payload)?.dreamId !== dreamId) continue;
    pending.push(roleForJob(row.kind) as DreamInsightKind);
  }
  return pending;
}

/**
 * Enqueues an embedding for one dream, or returns the already-open job.
 *
 * A backfill enqueues one of these per entry, and an edit enqueues another for
 * the entry it touched, so the de-dupe is what keeps a busy evening of editing
 * from queueing the same dream a dozen times.
 */
export async function enqueueEmbedDream(userId: string, dreamId: string): Promise<string> {
  const existing = await findOpenJobForDream(userId, dreamId, "embed_dream");
  if (existing) return existing;

  const id = randomUUID();
  await db.insert(jobs).values({ id, userId, kind: "embed_dream", payload: { dreamId } });
  return id;
}

/**
 * Enqueues embeddings for many dreams at once.
 *
 * One query for what is already queued rather than one per dream: a backfill
 * over a year's journal is several hundred entries, and the per-dream check
 * would be several hundred round-trips before a single vector is computed.
 */
export async function enqueueEmbedDreams(
  userId: string,
  dreamIds: readonly string[],
): Promise<number> {
  if (dreamIds.length === 0) return 0;

  const open = await db
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(
      and(eq(jobs.userId, userId), eq(jobs.kind, "embed_dream"), inArray(jobs.status, OPEN)),
    );
  const queued = new Set(
    open.map((row) => asDreamPayload(row.payload)?.dreamId).filter(Boolean) as string[],
  );

  const rows = [...new Set(dreamIds)]
    .filter((dreamId) => !queued.has(dreamId))
    .map((dreamId) => ({
      id: randomUUID(),
      userId,
      kind: "embed_dream" as const,
      payload: { dreamId },
    }));

  if (rows.length === 0) return 0;
  await db.insert(jobs).values(rows);
  return rows.length;
}

/** One scan at a time: two concurrent scans would race on the same sign rows. */
export async function enqueueSignScan(
  userId: string,
  periodStart: IsoDate,
  periodEnd: IsoDate,
): Promise<string> {
  const [existing] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.userId, userId),
        eq(jobs.kind, "detect_dream_signs"),
        inArray(jobs.status, OPEN),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const id = randomUUID();
  await db.insert(jobs).values({
    id,
    userId,
    kind: "detect_dream_signs",
    payload: { periodStart, periodEnd },
  });
  return id;
}

/**
 * What the capture job for one attachment is doing right now.
 *
 * The review page needs this because an attachment sits at `running` for the
 * whole retry budget: a failed attempt puts the job back to `pending` with a
 * backoff and only the third one flips the attachment to `failed`. Reading the
 * attachment row alone, the page can say nothing but "Reading the page..." for
 * a quarter of an hour while the model is unreachable. `lastError` is a
 * provider message that was already deemed safe to persist -- it names a host
 * or a status, never a prompt.
 */
export interface AttachmentJobProgress {
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
}

export const MAX_JOB_ATTEMPTS = 3;

export async function attachmentJobProgress(
  userId: string,
  attachmentId: string,
): Promise<AttachmentJobProgress | null> {
  const [row] = await db
    .select({ attempts: jobs.attempts, lastError: jobs.lastError })
    .from(jobs)
    .where(
      and(
        eq(jobs.userId, userId),
        inArray(jobs.kind, ["ocr_attachment", "transcribe_attachment"]),
        sql`${jobs.payload}->> 'attachmentId' = ${attachmentId}`,
      ),
    )
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  if (!row) return null;
  return {
    attempts: row.attempts,
    maxAttempts: MAX_JOB_ATTEMPTS,
    lastError: row.lastError,
  };
}

/**
 * The attachments that have a capture job still open.
 *
 * A photographed page is stored at `pending` and stays there until the writer
 * sends its stack to be read, so the attachment row alone cannot tell "queued"
 * from "not sent yet". The queue is the only thing that knows.
 */
export async function openCaptureAttachmentIds(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(
      and(
        eq(jobs.userId, userId),
        inArray(jobs.kind, ["ocr_attachment", "transcribe_attachment"]),
        inArray(jobs.status, OPEN),
      ),
    );

  const ids = new Set<string>();
  for (const row of rows) {
    try {
      ids.add(parseAttachmentPayload(row.payload).attachmentId);
    } catch {
      // A payload this cannot read is not an attachment waiting on anything.
    }
  }
  return ids;
}

export async function openJobCount(userId: string, kind: JobKind): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(jobs)
    .where(and(eq(jobs.userId, userId), eq(jobs.kind, kind), inArray(jobs.status, OPEN)));
  return Number(row?.total ?? 0);
}

export async function pendingReportCount(userId: string): Promise<number> {
  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(eq(jobs.userId, userId), eq(jobs.kind, "period_report"), inArray(jobs.status, OPEN)),
    );
  return rows.length;
}

export async function claimNextJob(): Promise<JobRecord | null> {
  const [row] = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.status, "pending"),
        lte(jobs.scheduledFor, new Date()),
        inArray(jobs.kind, ALL_JOB_KINDS),
      ),
    )
    .orderBy(asc(jobs.scheduledFor))
    .limit(1);
  if (!row || !isJobKind(row.kind)) return null;

  await db
    .update(jobs)
    .set({
      status: "running",
      startedAt: new Date(),
      attempts: sql`${jobs.attempts} + 1`,
    })
    .where(and(eq(jobs.id, row.id), eq(jobs.status, "pending")));

  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind,
    payload: row.payload as JobPayload,
    status: "running",
    attempts: row.attempts + 1,
    lastError: row.lastError,
    scheduledFor: row.scheduledFor,
  };
}

export async function completeJob(id: string): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "succeeded", completedAt: new Date(), lastError: null })
    .where(eq(jobs.id, id));
}

export async function skipJob(id: string, reason: string): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "skipped", completedAt: new Date(), lastError: reason })
    .where(eq(jobs.id, id));
}

export async function failJob(id: string, attempts: number, reason: string): Promise<void> {
  const retry = attempts < MAX_JOB_ATTEMPTS;
  await db
    .update(jobs)
    .set({
      status: retry ? "pending" : "failed",
      lastError: reason,
      scheduledFor: retry ? new Date(Date.now() + backoffMs(attempts)) : new Date(),
      completedAt: retry ? null : new Date(),
      startedAt: null,
    })
    .where(eq(jobs.id, id));
}

/**
 * Puts a claimed job back without burning a retry.
 *
 * Used when the data key is not in memory: that is not a failure, it is the
 * encryption model doing its job, and a lock-screen must not exhaust the
 * retry budget.
 */
export async function unclaimJob(id: string, reason: string): Promise<void> {
  await db
    .update(jobs)
    .set({
      status: "pending",
      startedAt: null,
      attempts: sql`greatest(${jobs.attempts} - 1, 0)`,
      lastError: reason,
    })
    .where(eq(jobs.id, id));
}

function backoffMs(attempts: number): number {
  return Math.min(15_000 * 4 ** (attempts - 1), 15 * 60 * 1000);
}

/** Running jobs whose worker died: put them back in the queue. */
export async function reclaimStuckJobs(maxAgeMs = 30 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const reclaimed = await db
    .update(jobs)
    .set({ status: "pending", startedAt: null })
    .where(and(eq(jobs.status, "running"), lte(jobs.startedAt, cutoff)))
    .returning({ id: jobs.id });
  return reclaimed.length;
}
