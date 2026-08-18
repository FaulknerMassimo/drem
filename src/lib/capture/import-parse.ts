/**
 * Parsers for JSON, Markdown and CSV journal exports.
 *
 * Pure: no database, no keys. The action validates each row through
 * `dreamInputSchema` before anything is written, so a malformed file cannot
 * smuggle an oversized body past the same limits the editor uses.
 */
import { isIsoDate, type IsoDate } from "@/lib/journal/dates";
import { MAX_BODY_LENGTH, MAX_TITLE_LENGTH, parseTagInput } from "@/lib/journal/validation";
import type { ImportedDream } from "./types";

export type { ImportedDream };

export type ImportFormat = "json" | "markdown" | "csv";

export interface ParseResult {
  format: ImportFormat;
  entries: ImportedDream[];
  skipped: number;
  error?: string;
}

export const MAX_IMPORT_ENTRIES = 100;

export function detectFormat(filename: string, text: string): ImportFormat | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".csv")) return "csv";
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  if (trimmed.includes(",") && looksLikeCsvHeader(trimmed.split(/\r?\n/, 1)[0] ?? "")) {
    return "csv";
  }
  if (trimmed.startsWith("#") || trimmed.startsWith("---")) return "markdown";
  return null;
}

export function parseImport(filename: string, text: string): ParseResult {
  const format = detectFormat(filename, text);
  if (!format) {
    return { format: "markdown", entries: [], skipped: 0, error: "Unrecognised file. Use JSON, Markdown or CSV." };
  }
  try {
    const raw =
      format === "json"
        ? parseJsonImport(text)
        : format === "csv"
          ? parseCsvImport(text)
          : parseMarkdownImport(text);
    const entries: ImportedDream[] = [];
    let skipped = 0;
    for (const candidate of raw) {
      if (entries.length >= MAX_IMPORT_ENTRIES) {
        skipped += 1;
        continue;
      }
      if (!candidate.body.trim()) {
        skipped += 1;
        continue;
      }
      entries.push(candidate);
    }
    if (entries.length === 0) {
      return { format, entries: [], skipped, error: "No dream entries were found in that file." };
    }
    return { format, entries, skipped };
  } catch {
    return { format, entries: [], skipped: 0, error: "That file could not be read." };
  }
}

function parseJsonImport(text: string): ImportedDream[] {
  const parsed: unknown = JSON.parse(text);
  const rows: unknown[] = [];

  if (Array.isArray(parsed)) {
    rows.push(...parsed);
  } else if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.dreams)) rows.push(...record.dreams);
    else if (Array.isArray(record.entries)) rows.push(...record.entries);
    else if (Array.isArray(record.nights)) {
      for (const night of record.nights) {
        if (!night || typeof night !== "object") continue;
        const nightRecord = night as Record<string, unknown>;
        const date = pickDate(nightRecord);
        const dreams = Array.isArray(nightRecord.dreams) ? nightRecord.dreams : [];
        for (const dream of dreams) {
          if (dream && typeof dream === "object") {
            rows.push({ date, ...(dream as object) });
          }
        }
      }
    } else {
      rows.push(parsed);
    }
  }

  return rows.map(fromUnknown).filter((row): row is ImportedDream => row !== null);
}

function parseMarkdownImport(text: string): ImportedDream[] {
  const chunks = splitMarkdown(text);
  const entries: ImportedDream[] = [];
  for (const chunk of chunks) {
    const parsed = fromMarkdownChunk(chunk);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

function splitMarkdown(text: string): string[] {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("---")) return splitFrontmatterDocs(trimmed);
  const headings = [...trimmed.matchAll(/^#{1,3}[ \t]+\d{4}-\d{2}-\d{2}\b.*$/gm)];
  if (headings.length <= 1) return [trimmed];
  const chunks: string[] = [];
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i]!.index ?? 0;
    const end = i + 1 < headings.length ? (headings[i + 1]!.index ?? trimmed.length) : trimmed.length;
    const chunk = trimmed.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

/** `---\\nfrontmatter\\n---\\nbody` documents, possibly several in one file. */
function splitFrontmatterDocs(text: string): string[] {
  const docs: string[] = [];
  let rest = text;
  while (rest.startsWith("---")) {
    const header = rest.match(/^---[\s\S]*?\n---[ \t]*(?:\n|$)/);
    if (!header) {
      docs.push(rest);
      break;
    }
    rest = rest.slice(header[0].length);
    const next = rest.search(/^---\s*$/m);
    const body = (next >= 0 ? rest.slice(0, next) : rest).trim();
    docs.push(`${header[0].trim()}\n${body}`.trim());
    rest = next >= 0 ? rest.slice(next).trim() : "";
  }
  return docs.filter(Boolean);
}

function fromMarkdownChunk(chunk: string): ImportedDream | null {
  let rest = chunk;
  const frontmatter: Record<string, string> = {};
  if (rest.startsWith("---")) {
    const end = rest.indexOf("\n---", 3);
    if (end > 0) {
      for (const line of rest.slice(3, end).split(/\r?\n/)) {
        const sep = line.indexOf(":");
        if (sep <= 0) continue;
        frontmatter[line.slice(0, sep).trim().toLowerCase()] = line.slice(sep + 1).trim();
      }
      rest = rest.slice(end + 4).trim();
    }
  }

  let headingDate: string | null = null;
  let headingTitle: string | null = null;
  const heading = rest.match(/^#{1,3}[ \t]+(\d{4}-\d{2}-\d{2})[ \t]*(.*)$/m);
  if (heading) {
    headingDate = heading[1] ?? null;
    headingTitle = heading[2]?.trim() || null;
    rest = rest.replace(heading[0], "").trim();
  }

  const record = { ...frontmatter, date: frontmatter.date ?? headingDate, title: frontmatter.title ?? headingTitle, body: rest };
  return fromUnknown(record);
}

function parseCsvImport(text: string): ImportedDream[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0]!.map((cell) => cell.trim().toLowerCase());
  const entries: ImportedDream[] = [];
  for (const row of rows.slice(1)) {
    const record: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) {
      const key = header[i];
      if (key) record[key] = row[i] ?? "";
    }
    const parsed = fromUnknown(record);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

function fromUnknown(value: unknown): ImportedDream | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const nightDate = pickDate(record);
  if (!nightDate) return null;
  const body = pickString(record, ["body", "text", "content", "dream"]) ?? "";
  const title = pickString(record, ["title", "name"]);
  const lucidity = pickInt(record, ["lucidity"], 0, 5) ?? (truthy(record.isLucid) || truthy(record.lucid) ? 3 : 0);
  return {
    nightDate,
    title: title ? title.slice(0, MAX_TITLE_LENGTH) : null,
    body: body.slice(0, MAX_BODY_LENGTH),
    lucidity,
    vividness: pickInt(record, ["vividness"], 1, 5),
    control: pickInt(record, ["control"], 1, 5),
    recallClarity: pickInt(record, ["recall", "recallclarity", "recall_clarity"], 1, 5),
    emotionalValence: pickInt(record, ["valence", "emotionalvalence", "emotional_valence"], -2, 2),
    isNightmare: truthy(record.isNightmare) || truthy(record.nightmare),
    isRecurring: truthy(record.isRecurring) || truthy(record.recurring),
    isFragment: truthy(record.isFragment) || truthy(record.fragment),
    tags: pickTags(record),
  };
}

function pickDate(record: Record<string, unknown>): IsoDate | null {
  for (const key of ["nightDate", "dreamDate", "date", "night", "day"]) {
    const value = record[key];
    if (typeof value === "string") {
      const sliced = value.trim().slice(0, 10);
      if (isIsoDate(sliced)) return sliced;
    }
  }
  return null;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  const lower = Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key.toLowerCase(), value]),
  );
  for (const key of keys) {
    const value = lower[key.toLowerCase()];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function pickInt(record: Record<string, unknown>, keys: string[], min: number, max: number): number | null {
  const lower = Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key.toLowerCase(), value]),
  );
  for (const key of keys) {
    const value = lower[key.toLowerCase()];
    const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(num)) continue;
    const rounded = Math.round(num);
    if (rounded >= min && rounded <= max) return rounded;
  }
  return null;
}

function pickTags(record: Record<string, unknown>): string[] {
  const value = record.tags ?? record.tag;
  if (Array.isArray(value)) {
    return parseTagInput(value.filter((item): item is string => typeof item === "string").join(","));
  }
  if (typeof value === "string") return parseTagInput(value);
  return [];
}

function truthy(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    return lower === "1" || lower === "true" || lower === "yes";
  }
  return false;
}

function looksLikeCsvHeader(line: string): boolean {
  const lower = line.toLowerCase();
  return lower.includes("date") && (lower.includes("body") || lower.includes("text") || lower.includes("dream"));
}

/** RFC 4180-ish: quoted fields, doubled quotes, commas. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const input = text.replace(/^\uFEFF/, "");

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      field = "";
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      continue;
    }
    field += char;
  }
  if (quoted) {
    row.push(field);
    if (row.some((cell) => cell.length > 0)) rows.push(row);
    return rows;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    if (row.some((cell) => cell.length > 0)) rows.push(row);
  }
  return rows;
}
