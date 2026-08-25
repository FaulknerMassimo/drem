import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelProse } from "./model-prose";

function render(text: string): string {
  return renderToStaticMarkup(<ModelProse text={text} />);
}

describe("model prose", () => {
  it("renders bold runs as emphasis rather than asterisks", () => {
    const html = render("The stairs **kept adding floors** as I climbed.");
    expect(html).toContain("<strong");
    expect(html).toContain("kept adding floors");
    expect(html).not.toContain("**");
  });

  it("treats a bold line of its own as a section heading", () => {
    // Every model writes its section titles this way, asked to or not.
    const html = render("**Recurring Places:**\nThe coast road appears in eight.");
    expect(html).toContain("<h4");
    expect(html).toContain("Recurring Places");
  });

  it("renders bullets and numbered lists as lists", () => {
    expect(render("- the coast road\n- the flat")).toContain("<ul");
    expect(render("1. the coast road\n2. the flat")).toContain("<ol");
  });

  it("keeps paragraph breaks apart", () => {
    const html = render("First thought.\n\nSecond thought.");
    expect(html.match(/<p/g)).toHaveLength(2);
  });

  /*
   * The reason this is hand-written rather than a markdown library: the string
   * has been through a model and is derived from something a person wrote, so
   * it is exactly the input that must never be interpreted as markup.
   */
  it("never interprets HTML in a model's answer", () => {
    const html = render("It said <img src=x onerror=alert(1)> and I woke up.");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("leaves an unmatched marker as the character it is", () => {
    const html = render("I woke at 3*am and the * was still there.");
    expect(html).toContain("3*am");
    expect(html).not.toContain("<em");
  });
});
