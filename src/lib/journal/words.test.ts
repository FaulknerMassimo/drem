import { describe, expect, it } from "vitest";
import { countWords, excerpt } from "./words";

describe("countWords", () => {
  it("counts whitespace-separated words", () => {
    expect(countWords("I was flying over the city")).toBe(6);
  });

  it("is unbothered by newlines and runs of spaces", () => {
    expect(countWords("  two\n\n  paragraphs   here \n")).toBe(3);
  });

  it("counts nothing for empty or blank text", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n\t ")).toBe(0);
  });
});

describe("excerpt", () => {
  it("returns short text unchanged", () => {
    expect(excerpt("A short dream.")).toBe("A short dream.");
  });

  it("collapses the whitespace of a multi-paragraph entry", () => {
    expect(excerpt("First line.\n\nSecond line.")).toBe("First line. Second line.");
  });

  it("cuts on a word boundary and marks the truncation", () => {
    const text = "word ".repeat(100);
    const result = excerpt(text, 40);
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(41);
    expect(result).not.toContain("wor…");
  });
});
