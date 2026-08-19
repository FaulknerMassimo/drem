import { describe, expect, it } from "vitest";
import {
  cosineSimilarity,
  dot,
  packVector,
  topMatches,
  unpackVector,
  type Candidate,
} from "./vectors";

function candidate(dreamId: string, vector: number[]): Candidate {
  return { dreamId, vector };
}

describe("the stored vector format", () => {
  it("round-trips a vector through the packed form", () => {
    const original = [0.5, -0.25, 0.125, 0];
    expect(unpackVector(packVector(original))).toEqual(original);
  });

  it("stores four bytes per component", () => {
    expect(packVector([1, 2, 3]).length).toBe(12);
  });

  it("refuses a buffer that is not whole float32 components", () => {
    expect(() => unpackVector(Buffer.alloc(7))).toThrow(/float32/);
  });

  it("keeps float32 precision within tolerance", () => {
    // The pack is lossy — doubles in, floats out — and the loss must stay small
    // enough not to reorder two genuinely different matches.
    const original = [0.123456789, 0.987654321];
    const [first, second] = unpackVector(packVector(original));
    expect(first).toBeCloseTo(0.123456789, 6);
    expect(second).toBeCloseTo(0.987654321, 6);
  });
});

describe("similarity", () => {
  it("scores an identical vector at 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it("scores an orthogonal vector at 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("scores an opposite vector at -1", () => {
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1);
  });

  it("ignores magnitude, which is the point of using cosine", () => {
    expect(cosineSimilarity([1, 1], [10, 10])).toBeCloseTo(1);
  });

  it("returns 0 rather than NaN for a zero vector", () => {
    // Some models emit a zero vector for whitespace. A NaN would poison every
    // comparison it took part in instead of simply matching nothing.
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("returns 0 when the dimensions do not match", () => {
    // Two different models' vectors are not comparable, and a partial dot
    // product would silently rank them as though they were.
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  it("takes the dot product over the shared prefix", () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
  });
});

describe("topMatches", () => {
  const query = [1, 0];

  it("returns the strongest matches first", () => {
    const matches = topMatches(
      query,
      [candidate("far", [0, 1]), candidate("near", [1, 0]), candidate("mid", [1, 1])],
      3,
      -1,
    );
    expect(matches.map((match) => match.dreamId)).toEqual(["near", "mid", "far"]);
  });

  it("stops at the limit", () => {
    const matches = topMatches(
      query,
      [candidate("a", [1, 0]), candidate("b", [1, 0.1]), candidate("c", [1, 0.2])],
      2,
      -1,
    );
    expect(matches).toHaveLength(2);
  });

  it("drops everything below the floor rather than padding the page", () => {
    // Without a floor, the least unrelated entry in the archive comes back
    // looking exactly like a real match.
    const matches = topMatches(query, [candidate("unrelated", [0, 1])], 5, 0.35);
    expect(matches).toEqual([]);
  });

  it("returns nothing for an empty index", () => {
    expect(topMatches(query, [], 5)).toEqual([]);
  });
});
