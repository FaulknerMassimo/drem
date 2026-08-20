import { describe, expect, it } from "vitest";
import {
  ArchiveDocumentError,
  DOCUMENT_FORMAT,
  DOCUMENT_VERSION,
  archiveFilename,
  dreamFingerprint,
  parseDocument,
  serialiseDocument,
  summariseDocument,
  type ArchiveDocument,
  type ArchiveDream,
  type ArchiveNight,
} from "./document";

function night(overrides: Partial<ArchiveNight> = {}): ArchiveNight {
  return {
    date: "2026-08-17",
    bedTime: null,
    wakeTime: null,
    wbtbTime: null,
    sleepQuality: null,
    techniques: [],
    noRecall: false,
    notes: null,
    ...overrides,
  };
}

function dream(overrides: Partial<ArchiveDream> = {}): ArchiveDream {
  return {
    nightDate: "2026-08-17",
    title: "The cathedral",
    body: "I was flying over it.",
    lucidity: 0,
    vividness: null,
    control: null,
    recallClarity: null,
    emotionalValence: null,
    isNightmare: false,
    isRecurring: false,
    isFragment: false,
    isDraft: false,
    source: "typed",
    createdAt: "2026-08-17T07:00:00.000Z",
    tags: [],
    ...overrides,
  };
}

function document(overrides: Partial<ArchiveDocument> = {}): ArchiveDocument {
  return {
    format: DOCUMENT_FORMAT,
    version: DOCUMENT_VERSION,
    exportedAt: "2026-08-19T09:00:00.000Z",
    nights: [night()],
    dreams: [dream()],
    ...overrides,
  };
}

describe("parseDocument", () => {
  it("round-trips a document", () => {
    const original = document();
    expect(parseDocument(serialiseDocument(original))).toEqual(original);
  });

  it("refuses anything that is not an archive document", () => {
    expect(() => parseDocument("not json")).toThrow(ArchiveDocumentError);
    expect(() => parseDocument("{}")).toThrow(ArchiveDocumentError);
    expect(() => parseDocument(JSON.stringify({ dreams: [] }))).toThrow(ArchiveDocumentError);
  });

  it("refuses a version it does not understand", () => {
    const future = { ...document(), version: 99 };
    expect(() => parseDocument(JSON.stringify(future))).toThrow(ArchiveDocumentError);
  });

  it("refuses an entry that could not have been written in the editor", () => {
    // The same limits the editor enforces, applied to a hand-edited archive:
    // an oversized body must not get in through the back door.
    const oversized = document({ dreams: [dream({ body: "x".repeat(50_001) })] });
    expect(() => parseDocument(JSON.stringify(oversized))).toThrow(ArchiveDocumentError);

    const impossible = document({ dreams: [dream({ lucidity: 9 })] });
    expect(() => parseDocument(JSON.stringify(impossible))).toThrow(ArchiveDocumentError);

    const notADate = document({ nights: [night({ date: "2026-02-31" })] });
    expect(() => parseDocument(JSON.stringify(notADate))).toThrow(ArchiveDocumentError);
  });

  it("says nothing about the values it rejected", () => {
    const oversized = document({ dreams: [dream({ body: "zarquon ".repeat(9000) })] });
    const message = (() => {
      try {
        parseDocument(JSON.stringify(oversized));
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })();
    // The rejected value is dream text; the message must not quote it.
    expect(message).not.toContain("zarquon");
  });
});

describe("dreamFingerprint", () => {
  it("is the same for the same entry on the same night", () => {
    expect(dreamFingerprint(dream())).toBe(dreamFingerprint(dream()));
  });

  it("separates the same words written on two different nights", () => {
    expect(dreamFingerprint(dream())).not.toBe(
      dreamFingerprint(dream({ nightDate: "2026-08-18" })),
    );
  });

  it("ignores ratings edited after the backup was taken", () => {
    // Same dream, rated later. Restoring must not produce a second copy of it.
    expect(dreamFingerprint(dream())).toBe(
      dreamFingerprint(dream({ vividness: 5, lucidity: 4 }) as ArchiveDream),
    );
  });

  it("distinguishes an absent title from an empty one only by content", () => {
    expect(dreamFingerprint(dream({ title: null }))).toBe(
      dreamFingerprint(dream({ title: "" })),
    );
    expect(dreamFingerprint(dream({ title: "Other" }))).not.toBe(
      dreamFingerprint(dream({ title: null })),
    );
  });
});

describe("summariseDocument", () => {
  it("reports the span the archive covers", () => {
    const summary = summariseDocument(
      document({
        nights: [night({ date: "2026-01-05" }), night({ date: "2026-08-17" })],
        dreams: [
          dream({ nightDate: "2026-01-05" }),
          dream({ nightDate: "2026-08-17", lucidity: 4 }),
        ],
      }),
    );

    expect(summary.nights).toBe(2);
    expect(summary.dreams).toBe(2);
    expect(summary.lucidDreams).toBe(1);
    expect(summary.from).toBe("2026-01-05");
    expect(summary.to).toBe("2026-08-17");
  });

  it("copes with an empty journal", () => {
    const summary = summariseDocument(document({ nights: [], dreams: [] }));
    expect(summary.from).toBeNull();
    expect(summary.to).toBeNull();
  });
});

describe("archiveFilename", () => {
  it("is dated, so a directory of them sorts chronologically", () => {
    expect(archiveFilename(new Date("2026-08-19T22:00:00Z"))).toBe(
      "drem-2026-08-19.dremarchive",
    );
  });
});
