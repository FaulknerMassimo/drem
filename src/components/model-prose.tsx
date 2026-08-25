import type { ReactNode } from "react";

/**
 * Renders a model's answer as the light markdown it is actually written in.
 *
 * Every chat model asked for a "review" or "feedback" answers in markdown
 * whether or not the prompt asked for it, and these were rendered with
 * `whitespace-pre-wrap` — so a period report opened with a literal
 * `**Period Review: 2026-07-27 to 2026-08-25**` and the lucidity coach's
 * headings were asterisks. Asking the prompts to stop is not a fix: the next
 * model does it again.
 *
 * **It builds React nodes and never parses HTML.** No `dangerouslySetInnerHTML`
 * and no markdown library, both for the same reason the dream body is rendered
 * as text: this string is derived from something a person wrote, and it has
 * been through a model, so it is exactly the kind of input that should never
 * be interpreted. Anything the grammar below does not recognise — a raw tag, a
 * link, an image — stays visible as the characters it is made of.
 *
 * The grammar is deliberately the small part of markdown these answers use:
 * headings, bullet and numbered lists, bold, italic and inline code. Nested
 * lists, tables and block quotes are left as plain paragraphs rather than
 * grown into a parser nobody is maintaining.
 */
export function ModelProse({ text, className = "" }: { text: string; className?: string }) {
  const blocks = toBlocks(text);

  return (
    <div className={`space-y-3 leading-relaxed text-ink-100 ${className}`}>
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          return (
            <h4 key={index} className="font-medium text-ink-100">
              {inline(block.lines[0]!)}
            </h4>
          );
        }
        if (block.kind === "bullets") {
          return (
            <ul key={index} className="list-disc space-y-1 pl-5 marker:text-ink-600">
              {block.lines.map((line, i) => (
                <li key={i}>{inline(line)}</li>
              ))}
            </ul>
          );
        }
        if (block.kind === "numbers") {
          return (
            <ol key={index} className="list-decimal space-y-1 pl-5 marker:text-ink-400">
              {block.lines.map((line, i) => (
                <li key={i}>{inline(line)}</li>
              ))}
            </ol>
          );
        }
        return (
          <p key={index} className="whitespace-pre-wrap">
            {inline(block.lines.join("\n"))}
          </p>
        );
      })}
    </div>
  );
}

type BlockKind = "paragraph" | "heading" | "bullets" | "numbers";

interface Block {
  kind: BlockKind;
  /** Item text for lists, the whole run for a paragraph. */
  lines: string[];
}

const HEADING = /^#{1,6}\s+(.*)$/;
const BULLET = /^[-*•]\s+(.*)$/;
const NUMBER = /^\d+[.)]\s+(.*)$/;

/**
 * A bold line on its own is a heading.
 *
 * `**Recurring Places:**` on its own line is how every one of these models
 * writes a section title, and it means the same thing as `## Recurring
 * Places`. Treating it as a paragraph left the report as an undifferentiated
 * wall with asterisks in it.
 */
const BOLD_LINE = /^\*\*(.+)\*\*:?$/;

function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;

  const push = (kind: BlockKind, line: string) => {
    if (current && current.kind === kind && kind !== "heading") current.lines.push(line);
    else {
      current = { kind, lines: [line] };
      blocks.push(current);
    }
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      current = null;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      push("heading", heading[1]!);
      current = null;
      continue;
    }

    const boldLine = BOLD_LINE.exec(line);
    if (boldLine) {
      push("heading", boldLine[1]!);
      current = null;
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      push("bullets", bullet[1]!);
      continue;
    }

    const numbered = NUMBER.exec(line);
    if (numbered) {
      push("numbers", numbered[1]!);
      continue;
    }

    push("paragraph", line);
  }

  return blocks;
}

/*
 * One pass over the inline markers, longest first so `**` is never read as two
 * `*`. The captured text is placed as a React child, so it is escaped by React
 * whatever it contains.
 */
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|(?<![*\w])\*[^*\n]+\*(?!\w)|(?<![_\w])_[^_\n]+_(?!\w))/g;

export function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;

  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    const start = match.index;
    if (start > last) nodes.push(text.slice(last, start));

    if (token.startsWith("**")) {
      nodes.push(
        <strong key={start} className="font-medium">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("`")) {
      nodes.push(
        <code key={start} className="rounded bg-ink-850 px-1 font-mono text-sm">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(<em key={start}>{token.slice(1, -1)}</em>);
    }

    last = start + token.length;
  }

  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
