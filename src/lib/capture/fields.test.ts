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
