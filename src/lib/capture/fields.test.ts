import { describe, expect, it } from "vitest";
import {
  fieldsFromTranscript,
  parseExtractedFields,
  parseSplitParts,
  serialiseFields,
  parseStoredFields,
} from "./fields";

describe("OCR field parsing", () => {
  it("reads flat confidence keys", () => {
    const parsed = parseExtractedFields(
      JSON.stringify({
        date: "2026-08-17",
        dateConfidence: 0.9,
        title: "The cathedral",
        titleConfidence: 0.4,
        body: "I was flying.",
        bodyConfidence: 0.8,
        tags: ["flying"],
        lucidity: 3,
      }),
    );
    expect(parsed.date.value).toBe("2026-08-17");
    expect(parsed.date.confidence).toBe(0.9);
    expect(parsed.title.value).toBe("The cathedral");
    expect(parsed.body.value).toBe("I was flying.");
    expect(parsed.tags.value).toEqual(["flying"]);
    expect(parsed.lucidity.value).toBe(3);
  });

  it("reads nested { value, confidence } objects", () => {
    const parsed = parseExtractedFields(
      JSON.stringify({
        body: { value: "a train", confidence: 0.55 },
        title: { value: "", confidence: 0.1 },
      }),
    );
    expect(parsed.body.value).toBe("a train");
    expect(parsed.body.confidence).toBe(0.55);
    expect(parsed.title.value).toBeNull();
  });

  it("drops a date that is not a real day", () => {
    const parsed = parseExtractedFields(JSON.stringify({ date: "Tuesday", body: "x" }));
    expect(parsed.date.value).toBeNull();
  });

  it("does not put the reply in the thrown error", () => {
    try {
      parseExtractedFields("the cathedral of bees");
    } catch (error) {
      expect((error as Error).message).not.toContain("cathedral");
    }
  });
});

describe("stored transcript round-trip", () => {
  it("round-trips structured fields", () => {
    const fields = fieldsFromTranscript("I was flying.", 0.7);
    const restored = parseStoredFields(serialiseFields(fields));
    expect(restored.body.value).toBe("I was flying.");
    expect(restored.body.confidence).toBe(0.7);
  });

  it("treats a plain-text blob as the body", () => {
    expect(parseStoredFields("just the transcript").body.value).toBe("just the transcript");
  });
});

describe("split parsing", () => {
  it("keeps the writer's words as separate dreams", () => {
    const parts = parseSplitParts(
      JSON.stringify({
        dreams: [
          { title: "The cathedral", body: "I was flying." },
          { title: "", body: "Then a train.", isFragment: true },
        ],
      }),
    );
    expect(parts).toHaveLength(2);
    expect(parts[0]?.title).toBe("The cathedral");
    expect(parts[1]?.isFragment).toBe(true);
  });

  it("accepts snake_case is_fragment", () => {
    const parts = parseSplitParts(
      JSON.stringify({ dreams: [{ body: "a scrap", is_fragment: true }] }),
    );
    expect(parts[0]?.isFragment).toBe(true);
  });

  it("refuses an empty split without echoing the log", () => {
    try {
      parseSplitParts(JSON.stringify({ dreams: [{ body: "   " }] }));
    } catch (error) {
      expect((error as Error).message).toBe("The model did not return JSON.");
    }
  });
});

describe("fields as a vision model actually writes them", () => {
  /*
   * Verbatim from qwen3.8:27b reading a photographed page under the app's own
   * OCR prompt. The prompt asks for an array of tags and a numeric rating; a
   * model told to transcribe literally hands back the page's own wording
   * instead, and every one of these fields used to be dropped on the floor.
   */
  const reply = JSON.stringify({
    date: { value: "12 March 2026", confidence: 0.99 },
    title: { value: "The lighthouse stairs", confidence: 0.99 },
    body: { value: "I was climbing a spiral staircase inside a lighthouse.", confidence: 0.98 },
    tags: { value: "lighthouse, stairs, hands", confidence: 0.99 },
    lucidity: { value: "fairly clear, maybe a 3", confidence: 0.97 },
  });

  it("keeps every field the model read", () => {
    const fields = parseExtractedFields(reply);
    expect(fields.date.value).toBe("2026-03-12");
    expect(fields.title.value).toBe("The lighthouse stairs");
    expect(fields.tags.value).toEqual(["lighthouse", "stairs", "hands"]);
    expect(fields.lucidity.value).toBe(3);
    expect(fields.body.confidence).toBeCloseTo(0.98);
  });

  it("reads a month-name date whichever way round it is written", () => {
    for (const written of ["12 March 2026", "March 12, 2026", "Mar 12 2026"]) {
      const fields = parseExtractedFields(JSON.stringify({ date: written, body: "x" }));
      expect(fields.date.value).toBe("2026-03-12");
    }
  });

  it("refuses an all-numeric date rather than guessing the order", () => {
    // 03/04/2026 is March or April depending on who wrote it. Filing the entry
    // under a date the writer never wrote is worse than leaving it blank.
    const fields = parseExtractedFields(JSON.stringify({ date: "03/04/2026", body: "x" }));
    expect(fields.date.value).toBeNull();
  });

  it("refuses a day the month does not have", () => {
    const fields = parseExtractedFields(JSON.stringify({ date: "31 February 2026", body: "x" }));
    expect(fields.date.value).toBeNull();
  });

  it("does not mine a rating out of prose holding two candidates", () => {
    // "woke at 4 ... maybe a 3" leaves two numbers that are both plausible
    // ratings; guessing between them is worse than the blank the reviewer can
    // fill in themselves.
    const fields = parseExtractedFields(
      JSON.stringify({ lucidity: "woke at 4, lucidity maybe a 3", body: "x" }),
    );
    expect(fields.lucidity.value).toBeNull();
  });

  it("ignores numbers that could not be a rating at all", () => {
    // "counted 6 fingers, maybe a 3" reads unambiguously once 6 is discarded
    // for being outside the scale -- the fingers are not the rating.
    const fields = parseExtractedFields(
      JSON.stringify({ lucidity: "counted 6 fingers, maybe a 3", body: "x" }),
    );
    expect(fields.lucidity.value).toBe(3);
  });

  it("still takes a plain array and a plain number", () => {
    const fields = parseExtractedFields(
      JSON.stringify({ tags: ["lighthouse", "stairs"], lucidity: 4, body: "x" }),
    );
    expect(fields.tags.value).toEqual(["lighthouse", "stairs"]);
    expect(fields.lucidity.value).toBe(4);
  });

  it("does not invent tags from an empty string", () => {
    const fields = parseExtractedFields(JSON.stringify({ tags: "  ,  ", body: "x" }));
    expect(fields.tags.value).toEqual([]);
  });
});
