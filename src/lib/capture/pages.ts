/**
 * Joining the pages of one dream into one entry.
 *
 * A handwritten dream rarely fits on one page, and a phone photographs one
 * page at a time, so the review screen has to be able to fold several
 * transcripts into a single body. Both directions are text-only and pure:
 * nothing here knows about attachments, and the caller owns the textarea.
 */

/**
 * Adds a page's text to the entry, one blank line between pages.
 *
 * `anchor` is the text of the page that follows this one, so a writer who
 * ticks page three and then remembers page two still gets them in reading
 * order rather than the order they happened to tick.
 */
export function addPage(body: string, page: string, anchor?: string): string {
  const text = page.trim();
  if (!text || body.includes(text)) return body;

  const mark = anchor?.trim();
  const at = mark ? body.indexOf(mark) : -1;
  if (at < 0) {
    const head = body.replace(/\s+$/, "");
    return head ? `${head}\n\n${text}` : text;
  }

  const before = body.slice(0, at).replace(/\s+$/, "");
  const after = body.slice(at);
  return before ? `${before}\n\n${text}\n\n${after}` : `${text}\n\n${after}`;
}

/**
 * Takes a page's text back out again.
 *
 * Only while it is still exactly as it went in: once the writer has corrected
 * a word of it, unticking the page must not swallow the correction, so a
 * near-match is left alone rather than guessed at.
 */
export function removePage(body: string, page: string): string {
  const text = page.trim();
  if (!text) return body;
  const at = body.indexOf(text);
  if (at < 0) return body;

  const before = body.slice(0, at).replace(/\s+$/, "");
  const after = body.slice(at + text.length).replace(/^\s+/, "");
  if (!before) return after;
  if (!after) return before;
  return `${before}\n\n${after}`;
}
