import { describe, expect, it } from "vitest";
import { MAX_SIGNS_PER_SCAN, parseSignScan } from "./signs-parse";

function reply(signs: unknown[]): string {
  return JSON.stringify({ signs });
}

describe("parseSignScan", () => {
  it("reads a well-formed sign and rebases its indices to zero", () => {
    // The prompt numbers entries from 1 so the model is not asked to count from
    // zero; the occurrence table indexes an array.
    const signs = parseSignScan(
      reply([{ label: "blue door", category: "object", entries: [1, 3], confidence: 0.9 }]),
      5,
    );
    expect(signs).toEqual([
      { label: "blue door", category: "object", entries: [0, 2], confidence: 0.9 },
    ]);
  });

  it("digs the object out of a fenced reply", () => {
    const text = "Here you go:\n```json\n" + reply([
      { label: "my old school", category: "place", entries: [1, 2] },
    ]) + "\n```";
    expect(parseSignScan(text, 3)).toHaveLength(1);
  });

  it("drops an entry index the scan was never given", () => {
    // Clamping instead would file a real sign against an unrelated dream, and
    // nothing downstream could tell that it was wrong.
    const signs = parseSignScan(
      reply([{ label: "a corridor", category: "place", entries: [1, 2, 99] }]),
      3,
    );
    expect(signs[0]!.entries).toEqual([0, 1]);
  });

  it("drops a sign whose indices were all invented", () => {
    const signs = parseSignScan(
      reply([{ label: "ghost", category: "person", entries: [40, 41] }]),
      3,
    );
    expect(signs).toEqual([]);
  });

  it("refuses a cue that appears only once", () => {
    // A detail that happened once is not a dream sign: it cannot be recognised
    // from inside a dream because there is no pattern to recognise.
    expect(parseSignScan(reply([{ label: "a kite", category: "object", entries: [1] }]), 4))
      .toEqual([]);
  });

  it("de-duplicates labels that differ only in case", () => {
    const signs = parseSignScan(
      reply([
        { label: "Blue Door", category: "object", entries: [1, 2] },
        { label: "blue door", category: "object", entries: [2, 3] },
      ]),
      4,
    );
    expect(signs).toHaveLength(1);
    expect(signs[0]!.label).toBe("Blue Door");
  });

  it("de-duplicates repeated indices within one sign", () => {
    const signs = parseSignScan(
      reply([{ label: "stairs", category: "place", entries: [1, 1, 2] }]),
      3,
    );
    expect(signs[0]!.entries).toEqual([0, 1]);
  });

  it("falls back to a theme for a category it does not recognise", () => {
    const signs = parseSignScan(
      reply([{ label: "being late", category: "vibe", entries: [1, 2] }]),
      3,
    );
    expect(signs[0]!.category).toBe("theme");
  });

  it("defaults confidence when the model omits it, and clamps it when it does not", () => {
    const signs = parseSignScan(
      reply([
        { label: "flying", category: "action", entries: [1, 2] },
        { label: "teeth", category: "object", entries: [1, 3], confidence: 7 },
        { label: "water", category: "object", entries: [2, 3], confidence: -1 },
      ]),
      4,
    );
    expect(signs.map((sign) => sign.confidence)).toEqual([1, 1, 0]);
  });

  it("normalises whitespace inside a label", () => {
    const signs = parseSignScan(
      reply([{ label: "  my   old  school \n", category: "place", entries: [1, 2] }]),
      3,
    );
    expect(signs[0]!.label).toBe("my old school");
  });

  it("caps a runaway reply", () => {
    const many = Array.from({ length: MAX_SIGNS_PER_SCAN + 10 }, (_, index) => ({
      label: `sign ${index}`,
      category: "theme",
      entries: [1, 2],
    }));
    expect(parseSignScan(reply(many), 3)).toHaveLength(MAX_SIGNS_PER_SCAN);
  });

  it("returns nothing for a reply with no signs in it", () => {
    expect(parseSignScan(JSON.stringify({ signs: [] }), 3)).toEqual([]);
    expect(parseSignScan(JSON.stringify({ notes: "none found" }), 3)).toEqual([]);
  });

  it("throws when the reply is not JSON at all", () => {
    expect(() => parseSignScan("I could not find any signs.", 3)).toThrow(
      "The model did not return JSON.",
    );
  });
});
