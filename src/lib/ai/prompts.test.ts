import { describe, expect, it } from "vitest";
import {
  extractionMessages,
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
    expect(PROMPT_VERSIONS.ocr).toBe("ocr.v1");
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
    expect(prompt.system).toMatch(/literal/i);
    expect(prompt.system).toMatch(/JSON/i);
  });

  it("puts the log in the split user message, not the system prompt", () => {
    const prompt = splitMessages("I was flying. Then I woke and was in a train.");
    expect(prompt.user).toContain("I was flying");
    expect(prompt.system).not.toContain("I was flying");
    expect(prompt.system).toMatch(/Keep the writer's words/);
  });
});
