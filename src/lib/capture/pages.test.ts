import { describe, expect, it } from "vitest";
import { addPage, removePage } from "./pages";

describe("joining pages into one dream", () => {
  it("separates pages with a blank line", () => {
    expect(addPage("The first page.", "The second page.")).toBe(
      "The first page.\n\nThe second page.",
    );
  });

  it("starts the entry when there is nothing to join to", () => {
    expect(addPage("", "The only page.")).toBe("The only page.");
    expect(addPage("   \n ", "The only page.")).toBe("The only page.");
  });

  it("does not add the same page twice", () => {
    const joined = addPage("One.", "Two.");
    expect(addPage(joined, "Two.")).toBe(joined);
  });

  it("adds nothing for a page that was never read", () => {
    expect(addPage("One.", "   ")).toBe("One.");
  });

  it("puts a late-ticked page in front of the page it precedes", () => {
    const joined = addPage("One.", "Three.");
    expect(addPage(joined, "Two.", "Three.")).toBe("One.\n\nTwo.\n\nThree.");
  });

  it("falls back to the end when the page it precedes is no longer there", () => {
    expect(addPage("One.", "Two.", "Edited away.")).toBe("One.\n\nTwo.");
  });

  it("takes a page back out and closes the gap", () => {
    const joined = addPage(addPage("One.", "Two."), "Three.");
    expect(removePage(joined, "Two.")).toBe("One.\n\nThree.");
    expect(removePage(joined, "Three.")).toBe("One.\n\nTwo.");
    expect(removePage(removePage(joined, "Two."), "Three.")).toBe("One.");
  });

  it("leaves an edited page alone rather than guessing at it", () => {
    const edited = "One.\n\nTwo, corrected.";
    expect(removePage(edited, "Two.")).toBe(edited);
  });
});
