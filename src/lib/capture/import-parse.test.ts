import { describe, expect, it } from "vitest";
import { parseCsv, parseImport } from "./import-parse";

describe("JSON import", () => {
  it("reads an array of dreams", () => {
    const result = parseImport(
      "journal.json",
      JSON.stringify([
        { date: "2026-08-17", title: "Flying", body: "Over the cathedral.", lucidity: 4, tags: ["flying"] },
        { date: "2026-08-18", body: "A train." },
      ]),
    );
    expect(result.error).toBeUndefined();
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]?.title).toBe("Flying");
    expect(result.entries[0]?.lucidity).toBe(4);
    expect(result.entries[0]?.tags).toEqual(["flying"]);
  });

  it("reads nights with nested dreams", () => {
    const result = parseImport(
      "journal.json",
      JSON.stringify({
        nights: [{ date: "2026-08-17", dreams: [{ body: "First." }, { body: "Second." }] }],
      }),
    );
    expect(result.entries.map((entry) => entry.body)).toEqual(["First.", "Second."]);
    expect(result.entries[0]?.nightDate).toBe("2026-08-17");
  });

  it("skips rows with no body", () => {
    const result = parseImport(
      "journal.json",
      JSON.stringify([{ date: "2026-08-17", title: "Empty" }, { date: "2026-08-18", body: "Kept." }]),
    );
    expect(result.entries).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });
});

describe("Markdown import", () => {
  it("splits on dated headings", () => {
    const result = parseImport(
      "journal.md",
      `# 2026-08-17 The cathedral\n\nI was flying.\n\n# 2026-08-18\n\nA train.`,
    );
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]?.title).toBe("The cathedral");
    expect(result.entries[1]?.body).toBe("A train.");
  });

  it("reads YAML frontmatter between --- rules", () => {
    const result = parseImport(
      "journal.md",
      `---\ndate: 2026-08-17\ntitle: Flying\ntags: flying, lucid\n---\nI was flying.\n\n---\ndate: 2026-08-18\n---\nA train.`,
    );
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]?.tags).toEqual(["flying", "lucid"]);
    expect(result.entries[1]?.nightDate).toBe("2026-08-18");
  });
});

describe("CSV import", () => {
  it("reads quoted fields with commas", () => {
    const rows = parseCsv('date,title,body\n2026-08-17,Flying,"Over the city, then home."\n');
    expect(rows[1]).toEqual(["2026-08-17", "Flying", "Over the city, then home."]);
  });

  it("maps a header row onto dreams", () => {
    const result = parseImport(
      "journal.csv",
      "date,title,body,lucidity,tags\n2026-08-17,Flying,Over the cathedral,4,flying\n",
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.lucidity).toBe(4);
    expect(result.entries[0]?.tags).toEqual(["flying"]);
  });
});

describe("unrecognised files", () => {
  it("refuses a file that is none of the three formats", () => {
    const result = parseImport("notes.txt", "just some notes without a date");
    expect(result.entries).toHaveLength(0);
    expect(result.error).toMatch(/Unrecognised/);
  });
});
