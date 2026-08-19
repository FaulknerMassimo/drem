import { describe, expect, it } from "vitest";
import {
  dreamFromTranscript,
  parseSplitParts,
  parseStackReading,
  parseStoredReading,
  serialiseReading,
} from "./fields";

/** One page, one dream — the shape most of these assertions only need. */
function readOne(reply: unknown, pageCount = 1) {
  const dreams = parseStackReading(JSON.stringify(reply), pageCount);
  return dreams[0]!;
}

describe("reading a stack of pages", () => {
  it("reads flat confidence keys", () => {
    const parsed = readOne({
        date: "2026-08-17",
        dateConfidence: 0.9,
        title: "The cathedral",
        titleConfidence: 0.4,
        body: "I was flying.",
        bodyConfidence: 0.8,
        tags: ["flying"],
        lucidity: 3,
    });
    expect(parsed.date.value).toBe("2026-08-17");
    expect(parsed.date.confidence).toBe(0.9);
    expect(parsed.title.value).toBe("The cathedral");
    expect(parsed.body.value).toBe("I was flying.");
    expect(parsed.tags.value).toEqual(["flying"]);
    expect(parsed.lucidity.value).toBe(3);
  });

  it("reads nested { value, confidence } objects", () => {
    const parsed = readOne({
      body: { value: "a train", confidence: 0.55 },
      title: { value: "", confidence: 0.1 },
    });
    expect(parsed.body.value).toBe("a train");
    expect(parsed.body.confidence).toBe(0.55);
    expect(parsed.title.value).toBeNull();
  });

  it("drops a date that is not a real day", () => {
    const parsed = readOne({ date: "Tuesday", body: "x" });
    expect(parsed.date.value).toBeNull();
  });

  /*
   * The failure this guards is not hypothetical: a vision model handed a page
   * it found hard replied with a well-formed object of its own invention, and
   * the review screen showed an empty form with nothing to explain it.
   */
  it("refuses a well-formed object that is not a transcript", () => {
    expect(() =>
      parseStackReading(JSON.stringify({ transcription: "I was flying.", certainty: 0.8 }), 1),
    ).toThrow();
  });

  it("still reads a page the model found blank", () => {
    const parsed = readOne({ date: "", title: "", body: "", bodyConfidence: 0, tags: [] });
    expect(parsed.body.value).toBe("");
    expect(parsed.body.confidence).toBe(0);
  });

  it("does not put the reply in the thrown error", () => {
    try {
      parseStackReading("the cathedral of bees", 1);
    } catch (error) {
      expect((error as Error).message).not.toContain("cathedral");
    }
  });
});

describe("stored reading round-trip", () => {
  it("round-trips a reading of several dreams", () => {
    const stored = serialiseReading([
      dreamFromTranscript("I was flying.", 0.7),
      dreamFromTranscript("Then a train.", 0.4),
    ]);
    const restored = parseStoredReading(stored);
    expect(restored).toHaveLength(2);
    expect(restored[0]?.body.value).toBe("I was flying.");
    expect(restored[0]?.body.confidence).toBe(0.7);
    expect(restored[1]?.body.value).toBe("Then a train.");
  });

  /*
   * Readings written before a stack was the unit are a single `ExtractedFields`
   * object, and the rows holding them are encrypted under a key only the owner
   * has -- there is no migration that could rewrite them, so the parser is the
   * only place the old shape can be honoured.
   */
  it("opens a transcript written before stacks existed", () => {
    const legacy = JSON.stringify({
      date: { value: null, confidence: null },
      title: { value: "The cathedral", confidence: 0.5 },
      body: { value: "I was flying.", confidence: 0.7 },
      tags: { value: ["flying"], confidence: null },
      lucidity: { value: null, confidence: null },
      raw: "I was flying.",
    });
    const restored = parseStoredReading(legacy);
    expect(restored).toHaveLength(1);
    expect(restored[0]?.body.value).toBe("I was flying.");
    expect(restored[0]?.title.value).toBe("The cathedral");
    expect(restored[0]?.pages).toEqual([]);
  });

  it("treats a plain-text blob as the body", () => {
    expect(parseStoredReading("just the transcript")[0]?.body.value).toBe("just the transcript");
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
    const fields = parseStackReading(reply, 1)[0]!;
    expect(fields.date.value).toBe("2026-03-12");
    expect(fields.title.value).toBe("The lighthouse stairs");
    expect(fields.tags.value).toEqual(["lighthouse", "stairs", "hands"]);
    expect(fields.lucidity.value).toBe(3);
    expect(fields.body.confidence).toBeCloseTo(0.98);
  });

  it("reads a month-name date whichever way round it is written", () => {
    for (const written of ["12 March 2026", "March 12, 2026", "Mar 12 2026"]) {
      const fields = readOne({ date: written, body: "x" });
      expect(fields.date.value).toBe("2026-03-12");
    }
  });

  it("refuses an all-numeric date rather than guessing the order", () => {
    // 03/04/2026 is March or April depending on who wrote it. Filing the entry
    // under a date the writer never wrote is worse than leaving it blank.
    const fields = readOne({ date: "03/04/2026", body: "x" });
    expect(fields.date.value).toBeNull();
  });

  it("refuses a day the month does not have", () => {
    const fields = readOne({ date: "31 February 2026", body: "x" });
    expect(fields.date.value).toBeNull();
  });

  it("does not mine a rating out of prose holding two candidates", () => {
    // "woke at 4 ... maybe a 3" leaves two numbers that are both plausible
    // ratings; guessing between them is worse than the blank the reviewer can
    // fill in themselves.
    const fields = readOne({ lucidity: "woke at 4, lucidity maybe a 3", body: "x" });
    expect(fields.lucidity.value).toBeNull();
  });

  it("ignores numbers that could not be a rating at all", () => {
    // "counted 6 fingers, maybe a 3" reads unambiguously once 6 is discarded
    // for being outside the scale -- the fingers are not the rating.
    const fields = readOne({ lucidity: "counted 6 fingers, maybe a 3", body: "x" });
    expect(fields.lucidity.value).toBe(3);
  });

  it("still takes a plain array and a plain number", () => {
    const fields = readOne({ tags: ["lighthouse", "stairs"], lucidity: 4, body: "x" });
    expect(fields.tags.value).toEqual(["lighthouse", "stairs"]);
    expect(fields.lucidity.value).toBe(4);
  });

  it("does not invent tags from an empty string", () => {
    const fields = readOne({ tags: "  ,  ", body: "x" });
    expect(fields.tags.value).toEqual([]);
  });
});

describe("carving a stack into dreams", () => {
  it("keeps each dream and the pages it was written across", () => {
    const dreams = parseStackReading(
      JSON.stringify({
        dreams: [
          { body: "I was flying over the cathedral.", pages: [1, 2], title: "The cathedral" },
          { body: "Then a train.", pages: [2], isFragment: true },
        ],
      }),
      2,
    );
    expect(dreams).toHaveLength(2);
    expect(dreams[0]?.pages).toEqual([1, 2]);
    expect(dreams[0]?.title.value).toBe("The cathedral");
    expect(dreams[1]?.pages).toEqual([2]);
    expect(dreams[1]?.isFragment).toBe(true);
  });

  /*
   * The same rule the dream-sign scan holds to. A page number the stack does
   * not have is dropped rather than clamped: clamping files a photograph
   * against a dream it has nothing to do with, and the review screen would
   * show it there as if the model had said so.
   */
  it("drops a page number the stack does not have", () => {
    const dreams = parseStackReading(
      JSON.stringify({ dreams: [{ body: "I was flying.", pages: [1, 7, 0, -2] }] }),
      3,
    );
    expect(dreams[0]?.pages).toEqual([1]);
  });

  it("puts page numbers in reading order however they were listed", () => {
    const dreams = parseStackReading(
      JSON.stringify({ dreams: [{ body: "I was flying.", pages: [3, 1, 1] }] }),
      3,
    );
    expect(dreams[0]?.pages).toEqual([1, 3]);
  });

  it("reads a bare transcript object as a stack holding one dream", () => {
    const dreams = parseStackReading(JSON.stringify({ body: "I was flying.", tags: [] }), 1);
    expect(dreams).toHaveLength(1);
    expect(dreams[0]?.body.value).toBe("I was flying.");
  });

  it("drops an item the model padded the array out with", () => {
    const dreams = parseStackReading(
      JSON.stringify({ dreams: [{ body: "I was flying." }, { body: "   ", title: "" }] }),
      1,
    );
    expect(dreams).toHaveLength(1);
  });

  it("refuses a reading with no dream text, without echoing the pages", () => {
    try {
      parseStackReading(JSON.stringify({ dreams: [{ body: "   ", title: "cathedral" }] }), 1);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as Error).message).not.toContain("cathedral");
    }
  });
});
