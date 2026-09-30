// S45 (W3-R1-2, P4-R1-1): a permission's tool input is shown literally. The seam: the text toolInputLines of
// src/prompts.ts produces, rendered by the page's renderer (marked and its sanitizer), shows every value exactly.
import { describe, expect, test } from "vitest";
import * as prompts from "../../src/prompts.ts";
import { renderQuestionRecord } from "../../src/render.ts";
import { render } from "./markdown.ts";

const rendered = (input: Record<string, unknown>): HTMLElement => {
  const el = document.createElement("div");
  el.innerHTML = render(prompts.toolInputLines(input));
  return el;
};
const codes = (el: HTMLElement): string[] => [...el.querySelectorAll("code")].map((c) => c.textContent ?? "");

describe("a tool's input, rendered in the page", () => {
  const singleLine = [
    "<script>alert(1)</script>",
    "echo <secret> > /tmp/out",
    "*emphasis*",
    "_x_",
    "`prefix",
    "suffix`",
    "`both`",
    "a `` b",
    " value ",
    " x",
    "x ",
  ];
  for (const value of singleLine) {
    test(`a single-line value is shown exactly: ${JSON.stringify(value)}`, () => {
      expect(codes(rendered({ new_string: value }))).toEqual([value]);
    });
  }

  for (const value of ["line 1\n```\nline 3", "  indented\n    more", "a\n````\nb"]) {
    test(`a multi-line value is shown exactly in its block: ${JSON.stringify(value)}`, () => {
      const el = rendered({ content: value });
      expect([...el.querySelectorAll("pre code")].map((c) => c.textContent)).toEqual([`${value}\n`]);
    });
  }

  test("the empty string and spaces alone are shown as the program's phrases", () => {
    expect(rendered({ new_string: "" }).textContent).toContain(prompts.emptyTextPhrase);
    expect(rendered({ new_string: "   " }).textContent).toContain(prompts.spacesPhrase(3));
    expect(codes(rendered({ new_string: "" }))).toEqual([]);
  });

  test("the labels, numbers and booleans are the program's own text", () => {
    const el = rendered({ file_path: "/tmp/a", replace_all: true, timeout: 5 });
    expect(el.textContent).toContain("The file:");
    expect(el.textContent).toContain("Replace every occurrence: yes");
    expect(el.textContent).toContain("5");
    expect(codes(el)).toEqual(["/tmp/a"]);
  });

  test("conversation.md carries the same text", () => {
    const details = `${prompts.TOOL_INPUT_HEADING}\n\n${prompts.toolInputLines({ command: "echo <secret> > /tmp/out" })}`;
    const record = renderQuestionRecord({ number: 1, origin: { kind: "permission", tool: "Bash", input: "" }, context: { text: "c", by: "program" }, terms: [], question: "Allow?", options: [], details, decision: null });
    const el = document.createElement("div");
    el.innerHTML = render(record);
    expect(codes(el)).toContain("echo <secret> > /tmp/out");
  });
});
