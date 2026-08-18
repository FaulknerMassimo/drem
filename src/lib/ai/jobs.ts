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
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { isIsoDate, type IsoDate } from "@/lib/journal/dates";
import type { DreamInsightKind, InsightRole } from "./types";

export type JobKind =
  | "extract_insight"
  | "lucidity_insight"
  | "symbolic_insight"
  | "period_report";

export interface DreamJobPayload {
  dreamId: string;
}

export interface ReportJobPayload {
  periodStart: IsoDate;
  periodEnd: IsoDate;
}

export interface JobRecord {
  id: string;
  userId: string;
  kind: JobKind;
  payload: DreamJobPayload | ReportJobPayload;
  status: (typeof jobs.$inferSelect)["status"];
  attempts: number;
  lastError: string | null;
  scheduledFor: Date;
}

const DREAM_JOB: Record<DreamInsightKind, JobKind> = {
  extraction: "extract_insight",
  lucidity: "lucidity_insight",
  symbolic: "symbolic_insight",
};

const KIND_FROM_JOB: Record<JobKind, InsightRole> = {
  extract_insight: "extraction",
  lucidity_insight: "lucidity",
  symbolic_insight: "symbolic",
  period_report: "report",
};

const OPEN: Array<(typeof jobs.$inferSelect)["status"]> = ["pending", "running"];

export function jobKindFor(role: DreamInsightKind): JobKind {
  return DREAM_JOB[role];
}

export function roleForJob(kind: JobKind): InsightRole {
  return KIND_FROM_JOB[kind];
}

export function isJobKind(value: string): value is JobKind {
  return value in KIND_FROM_JOB;
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
  const existing = await findOpenDreamJob(userId, dreamId, kind);
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

async function findOpenDreamJob(
  userId: string,
  dreamId: string,
  kind: JobKind,
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
    if (!isJobKind(row.kind) || row.kind === "period_report") continue;
    if (asDreamPayload(row.payload)?.dreamId !== dreamId) continue;
    pending.push(roleForJob(row.kind) as DreamInsightKind);
  }
  return pending;
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
    .where(and(eq(jobs.status, "pending"), lte(jobs.scheduledFor, new Date())))
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
    payload: row.payload as DreamJobPayload | ReportJobPayload,
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
  const retry = attempts < 3;
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
