import { describe, expect, it } from "vitest";
import { parseExtraction, parseJsonObject } from "./json";

describe("extraction JSON", () => {
  it("accepts a clean object", () => {
    const parsed = parseExtraction(
      JSON.stringify({
        summary: "Flying over a cathedral",
        people: ["a choir"],
        places: ["the cathedral"],
        anomalies: ["the bells rang underwater"],
        dreamSigns: ["underwater bells"],
      }),
    );
    expect(parsed.summary).toBe("Flying over a cathedral");
    expect(parsed.places).toEqual(["the cathedral"]);
    expect(parsed.dreamSigns).toEqual(["underwater bells"]);
    expect(parsed.objects).toEqual([]);
  });

  it("pulls an object out of fenced chatter", () => {
    const parsed = parseJsonObject('Sure.\n```json\n{"summary":"ok"}\n```');
    expect(parsed).toEqual({ summary: "ok" });
  });

  it("accepts snake_case dream_signs from sloppy models", () => {
    const parsed = parseExtraction(
      JSON.stringify({ summary: "x", dream_signs: ["flying"] }),
    );
    expect(parsed.dreamSigns).toEqual(["flying"]);
  });

  it("deduplicates list entries without regard to case", () => {
    const parsed = parseExtraction(
      JSON.stringify({ people: ["Ada", "ada", "Ada "] }),
    );
    expect(parsed.people).toEqual(["Ada"]);
  });

  it("throws an opaque error when the reply is not JSON", () => {
    expect(() => parseJsonObject("I cannot do that")).toThrow(/did not return JSON/);
    try {
      parseJsonObject("the cathedral of bees");
    } catch (error) {
      expect((error as Error).message).not.toContain("cathedral");
    }
  });
});
