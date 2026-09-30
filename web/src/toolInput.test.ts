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

// S48 (P5-R1-1, P5-R1-2): through the page's renderer, a value is shown exactly or with each differing character named.
describe("whitespace and invisible characters in a tool's input", () => {
  const text = (input: Record<string, unknown>) => rendered(input).textContent ?? "";
  test("whitespace alone is named as its runs in order", () => {
    expect(text({ new_string: "\t" })).toContain("(1 tab)");
    expect(text({ new_string: "\u00a0" })).toContain("(1 non-breaking space)");
    const a = text({ old_string: "\t  " });
    const b = text({ old_string: "  \t" });
    expect(a).toContain("(1 tab, then 2 spaces)");
    expect(b).toContain("(2 spaces, then 1 tab)");
    expect(a).not.toBe(b);
  });
  for (const [value, escape, raw] of [
    ["before\rafter", "before\\rafter", "\r"],
    ["end\r", "end\\r", "\r"],
    ["a\u200bb", "a\\u200Bb", "\u200b"],
    ["bell\u0007", "bell\\u0007", "\u0007"],
    ["\u00a0x", "\\u00A0x", "\u00a0"],
  ] as const) {
    test(`an invisible or control character is a visible escape: ${JSON.stringify(value)}`, () => {
      const el = rendered({ new_string: value });
      expect(codes(el)[0]).toBe(escape);
      expect(el.textContent).not.toContain(raw);
      expect(el.textContent).toContain(render(prompts.ESCAPED_VALUE_NOTE).replace(/<[^>]+>/g, "").trim());
    });
  }
  test("a multi-line value with CRLF line ends shows the carriage return's escape at the end of its line", () => {
    const el = rendered({ content: "one\r\ntwo" });
    expect([...el.querySelectorAll("pre code")].map((c) => c.textContent)).toEqual(["one\\r\ntwo\n"]);
  });
});

// S52 (W5-R1-1, P6-R1-1): the fault of the transport pause moved into its details, which the page renders as Markdown.
// The fault is text of the SDK or the CLI, not Markdown, so it is shown literally, as a tool's input is.
describe("the transport pause's fault, rendered in the page", () => {
  const faults = ["Connection failed: <endpoint> unavailable", "a ` tick and a ``` run", "*stars* and _underscores_"];
  const renderedDetails = (fault: string): HTMLElement => {
    const el = document.createElement("div");
    el.innerHTML = render(prompts.transportDetails(3, fault));
    return el;
  };
  for (const fault of faults) {
    test(`a single-line fault is shown exactly: ${JSON.stringify(fault)}`, () => {
      const el = renderedDetails(fault);
      expect(el.textContent).toContain(prompts.TRANSPORT_FAULT_HEADING);
      expect(codes(el)).toEqual([fault]);
    });
  }
  test("a fault of several lines is shown exactly in its block", () => {
    const fault = "request failed\n    at <anonymous>\n```";
    expect([...renderedDetails(fault).querySelectorAll("pre code")].map((c) => c.textContent)).toEqual([`${fault}\n`]);
  });
  test("the record in conversation.md carries the same details", () => {
    const details = prompts.transportDetails(3, faults[0]);
    const q = { number: 1, origin: { kind: "transport", agent: "codex", what: "the review", attempts: 3, fault: faults[0] }, context: { text: "c", by: "program" }, terms: [], question: prompts.transportExhaustedQuestion("codex", "the review"), options: [], details, decision: null } as const;
    expect(renderQuestionRecord(q as never)).toContain(details);
  });
});
