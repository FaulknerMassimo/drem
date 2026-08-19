import { describe, expect, it } from "vitest";
import {
  extractionMessages,
  MAX_STACK_PAGES,
  OCR_RESPONSE_SCHEMA,
  lucidityMessages,
  ocrMessages,
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
    expect(PROMPT_VERSIONS.split).toBe("split.v1");
    // v2 is the stack reading: one call over every page, answering with the
    // dreams rather than with one page's fields.
    expect(PROMPT_VERSIONS.ocr).toBe("ocr.v2");
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
    const prompt = ocrMessages(1);
    expect(prompt.system).toMatch(/literal/i);
    expect(prompt.system).toMatch(/JSON/i);
  });

  it("tells the reading how many pages it was handed, and that they are ordered", () => {
    const prompt = ocrMessages(3);
    expect(prompt.user).toContain("3 attached images");
    expect(prompt.user).toMatch(/pages 1 to 3/);
    expect(prompt.user).toMatch(/in the order they were written/);
  });

  /*
   * The two questions the whole flow turns on. Reading page by page could
   * answer neither, which is what pushed the join and the split back onto the
   * writer as two manual passes over the same text.
   */
  it("asks a multi-page reading to carry a dream over the page break", () => {
    const prompt = ocrMessages(2);
    expect(prompt.user).toMatch(/ONE dream/);
    expect(prompt.user).toMatch(/list both page numbers/);
    expect(prompt.user).toMatch(/start a new dream partway down/);
  });

  it("does not talk about page breaks when there is only one page", () => {
    const prompt = ocrMessages(1);
    expect(prompt.user).not.toMatch(/ONE dream/);
    expect(prompt.user).toContain("It is page 1.");
  });

  it("refuses to invent a split in the system prompt", () => {
    expect(ocrMessages(4).system).toMatch(/never invent a split/i);
  });

  /*
   * The grammar, not the prose, is what a model that answers its own way is
   * caught by -- a well-formed object with none of these keys in it used to
   * parse into a blank form with nothing to explain it.
   */
  it("holds the reading to a required dreams array", () => {
    expect(OCR_RESPONSE_SCHEMA.required).toEqual(["dreams"]);
    const dreams = (OCR_RESPONSE_SCHEMA.properties as Record<string, { items: { required: string[] } }>)
      .dreams!;
    expect(dreams.items.required).toContain("pages");
    expect(dreams.items.required).toContain("body");
    expect(dreams.items.required).toContain("isFragment");
  });

  it("caps a stack at what one call can carry", () => {
    expect(MAX_STACK_PAGES).toBeGreaterThan(1);
    expect(MAX_STACK_PAGES).toBeLessThanOrEqual(8);
  });

  it("puts the log in the split user message, not the system prompt", () => {
    const prompt = splitMessages("I was flying. Then I woke and was in a train.");
    expect(prompt.user).toContain("I was flying");
    expect(prompt.system).not.toContain("I was flying");
    expect(prompt.system).toMatch(/Keep the writer's words/);
  });
});
