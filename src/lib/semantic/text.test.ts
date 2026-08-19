import { describe, expect, it } from "vitest";
import {
  embeddingModelKey,
  embeddingText,
  isEmbeddable,
  MAX_EMBEDDING_CHARS,
  modelFromKey,
} from "./text";

function dream(overrides: Partial<Parameters<typeof embeddingText>[0]> = {}) {
  return { title: null, body: null, tags: [] as string[], ...overrides };
}

describe("embeddingText", () => {
  it("leads with the title and tags so a clipped entry keeps them", () => {
    expect(embeddingText(dream({ title: "The tower", tags: ["flying"], body: "I fell." }))).toBe(
      "The tower\n\nflying\n\nI fell.",
    );
  });

  it("omits the parts that are not there rather than leaving blank lines", () => {
    expect(embeddingText(dream({ body: "just the dream" }))).toBe("just the dream");
  });

  it("clips at the budget, because models truncate silently past their context", () => {
    const long = "a".repeat(MAX_EMBEDDING_CHARS + 500);
    expect(embeddingText(dream({ body: long })).length).toBe(MAX_EMBEDDING_CHARS);
  });

  it("has nothing to embed for an entry with no words in it", () => {
    expect(isEmbeddable(dream())).toBe(false);
    expect(isEmbeddable(dream({ body: "   " }))).toBe(false);
    expect(isEmbeddable(dream({ title: "Untitled" }))).toBe(true);
  });
});

describe("the index key", () => {
  it("separates two models' vectors, which are not comparable", () => {
    expect(embeddingModelKey("embeddinggemma")).not.toBe(embeddingModelKey("nomic-embed-text"));
  });

  it("carries the composition version, so a change to what gets embedded forces a re-index", () => {
    expect(embeddingModelKey("embeddinggemma")).toMatch(/@v\d+$/);
  });

  it("gives the model name back for display", () => {
    expect(modelFromKey(embeddingModelKey("embeddinggemma:300m"))).toBe("embeddinggemma:300m");
  });

  it("leaves a key it does not recognise alone", () => {
    expect(modelFromKey("some-model")).toBe("some-model");
  });
});
