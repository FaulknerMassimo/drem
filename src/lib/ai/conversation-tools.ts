/** Read-only tools exposed to the journal conversation model. */
import "server-only";
import { and, asc, count, desc, eq, gte, inArray, lte, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { dreamTags, dreams, nights, tags } from "@/db/schema";
import type { UserKeys } from "@/lib/crypto/envelope";
import { insightsForDream, listReports } from "./insights";
import type { ChatTool } from "./types";
import { techniqueEffectiveness } from "@/lib/journal/analytics";
import { isIsoDate, today, type IsoDate } from "@/lib/journal/dates";
import {
  dreamSummaries,
  dreamRecords,
  dreamsForNight,
} from "@/lib/journal/dreams";
import { getNight } from "@/lib/journal/nights";
import { activityBetween, analyticsRows, journalTotals } from "@/lib/journal/stats";
import { listTagCounts, tagFingerprint } from "@/lib/journal/tags";
import {
  dreamIdsForSign,
  getSign,
  listSigns,
  signsForDreams,
} from "@/lib/semantic/signs";

const isoDate = z.string().refine(isIsoDate);
const optionalRange = { from: isoDate.optional(), to: isoDate.optional() };
const empty = z.object({}).strict();

const listDreamsArgs = z.object({
  ...optionalRange,
  lucid_only: z.boolean().optional(),
  nightmares_only: z.boolean().optional(),
  recurring_only: z.boolean().optional(),
  drafts_only: z.boolean().optional(),
  include_fragments: z.boolean().optional(),
  tag: z.string().trim().min(1).max(100).optional(),
  sort: z.enum(["newest", "oldest", "longest"]).optional(),
  page: z.number().int().min(1).max(1000).optional(),
  page_size: z.number().int().min(1).max(50).optional(),
}).strict();

const idsArgs = z.object({ ids: z.array(z.string().uuid()).min(1).max(10) }).strict();
const searchArgs = z.object({
  query: z.string().trim().min(2).max(200),
  ...optionalRange,
  limit: z.number().int().min(1).max(10).optional(),
}).strict();
const listNightsArgs = z.object({
  ...optionalRange,
  order: z.enum(["newest", "oldest"]).optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).strict();
const nightArgs = z.object({ date: isoDate }).strict();
const signListArgs = z.object({
  include_dismissed: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();
const signArgs = z.object({ id: z.string().uuid() }).strict();
const statsArgs = z.object({ ...optionalRange }).strict();
const reportArgs = z.object({ limit: z.number().int().min(1).max(20).optional() }).strict();
const insightArgs = z.object({ dream_id: z.string().uuid() }).strict();

const rangeProperties = {
  from: { type: "string", format: "date", description: "Inclusive YYYY-MM-DD start date." },
  to: { type: "string", format: "date", description: "Inclusive YYYY-MM-DD end date." },
};

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

/** Kept as plain JSON Schema because all three providers consume this shape. */
export const JOURNAL_CHAT_TOOLS: ChatTool[] = [
  {
    name: "get_journal_overview",
    description: "Get all-time counts for journalled nights, dreams, lucid dreams, words, and lucid rate over recalled nights.",
    parameters: objectSchema({}),
  },
  {
    name: "list_dreams",
    description: "List dream summaries and ids with rich metadata filters. Use read_dreams for complete text.",
    parameters: objectSchema({
      ...rangeProperties,
      lucid_only: { type: "boolean" },
      nightmares_only: { type: "boolean" },
      recurring_only: { type: "boolean" },
      drafts_only: { type: "boolean" },
      include_fragments: { type: "boolean", description: "Defaults to true." },
      tag: { type: "string" },
      sort: { type: "string", enum: ["newest", "oldest", "longest"] },
      page: { type: "integer", minimum: 1 },
      page_size: { type: "integer", minimum: 1, maximum: 50 },
    }),
  },
  {
    name: "read_dreams",
    description: "Read complete dream entries by id, including body, ratings, tags, flags, source, and attached dream signs.",
    parameters: objectSchema({
      ids: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", format: "uuid" } },
    }, ["ids"]),
  },
  {
    name: "search_dream_text",
    description: "Search decrypted titles and bodies for an exact word or phrase. Returns up to 10 complete matching entries.",
    parameters: objectSchema({
      query: { type: "string", minLength: 2, maxLength: 200 },
      ...rangeProperties,
      limit: { type: "integer", minimum: 1, maximum: 10 },
    }, ["query"]),
  },
  {
    name: "list_nights",
    description: "List journalled nights with sleep times, quality, techniques, recall state, and encrypted night notes decrypted in-process.",
    parameters: objectSchema({
      ...rangeProperties,
      order: { type: "string", enum: ["newest", "oldest"] },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    }),
  },
  {
    name: "read_night",
    description: "Read one night and every dream recorded on that date.",
    parameters: objectSchema({ date: rangeProperties.from }, ["date"]),
  },
  {
    name: "list_dream_signs",
    description: "List recurring dream signs with categories, occurrence counts, lucid counts, and correlation with lucidity.",
    parameters: objectSchema({
      include_dismissed: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    }),
  },
  {
    name: "read_dream_sign",
    description: "Read a dream sign and summaries of every dream where it occurs.",
    parameters: objectSchema({ id: { type: "string", format: "uuid" } }, ["id"]),
  },
  {
    name: "list_tags",
    description: "List every decrypted journal tag and how many dreams use it.",
    parameters: objectSchema({}),
  },
  {
    name: "get_statistics",
    description: "Calculate recall, lucidity, ratings, and induction-technique effectiveness for a date range.",
    parameters: objectSchema(rangeProperties),
  },
  {
    name: "get_activity",
    description: "Get per-day journal activity: whether journalled, dream count, lucid count, and word count.",
    parameters: objectSchema(rangeProperties),
  },
  {
    name: "list_reports",
    description: "Read saved cross-dream period reports, newest first.",
    parameters: objectSchema({ limit: { type: "integer", minimum: 1, maximum: 20 } }),
  },
  {
    name: "read_dream_insights",
    description: "Read the latest extraction, lucidity coaching, and symbolic insight saved for one dream.",
    parameters: objectSchema({ dream_id: { type: "string", format: "uuid" } }, ["dream_id"]),
  },
];

export interface ChatToolContext {
  userId: string;
  keys: UserKeys;
}

/** Executes one validated tool call and returns a bounded JSON result. */
export async function executeJournalChatTool(
  context: ChatToolContext,
  name: string,
  rawArguments: unknown,
): Promise<string> {
  try {
    let result: unknown;
    if (name === "get_journal_overview") {
      empty.parse(rawArguments);
      result = await journalTotals(context.userId);
    } else if (name === "list_dreams") {
      result = await listDreamTool(context, listDreamsArgs.parse(rawArguments));
    } else if (name === "read_dreams") {
      const { ids } = idsArgs.parse(rawArguments);
      result = await readDreamsTool(context, ids);
    } else if (name === "search_dream_text") {
      result = await searchDreamsTool(context, searchArgs.parse(rawArguments));
    } else if (name === "list_nights") {
      result = await listNightsTool(context, listNightsArgs.parse(rawArguments));
    } else if (name === "read_night") {
      const { date } = nightArgs.parse(rawArguments);
      result = {
        night: await getNight(context.userId, context.keys, date),
        dreams: await dreamsForNight(context.userId, context.keys, date),
      };
    } else if (name === "list_dream_signs") {
      const args = signListArgs.parse(rawArguments);
      const totals = await journalTotals(context.userId);
      const rows = await listSigns(context.userId, context.keys, {
        baseline: totals.lucidRate,
        includeDismissed: args.include_dismissed,
      });
      result = rows.slice(0, args.limit ?? 50);
    } else if (name === "read_dream_sign") {
      const { id } = signArgs.parse(rawArguments);
      const totals = await journalTotals(context.userId);
      const sign = await getSign(context.userId, context.keys, id, totals.lucidRate);
      const dreamIds = sign ? await dreamIdsForSign(context.userId, id) : [];
      result = { sign, dreams: await dreamSummaries(context.userId, context.keys, dreamIds) };
    } else if (name === "list_tags") {
      empty.parse(rawArguments);
      result = await listTagCounts(context.userId, context.keys);
    } else if (name === "get_statistics") {
      result = await statisticsTool(context, statsArgs.parse(rawArguments));
    } else if (name === "get_activity") {
      const args = statsArgs.parse(rawArguments);
      result = await activityBetween(context.userId, fromOf(args), toOf(args));
    } else if (name === "list_reports") {
      const { limit } = reportArgs.parse(rawArguments);
      result = await listReports(context.userId, context.keys, limit ?? 10);
    } else if (name === "read_dream_insights") {
      const { dream_id } = insightArgs.parse(rawArguments);
      result = await insightsForDream(context.userId, context.keys, dream_id);
    } else {
      return JSON.stringify({ error: "That tool is not available." });
    }
    return JSON.stringify(result);
  } catch {
    // Validation and database errors must not echo model arguments: those can
    // contain a name or phrase copied from a dream.
    return JSON.stringify({ error: "The tool arguments were invalid or the data could not be read." });
  }
}

function fromOf(args: { from?: IsoDate }): IsoDate {
  return args.from ?? "0001-01-01";
}

function toOf(args: { to?: IsoDate }): IsoDate {
  return args.to ?? today();
}

async function listDreamTool(context: ChatToolContext, args: z.infer<typeof listDreamsArgs>) {
  const conditions: SQL[] = [eq(dreams.userId, context.userId)];
  if (args.from) conditions.push(gte(dreams.dreamDate, args.from));
  if (args.to) conditions.push(lte(dreams.dreamDate, args.to));
  if (args.lucid_only) conditions.push(eq(dreams.isLucid, true));
  if (args.nightmares_only) conditions.push(eq(dreams.isNightmare, true));
  if (args.recurring_only) conditions.push(eq(dreams.isRecurring, true));
  if (args.drafts_only) conditions.push(eq(dreams.isDraft, true));
  if (args.include_fragments === false) conditions.push(eq(dreams.isFragment, false));
  if (args.tag) {
    conditions.push(inArray(
      dreams.id,
      db.select({ id: dreamTags.dreamId })
        .from(dreamTags)
        .innerJoin(tags, eq(tags.id, dreamTags.tagId))
        .where(and(eq(tags.userId, context.userId), eq(tags.nameBidx, tagFingerprint(context.keys, args.tag)))),
    ));
  }

  const where = and(...conditions);
  const [totalRow] = await db.select({ value: count() }).from(dreams).where(where);
  const pageSize = args.page_size ?? 25;
  const page = args.page ?? 1;
  const order = args.sort === "oldest"
    ? [asc(dreams.dreamDate), asc(dreams.createdAt)]
    : args.sort === "longest"
      ? [desc(dreams.wordCount), desc(dreams.dreamDate)]
      : [desc(dreams.dreamDate), desc(dreams.createdAt)];
  const rows = await db
    .select({ id: dreams.id })
    .from(dreams)
    .where(where)
    .orderBy(...order)
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return {
    total: Number(totalRow?.value ?? 0),
    page,
    page_size: pageSize,
    dreams: await dreamSummaries(context.userId, context.keys, rows.map((row) => row.id)),
  };
}

async function readDreamsTool(context: ChatToolContext, ids: string[]) {
  const records = await dreamRecords(context.userId, context.keys, ids);
  const signs = await signsForDreams(context.userId, context.keys, records.map((dream) => dream.id));
  return records.map((dream) => ({ ...dream, dreamSigns: signs.get(dream.id) ?? [] }));
}

async function searchDreamsTool(context: ChatToolContext, args: z.infer<typeof searchArgs>) {
  const rows = await db
    .select({ id: dreams.id })
    .from(dreams)
    .where(and(
      eq(dreams.userId, context.userId),
      gte(dreams.dreamDate, fromOf(args)),
      lte(dreams.dreamDate, toOf(args)),
    ))
    .orderBy(desc(dreams.dreamDate), desc(dreams.createdAt))
    // Exact text search requires decryption. Bound the scan so one tool call
    // cannot unexpectedly put a multi-decade archive into memory.
    .limit(2_000);
  const query = args.query.toLowerCase();
  const records = await dreamRecords(context.userId, context.keys, rows.map((row) => row.id));
  const found = [];
  for (const dream of records) {
    const haystack = `${dream.title ?? ""}\n${dream.body ?? ""}`.toLowerCase();
    if (haystack.includes(query)) found.push(dream);
    if (found.length >= (args.limit ?? 10)) break;
  }
  return { scanned: rows.length, matches: found };
}

async function listNightsTool(context: ChatToolContext, args: z.infer<typeof listNightsArgs>) {
  const conditions: SQL[] = [eq(nights.userId, context.userId)];
  if (args.from) conditions.push(gte(nights.date, args.from));
  if (args.to) conditions.push(lte(nights.date, args.to));
  const rows = await db
    .select({ date: nights.date })
    .from(nights)
    .where(and(...conditions))
    .orderBy(args.order === "oldest" ? asc(nights.date) : desc(nights.date))
    .limit(args.limit ?? 30);
  return (await Promise.all(rows.map((row) => getNight(context.userId, context.keys, row.date))))
    .filter((night) => night !== null);
}

async function statisticsTool(context: ChatToolContext, args: z.infer<typeof statsArgs>) {
  const from = fromOf(args);
  const to = toOf(args);
  const rows = await analyticsRows(context.userId, from, to);
  const recalledDates = new Set(rows.dreams.map((dream) => dream.date));
  const lucidDates = new Set(rows.dreams.filter((dream) => dream.isLucid).map((dream) => dream.date));
  const rated = <K extends "vividness" | "control" | "recallClarity">(key: K) => {
    const values = rows.dreams.map((dream) => dream[key]).filter((value): value is number => value !== null);
    return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
  };
  return {
    from,
    to,
    nights: rows.nights.length,
    recalled_nights: recalledDates.size,
    dreams: rows.dreams.length,
    lucid_nights: lucidDates.size,
    recall_rate: rows.nights.length === 0 ? null : recalledDates.size / rows.nights.length,
    lucid_rate: rows.nights.length === 0 ? null : lucidDates.size / rows.nights.length,
    average_vividness: rated("vividness"),
    average_control: rated("control"),
    average_recall_clarity: rated("recallClarity"),
    techniques: techniqueEffectiveness(rows.nights, rows.dreams),
  };
}
