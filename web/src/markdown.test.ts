import { describe, expect, test } from "vitest";
import DOMPurify from "dompurify";
import { makeRenderer, render } from "./markdown.ts";

// Plan step 4.4: the agents' Markdown is rendered and sanitised.
describe("render", () => {
  test("headings, lists and code render", () => {
    const html = render("# Title\n\n- one\n- two\n\n`code`");
    expect(html).toMatch(/<h1[^>]*>Title<\/h1>/);
    expect(html).toMatch(/<li>one<\/li>/);
    expect(html).toMatch(/<code>code<\/code>/);
  });

  test("a script tag, an onerror attribute and a javascript: link are removed", () => {
    const html = render('<script>alert(1)</script>\n\n<img src="x" onerror="alert(2)">\n\n[x](javascript:alert(3))');
    expect(html).not.toMatch(/<script/);
    expect(html).not.toMatch(/onerror/);
    expect(html).not.toMatch(/javascript:/);
  });

  test("links open without access to the page", () => {
    expect(render("[site](https://example.com)")).toMatch(/<a href="https:\/\/example.com"[^>]*rel="noopener noreferrer"/);
  });
});

// Finding 14 of docs/gui-review.md: the link hook belongs to a private instance, not to the imported singleton.
describe("makeRenderer", () => {
  test("its links open without access to the page, and the global DOMPurify is left unconfigured", () => {
    const own = makeRenderer(window);
    expect(own("[site](https://example.com)")).toMatch(/target="_blank"/);
    expect(DOMPurify.sanitize('<a href="https://example.com">x</a>', { ADD_ATTR: ["target"] })).not.toMatch(/target=|rel=/);
  });

  test("two renderers are independent instances", () => {
    const a = makeRenderer(window);
    const b = makeRenderer(window);
    expect(a).not.toBe(b);
    expect(b("[x](https://example.com)")).toMatch(/rel="noopener noreferrer"/);
  });
});
