import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { blindIndex, namespacedBlindIndex, normalizeForIndex } from "./blind-index";

const indexKey = randomBytes(32);

describe("normalisation", () => {
  it("folds case, surrounding space and repeated whitespace", () => {
    expect(normalizeForIndex("  Flying   Dream ")).toBe("flying dream");
  });

  it("folds equivalent Unicode spellings together", () => {
    const precomposed = "café"; // é as one code point
    const decomposed = "café"; // e + combining acute
    expect(normalizeForIndex(precomposed)).toBe(normalizeForIndex(decomposed));
  });
});

describe("blind index", () => {
  it("is deterministic, so SQL equality works", () => {
    expect(blindIndex(indexKey, "nightmare").equals(blindIndex(indexKey, "nightmare"))).toBe(true);
  });

  it("matches across the normalisation rules", () => {
    expect(blindIndex(indexKey, "Flying  Dream").equals(blindIndex(indexKey, "flying dream"))).toBe(true);
  });

  it("separates different values", () => {
    expect(blindIndex(indexKey, "flying").equals(blindIndex(indexKey, "falling"))).toBe(false);
  });

  it("is useless without the key", () => {
    // Two accounts sharing a tag name must not share a fingerprint.
    expect(blindIndex(indexKey, "flying").equals(blindIndex(randomBytes(32), "flying"))).toBe(false);
  });

  it("does not embed the plaintext", () => {
    expect(blindIndex(indexKey, "flying").toString("utf8")).not.toContain("flying");
  });

  it("is 16 bytes, for compact storage", () => {
    expect(blindIndex(indexKey, "flying")).toHaveLength(16);
  });
});

describe("namespacing", () => {
  it("separates the same word used as a tag and as a dream sign", () => {
    const asTag = namespacedBlindIndex(indexKey, "tag", "hands");
    const asSign = namespacedBlindIndex(indexKey, "dream_sign", "hands");
    expect(asTag.equals(asSign)).toBe(false);
  });

  it("stays deterministic within a namespace", () => {
    expect(
      namespacedBlindIndex(indexKey, "tag", "Hands").equals(
        namespacedBlindIndex(indexKey, "tag", "hands"),
      ),
    ).toBe(true);
  });
});
