import { describe, expect, it } from "vitest";
import {
  extractionMessages,
  MAX_STACK_PAGES,
  OCR_RESPONSE_SCHEMA,
  lucidityMessages,
  ocrMessages,
  ocrVerificationMessages,
  PROMPT_VERSIONS,
  reportMessages,
  splitMessages,
  symbolicMessages,
} from "./prompts";

const dream = {
  date: "2026-08-17",
  title: "The cathedral",
  body: "I was flying over the cathedral of bees.",
  isLucid: true,
  lucidity: 4,
  vividness: 5,
  tags: ["flying"],
};

describe("insight prompts", () => {
  it("keeps version ids stable so stored rows stay honest", () => {
    expect(PROMPT_VERSIONS.extraction).toBe("extraction.v1");
    expect(PROMPT_VERSIONS.lucidity).toBe("lucidity.v1");
    expect(PROMPT_VERSIONS.symbolic).toBe("symbolic.v1");
    expect(PROMPT_VERSIONS.split).toBe("split.v4");
    // v7 adds a second image-grounded proofreading pass while retaining v5's
    // one-page copy boundary.
    expect(PROMPT_VERSIONS.ocr).toBe("ocr.v7");
  });

  it("puts the dream in the user message, not the system prompt", () => {
    const prompt = extractionMessages(dream);
    expect(prompt.user).toContain("flying over the cathedral of bees");
    expect(prompt.system).not.toContain("cathedral of bees");
    expect(prompt.system).toContain("JSON");
  });

  it("asks extraction to stay literal", () => {
    expect(extractionMessages(dream).system).toMatch(/literal/i);
    expect(extractionMessages(dream).system).toMatch(/Do not interpret/);
  });

  it("feeds a prior extraction to the lucidity and symbolic prompts", () => {
    const extraction = JSON.stringify({ anomalies: ["underwater bells"] });
    expect(lucidityMessages({ ...dream, extraction }).user).toContain("underwater bells");
    expect(symbolicMessages({ ...dream, extraction }).user).toContain("underwater bells");
    expect(lucidityMessages(dream).user).not.toContain("Structured extraction");
  });

  it("includes the period bounds in a report prompt", () => {
    const prompt = reportMessages("2026-08-01", "2026-08-17", [dream], false);
    expect(prompt.user).toContain("2026-08-01");
    expect(prompt.user).toContain("2026-08-17");
    expect(prompt.user).toContain("cathedral of bees");
  });

  it("notes when a report was capped", () => {
    const prompt = reportMessages("2026-08-01", "2026-08-17", [dream], true);
    expect(prompt.user).toMatch(/only the most recent 1 entries/i);
  });

  it("keeps the photographed page out of the OCR system prompt", () => {
    const prompt = ocrMessages();
    expect(prompt.system).toMatch(/transcribe/i);
    expect(prompt.system).toMatch(/JSON/i);
    expect(prompt.system).not.toContain("cathedral");
  });

  it("asks for one page, not a stack of dreams", () => {
    const prompt = ocrMessages();
    expect(prompt.user).toMatch(/Transcribe the attached page/);
    expect(prompt.user).not.toMatch(/pages 1 to/);
    expect(prompt.system).not.toMatch(/ONE dream/);
    expect(prompt.system).toMatch(/Be literal/);
  });

  it("keeps proofreading image-grounded and separate from splitting", () => {
    const prompt = ocrVerificationMessages({
      date: "2026-08-17",
      title: "The cathedral",
      body: "I was flying.",
      tags: [],
      lucidity: null,
      bedTime: null,
      wakeTime: null,
    });
    expect(prompt.user).toContain("I was flying");
    expect(prompt.system).toMatch(/attached handwritten page/);
    expect(prompt.system).toMatch(/Do not split dreams/);
  });

  /*
   * The grammar, not the prose, is what a model that answers its own way is
   * caught by -- a well-formed object with none of these keys in it used to
   * parse into a blank form with nothing to explain it.
   */
  it("holds a page copy to the transcript fields", () => {
    expect(OCR_RESPONSE_SCHEMA.required).toEqual([
      "date",
      "dateConfidence",
      "title",
      "titleConfidence",
      "body",
      "bodyConfidence",
      "tags",
      "tagsConfidence",
      "lucidity",
      "lucidityConfidence",
      "bedTime",
      "bedTimeConfidence",
      "wakeTime",
      "wakeTimeConfidence",
    ]);
  });

  it("caps a stack at a night a job can copy page by page", () => {
    expect(MAX_STACK_PAGES).toBeGreaterThan(1);
    expect(MAX_STACK_PAGES).toBeLessThanOrEqual(8);
  });

  it("puts the log in the split user message, not the system prompt", () => {
    const prompt = splitMessages("I was flying. Then I woke and was in a train.");
    expect(prompt.user).toContain("I was flying");
    expect(prompt.system).not.toContain("I was flying");
    expect(prompt.system).toMatch(/Copy every character/);
  });

  /*
   * The regression that made a three-dream night arrive as one entry. The
   * example carries more weight than the prose at this temperature, so a
   * one-entry example is a worked example of never splitting.
   */
  it("shows the split schema with more than one dream in it", () => {
    const prompt = splitMessages("I was flying. Then I was on a train.");
    const example = prompt.user.slice(0, prompt.user.indexOf("Log:"));
    expect(example.match(/"isFragment"/g)?.length).toBeGreaterThan(1);
  });

  it("tells a page-log split that a page break is not a new dream", () => {
    const fromPages = splitMessages("I was flying.", "pages");
    expect(fromPages.system).toMatch(/page break is not a new dream/i);
    expect(splitMessages("I was flying.").system).not.toMatch(/page break/);
  });

  it("does not clip a photographed night before the verbatim split", () => {
    const tail = "last-written-word";
    const body = `${"a".repeat(9_000)} ${tail}`;
    expect(splitMessages(body, "pages").user).toContain(tail);
    expect(splitMessages(body).user).not.toContain(tail);
  });
});
