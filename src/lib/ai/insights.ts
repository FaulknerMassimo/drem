/**
 * Encrypted insight records.
 *
 * Content is bound to the insight row, not the dream: regenerating produces a
 * new row rather than rewriting one, so a prompt-version bump can sit beside
 * the previous reading instead of silently replacing it. The latest row of
 * each kind is what the UI shows.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { insightKind, insights } from "@/db/schema";
import { decryptString, encrypt } from "@/lib/crypto/aead";
import type { UserKeys } from "@/lib/crypto/envelope";
import type { IsoDate } from "@/lib/journal/dates";
import { INSIGHT_ROLES, type InsightRole } from "./types";

type SchemaKind = (typeof insightKind.enumValues)[number];
type KindsMatch = InsightRole extends SchemaKind
  ? SchemaKind extends InsightRole
    ? true
    : never
  : never;
const kindsMatch: KindsMatch = true;
void kindsMatch;
void INSIGHT_ROLES;

export interface InsightRecord {
  id: string;
  dreamId: string | null;
  kind: InsightRole;
  periodStart: IsoDate | null;
  periodEnd: IsoDate | null;
  provider: string;
  model: string;
  promptVersion: string;
  content: string;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: Date;
}

function contentAad(id: string) {
  return { table: "insights", column: "content_enc", id };
}

function decode(keys: UserKeys, row: typeof insights.$inferSelect): InsightRecord {
  return {
    id: row.id,
    dreamId: row.dreamId,
    kind: row.kind,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    provider: row.provider,
    model: row.model,
    promptVersion: row.promptVersion,
    content: decryptString(keys.field, row.contentEnc, contentAad(row.id)),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    createdAt: row.createdAt,
  };
}

export async function saveInsight(
  userId: string,
  keys: UserKeys,
  input: {
    dreamId?: string | null;
    kind: InsightRole;
    periodStart?: IsoDate | null;
    periodEnd?: IsoDate | null;
    provider: string;
    model: string;
    promptVersion: string;
    content: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
  },
): Promise<string> {
  const id = randomUUID();
  await db.insert(insights).values({
    id,
    userId,
    dreamId: input.dreamId ?? null,
    kind: input.kind,
    periodStart: input.periodStart ?? null,
    periodEnd: input.periodEnd ?? null,
    provider: input.provider,
    model: input.model,
    promptVersion: input.promptVersion,
    contentEnc: encrypt(keys.field, input.content, contentAad(id)),
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
  });
  return id;
}

export async function latestInsightForDream(
  userId: string,
  keys: UserKeys,
  dreamId: string,
  kind: InsightRole,
): Promise<InsightRecord | null> {
  const [row] = await db
    .select()
    .from(insights)
    .where(
      and(eq(insights.userId, userId), eq(insights.dreamId, dreamId), eq(insights.kind, kind)),
    )
    .orderBy(desc(insights.createdAt))
    .limit(1);
  return row ? decode(keys, row) : null;
}

export async function insightsForDream(
  userId: string,
  keys: UserKeys,
  dreamId: string,
): Promise<Partial<Record<InsightRole, InsightRecord>>> {
  const rows = await db
    .select()
    .from(insights)
    .where(and(eq(insights.userId, userId), eq(insights.dreamId, dreamId)))
    .orderBy(desc(insights.createdAt));

  const latest: Partial<Record<InsightRole, InsightRecord>> = {};
  for (const row of rows) {
    const kind = row.kind as InsightRole;
    if (!latest[kind]) latest[kind] = decode(keys, row);
  }
  return latest;
}

export async function latestExtractionsForDreams(
  userId: string,
  keys: UserKeys,
  dreamIds: string[],
): Promise<Map<string, InsightRecord>> {
  const found = new Map<string, InsightRecord>();
  if (dreamIds.length === 0) return found;

  const rows = await db
    .select()
    .from(insights)
    .where(
      and(
        eq(insights.userId, userId),
        eq(insights.kind, "extraction"),
        inArray(insights.dreamId, dreamIds),
      ),
    )
    .orderBy(desc(insights.createdAt));

  for (const row of rows) {
    if (!row.dreamId || found.has(row.dreamId)) continue;
    found.set(row.dreamId, decode(keys, row));
  }
  return found;
}

export async function listReports(
  userId: string,
  keys: UserKeys,
  limit = 20,
): Promise<InsightRecord[]> {
  const rows = await db
    .select()
    .from(insights)
    .where(
      and(eq(insights.userId, userId), eq(insights.kind, "report"), isNull(insights.dreamId)),
    )
    .orderBy(desc(insights.createdAt))
    .limit(limit);
  return rows.map((row) => decode(keys, row));
}
